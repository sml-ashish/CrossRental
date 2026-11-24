import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { env } from "../config/env";
import {
  straightLineKm,
  tryGeocode,
  tryRoadRoutes,
  type GeoPoint,
  type RouteWaypoint,
  type RoutesResult,
} from "../lib/geo";
import type { Actor } from "./rfq.service";

/**
 * The mobilisation route from a job site to one crane.
 *
 * This is the one place in the product that answers "how does the crane get
 * there", as opposed to "how far is it". The shape is deliberately different
 * from a distance: a distance is a number a list can sort by, a route is a
 * picture of one journey, and the two need different guarantees.
 *
 * **The server owns both ends.** The endpoint takes a line id and a crane id
 * and nothing else. The job site is geocoded from the enquiry's ship-to city and
 * state, and the crane end comes from its stored pin (or its place name), so a
 * caller cannot ask us to draw a line between two points of their choosing and
 * then screenshot it as fact.
 *
 * **A straight line is a labelled failure, never a route.** Google's Routes
 * API can decline (quota, key restriction, no drivable path), and `stub` and
 * `disabled` providers cannot route at all. In every one of those cases the
 * caller gets `method: "straight_line"`, `approximate: true` and one option
 * whose `encodedPolyline` is null, which the map draws dashed and the card
 * labels as an approximation. The polyline is null on purpose: if we shipped
 * two endpoints as a "route shape", a careless polyline would render a road
 * that does not exist.
 *
 * **Only successful routes are cached.** A 24-hour in-memory LRU keyed on the
 * coordinates rounded to three decimals — the same granularity as
 * `distance.service.ts`, ~110 m — turns the second and third look at a crane
 * into a free response. A fallback is never cached: an outage must not become
 * a permanent approximation nobody can tell apart from a real road.
 */

export type RouteMethod = "road" | "straight_line";

export interface LineRouteOption {
  id: string;
  isPrimary: boolean;
  km: number;
  durationMin: number | null;
  via: string | null;
  encodedPolyline: string | null;
}

export interface LineRoute {
  method: RouteMethod;
  /** True only for the straight-line fallback. */
  approximate: boolean;
  siteLabel: string;
  craneLabel: string;
  /** Where the route ends, so the map can draw a crane that has no stored pin. */
  destination: GeoPoint;
  /** Where the route starts (the job site), for the same reason. */
  origin: GeoPoint;
  /**
   * True when an end has no stored pin and was worked out from its place name
   * (for example "Nagpur, Maharashtra"), either by the geocoder or by the router
   * itself. It is the place, not the yard, so the screen labels it as an
   * estimate. `destinationEstimated` is the crane end, `originEstimated` the
   * job site.
   */
  destinationEstimated: boolean;
  originEstimated: boolean;
  /**
   * Why the route is a straight line, or null for a real road route. One of
   * `provider_stub`, `provider_disabled`, `route_polyline_off`, or
   * `route_error: <what Google or the lookup said>`. Internal staff only see
   * this endpoint, so the screen shows it to explain an approximation.
   */
  reason: string | null;
  /** Primary first. Exactly one option is primary; the fallback has one option. */
  routes: LineRouteOption[];
}

/** Geometry is cacheable; the labels are per line and per crane. */
type RouteGeometry = Pick<LineRoute, "method" | "approximate" | "reason" | "routes">;

const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** ~110 m, the same granularity `distance.service.ts` caches at. */
const PRECISION = 3;

interface CacheEntry {
  route: RouteGeometry;
  storedAt: number;
}

/**
 * Insertion-ordered `Map` as an LRU: a hit is re-inserted so it moves to the
 * end, and eviction takes from the front. No dependency, and bounded memory.
 */
const cache = new Map<string, CacheEntry>();

function routeKey(origin: GeoPoint, destination: GeoPoint): string {
  const coord = (value: number) => value.toFixed(PRECISION);
  return [
    coord(origin.lat),
    coord(origin.lng),
    coord(destination.lat),
    coord(destination.lng),
  ].join(":");
}

function cacheGet(key: string): RouteGeometry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.route;
}

function cacheSet(key: string, route: RouteGeometry): void {
  cache.delete(key);
  cache.set(key, { route, storedAt: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam: an empty cache between suites. */
export function clearRouteCache(): void {
  cache.clear();
}

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can work with enquiries");
  }
}

function point(lat: unknown, lng: unknown): GeoPoint | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const parsed = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng) ? parsed : null;
}

function label(parts: Array<string | null | undefined>, fallback: string): string {
  const text = parts
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return text || fallback;
}

/**
 * The route for one line and one crane.
 *
 * A missing pin is a 422, not a 400: the request is well formed and the answer
 * is "this record is not complete enough to draw a route", which is what the
 * screen shows as "No route: the job site could not be placed".
 */
export async function getLineRoute(
  lineId: string,
  craneId: string,
  actor: Actor,
): Promise<LineRoute> {
  assertInternal(actor);

  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: {
      enquiry: {
        select: {
          shipToCity: true,
          siteStateCode: true,
          siteState: { select: { name: true } },
        },
      },
    },
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");

  const crane = await prisma.crane.findUnique({
    where: { id: craneId },
    select: {
      make: true,
      model: true,
      serialRegistrationNo: true,
      latitude: true,
      longitude: true,
      currentLocation: true,
      stateCode: true,
      pincode: true,
      state: { select: { name: true } },
    },
  });
  if (!crane) throw AppError.notFound("That crane does not exist");

  // An end with no stored pin is looked up from its place name, the way Google
  // Maps takes "Pune, Maharashtra". The geocoder is tried first. If it cannot
  // place the name (no geocoder, or a failed lookup), the router is given the
  // name itself and reports where it put the end. Read-only: no record is
  // changed, so a crane stays "unverified" until a pin is dropped.
  const placeName = (text: string, state: string): string => {
    const parts = [text.trim()];
    if (state && !text.toLowerCase().includes(state.toLowerCase())) parts.push(state);
    return [...parts, "India"].filter(Boolean).join(", ");
  };

  // The enquiry stores a city, not a pin, so the job site is placed from the
  // city and state on every request. This is read-only: a failed lookup costs
  // the caller an estimate, it never writes a guessed coordinate anywhere.
  const siteState = line.enquiry.siteState?.name ?? line.enquiry.siteStateCode;
  let origin: GeoPoint | null = null;
  let originEstimated = true;
  const geocoded = await tryGeocode({
    location: line.enquiry.shipToCity,
    state: siteState,
  });
  if (geocoded.ok) origin = geocoded.point;

  let destination = point(crane.latitude, crane.longitude);
  let destinationEstimated = false;
  if (!destination) {
    destinationEstimated = true;
    const geocoded = await tryGeocode({
      location: crane.currentLocation,
      state: crane.state?.name ?? crane.stateCode,
      pincode: crane.pincode,
    });
    if (geocoded.ok) destination = geocoded.point;
  }

  const noPin = () =>
    new AppError(
      origin ? "This crane has no pin" : "The job site has no pin",
      422,
      "NO_PIN",
    );

  // Still an end without a point: ask the router to find it from the name.
  let namedRoad: RoutesResult | null = null;
  if (!origin || !destination) {
    if (!env.route.polyline) throw noPin();
    const originWaypoint: RouteWaypoint = origin ?? {
      address: placeName(line.enquiry.shipToCity, siteState),
    };
    const destinationWaypoint: RouteWaypoint = destination ?? {
      address: placeName(crane.currentLocation, crane.state?.name ?? crane.stateCode),
    };
    namedRoad = await tryRoadRoutes(originWaypoint, destinationWaypoint);
    if (!namedRoad.ok) throw noPin();
    // The map needs both ends as points, and the router reports them.
    origin = origin ?? namedRoad.origin ?? null;
    destination = destination ?? namedRoad.destination ?? null;
    if (!origin || !destination) throw noPin();
  }

  const siteLabel = label([line.enquiry.shipToCity, siteState], "Job site");
  const craneLabel = label(
    [crane.make, crane.model],
    crane.serialRegistrationNo?.trim() || "Crane",
  );

  const ends = { origin, destination, originEstimated, destinationEstimated };

  const key = routeKey(origin, destination);
  const cached = namedRoad ? null : cacheGet(key);
  if (cached) return { ...cached, siteLabel, craneLabel, ...ends };

  const fallback = (reason: string): LineRoute => ({
    method: "straight_line",
    approximate: true,
    siteLabel,
    craneLabel,
    ...ends,
    reason,
    routes: [
      {
        id: "r0",
        isPrimary: true,
        // A real great-circle figure, not a detour guess: the card must not
        // show a number that implies a road it never found.
        km: Number(straightLineKm(origin, destination).toFixed(2)),
        durationMin: null,
        via: null,
        encodedPolyline: null,
      },
    ],
  });

  // The kill switch exists because the polyline field is a billed SKU. With it
  // off the screen still draws a labelled approximation and no Google call is
  // made at all.
  if (!env.route.polyline) return fallback("route_polyline_off");

  const road = namedRoad ?? (await tryRoadRoutes(origin, destination));
  if (!road.ok) {
    if (env.geo.provider === "stub") return fallback("provider_stub");
    if (env.geo.provider === "disabled") return fallback("provider_disabled");
    return fallback(`route_error: ${road.reason}`);
  }
  if (road.routes.length === 0) {
    return fallback("route_error: Google returned no drivable route between these points");
  }

  const geometry: RouteGeometry = {
    method: "road",
    approximate: false,
    reason: null,
    routes: road.routes.map((route, index) => ({
      id: route.id || `r${index}`,
      isPrimary: index === 0,
      km: route.km,
      durationMin: route.durationMin,
      via: route.via,
      encodedPolyline: route.encodedPolyline,
    })),
  };
  cacheSet(key, geometry);
  return { ...geometry, siteLabel, craneLabel, ...ends };
}



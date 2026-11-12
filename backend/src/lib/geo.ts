import { env } from "../config/env";

/**
 * Geocoding and distance, behind an interface (brief 6.8).
 *
 * Google Maps is now the chosen provider: the Geocoding API turns an address
 * into a coordinate and the Routes API returns a real road distance. `stub`
 * and `disabled` remain for development, tests, and a deployment that has not
 * been given a key.
 *
 * Three things hold whichever provider is selected:
 *
 * 1. **The stub is never used in production.** It invents coordinates, and a
 *    fabricated pin on a real crane is worse than no pin — it would flow into
 *    distance sorting and candidate lists as though it were real. With
 *    `disabled` in production `geocode` always fails, which is brief 6.8's
 *    "cranes stay location unverified", and the vendor is prompted to drop a
 *    pin by hand.
 * 2. **A failed geocode is never fatal.** Brief 6.3 requires the crane to be
 *    saved anyway and flagged unverified, so every failure path here is a
 *    value the caller can handle, not an exception it must catch.
 * 3. **An approximation is labelled as one.** The stub's road distance is a
 *    straight line scaled by a detour factor and reported as `straight_line`;
 *    only a routed answer is reported as `road`.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type GeocodeResult =
  | { ok: true; point: GeoPoint; provider: string }
  | { ok: false; reason: string };

export type DistanceMethod = "road" | "straight_line";

export type DistanceResult =
  | { ok: true; km: number; method: DistanceMethod; provider: string }
  | { ok: false; reason: string };

/** The address pieces a reverse lookup can return, all optional in practice. */
export interface GeocodedAddress {
  /** A human-readable place — the locality or sublocality. */
  currentLocation: string | null;
  /** The state name, e.g. "Gujarat". */
  stateName: string | null;
  /** The state's short code where the provider gives one, e.g. "GJ". */
  stateCode: string | null;
  pincode: string | null;
}

export type ReverseGeocodeResult =
  | { ok: true; address: GeocodedAddress; provider: string }
  | { ok: false; reason: string };

export interface GeoProvider {
  /** Recorded on the crane as `geocodedBy` so a coordinate is traceable. */
  readonly name: string;
  /** True when coordinates from this provider are real rather than synthetic. */
  readonly isAuthoritative: boolean;
  geocode(input: { location: string; state: string; pincode?: string | null }): Promise<GeocodeResult>;
  roadDistance(origin: GeoPoint, destination: GeoPoint): Promise<DistanceResult>;
  /**
   * Turns a coordinate back into an address. Optional on purpose: a provider
   * that cannot do this (the stub, the disabled provider) leaves it out, so an
   * address is never invented for a pin the vendor dropped.
   */
  reverseGeocode?(point: GeoPoint): Promise<ReverseGeocodeResult>;
}

/**
 * India's bounding box (brief 5.2). Coordinates outside it are rejected with a
 * message the vendor can act on. The same bounds exist as a CHECK constraint in
 * the database; this is the friendly layer in front of it.
 */
export const INDIA_BOUNDS = { minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 } as const;

export function isInsideIndia(point: GeoPoint): boolean {
  return (
    point.lat >= INDIA_BOUNDS.minLat &&
    point.lat <= INDIA_BOUNDS.maxLat &&
    point.lng >= INDIA_BOUNDS.minLng &&
    point.lng <= INDIA_BOUNDS.maxLng
  );
}

export class OutsideIndiaError extends Error {
  constructor(point: GeoPoint) {
    super(
      `That pin is outside India (latitude ${point.lat.toFixed(4)}, longitude ${point.lng.toFixed(
        4,
      )}). Drag the pin to the crane's location.`,
    );
    this.name = "OutsideIndiaError";
  }
}

/** Great-circle distance in km. Real arithmetic, unlike the stub's road figure. */
export function straightLineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Deterministic pseudo-coordinate for a location string.
 *
 * A hash rather than a constant, so two different crane locations do not
 * collapse onto one pin — which would make the distance-sorted lists of M4 look
 * plausible while being meaningless.
 */
function syntheticPoint(seed: string): GeoPoint {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const lat = INDIA_BOUNDS.minLat + 1 + ((h >>> 8) % 10000) / 10000 * (INDIA_BOUNDS.maxLat - INDIA_BOUNDS.minLat - 2);
  const lng = INDIA_BOUNDS.minLng + 1 + ((h >>> 20) % 10000) / 10000 * (INDIA_BOUNDS.maxLng - INDIA_BOUNDS.minLng - 2);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/**
 * Development and test provider (brief 6.8: "a stub that returns fixed test
 * coordinates and distances").
 *
 * Its road distance is synthetic — the straight line scaled by a detour factor
 * — and is labelled `straight_line` so nothing downstream can mistake it for a
 * routed figure. Brief 6.9 requires that distinction to be visible to the user.
 */
class StubGeoProvider implements GeoProvider {
  readonly name = "stub";
  readonly isAuthoritative = false;

  async geocode(input: {
    location: string;
    state: string;
    pincode?: string | null;
  }): Promise<GeocodeResult> {
    const seed = `${input.state}|${input.pincode ?? ""}|${input.location}`.trim().toLowerCase();
    if (seed.replace(/\|/g, "") === "") {
      return { ok: false, reason: "No location text to geocode" };
    }
    return { ok: true, point: syntheticPoint(seed), provider: this.name };
  }

  async roadDistance(origin: GeoPoint, destination: GeoPoint): Promise<DistanceResult> {
    // Not a routed distance. Reported as straight_line on purpose.
    return {
      ok: true,
      km: Number((straightLineKm(origin, destination) * 1.3).toFixed(2)),
      method: "straight_line",
      provider: this.name,
    };
  }
}

/**
 * Used in production until a provider is chosen. Failing is the safe answer:
 * brief 6.3 says a crane with no coordinates is still saved and flagged
 * "location unverified", and brief 6.8 says distance shows as unavailable.
 */
class UnverifiedGeoProvider implements GeoProvider {
  readonly name = "none";
  readonly isAuthoritative = false;

  async geocode(): Promise<GeocodeResult> {
    return {
      ok: false,
      reason:
        "Automatic location lookup is not available yet. Drop a pin to confirm where this crane is.",
    };
  }

  async roadDistance(): Promise<DistanceResult> {
    return { ok: false, reason: "Distance lookup is not available yet." };
  }
}

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

interface GoogleGeocodeResponse {
  status?: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    address_components?: Array<{
      long_name?: string;
      short_name?: string;
      types?: string[];
    }>;
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
}

interface GoogleRoutesResponse {
  routes?: Array<{ distanceMeters?: number; duration?: string }>;
  error?: { code?: number; message?: string; status?: string };
}

export interface GoogleGeoProviderOptions {
  apiKey: string;
  /** Region bias and country component. Defaults to India. */
  region?: string;
  language?: string;
  timeoutMs?: number;
  /** Test seam. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Google Maps: Geocoding API for addresses, Routes API for road distance.
 *
 * Both calls are bounded by a timeout because an unreachable Google is the same
 * thing as a failed lookup to the caller, and blocking a crane save on a hung
 * socket is not acceptable. The API key is sent in the query string of the
 * Geocoding call (that API's only option) and in the `X-Goog-Api-Key` header of
 * the Routes call; neither is ever put into a reason or a log line.
 */
export class GoogleGeoProvider implements GeoProvider {
  readonly name = "google";
  readonly isAuthoritative = true;

  private readonly apiKey: string;
  private readonly region: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleGeoProviderOptions) {
    const key = options.apiKey?.trim();
    if (!key) {
      throw new Error("GoogleGeoProvider requires an API key");
    }
    this.apiKey = key;
    this.region = options.region ?? "IN";
    this.language = options.language ?? "en";
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async geocode(input: {
    location: string;
    state: string;
    pincode?: string | null;
  }): Promise<GeocodeResult> {
    // The country alone is not an address; without a place there is nothing to
    // look up, and spending a call on it would only return a country centroid.
    if (!input.location || input.location.trim() === "") {
      return { ok: false, reason: "No location text to geocode" };
    }

    // Google is tolerant of a state code, but a full country name anchors the
    // search so "Pune" does not resolve to a Pune outside India.
    const country = this.region === "IN" ? "India" : this.region;
    const address = [input.location, input.pincode, input.state, country]
      .map((part) => (part ?? "").toString().trim())
      .filter(Boolean)
      .join(", ");

    if (!address) {
      return { ok: false, reason: "No location text to geocode" };
    }

    const params = new URLSearchParams({
      address,
      key: this.apiKey,
      language: this.language,
      region: this.region.toLowerCase(),
      components: `country:${this.region.toUpperCase()}`,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${GOOGLE_GEOCODE_URL}?${params.toString()}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Never echo the URL: it carries the key.
      return { ok: false, reason: "Google geocoding could not be reached" };
    }

    if (!response.ok) {
      return { ok: false, reason: `Google geocoding returned HTTP ${response.status}` };
    }

    let body: GoogleGeocodeResponse;
    try {
      body = (await response.json()) as GoogleGeocodeResponse;
    } catch {
      return { ok: false, reason: "Google geocoding returned an unreadable response" };
    }

    if (body.status !== "OK") {
      if (body.status === "ZERO_RESULTS") {
        return { ok: false, reason: "Google could not find that address" };
      }
      // Google's own message says which restriction failed — API not enabled,
      // key restricted to other APIs, referrer used from the server. It never
      // contains the key, and it is the difference between a five-minute fix
      // and a guessing game, so it belongs in the reason.
      const detail = body.error_message?.trim().slice(0, 300);
      return {
        ok: false,
        reason: `Google geocoding failed (${body.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      };
    }

    const location = body.results?.[0]?.geometry?.location;
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, reason: "Google geocoding returned no usable coordinate" };
    }

    return { ok: true, point: { lat, lng }, provider: this.name };
  }

  /**
   * Coordinate → address, using the same Geocoding endpoint with `latlng=`.
   *
   * Only the pieces the crane form asks for are read: the locality for the
   * location text, the state's long and short names, and the postal code. A
   * missing piece is `null` rather than guessed.
   */
  async reverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult> {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      return { ok: false, reason: "Reverse lookup needs a coordinate" };
    }

    const params = new URLSearchParams({
      latlng: `${point.lat},${point.lng}`,
      key: this.apiKey,
      language: this.language,
      region: this.region.toLowerCase(),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${GOOGLE_GEOCODE_URL}?${params.toString()}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Never echo the URL: it carries the key.
      return { ok: false, reason: "Google geocoding could not be reached" };
    }

    if (!response.ok) {
      return { ok: false, reason: `Google geocoding returned HTTP ${response.status}` };
    }

    let body: GoogleGeocodeResponse;
    try {
      body = (await response.json()) as GoogleGeocodeResponse;
    } catch {
      return { ok: false, reason: "Google geocoding returned an unreadable response" };
    }

    if (body.status !== "OK") {
      if (body.status === "ZERO_RESULTS") {
        return { ok: false, reason: "Google could not find that point" };
      }
      const detail = body.error_message?.trim().slice(0, 300);
      return {
        ok: false,
        reason: `Google geocoding failed (${body.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      };
    }

    const components = body.results?.[0]?.address_components ?? [];
    const pick = (...types: string[]) => {
      for (const type of types) {
        const component = components.find((candidate) => candidate.types?.includes(type));
        if (component?.long_name) return component;
      }
      return undefined;
    };

    const state = pick("administrative_area_level_1");
    const locality = pick("locality", "sublocality_level_1", "administrative_area_level_2");
    const postal = pick("postal_code");

    return {
      ok: true,
      provider: this.name,
      address: {
        currentLocation: locality?.long_name?.trim() || null,
        stateName: state?.long_name?.trim() || null,
        stateCode: state?.short_name?.trim() || null,
        pincode: postal?.long_name?.trim() || null,
      },
    };
  }

  async roadDistance(origin: GeoPoint, destination: GeoPoint): Promise<DistanceResult> {
    if (
      !Number.isFinite(origin.lat) ||
      !Number.isFinite(origin.lng) ||
      !Number.isFinite(destination.lat) ||
      !Number.isFinite(destination.lng)
    ) {
      return { ok: false, reason: "Both ends of the route need a coordinate" };
    }

    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: {
        location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
      },
      travelMode: "DRIVE",
      // Crane mobilisation is planned, not live: traffic-aware routing would
      // bill a premium for a number nobody acts on today.
      routingPreference: "TRAFFIC_UNAWARE",
      units: "METRIC",
    };

    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          // computeRoutes refuses the call without an explicit field mask;
          // asking for distance only keeps the response small.
          "X-Goog-FieldMask": "routes.distanceMeters",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: "Google routing could not be reached" };
    }

    if (!response.ok) {
      // Same reasoning as geocoding: Google's error body names the missing
      // enablement or restriction, and reading it costs nothing.
      let detail = "";
      try {
        const failure = (await response.json()) as GoogleRoutesResponse;
        detail = failure.error?.message?.trim().slice(0, 300) ?? "";
      } catch {
        // A non-JSON error body leaves the status as the only fact.
      }
      return {
        ok: false,
        reason: `Google routing returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let parsed: GoogleRoutesResponse;
    try {
      parsed = (await response.json()) as GoogleRoutesResponse;
    } catch {
      return { ok: false, reason: "Google routing returned an unreadable response" };
    }

    const meters = Number(parsed.routes?.[0]?.distanceMeters);
    if (!Number.isFinite(meters) || meters <= 0) {
      return { ok: false, reason: "Google routing found no drivable route" };
    }

    return {
      ok: true,
      km: Number((meters / 1000).toFixed(2)),
      method: "road",
      provider: this.name,
    };
  }
}

function buildGeoProvider(): GeoProvider {
  switch (env.geo.provider) {
    case "google":
      return new GoogleGeoProvider({
        apiKey: env.geo.googleServerApiKey ?? "",
        region: env.geo.googleRegion,
        language: env.geo.googleLanguage,
        timeoutMs: env.geo.googleTimeoutMs,
      });
    case "stub":
      return new StubGeoProvider();
    default:
      return new UnverifiedGeoProvider();
  }
}

let provider: GeoProvider | null = null;

export function getGeoProvider(): GeoProvider {
  if (!provider) {
    provider = buildGeoProvider();
  }
  return provider;
}

/** Test seam: lets a suite pin a provider without touching configuration. */
export function setGeoProvider(next: GeoProvider | null): void {
  provider = next;
}

/**
 * Geocodes, converting an out-of-bounds or failed result into a reason string.
 *
 * Never throws: brief 6.3 requires the crane to be saved even when the lookup
 * fails, so the caller gets `{ok: false}` and stores an unverified crane.
 */
export async function tryGeocode(input: {
  location: string;
  state: string;
  pincode?: string | null;
}): Promise<GeocodeResult> {
  try {
    const result = await getGeoProvider().geocode(input);
    if (result.ok && !isInsideIndia(result.point)) {
      return { ok: false, reason: "The lookup returned a point outside India" };
    }
    return result;
  } catch (err) {
    // A provider outage must not lose the vendor's data entry.
    console.error("[geo] geocode failed", err);
    return { ok: false, reason: "Location lookup failed. Drop a pin to confirm it by hand." };
  }
}

export async function tryRoadDistance(
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<DistanceResult> {
  try {
    const result = await getGeoProvider().roadDistance(origin, destination);
    if (result.ok && !isInsideIndia(destination)) {
      return { ok: false, reason: "Destination is outside India" };
    }
    return result;
  } catch (err) {
    console.error("[geo] road distance failed", err);
    return { ok: false, reason: "Distance lookup failed" };
  }
}

/**
 * Reverse geocodes, never throwing.
 *
 * A provider without the capability (the stub and the disabled provider) gets a
 * clear "not available" reason rather than an invented address. That keeps a
 * development pin from looking like a real street address.
 */
export async function tryReverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult> {
  const geo = getGeoProvider();
  if (!geo.reverseGeocode) {
    return {
      ok: false,
      reason: "Reverse address lookup is not available with the current map provider",
    };
  }
  try {
    const result = await geo.reverseGeocode(point);
    if (result.ok && !isInsideIndia(point)) {
      return { ok: false, reason: "The point is outside India" };
    }
    return result;
  } catch (err) {
    console.error("[geo] reverse geocode failed", err);
    return { ok: false, reason: "Reverse address lookup failed" };
  }
}
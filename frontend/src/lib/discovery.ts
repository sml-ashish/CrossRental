import { api } from "@/lib/api";
import type { CalendarView } from "@/lib/calendar";

/**
 * Client for manual vendor discovery (P4, BPD 6.8 / 5.9).
 *
 * Discovery is a browse across every approved vendor's fleet with no enquiry in
 * view. It never merges SML and vendor sets because there is nothing to merge:
 * every crane here is a vendor crane (open item 2). Distances appear only when a
 * site pin is supplied, and they come from whatever geocoding provider is in use
 * (the stub today, item 13).
 */

export type DiscoveryAvailability = "AVAILABLE" | "ENGAGED" | "UNDER_MAINTENANCE" | "ALL";

export interface DiscoveryFilters {
  craneType?: string;
  capacityT?: string;
  capacityRule?: "AT_LEAST" | "EXACT";
  location?: string;
  region?: string;
  vendorName?: string;
  vendorRegion?: string;
  companySize?: string;
  fleetSizeMin?: string;
  yomFrom?: string;
  yomTo?: string;
  availability?: DiscoveryAvailability;
  /**
   * The hire window, as two `YYYY-MM-DD` days. Sent together or not at all: the
   * backend refuses one date on its own, and a crane has to be free for the
   * whole period, not merely free on the start date.
   */
  availableFrom?: string;
  availableTo?: string;
  siteLat?: number;
  siteLng?: number;
  /** Free-text job site, geocoded by the backend when no pin is supplied. */
  siteLocation?: string;
  sitePincode?: string;
}

export interface DiscoveryCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  vendorCompanySize: string | null;
  vendorFleetSize: number;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  make: string;
  model: string;
  yom: number;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  expectedReadyDate: string | null;
  ownershipType: string;
  serialRegistrationNo: string;
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  distanceKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
}

export interface DiscoveryGroup {
  vendorId: string;
  vendorName: string;
  companySize: string | null;
  fleetSize: number;
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  cranes: DiscoveryCrane[];
}

/**
 * Where a vendor sits on the density map.
 *
 * `source: "state"` means the point is the centre of the vendor's registered
 * state — the map shows where vendors are based, not where their cranes happen
 * to be parked. `source: "fleet"` is the server's fallback for a vendor whose
 * address state is unknown: the centre of its located cranes.
 */
export interface DiscoveryVendorPoint {
  vendorId: string;
  vendorName: string;
  stateCode: string | null;
  stateName: string | null;
  latitude: number;
  longitude: number;
  craneCount: number;
  source: "state" | "fleet";
}

export interface DiscoveryResult {
  distancesAvailable: boolean;
  site: { latitude: number; longitude: number } | null;
  groups: DiscoveryGroup[];
  unverified: DiscoveryCrane[];
  vendorPoints: DiscoveryVendorPoint[];
  totalMatched: number;
}

export interface DiscoveryFacets {
  craneTypes: Array<{ code: string; name: string }>;
  states: Array<{ code: string; name: string }>;
  companySizes: string[];
  availability: DiscoveryAvailability[];
}

export function searchDiscovery(filters: DiscoveryFilters): Promise<DiscoveryResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return api(`/discovery/cranes${query ? `?${query}` : ""}`);
}

export function discoveryFacets(): Promise<DiscoveryFacets> {
  return api("/discovery/facets");
}

/**
 * The calendar tab's range on top of the same discovery filters.
 *
 * The server applies `discoveryWhere` before drawing the grid, so the calendar
 * shows exactly the cranes the list would — the range only decides which days
 * are painted.
 */
export interface DiscoveryCalendarFilters extends DiscoveryFilters {
  /** `YYYY-MM-DD`, inclusive. The server caps the span at 92 days. */
  from: string;
  to: string;
}

export interface DiscoveryCalendarResult {
  calendar: CalendarView;
  totalMatched: number;
}

export function searchDiscoveryCalendar(
  filters: DiscoveryCalendarFilters,
): Promise<DiscoveryCalendarResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      params.set(key, String(value));
    }
  }
  return api(`/discovery/calendar?${params.toString()}`);
}

/* ------------------------------------------------- enquiry recommendations */

/**
 * The two lists the enquiry section can show.
 *
 * `technical` is the snapshot the recommendation engine stored — the list sales
 * actually acted on. `distance` is computed live and is never stored, which is
 * why the response carries no `snapshotId` for it.
 */
export type RecommendationMode = "technical" | "distance";

/**
 * How the recommended list is ordered. `best` is the technical order (smallest
 * adequate capacity first); `nearest` and `farthest` re-order the same cranes by
 * distance from the job site, ascending or descending.
 */
export type DistanceSort = "best" | "nearest" | "farthest";

export const DISTANCE_SORT_OPTIONS: ReadonlyArray<{ value: DistanceSort; label: string }> = [
  { value: "best", label: "Best fit" },
  { value: "nearest", label: "Nearest first" },
  { value: "farthest", label: "Farthest first" },
];

export interface RecommendationParticipation {
  invitations: number;
  quoted: number;
  awarded: number;
  responsivenessPct: number | null;
  winPct: number | null;
}

/** A recommended crane: a candidate plus cost, warnings and its stored pin. */
export interface RecommendationCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  /** True in distance mode for a crane below the line's tonnage. */
  belowRequiredCapacity: boolean;
  make: string;
  model: string;
  yom: number | null;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  loadChartFileName: string | null;
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  ownershipType: string;
  availableInTime: boolean;
  /** The crane's own pin. Null means no route and no marker for it. */
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  lastUpdatedAt: string;
  distanceKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  estimatedMobilisationCost: number | null;
  ratePerKm: number | null;
  boomWarnings: string[];
}

export interface RecommendationGroup {
  vendorId: string;
  vendorName: string;
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  participation: RecommendationParticipation | null;
  cranes: RecommendationCrane[];
}

export interface RecommendationSite {
  siteLocation: string;
  stateCode: string;
  stateName: string;
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
}

export interface LineRecommendations {
  lineId: string;
  /** Null for the live distance list, which is not a stored snapshot. */
  snapshotId: string | null;
  trigger: string;
  evaluatedAt: string;
  provider: string | null;
  site: RecommendationSite;
  distancesAvailable: boolean;
  startDateTbc: boolean;
  capacityRule: string;
  notice: string | null;
  sml: {
    ownership: string;
    cranes: RecommendationCrane[];
    internalCheck: { trailStatus: string; closureStatus: string | null } | null;
  };
  vendor: {
    ownership: string;
    groups: RecommendationGroup[];
    unverified: RecommendationCrane[];
  };
}

export interface SnapshotSummary {
  id: string;
  trigger: string;
  evaluatedAt: string;
  provider: string | null;
  vendorCraneCount: number;
}

export interface LineRecommendationsResponse {
  recommendations: LineRecommendations;
  snapshots: SnapshotSummary[];
  /** True when `ROUTE_POLYLINE` is on and a real path can be requested. */
  routeAvailable: boolean;
}

export function lineRecommendations(
  lineId: string,
  mode: RecommendationMode,
): Promise<LineRecommendationsResponse> {
  return api(`/enquiries/lines/${lineId}/recommendations?mode=${mode}`);
}

/** Re-runs the engine and stores a new snapshot. Technical view only. */
export function refreshLineRecommendations(
  lineId: string,
): Promise<LineRecommendationsResponse> {
  return api(`/enquiries/lines/${lineId}/recommendations/refresh`, { method: "POST" });
}

/**
 * One drivable option from the job site to one crane.
 *
 * The shape is **encoded**: `encodedPolyline` is Google's polyline, decoded in
 * the browser by the Maps JavaScript geometry library. The server never ships
 * a decoded vertex array, and the client never measures anything — `km` and
 * `durationMin` come from the backend.
 */
export interface LineRouteOption {
  /** "r0", "r1", … — stable within one response. */
  id: string;
  /** Google's recommended option. Exactly one carries this. */
  isPrimary: boolean;
  km: number;
  durationMin: number | null;
  /** The road the option is described by, e.g. "NH 48". */
  via: string | null;
  /** Null only on the straight-line fallback. */
  encodedPolyline: string | null;
}

/**
 * A drivable route from the job site to one crane.
 *
 * `routes` is primary first and holds at most three options. On a routing
 * failure the shape is still present, `method` is `"straight_line"` and the one
 * option's `encodedPolyline` is null: the map draws a **dashed, labelled**
 * line, never an unlabelled road.
 */
export interface LineRoute {
  method: "road" | "straight_line";
  approximate: boolean;
  siteLabel: string;
  craneLabel: string;
  /** Where the route ends; used to place a crane that has no stored pin. */
  destination?: { lat: number; lng: number };
  /** Where the route starts (the job site), for a site with no stored pin. */
  origin?: { lat: number; lng: number };
  /** True when the crane's end was worked out from its place name. */
  destinationEstimated?: boolean;
  /** True when the job site's end was worked out from its place name. */
  originEstimated?: boolean;
  /**
   * Why this is a straight line, or null for a real road route:
   * `provider_stub`, `provider_disabled`, `route_polyline_off` or
   * `route_error: <what Google said>`.
   */
  reason?: string | null;
  routes: LineRouteOption[];
}

export function getLineRoute(
  lineId: string,
  craneId: string,
  signal?: AbortSignal,
): Promise<LineRoute> {
  const params = new URLSearchParams({ craneId });
  return api(`/enquiries/lines/${lineId}/route?${params.toString()}`, { signal });
}

/**
 * A crane the map and the card can draw, from either a browse or a
 * recommendation. The recommendation adds cost and warnings to the same shape,
 * so there is a single render path for a crane.
 */
export type DisplayCrane = DiscoveryCrane &
  Partial<
    Pick<
      RecommendationCrane,
      "estimatedMobilisationCost" | "ratePerKm" | "boomWarnings" | "belowRequiredCapacity"
    >
  >;

export function toDisplayCrane(crane: RecommendationCrane): DisplayCrane {
  return {
    ...crane,
    // Browse-only fields. The card and map do not read them, but keeping the
    // object whole means neither has to know where the crane came from.
    vendorCompanySize: null,
    vendorFleetSize: 0,
    expectedReadyDate: null,
    serialRegistrationNo: `${crane.make} ${crane.model}`,
    // The recommendation payload allows a missing year; the browse shape does
    // not. Zero is the card's "not recorded" signal, never a real model year.
    yom: crane.yom ?? 0,
  };
}

export function recommendationCranes(
  recommendations: LineRecommendations | undefined,
): RecommendationCrane[] {
  if (!recommendations) return [];
  return [
    ...recommendations.vendor.groups.flatMap((group) => group.cranes),
    ...recommendations.vendor.unverified,
  ];
}

/**
 * "From" filter: keep the cranes that are located in the place typed — `Pune`,
 * `Pune, Maharashtra`, a state. Each comma-separated part has to appear in the
 * crane's city/state, case-insensitively. Empty text keeps everything.
 *
 * Only the crane's own location is matched (not make, model or vendor), so
 * "Pune" means cranes that are in Pune.
 */
export function cranesLocatedIn<T extends { currentLocation: string; stateName?: string | null }>(
  cranes: T[],
  from: string,
): T[] {
  const parts = from
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return cranes;
  return cranes.filter((crane) => {
    const place = `${crane.currentLocation} ${crane.stateName ?? ""}`.toLowerCase();
    return parts.every((part) => place.includes(part));
  });
}

/**
 * One flat list of cranes in the order the chosen view asks for — no vendor
 * grouping, so the vendor is just a line on each crane's card.
 *
 * - `distance`: nearest first.
 * - `technical`: smallest adequate capacity first, nearest breaking ties.
 *
 * Cranes with no distance (location unverified) always sit last. This only orders
 * rows for display; every figure on a row still comes from the server.
 */
/**
 * Distance view: a 300 t line shows nothing under 250 t. The floor is a sixth
 * below the requirement, so a small line is not asked to take a crane that is
 * half its size.
 */
export function capacityFloorT(requiredT: number | null | undefined): number | null {
  return typeof requiredT === "number" && requiredT > 0 ? Math.floor((requiredT * 5) / 6) : null;
}

export function orderedRecommendationCranes(
  recommendations: LineRecommendations | undefined,
  mode: RecommendationMode,
  requiredT?: number | null,
  sort: DistanceSort = "best",
): RecommendationCrane[] {
  const floor = mode === "distance" ? capacityFloorT(requiredT) : null;
  const km = (crane: RecommendationCrane) =>
    crane.distanceKm !== null && Number.isFinite(crane.distanceKm) && crane.distanceKm > 0
      ? crane.distanceKm
      : Number.POSITIVE_INFINITY;
  const byDistance = (a: RecommendationCrane, b: RecommendationCrane) => {
    const x = km(a);
    const y = km(b);
    if (x === y) return 0;
    return x < y ? -1 : 1;
  };
  return [...recommendationCranes(recommendations)]
    .filter((crane) => floor === null || crane.capacityT >= floor)
    .sort((a, b) => {
    if (sort !== "best") {
      // A crane with no distance sits last whichever way the list runs.
      const x = km(a);
      const y = km(b);
      if (x !== y) {
        if (x === Number.POSITIVE_INFINITY) return 1;
        if (y === Number.POSITIVE_INFINITY) return -1;
        return sort === "nearest" ? x - y : y - x;
      }
      return a.capacityT - b.capacityT || a.vendorName.localeCompare(b.vendorName);
    }
    if (mode === "technical" && a.capacityT !== b.capacityT) return a.capacityT - b.capacityT;
    return byDistance(a, b) || a.vendorName.localeCompare(b.vendorName);
  });
}

/** Extra filters on the recommended list: free in time, and a make/model/vendor search. */
export function filterRecommended<
  T extends { availableInTime: boolean; make: string; model: string; vendorName: string },
>(list: T[], availableOnly: boolean, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return list.filter(
    (crane) =>
      (!availableOnly || crane.availableInTime) &&
      (!needle || `${crane.make} ${crane.model} ${crane.vendorName}`.toLowerCase().includes(needle)),
  );
}

/** The recommendation list opens on the best ten and reveals this many more per click. */
export const RECOMMENDED_PAGE_SIZE = 10;

/** `412 km` — whole kilometres once the number is big enough to stop caring. */
export function formatKm(km: number | null): string {
  if (km === null || !Number.isFinite(km) || km <= 0) return "—";
  const rounded = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
  return `${rounded} km`;
}

/** `9 h 10 min` — a drive time in the unit people actually plan with. */
export function formatDriveTime(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/** `412 km · about 9 h 10 min`, or just the distance when there is no drive time. */
export function formatRouteDistance(
  km: number | null,
  durationMin: number | null,
): string {
  const distance = formatKm(km);
  const drive = formatDriveTime(durationMin);
  return drive ? `${distance} · about ${drive}` : distance;
}

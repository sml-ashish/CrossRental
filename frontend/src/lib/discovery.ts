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

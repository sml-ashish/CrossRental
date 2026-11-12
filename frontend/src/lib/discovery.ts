import { api } from "@/lib/api";

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
  ownershipType?: "SML" | "VENDOR";
  availability?: DiscoveryAvailability;
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

export interface DiscoveryResult {
  distancesAvailable: boolean;
  site: { latitude: number; longitude: number } | null;
  groups: DiscoveryGroup[];
  unverified: DiscoveryCrane[];
  totalMatched: number;
}

export interface DiscoveryFacets {
  craneTypes: Array<{ code: string; name: string }>;
  states: Array<{ code: string; name: string }>;
  companySizes: string[];
  ownershipTypes: Array<"VENDOR" | "SML">;
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

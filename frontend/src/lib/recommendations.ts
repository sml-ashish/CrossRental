import { api } from "@/lib/api";
import type { CandidateCrane } from "@/lib/rfqs";

/**
 * Client for the recommendation engine's endpoints (P2).
 *
 * The engine evaluates a line and **snapshots** the result: the view served
 * later is always the stored list, never a recompute, because crane locations
 * move and sales must see the list they acted on. `refresh` writes a new
 * snapshot; this client never edits one.
 *
 * The SML and vendor sets arrive as two objects and stay two objects. There is
 * no client-side merge helper — merging them is the one thing the hard rule
 * forbids, so it is not offered here either.
 */

export type CoordinateSource = "auto" | "manual" | null;
export type OwnershipType = "SML" | "VENDOR";

/** A candidate crane with its P2 cost and warning detail. */
export interface RecommendedCrane extends CandidateCrane {
  estimatedMobilisationCost: number | null;
  ratePerKm: number | null;
  /** Brief 6.9: boom or jib shorter than the line requires. */
  boomWarnings: string[];
}

/** BPD 6.7 participation, derived only from RFQ participation. */
export interface VendorParticipation {
  invitations: number;
  quoted: number;
  awarded: number;
  responsivenessPct: number | null;
  winPct: number | null;
}

export interface RecommendedGroup {
  vendorId: string;
  vendorName: string;
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  participation: VendorParticipation | null;
  cranes: RecommendedCrane[];
}

export interface RecommendationSite {
  siteLocation: string;
  stateCode: string;
  stateName: string;
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
}

export interface RecommendationResult {
  lineId: string;
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
    ownership: OwnershipType;
    /** SML has no crane fleet; this is always empty. */
    cranes: RecommendedCrane[];
    internalCheck: {
      trailStatus: string;
      selectedSource: string | null;
      closureStatus: string | null;
    } | null;
  };
  vendor: {
    ownership: OwnershipType;
    groups: RecommendedGroup[];
    unverified: RecommendedCrane[];
  };
}

export interface SnapshotSummary {
  id: string;
  trigger: string;
  evaluatedAt: string;
  provider: string | null;
  vendorCraneCount: number;
}

export function getLineRecommendations(
  lineId: string,
): Promise<{ recommendations: RecommendationResult; snapshots: SnapshotSummary[] }> {
  return api(`/enquiries/lines/${lineId}/recommendations`);
}

export function refreshLineRecommendations(
  lineId: string,
): Promise<{ recommendations: RecommendationResult; snapshots: SnapshotSummary[] }> {
  return api(`/enquiries/lines/${lineId}/recommendations/refresh`, {
    method: "POST",
  });
}

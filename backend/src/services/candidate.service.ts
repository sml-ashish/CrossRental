import { prisma } from "../lib/database";
import { distancesTo, type Distance } from "./distance.service";
import { getSettings } from "../utils/settings";
import { CraneStatus, OnboardingStatus } from "../generated/prisma/client";

/**
 * The candidate picker (brief 6.9): which vendor cranes could answer this RFQ,
 * nearest first.
 *
 * **Eligibility is a server-side filter, and it is deliberately not the same
 * filter as "who may receive an RFQ".** Brief 6.9 asks for cranes belonging to
 * approved vendors; brief 6.7 additionally requires the vendor to have an active
 * user before it can be *sent* one. The picker is a search aid and may show a
 * vendor who has since deactivated their only user; `sendRfq` re-checks at send
 * time and refuses. Both rules are enforced, in the right place, rather than one
 * being stretched to cover the other.
 *
 * **Capacity matches as "at least".** The brief says "match the RFQ crane type
 * and capacity" without saying which way round. A 2500 t crawler is a legitimate
 * answer to a 400 t requirement and routinely the only one in the district, so
 * an exact-equality reading would hide real options from the sales user. The
 * rule is a single named constant so the decision is easy to find and reverse.
 */

const CAPACITY_MATCH = "gte" as const;

export interface CandidateCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  make: string;
  model: string;
  yom: number | null;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  loadChartFileName: string | null;
  /** True when the crane is Engaged but free by the required start date. */
  availableInTime: boolean;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  distanceKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
}

export interface CandidateGroup {
  vendorId: string;
  vendorName: string;
  /** Nearest crane first (brief 6.9: "grouped by vendor, nearest crane first"). */
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  cranes: CandidateCrane[];
}

export interface CandidateList {
  site: {
    siteLocation: string;
    stateCode: string;
    stateName: string;
    latitude: number | null;
    longitude: number | null;
    locationUnverified: boolean;
  };
  /** False when the job site has no pin, so no distance can be produced at all. */
  distancesAvailable: boolean;
  located: CandidateGroup[];
  unverified: CandidateCrane[];
  capacityMatch: typeof CAPACITY_MATCH;
  capacityRule: string;
}

const CANDIDATE_SELECT = {
  id: true,
  vendorId: true,
  typeOfCraneCode: true,
  capacityT: true,
  make: true,
  model: true,
  yom: true,
  currentStatus: true,
  currentLocation: true,
  stateCode: true,
  availableFrom: true,
  loadChartFileName: true,
  latitude: true,
  longitude: true,
  statusUpdatedAt: true,
  typeOfCrane: { select: { name: true } },
  state: { select: { name: true } },
  vendor: { select: { id: true, name: true, onboardingStatus: true } },
} as const;

type CandidateRow = {
  id: string;
  vendorId: string;
  typeOfCraneCode: string;
  capacityT: unknown;
  make: string;
  model: string;
  yom: number | null;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  availableFrom: Date | null;
  loadChartFileName: string | null;
  latitude: unknown;
  longitude: unknown;
  statusUpdatedAt: Date;
  typeOfCrane: { name: string };
  state: { name: string };
  vendor: { id: string; name: string; onboardingStatus: string };
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whole days since the crane's status or location last moved (brief 6.5). */
function daysSince(date: Date): number {
  return Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)),
  );
}

/**
 * The RFQ fields the picker reads. Declared structurally rather than as a
 * Prisma payload type so the caller can pass a projection without carrying
 * every column of `rfqs` into this file.
 */
export interface CandidateRfq {
  id: string;
  craneType: string;
  capacityT: unknown;
  requiredStartDate: Date;
  siteLocation: string;
  siteStateCode: string;
  siteLatitude: unknown;
  siteLongitude: unknown;
  site: { name: string };
}

/**
 * Matching cranes for an RFQ, grouped by vendor and ordered by distance.
 *
 * The two buckets are the brief's: cranes with coordinates are ranked, and
 * cranes without are listed separately as "location unverified" rather than
 * being pushed to the bottom of a ranking they cannot participate in. Dropping
 * them would be worse — an unlocated crane is still a crane that can do the job.
 */
export async function candidatesForRfq(
  rfq: CandidateRfq,
): Promise<CandidateList> {
  const settings = await getSettings();
  const required = num(rfq.capacityT) ?? 0;

  const rows = (await prisma.crane.findMany({
    where: {
      isActive: true,
      typeOfCraneCode: rfq.craneType,
      // "At least" the required capacity — see CAPACITY_MATCH above.
      capacityT:
        CAPACITY_MATCH === "gte" ? { gte: required } : { equals: required },
      vendor: { onboardingStatus: OnboardingStatus.APPROVED },
      // Available, or Engaged and free by the time the work starts.
      //
      // Engaged with a null available_from is *excluded*, not admitted. The form
      // requires the date (brief 6.1) and the fleet service refuses to write an
      // Engaged crane without one, so such a row can only be legacy data or a
      // direct database write — but it can exist, and admitting it would offer
      // sales a crane whose release date nobody knows. An RFQ sent on that
      // assumption is an RFQ that collapses after the vendor has already quoted.
      //
      // It is dropped rather than parked in "unverified": that bucket means
      // "location unverified" (brief 6.9), and reusing it for an availability
      // problem would mislabel why the crane is unusable.
      OR: [
        { currentStatus: CraneStatus.AVAILABLE },
        {
          currentStatus: CraneStatus.ENGAGED,
          availableFrom: { lte: rfq.requiredStartDate },
        },
      ],
    },
    select: CANDIDATE_SELECT,
  })) as unknown as CandidateRow[];

  const siteLat = num(rfq.siteLatitude);
  const siteLng = num(rfq.siteLongitude);
  const siteUnverified = siteLat === null || siteLng === null;

  const located: CandidateRow[] = [];
  const unverified: CandidateRow[] = [];
  for (const row of rows) {
    if (num(row.latitude) === null || num(row.longitude) === null)
      unverified.push(row);
    else located.push(row);
  }

  // One destination, many origins; only worth measuring when the site has a pin.
  const measured = new Map<string, Distance | null>();
  if (!siteUnverified) {
    const results = await distancesTo(
      { lat: siteLat as number, lng: siteLng as number },
      located.map((r) => ({
        lat: num(r.latitude) as number,
        lng: num(r.longitude) as number,
      })),
    );
    located.forEach((row, i) => measured.set(row.id, results[i] ?? null));
  }

  const shape = (
    row: CandidateRow,
    distance: Distance | null,
  ): CandidateCrane => {
    const days = daysSince(row.statusUpdatedAt);
    return {
      craneId: row.id,
      vendorId: row.vendorId,
      vendorName: row.vendor.name,
      typeOfCraneCode: row.typeOfCraneCode,
      typeOfCraneName: row.typeOfCrane.name,
      capacityT: num(row.capacityT) ?? 0,
      make: row.make,
      model: row.model,
      yom: row.yom,
      currentStatus: row.currentStatus,
      currentLocation: row.currentLocation,
      stateCode: row.stateCode,
      stateName: row.state.name,
      availableFrom: row.availableFrom ? row.availableFrom.toISOString() : null,
      loadChartFileName: row.loadChartFileName,
      availableInTime:
        row.currentStatus !== CraneStatus.ENGAGED ||
        (row.availableFrom !== null &&
          row.availableFrom.getTime() <= rfq.requiredStartDate.getTime()),
      locationUnverified: false,
      stale: days >= settings.staleFlagDays,
      daysSinceUpdate: days,
      distanceKm: distance?.km ?? null,
      distanceMethod: distance?.method ?? null,
      distanceApproximate: distance?.approximate ?? false,
    };
  };

  const locatedCranes = located.map((row) =>
    shape(row, measured.get(row.id) ?? null),
  );

  // Nulls last: a crane we cannot measure should not outrank one we can.
  locatedCranes.sort((a, b) => {
    if (a.distanceKm === null && b.distanceKm === null)
      return a.capacityT - b.capacityT;
    if (a.distanceKm === null) return 1;
    if (b.distanceKm === null) return -1;
    return a.distanceKm - b.distanceKm;
  });

  const unverifiedCranes: CandidateCrane[] = unverified.map((row) => {
    const days = daysSince(row.statusUpdatedAt);
    return {
      ...shape(row, null),
      locationUnverified: true,
      stale: days >= settings.staleFlagDays,
      daysSinceUpdate: days,
    };
  });

  // Group by vendor, keeping the global distance order inside each group.
  const groups = new Map<string, CandidateGroup>();
  for (const crane of locatedCranes) {
    let group = groups.get(crane.vendorId);
    if (!group) {
      group = {
        vendorId: crane.vendorId,
        vendorName: crane.vendorName,
        nearestKm: null,
        distanceMethod: null,
        distanceApproximate: false,
        cranes: [],
      };
      groups.set(crane.vendorId, group);
    }
    group.cranes.push(crane);
  }
  for (const group of groups.values()) {
    const first = group.cranes[0];
    group.nearestKm = first?.distanceKm ?? null;
    group.distanceMethod = first?.distanceMethod ?? null;
    group.distanceApproximate = first?.distanceApproximate ?? false;
  }

  return {
    site: {
      siteLocation: rfq.siteLocation,
      stateCode: rfq.siteStateCode,
      stateName: rfq.site.name,
      latitude: siteLat,
      longitude: siteLng,
      locationUnverified: siteUnverified,
    },
    distancesAvailable: !siteUnverified,
    located: [...groups.values()].sort((a, b) => {
      if (a.nearestKm === null && b.nearestKm === null)
        return a.vendorName.localeCompare(b.vendorName);
      if (a.nearestKm === null) return 1;
      if (b.nearestKm === null) return -1;
      return a.nearestKm - b.nearestKm;
    }),
    unverified: unverifiedCranes,
    capacityMatch: CAPACITY_MATCH,
    capacityRule: `Cranes of this type with at least ${required} t capacity`,
  };
}

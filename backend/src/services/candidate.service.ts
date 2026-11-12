import { prisma } from "../lib/database";
import { distancesTo, type Distance } from "./distance.service";
import { getSettings } from "../utils/settings";
import { reservationWindowForRfq } from "./reservations.service";
import {
  CapacityRule,
  CraneStatus,
  ReservationStatus,
  OnboardingStatus,
} from "../generated/prisma/client";
import type { DurationUnit, OwnershipType } from "../generated/prisma/client";

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
 * **Capacity matches as "at least" unless the RFQ says otherwise.** The brief
 * says "match the RFQ crane type and capacity" without saying which way round.
 * A 2500 t crawler is a legitimate answer to a 400 t requirement and routinely
 * the only one in the district, so the default is "at least"; brief A3 lets
 * each RFQ choose Exact when the customer genuinely means it, which switches
 * the filter to equality for that enquiry alone.
 */

/**
 * How the picker ranks. `technical` is the brief 6.9 list: crane type *and*
 * capacity match, nearest first. `distance` is the sourcing aid sales asked
 * for: the same crane type at any capacity, nearest first, so a nearby crane
 * that is short on tonnage is still visible.
 */
export type CandidateMode = "technical" | "distance";

export interface CandidateCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  /** True when the crane is lighter than the RFQ asks for (distance mode only). */
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
  /** Brief 6.9 boom warnings (P2): the offered crane's own lengths, in metres. */
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  /** P2: drives the mobilisation rate band lookup. */
  ownershipType: OwnershipType;
  /** True when the crane is Engaged but free by the required start date. */
  availableInTime: boolean;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  /** When the crane's details were last edited, for the picker's freshness line. */
  lastUpdatedAt: string;
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
  /** Which ranking produced this list. */
  mode: CandidateMode;
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
  /** `none` in distance mode: capacity was deliberately not filtered. */
  capacityMatch: "gte" | "equals" | "none";
  capacityRule: string;
  /** Brief C3: true when the RFQ has no fixed start, so date checks were skipped. */
  startDateTbc: boolean;
  /** The notice to show beside the list when dates could not be checked. */
  notice: string | null;
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
  mainBoomM: true,
  fixedJibM: true,
  luffingJibM: true,
  windJibM: true,
  ownershipType: true,
  latitude: true,
  longitude: true,
  statusUpdatedAt: true,
  updatedAt: true,
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
  mainBoomM: unknown;
  fixedJibM: unknown;
  luffingJibM: unknown;
  windJibM: unknown;
  ownershipType: string;
  latitude: unknown;
  longitude: unknown;
  statusUpdatedAt: Date;
  updatedAt: Date;
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
  /** Brief A3: AT_LEAST admits a bigger crane; EXACT only the stated tonnage. */
  capacityRule?: CapacityRule;
  requiredStartDate: Date;
  /** Brief B3: the window whose overlapping reservations disqualify a crane. */
  durationValue: unknown;
  durationUnit: DurationUnit;
  startDateTbc?: boolean;
  workingDaysPerMonth?: number | null;
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
  options: { mode?: CandidateMode } = {},
): Promise<CandidateList> {
  const settings = await getSettings();
  const required = num(rfq.capacityT) ?? 0;
  const tbc = rfq.startDateTbc === true;
  const mode: CandidateMode = options.mode ?? "technical";

  let rows = (await prisma.crane.findMany({
    where: {
      isActive: true,
      typeOfCraneCode: rfq.craneType,
      // "At least" the required capacity unless the RFQ demands an exact match.
      // Distance mode drops the tonnage filter entirely: it answers "what is
      // near the site", and the UI labels each crane that is short on capacity.
      capacityT:
        mode === "distance"
          ? undefined
          : (rfq.capacityRule ?? CapacityRule.AT_LEAST) === CapacityRule.EXACT
            ? { equals: required }
            : { gte: required },
      // P0 B2: a suspended vendor's cranes leave the candidate set entirely.
      vendor: {
        onboardingStatus: OnboardingStatus.APPROVED,
        suspendedAt: null,
      },
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
      //
      // Brief C3: when the start date is TBC there is no date to compare, so
      // the timing filter is skipped (an Engaged crane is admitted however its
      // release date reads) and the list carries a notice saying so.
      OR: [
        { currentStatus: CraneStatus.AVAILABLE },
        tbc
          ? { currentStatus: CraneStatus.ENGAGED }
          : {
              currentStatus: CraneStatus.ENGAGED,
              availableFrom: { lte: rfq.requiredStartDate },
            },
      ],
    },
    select: CANDIDATE_SELECT,
  })) as unknown as CandidateRow[];

  // Brief B3: the booking that disqualifies a crane is an overlapping ACTIVE
  // reservation, not a stored Booked/Hired status. Filtered in one extra query
  // for the whole set rather than per crane. A TBC start date has no window to
  // overlap, so nothing is filtered (brief C3 threads the notice through).
  const window = reservationWindowForRfq(rfq, {
    rateDayBasis: settings.rateDayBasis,
    workingDaysPerMonth: rfq.workingDaysPerMonth,
  });
  if (window && rows.length > 0) {
    const conflicts = await prisma.reservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        craneId: { in: rows.map((r) => r.id) },
        startDate: { lte: window.end },
        endDate: { gte: window.start },
      },
      select: { craneId: true },
    });
    const busy = new Set(conflicts.map((c) => c.craneId));
    rows = rows.filter((row) => !busy.has(row.id));
  }

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
      belowRequiredCapacity: (num(row.capacityT) ?? 0) < required,
      make: row.make,
      model: row.model,
      yom: row.yom,
      currentStatus: row.currentStatus,
      currentLocation: row.currentLocation,
      stateCode: row.stateCode,
      stateName: row.state.name,
      availableFrom: row.availableFrom ? row.availableFrom.toISOString() : null,
      loadChartFileName: row.loadChartFileName,
      mainBoomM: num(row.mainBoomM),
      fixedJibM: num(row.fixedJibM),
      luffingJibM: num(row.luffingJibM),
      windJibM: num(row.windJibM),
      ownershipType: row.ownershipType as OwnershipType,
      availableInTime:
        tbc ||
        row.currentStatus !== CraneStatus.ENGAGED ||
        (row.availableFrom !== null &&
          row.availableFrom.getTime() <= rfq.requiredStartDate.getTime()),
      locationUnverified: false,
      stale: days >= settings.staleFlagDays,
      daysSinceUpdate: days,
      lastUpdatedAt: row.updatedAt.toISOString(),
      distanceKm: distance?.km ?? null,
      distanceMethod: distance?.method ?? null,
      distanceApproximate: distance?.approximate ?? false,
    };
  };

  const locatedCranes = located.map((row) =>
    shape(row, measured.get(row.id) ?? null),
  );

  // Technical answers "which crane can do the lift", so the smallest adequate
  // capacity leads and distance breaks the tie — a 600 t requirement should
  // offer the 800 t crane before a 2500 t one, however far away the big crane
  // is. Distance mode is a proximity question, so it stays nearest-first.
  // Nulls last either way: a crane we cannot measure should not outrank one we
  // can.
  locatedCranes.sort((a, b) => {
    if (mode === "technical" && a.capacityT !== b.capacityT) {
      return a.capacityT - b.capacityT;
    }
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
  // A vendor card's "nearest" figure is its closest crane, not its first one:
  // in technical mode the list leads with capacity, so the first crane is the
  // smallest, not necessarily the nearest.
  for (const group of groups.values()) {
    const nearest = group.cranes.reduce<CandidateCrane | null>(
      (best, crane) =>
        crane.distanceKm !== null &&
        (best === null || (best.distanceKm ?? Infinity) > crane.distanceKm)
          ? crane
          : best,
      null,
    );
    group.nearestKm = nearest?.distanceKm ?? null;
    group.distanceMethod = nearest?.distanceMethod ?? null;
    group.distanceApproximate = nearest?.distanceApproximate ?? false;
  }

  return {
    mode,
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
      // Technical groups follow the crane that leads them — smallest adequate
      // capacity, then its distance. Distance groups follow their nearest one.
      if (mode === "technical") {
        const ac = a.cranes[0];
        const bc = b.cranes[0];
        if ((ac?.capacityT ?? 0) !== (bc?.capacityT ?? 0)) {
          return (ac?.capacityT ?? 0) - (bc?.capacityT ?? 0);
        }
        if (ac?.distanceKm != null && bc?.distanceKm != null) {
          if (ac.distanceKm !== bc.distanceKm) return ac.distanceKm - bc.distanceKm;
        } else if (ac?.distanceKm == null && bc?.distanceKm != null) {
          return 1;
        } else if (ac?.distanceKm != null && bc?.distanceKm == null) {
          return -1;
        }
      }
      if (a.nearestKm === null && b.nearestKm === null)
        return a.vendorName.localeCompare(b.vendorName);
      if (a.nearestKm === null) return 1;
      if (b.nearestKm === null) return -1;
      return a.nearestKm - b.nearestKm;
    }),
    unverified: unverifiedCranes,
    capacityMatch:
      mode === "distance"
        ? "none"
        : (rfq.capacityRule ?? CapacityRule.AT_LEAST) === CapacityRule.EXACT
          ? "equals"
          : "gte",
    capacityRule:
      mode === "distance"
        ? `Cranes of this type at any capacity, nearest first — ${required} t is the requirement, not a filter`
        : (rfq.capacityRule ?? CapacityRule.AT_LEAST) === CapacityRule.EXACT
          ? `Cranes of this type with exactly ${required} t capacity, nearest first`
          : `Cranes of this type with at least ${required} t capacity, smallest adequate first`,
    startDateTbc: tbc,
    notice: tbc
      ? "The start date is to be confirmed, so cranes are not checked against the work dates. Confirm availability with each vendor before committing."
      : null,
  };
}

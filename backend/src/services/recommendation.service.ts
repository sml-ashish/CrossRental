import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { getGeoProvider, tryGeocode } from "../lib/geo";
import { candidatesForRfq, type CandidateCrane } from "./candidate.service";
import {
  estimateMobilisationCost,
  loadRateTable,
  pickRate,
  type RateRow,
} from "./mobilisationCost.service";
import {
  CapacityRule,
  CoordinateSource,
  DurationUnit,
  OwnershipType,
} from "../generated/prisma/client";
import type { Actor } from "./rfq.service";

/**
 * The recommendation engine (BPD 7.1, P2 section 1).
 *
 * **The SML and vendor sets are never merged.** The overview's hard rule is
 * that they stay separate, and here that is enforced by shape rather than by
 * discipline: the result carries a `sml` object and a `vendor` object, and the
 * snapshot stores them in two columns. A mapper cannot accidentally interleave
 * them because there is nowhere for the interleaving to live.
 *
 * **SML has no crane fleet** (open item 2, resolved by the owner). So the SML
 * set is always empty of cranes; what it carries is the line's manual internal
 * check outcome. The section exists rather than being dropped so the two-set
 * contract survives if an SML fleet ever appears.
 *
 * **Every evaluation is snapshotted.** A result is stored at evaluation time
 * and never recomputed in place: crane locations move, and sales must be able
 * to see the list they actually acted on. `refresh` writes another row.
 *
 * **Distances run on the provider interface.** That interface is Google when
 * `GEO_PROVIDER=google` (open item 13, resolved) and the stub otherwise, so the
 * numbers are real road distance or synthetic straight-line depending on
 * configuration. The `provider` on the snapshot records which one produced them,
 * so a synthetic figure is never mistaken for a real one later.
 */

/** A candidate crane with its cost and warning detail added (P2). */
export interface RecommendedCrane extends CandidateCrane {
  estimatedMobilisationCost: number | null;
  ratePerKm: number | null;
  /** Brief 6.9: boom or jib shorter than the line requires. */
  boomWarnings: string[];
}

/** BPD 6.7 participation, derived only from RFQ participation (not performance). */
export interface VendorParticipation {
  invitations: number;
  quoted: number;
  awarded: number;
  /** Quoted as a percentage of invited; null when never invited. */
  responsivenessPct: number | null;
  /** Awarded as a percentage of quoted; null when never quoted. */
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
  /** Null only for a result built before it was persisted. */
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
    /** The manual internal availability check recorded on the line, if any. */
    internalCheck: {
      trailStatus: string;
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
  /** Counts for the history list without reading every snapshot in full. */
  vendorCraneCount: number;
}

interface LineForRecommendation {
  id: string;
  craneTypeCode: string | null;
  capacityT: unknown;
  capacityRule: CapacityRule;
  requiredStartDate: Date | null;
  startDateTbc: boolean;
  durationValue: unknown;
  durationUnit: DurationUnit | null;
  workingDaysPerMonth: number | null;
  requiredMainBoomM: unknown;
  requiredFixedJibM: unknown;
  requiredLuffingJibM: unknown;
  requiredWindJibM: unknown;
  trailStatus: string;
  closureStatus: string | null;
  enquiry: {
    id: string;
    siteLocation: string;
    siteStateCode: string;
    sitePincode: string | null;
    siteLatitude: unknown;
    siteLongitude: unknown;
    siteState: { name: string } | null;
  };
}

const LINE_FOR_RECOMMENDATION = {
  id: true,
  craneTypeCode: true,
  capacityT: true,
  capacityRule: true,
  requiredStartDate: true,
  durationValue: true,
  durationUnit: true,
  workingDaysPerMonth: true,
  requiredMainBoomM: true,
  requiredFixedJibM: true,
  requiredLuffingJibM: true,
  requiredWindJibM: true,
  trailStatus: true,
  closureStatus: true,
  enquiry: {
    select: {
      id: true,
      siteLocation: true,
      siteStateCode: true,
      sitePincode: true,
      siteLatitude: true,
      siteLongitude: true,
      siteState: { select: { name: true } },
    },
  },
} as const;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can run recommendations");
  }
}

/**
 * Pin the job site, storing the result on the enquiry.
 *
 * The pin is geocoded once and reused. A provider failure is not fatal — the
 * brief has cranes saved with an unverified location — so a failed lookup
 * leaves the coordinates null and the distances simply unavailable. The stub
 * always succeeds, and its point is deterministic for a given place.
 */
async function ensureSitePin(line: LineForRecommendation): Promise<{
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
}> {
  const existingLat = num(line.enquiry.siteLatitude);
  const existingLng = num(line.enquiry.siteLongitude);
  if (existingLat !== null && existingLng !== null) {
    return { latitude: existingLat, longitude: existingLng, locationUnverified: false };
  }

  const result = await tryGeocode({
    location: line.enquiry.siteLocation,
    state: line.enquiry.siteStateCode,
    pincode: line.enquiry.sitePincode,
  });

  if (!result.ok) {
    return { latitude: null, longitude: null, locationUnverified: true };
  }

  await prisma.enquiry.update({
    where: { id: line.enquiry.id },
    data: {
      siteLatitude: result.point.lat,
      siteLongitude: result.point.lng,
      siteCoordinateSource:
        getGeoProvider().isAuthoritative ? CoordinateSource.auto : CoordinateSource.manual,
    },
  });

  return { latitude: result.point.lat, longitude: result.point.lng, locationUnverified: false };
}

/** Brief 6.9: name every length on the line the crane cannot reach. */
function boomWarnings(line: LineForRecommendation, crane: CandidateCrane): string[] {
  const checks: Array<{ required: unknown; offered: unknown; label: string }> = [
    { required: line.requiredMainBoomM, offered: crane.mainBoomM, label: "Main boom" },
    { required: line.requiredFixedJibM, offered: crane.fixedJibM, label: "Fixed jib" },
    { required: line.requiredLuffingJibM, offered: crane.luffingJibM, label: "Luffing jib" },
    { required: line.requiredWindJibM, offered: crane.windJibM, label: "Wind jib" },
  ];
  const warnings: string[] = [];
  for (const check of checks) {
    const required = num(check.required);
    const offered = num(check.offered);
    if (required === null || required <= 0) continue;
    if (offered === null) continue;
    if (offered < required) {
      warnings.push(
        `${check.label} ${offered} m is shorter than the ${required} m required`,
      );
    }
  }
  return warnings;
}

/**
 * BPD 6.7 participation for each vendor, from RFQs only (never performance).
 * Exported so the vendor detail screen (P4) reads the same numbers the
 * recommendation engine shows, rather than computing a second version.
 */
export async function participationByVendor(
  vendorIds: string[],
): Promise<Map<string, VendorParticipation>> {
  const map = new Map<string, VendorParticipation>();
  if (vendorIds.length === 0) return map;

  const [recipients, awarded] = await Promise.all([
    prisma.rfqVendorRecipient.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { vendorId: true, responseStatus: true },
    }),
    prisma.quotation.findMany({
      where: { vendorId: { in: vendorIds }, status: "SELECTED" },
      select: { vendorId: true },
    }),
  ]);

  for (const vendorId of vendorIds) {
    map.set(vendorId, {
      invitations: 0,
      quoted: 0,
      awarded: 0,
      responsivenessPct: null,
      winPct: null,
    });
  }
  for (const recipient of recipients) {
    const entry = map.get(recipient.vendorId);
    if (!entry) continue;
    entry.invitations += 1;
    if (recipient.responseStatus === "QUOTED") entry.quoted += 1;
  }
  for (const quotation of awarded) {
    const entry = map.get(quotation.vendorId);
    if (entry) entry.awarded += 1;
  }
  for (const entry of map.values()) {
    entry.responsivenessPct =
      entry.invitations > 0 ? Math.round((entry.quoted / entry.invitations) * 100) : null;
    entry.winPct = entry.quoted > 0 ? Math.round((entry.awarded / entry.quoted) * 100) : null;
  }
  return map;
}

/**
 * Build a recommendation result. Does not persist it — `evaluateAndStore` is
 * the writer, and `refreshRecommendations` calls both.
 */
async function buildRecommendation(
  line: LineForRecommendation,
): Promise<Omit<RecommendationResult, "snapshotId" | "evaluatedAt" | "lineId">> {
  const smlInternalCheck = {
    trailStatus: line.trailStatus,
    closureStatus: line.closureStatus,
  };

  const emptySml = {
    ownership: OwnershipType.SML,
    cranes: [] as RecommendedCrane[],
    internalCheck: smlInternalCheck,
  };

  // Without a type and capacity there is nothing to match. Return an empty
  // vendor set rather than a 400: the workspace shows "needs a type and
  // capacity" from this result, not an error.
  if (!line.craneTypeCode || num(line.capacityT) === null) {
    return {
      trigger: "initial",
      provider: getGeoProvider().name,
      site: {
        siteLocation: line.enquiry.siteLocation,
        stateCode: line.enquiry.siteStateCode,
        stateName: line.enquiry.siteState?.name ?? "",
        latitude: num(line.enquiry.siteLatitude),
        longitude: num(line.enquiry.siteLongitude),
        locationUnverified: num(line.enquiry.siteLatitude) === null,
      },
      distancesAvailable: false,
      startDateTbc: line.requiredStartDate === null,
      capacityRule: "Cranes matching this requirement",
      notice: "This line needs a crane type and capacity before candidates can be matched.",
      sml: emptySml,
      vendor: { ownership: OwnershipType.VENDOR, groups: [], unverified: [] },
    };
  }

  const pin = await ensureSitePin(line);

  const candidates = await candidatesForRfq({
    id: line.id,
    craneType: line.craneTypeCode,
    capacityT: line.capacityT,
    capacityRule: line.capacityRule,
    requiredStartDate: line.requiredStartDate ?? new Date(),
    durationValue: line.durationValue ?? 1,
    durationUnit: line.durationUnit ?? DurationUnit.DAYS,
    startDateTbc: line.requiredStartDate === null,
    workingDaysPerMonth: line.workingDaysPerMonth,
    siteLocation: line.enquiry.siteLocation,
    siteStateCode: line.enquiry.siteStateCode,
    siteLatitude: pin.latitude,
    siteLongitude: pin.longitude,
    site: line.enquiry.siteState ?? { name: "" },
  });

  const rates = await loadRateTable();

  const enrich = (crane: CandidateCrane): RecommendedCrane => {
    const ratePerKm =
      crane.distanceKm === null
        ? null
        : pickRate(rates, {
            craneTypeCode: crane.typeOfCraneCode,
            capacityT: crane.capacityT,
            ownershipType: crane.ownershipType,
          });
    return {
      ...crane,
      ratePerKm,
      estimatedMobilisationCost:
        crane.distanceKm !== null && ratePerKm !== null
          ? estimateMobilisationCost(crane.distanceKm, ratePerKm)
          : null,
      boomWarnings: boomWarnings(line, crane),
    };
  };

  const vendorIds = candidates.located.map((group) => group.vendorId);
  const participation = await participationByVendor(vendorIds);

  const groups: RecommendedGroup[] = candidates.located.map((group) => ({
    vendorId: group.vendorId,
    vendorName: group.vendorName,
    nearestKm: group.nearestKm,
    distanceMethod: group.distanceMethod,
    distanceApproximate: group.distanceApproximate,
    participation: participation.get(group.vendorId) ?? null,
    cranes: group.cranes.map(enrich),
  }));

  return {
    trigger: "initial",
    provider: getGeoProvider().name,
    site: {
      siteLocation: candidates.site.siteLocation,
      stateCode: candidates.site.stateCode,
      stateName: candidates.site.stateName,
      latitude: candidates.site.latitude,
      longitude: candidates.site.longitude,
      locationUnverified: candidates.site.locationUnverified,
    },
    distancesAvailable: candidates.distancesAvailable,
    startDateTbc: candidates.startDateTbc,
    capacityRule: candidates.capacityRule,
    notice: candidates.notice,
    sml: emptySml,
    vendor: {
      ownership: OwnershipType.VENDOR,
      groups,
      unverified: candidates.unverified.map(enrich),
    },
  };
}

function fromSnapshot(row: {
  id: string;
  trigger: string;
  provider: string | null;
  createdAt: Date;
  enquiryLineId: string;
  site: unknown;
  smlSet: unknown;
  vendorSet: unknown;
}): RecommendationResult {
  const vendorSet = row.vendorSet as {
    groups: RecommendedGroup[];
    unverified: RecommendedCrane[];
    distancesAvailable: boolean;
    startDateTbc: boolean;
    capacityRule: string;
    notice: string | null;
  };
  const smlSet = row.smlSet as RecommendationResult["sml"];
  return {
    lineId: row.enquiryLineId,
    snapshotId: row.id,
    trigger: row.trigger,
    evaluatedAt: row.createdAt.toISOString(),
    provider: row.provider,
    site: row.site as RecommendationSite,
    distancesAvailable: vendorSet.distancesAvailable,
    startDateTbc: vendorSet.startDateTbc,
    capacityRule: vendorSet.capacityRule,
    notice: vendorSet.notice,
    sml: smlSet,
    vendor: {
      ownership: OwnershipType.VENDOR,
      groups: vendorSet.groups,
      unverified: vendorSet.unverified,
    },
  };
}

/** The most recent stored snapshot for a line, or null when none exists. */
export async function getLatestRecommendation(
  lineId: string,
): Promise<RecommendationResult | null> {
  const row = await prisma.recommendationSnapshot.findFirst({
    where: { enquiryLineId: lineId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      trigger: true,
      provider: true,
      createdAt: true,
      enquiryLineId: true,
      site: true,
      smlSet: true,
      vendorSet: true,
    },
  });
  return row ? fromSnapshot(row) : null;
}

export async function listSnapshots(lineId: string): Promise<SnapshotSummary[]> {
  const rows = await prisma.recommendationSnapshot.findMany({
    where: { enquiryLineId: lineId },
    orderBy: { createdAt: "desc" },
    select: { id: true, trigger: true, provider: true, createdAt: true, vendorSet: true },
  });
  return rows.map((row) => {
    const vendorSet = row.vendorSet as { groups?: RecommendedGroup[]; unverified?: unknown[] };
    const groupCranes = (vendorSet.groups ?? []).reduce(
      (total, group) => total + group.cranes.length,
      0,
    );
    return {
      id: row.id,
      trigger: row.trigger,
      evaluatedAt: row.createdAt.toISOString(),
      provider: row.provider,
      vendorCraneCount: groupCranes + (vendorSet.unverified?.length ?? 0),
    };
  });
}

/** Run the engine now and store the result as a new snapshot. */
export async function evaluateAndStore(
  lineId: string,
  actor: Actor,
  trigger: "initial" | "refresh",
): Promise<RecommendationResult> {
  assertInternal(actor);
  const line = (await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: LINE_FOR_RECOMMENDATION,
  })) as unknown as LineForRecommendation | null;
  if (!line) throw AppError.notFound("That enquiry line does not exist");

  const built = await buildRecommendation(line);

  const row = await prisma.recommendationSnapshot.create({
    data: {
      enquiryLineId: line.id,
      trigger,
      provider: built.provider,
      site: built.site as unknown as object,
      smlSet: built.sml as unknown as object,
      vendorSet: {
        groups: built.vendor.groups,
        unverified: built.vendor.unverified,
        distancesAvailable: built.distancesAvailable,
        startDateTbc: built.startDateTbc,
        capacityRule: built.capacityRule,
        notice: built.notice,
      } as unknown as object,
      createdById: actor.id,
    },
    select: {
      id: true,
      trigger: true,
      provider: true,
      createdAt: true,
      enquiryLineId: true,
      site: true,
      smlSet: true,
      vendorSet: true,
    },
  });

  return fromSnapshot(row);
}

/** Latest snapshot, or a fresh one on first look. Used by the workspace. */
export async function getOrEvaluateLatest(
  lineId: string,
  actor: Actor,
): Promise<RecommendationResult> {
  assertInternal(actor);
  const latest = await getLatestRecommendation(lineId);
  if (latest) return latest;
  return evaluateAndStore(lineId, actor, "initial");
}

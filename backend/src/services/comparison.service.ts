import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { getSettings, type QuoteRankRule } from "../utils/settings";
import { getLatestRecommendation } from "./recommendation.service";
import type { Actor } from "./rfq.service";

/**
 * Quote comparison (BPD 6.15, P3 section 1).
 *
 * Read-only. It gathers every comparable quotation on an enquiry line — the
 * latest, non-withdrawn version of each — beside the line's requirement and its
 * internal rental budget, and ranks them by total estimated cost. Marking and
 * awarding are separate writes (`markQuotation`, `awardQuotation`); nothing here
 * changes state.
 *
 * This is an internal screen: the rental budget and the vendor names are SML's
 * own view, never the vendor's. Only internal roles may call it.
 */

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can compare quotations");
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface ComparisonQuotation {
  quotationId: string;
  version: number;
  rfqId: string;
  rfqNumber: string;
  vendorId: string;
  vendorName: string | null;
  crane: {
    craneId: string;
    label: string;
    craneTypeName: string;
    capacityT: number | null;
    make: string;
    model: string;
    serialRegistrationNo: string;
    ownershipType: string;
  };
  rentalRate: number;
  rateBasis: string;
  taxBasis: string;
  mobilisationCharges: number;
  demobilisationCharges: number;
  totalEstimatedCost: number;
  distanceToSiteKm: number | null;
  distanceMethod: string | null;
  craneAgeYears: number | null;
  availabilityConfirmed: boolean;
  availableFrom: string | null;
  validityDate: string;
  responseTimeHours: number | null;
  remarks: string | null;
  acceptsCommercialTerms: boolean;
  deviationText: string | null;
  warnings: Array<{ code: string; message: string }>;
  recommendationRank: number | null;
  status: string;
  markReasonCode: string | null;
  markReasonText: string | null;
  markedAt: string | null;
  submittedAt: string;
}

export interface ComparisonResult {
  lineId: string;
  enquiryId: string;
  enquiryNo: string;
  siteLocation: string;
  siteStateName: string | null;
  lineNo: number;
  requirement: {
    craneTypeCode: string | null;
    craneTypeName: string | null;
    capacityT: number | null;
    capacityRule: string;
    quantity: number;
    requiredStartDate: string | null;
    startDateTbc: boolean;
    durationValue: number | null;
    durationUnit: string | null;
    craneAgeCriteriaYears: number | null;
  };
  /** Internal only: the free-text budget note. */
  rentalBudget: string | null;
  /** Internal only: the budget as a number, for a like-for-like comparison. */
  rentalBudgetValue: number | null;
  poSapReference: string | null;
  rankRule: QuoteRankRule;
  quantity: number;
  awardedCount: number;
  fullyAwarded: boolean;
  quotations: ComparisonQuotation[];
}

/**
 * The crane's standing in the newest recommendation snapshot, keyed by crane id
 * (1 = nearest/best). Null when the line has no snapshot or the crane was not in
 * it — a quotation can exist for a crane that never appeared (open item 3).
 */
async function recommendationRankByCrane(
  lineId: string,
): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  const latest = await getLatestRecommendation(lineId);
  if (!latest) return ranks;

  let rank = 0;
  for (const group of latest.vendor.groups) {
    for (const crane of group.cranes) {
      rank += 1;
      ranks.set(crane.craneId, rank);
    }
  }
  for (const crane of latest.vendor.unverified) {
    rank += 1;
    ranks.set(crane.craneId, rank);
  }
  return ranks;
}

export async function compareQuotationsForLine(
  lineId: string,
  actor: Actor,
): Promise<ComparisonResult> {
  assertInternal(actor);

  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      lineNo: true,
      quantity: true,
      craneTypeCode: true,
      craneType: { select: { name: true } },
      capacityT: true,
      capacityRule: true,
      requiredStartDate: true,
      startDateTbc: true,
      durationValue: true,
      durationUnit: true,
      rentalBudget: true,
      rentalBudgetValue: true,
      poSapReference: true,
      craneAgeCriteriaYears: true,
      enquiry: {
        select: {
          id: true,
          enquiryNo: true,
          siteLocation: true,
          siteState: { select: { name: true } },
        },
      },
    },
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");

  const quotes = await prisma.quotation.findMany({
    where: {
      rfq: { enquiryLineId: lineId },
      isLatest: true,
      status: { not: "WITHDRAWN" },
    },
    select: {
      id: true,
      version: true,
      rfqId: true,
      vendorId: true,
      rentalRate: true,
      rateBasis: true,
      taxBasis: true,
      mobilisationCharges: true,
      demobilisationCharges: true,
      totalQuotedValue: true,
      distanceToSiteKm: true,
      distanceMethod: true,
      availabilityConfirmed: true,
      availableFrom: true,
      validityDate: true,
      remarks: true,
      acceptsCommercialTerms: true,
      deviationText: true,
      warnings: true,
      status: true,
      statusReasonCode: true,
      statusReasonText: true,
      statusChangedAt: true,
      submittedAt: true,
      vendor: { select: { name: true } },
      crane: {
        select: {
          id: true,
          serialRegistrationNo: true,
          capacityT: true,
          make: true,
          model: true,
          yom: true,
          ownershipType: true,
          typeOfCrane: { select: { name: true } },
        },
      },
      rfq: { select: { id: true, rfqNumber: true, sentAt: true } },
    },
    orderBy: { submittedAt: "asc" },
  });

  const ranks = await recommendationRankByCrane(lineId);
  const settings = await getSettings();
  const currentYear = new Date().getUTCFullYear();

  const quotations: ComparisonQuotation[] = quotes.map((q) => {
    const craneTypeName = q.crane.typeOfCrane.name;
    const capacityT = num(q.crane.capacityT);
    return {
      quotationId: q.id,
      version: q.version,
      rfqId: q.rfq.id,
      rfqNumber: q.rfq.rfqNumber,
      vendorId: q.vendorId,
      vendorName: q.vendor.name,
      crane: {
        craneId: q.crane.id,
        label: `${craneTypeName} ${capacityT ?? "?"} t — ${q.crane.serialRegistrationNo}`,
        craneTypeName,
        capacityT,
        make: q.crane.make,
        model: q.crane.model,
        serialRegistrationNo: q.crane.serialRegistrationNo,
        ownershipType: q.crane.ownershipType,
      },
      rentalRate: num(q.rentalRate) ?? 0,
      rateBasis: q.rateBasis,
      taxBasis: q.taxBasis,
      mobilisationCharges: num(q.mobilisationCharges) ?? 0,
      demobilisationCharges: num(q.demobilisationCharges) ?? 0,
      totalEstimatedCost: num(q.totalQuotedValue) ?? 0,
      distanceToSiteKm: num(q.distanceToSiteKm),
      distanceMethod: q.distanceMethod,
      craneAgeYears: q.crane.yom ? currentYear - q.crane.yom : null,
      availabilityConfirmed: q.availabilityConfirmed,
      availableFrom: q.availableFrom?.toISOString() ?? null,
      validityDate: q.validityDate.toISOString(),
      responseTimeHours: q.rfq.sentAt
        ? Math.round((q.submittedAt.getTime() - q.rfq.sentAt.getTime()) / 3_600_000)
        : null,
      remarks: q.remarks,
      acceptsCommercialTerms: q.acceptsCommercialTerms,
      deviationText: q.deviationText,
      warnings: (q.warnings ?? []) as Array<{ code: string; message: string }>,
      recommendationRank: ranks.get(q.crane.id) ?? null,
      status: q.status,
      markReasonCode: q.statusReasonCode,
      markReasonText: q.statusReasonText,
      markedAt: q.statusChangedAt?.toISOString() ?? null,
      submittedAt: q.submittedAt.toISOString(),
    };
  });

  // Default rank by total estimated cost ascending (open item 5), with the
  // earliest offer breaking ties so the order is stable and reproducible.
  quotations.sort((a, b) => {
    const delta = a.totalEstimatedCost - b.totalEstimatedCost;
    if (delta !== 0) return delta;
    return a.submittedAt.localeCompare(b.submittedAt);
  });

  const awardedCount = quotes.filter((q) => q.status === "SELECTED").length;

  return {
    lineId: line.id,
    enquiryId: line.enquiry.id,
    enquiryNo: line.enquiry.enquiryNo,
    siteLocation: line.enquiry.siteLocation,
    siteStateName: line.enquiry.siteState?.name ?? null,
    lineNo: line.lineNo,
    requirement: {
      craneTypeCode: line.craneTypeCode,
      craneTypeName: line.craneType?.name ?? null,
      capacityT: num(line.capacityT),
      capacityRule: line.capacityRule,
      quantity: line.quantity,
      requiredStartDate: line.requiredStartDate?.toISOString() ?? null,
      startDateTbc: line.startDateTbc,
      durationValue: num(line.durationValue),
      durationUnit: line.durationUnit,
      craneAgeCriteriaYears: line.craneAgeCriteriaYears,
    },
    rentalBudget: line.rentalBudget,
    rentalBudgetValue: num(line.rentalBudgetValue),
    poSapReference: line.poSapReference,
    rankRule: settings.quoteRankRule,
    quantity: line.quantity,
    awardedCount,
    fullyAwarded: awardedCount >= line.quantity,
    quotations,
  };
}

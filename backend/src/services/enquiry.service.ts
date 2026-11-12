import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { recordAudit } from "./audit.service";
import { nextEnquiryNumber } from "./enquiryNumber.service";
import { evaluateAndStore, getOrEvaluateLatest, listSnapshots } from "./recommendation.service";
import { compareQuotationsForLine } from "./comparison.service";
import { createRfq, type Actor } from "./rfq.service";
import * as trail from "./enquiryTrail.service";
import {
  createEnquirySchema,
  updateEnquirySchema,
  addLineSchema,
  updateLineSchema,
  cancelLineSchema,
  internalCheckSchema,
  rfqFromLineSchema,
  listEnquiriesQuerySchema,
  listRaisableLinesQuerySchema,
  type CreateEnquiryInput,
  type UpdateEnquiryInput,
  type AddLineInput,
  type UpdateLineInput,
  type CancelLineInput,
  type InternalCheckInput,
  type RfqFromLineInput,
  type ListEnquiriesQuery,
  type ListRaisableLinesQuery,
} from "../validation/enquiryFields";
import {
  CapacityRule,
  DurationUnit,
  EnquiryLineTrailStatus,
  EnquiryOverallStatus,
  EnquirySource,
} from "../generated/prisma/client";

/**
 * Native enquiry intake and the line-item sourcing workspace (P1).
 *
 * **One adapter point.** All creation goes through `createEnquiry(payload,
 * source, actor)`. `source` is `manual` today; a future SAP feed calls the same
 * function with its own source and needs no new code path. Nothing here talks
 * to SAP.
 *
 * **The customer block is internal.** `customerName`, `customerAddress` and
 * `rentalBudget` are never copied into an RFQ. `createRfqFromLine` builds the
 * RFQ payload from the vendor-safe subset by construction (it never references
 * those fields), and a test asserts the created RFQ carries none of them.
 *
 * **Status is event driven.** The trail lives in `enquiryTrail.service.ts`;
 * this file calls it at the trigger points and never lets a caller set a status
 * directly.
 */

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can work with enquiries");
  }
}

function auditActor(actor: Actor): AuthedRequest["user"] {
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const ENQUIRY_SELECT = {
  id: true,
  enquiryNo: true,
  enquiryDate: true,
  source: true,
  crOwnerId: true,
  customerName: true,
  customerAddress: true,
  siteLocation: true,
  siteStateCode: true,
  sitePincode: true,
  region: true,
  overallStatus: true,
  createdAt: true,
  updatedAt: true,
  crOwner: { select: { id: true, email: true, fullName: true } },
  siteState: { select: { name: true } },
} as const;

const LINE_SELECT = {
  id: true,
  enquiryId: true,
  lineNo: true,
  craneTypeCode: true,
  capacityT: true,
  capacityRule: true,
  capacityNote: true,
  quantity: true,
  applicationDescription: true,
  loadDescription: true,
  liftLoadT: true,
  workingRadiusM: true,
  requiredMainBoomM: true,
  requiredFixedJibM: true,
  requiredLuffingJibM: true,
  requiredWindJibM: true,
  configurationNotes: true,
  requiredStartDate: true,
  durationValue: true,
  durationUnit: true,
  workingDaysPerMonth: true,
  mobilisationTerms: true,
  demobilisationTerms: true,
  otCharges: true,
  breakdownTerms: true,
  dieselScope: true,
  workingHoursShift: true,
  accommodationConveyance: true,
  paymentTerms: true,
  supportCraneScope: true,
  steelMatsGroundPrepScope: true,
  ehsHrCompliance: true,
  insuranceTerms: true,
  extensionClause: true,
  craneAgeCriteriaYears: true,
  otherTerms: true,
  additionalManpowerScope: true,
  intraSiteMovementScope: true,
  prereleaseTerms: true,
  ppeScope: true,
  rowScope: true,
  rentalBudget: true,
  trailStatus: true,
  selectedSource: true,
  closureStatus: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  craneType: { select: { name: true } },
} as const;

type EnquiryRow = Record<string, unknown>;
type LineRow = Record<string, unknown>;

/** Decimals become numbers for the API; dates stay as dates (serialised by Express). */
export function toLineView(row: LineRow) {
  return {
    ...row,
    capacityT: num(row.capacityT),
    liftLoadT: num(row.liftLoadT),
    workingRadiusM: num(row.workingRadiusM),
    requiredMainBoomM: num(row.requiredMainBoomM),
    requiredFixedJibM: num(row.requiredFixedJibM),
    requiredLuffingJibM: num(row.requiredLuffingJibM),
    requiredWindJibM: num(row.requiredWindJibM),
    durationValue: num(row.durationValue),
    craneTypeName: (row.craneType as { name: string } | null)?.name ?? null,
  };
}

export function toEnquiryView(row: EnquiryRow) {
  return {
    ...row,
    siteStateName: (row.siteState as { name: string } | null)?.name ?? null,
  };
}

async function stateNameOf(code: string): Promise<string> {
  const state = await prisma.state.findUnique({
    where: { code },
    select: { name: true },
  });
  if (!state) throw AppError.badRequest(`"${code}" is not a known state`);
  return state.name;
}

async function assertCraneType(code: string | null): Promise<void> {
  if (!code) return;
  const found = await prisma.craneType.findUnique({
    where: { code },
    select: { code: true },
  });
  if (!found) throw AppError.badRequest(`"${code}" is not a known crane type`);
}

/** The header columns, shared by create and update so they cannot drift. */
function headerData(input: CreateEnquiryInput | UpdateEnquiryInput) {
  return {
    customerName: input.customerName,
    customerAddress: input.customerAddress,
    siteLocation: input.siteLocation,
    siteStateCode: input.siteStateCode,
    sitePincode: input.sitePincode,
    region: input.region,
  };
}

// --- create / update ------------------------------------------------------

/** The adapter point (P1 section 1). Nothing else creates an enquiry. */
export async function createEnquiry(
  raw: unknown,
  actor: Actor,
  source: EnquirySource = EnquirySource.manual,
) {
  assertInternal(actor);
  const input = createEnquirySchema.parse(raw);
  await stateNameOf(input.siteStateCode);
  for (const line of input.lines) await assertCraneType(line.craneTypeCode);

  const crOwnerId = input.crOwnerId ?? actor.id;
  const owner = await prisma.user.findUnique({
    where: { id: crOwnerId },
    select: { role: true },
  });
  if (!owner || owner.role === "vendor_user") {
    throw AppError.badRequest("The enquiry owner must be an SML user");
  }

  const enquiryNo = await nextEnquiryNumber();

  const row = await prisma.enquiry.create({
    data: {
      enquiryNo,
      enquiryDate: input.enquiryDate ?? new Date(),
      source,
      crOwnerId,
      createdById: actor.id,
      ...headerData(input),
      lines: {
        create: input.lines.map((line, index) => ({
          ...line,
          lineNo: index + 1,
        })),
      },
    },
    select: { ...ENQUIRY_SELECT, lines: { select: LINE_SELECT, orderBy: { lineNo: "asc" } } },
  });

  await recordAudit({
    entity: "enquiry",
    entityId: row.id,
    action: "create",
    newValue: { enquiryNo, source, lines: input.lines.length },
    actor: auditActor(actor),
  });

  await trail.recomputeRollup(row.id, actor);
  return toEnquiryDetailView(row as unknown as EnquiryRow);
}

export async function updateEnquiry(enquiryId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: UpdateEnquiryInput = updateEnquirySchema.parse(raw);

  const existing = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { id: true, siteStateCode: true },
  });
  if (!existing) throw AppError.notFound("That enquiry does not exist");
  await stateNameOf(input.siteStateCode);

  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: headerData(input),
  });

  await recordAudit({
    entity: "enquiry",
    entityId: enquiryId,
    action: "update",
    oldValue: { siteStateCode: existing.siteStateCode },
    newValue: { siteStateCode: input.siteStateCode },
    actor: auditActor(actor),
  });

  return getEnquiryDetail(enquiryId, actor);
}

// --- reads ----------------------------------------------------------------

function stageCountsOf(lines: LineRow[]) {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const status = String(line.trailStatus);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return {
    total: lines.length,
    byStage: counts,
    pendingSourcing:
      lines.filter(
        (l) =>
          l.trailStatus === EnquiryLineTrailStatus.NEW ||
          l.trailStatus === EnquiryLineTrailStatus.AVAILABILITY_CHECK ||
          l.trailStatus === EnquiryLineTrailStatus.VENDOR_SHORTLISTED,
      ).length,
    rfqSent:
      (counts[EnquiryLineTrailStatus.RFQ_SENT] ?? 0) +
      (counts[EnquiryLineTrailStatus.AWAITING_QUOTES] ?? 0),
    quotesReceived:
      (counts[EnquiryLineTrailStatus.QUOTES_RECEIVED] ?? 0) +
      (counts[EnquiryLineTrailStatus.UNDER_EVALUATION] ?? 0),
    finalised:
      (counts[EnquiryLineTrailStatus.VENDOR_FINALISED] ?? 0) +
      (counts[EnquiryLineTrailStatus.BOOKED] ?? 0) +
      (counts[EnquiryLineTrailStatus.FULFILLED_INTERNALLY] ?? 0),
    closed:
      (counts[EnquiryLineTrailStatus.CLOSED] ?? 0) +
      (counts[EnquiryLineTrailStatus.CANCELLED] ?? 0),
  };
}

function toEnquiryDetailView(row: EnquiryRow) {
  const lines = ((row.lines as LineRow[] | undefined) ?? []);
  return {
    ...toEnquiryView(row),
    lines: lines.map((line) => toLineView(line)),
    summary: stageCountsOf(lines),
  };
}

export async function listEnquiries(rawQuery: unknown, actor: Actor) {
  assertInternal(actor);
  const query: ListEnquiriesQuery = listEnquiriesQuerySchema.parse(rawQuery ?? {});

  const rows = await prisma.enquiry.findMany({
    where: {
      ...(query.status ? { overallStatus: query.status } : {}),
      ...(query.region ? { region: query.region } : {}),
      ...(query.stateCode ? { siteStateCode: query.stateCode } : {}),
      ...(query.from || query.to
        ? {
            enquiryDate: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { enquiryNo: { contains: query.search, mode: "insensitive" as const } },
              { customerName: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: {
      ...ENQUIRY_SELECT,
      lines: { select: { trailStatus: true } },
    },
    orderBy: [{ enquiryDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const lines = (row.lines ?? []) as LineRow[];
    return {
      ...toEnquiryView(row as unknown as EnquiryRow),
      lineCount: lines.length,
      summary: stageCountsOf(lines),
    };
  });
}

/**
 * The lines an RFQ can still be raised against.
 *
 * The RFQ creation screen is line-driven, so it needs a list of lines rather
 * than a free-form enquiry/line pair. A line is raisable when it still has a
 * crane type and capacity (otherwise `createRfqFromLine` refuses it) and has not
 * been cancelled or fulfilled internally. The customer block is deliberately not
 * selected: this list is only used to choose a line, and there is no reason to
 * carry the customer's name into a second screen.
 */
export async function listRaisableLines(rawQuery: unknown, actor: Actor) {
  assertInternal(actor);
  const query: ListRaisableLinesQuery = listRaisableLinesQuerySchema.parse(
    rawQuery ?? {},
  );

  const rows = await prisma.enquiryLineItem.findMany({
    where: {
      cancelledAt: null,
      trailStatus: {
        in: [
          EnquiryLineTrailStatus.NEW,
          EnquiryLineTrailStatus.AVAILABILITY_CHECK,
          EnquiryLineTrailStatus.VENDOR_SHORTLISTED,
          EnquiryLineTrailStatus.RFQ_SENT,
          EnquiryLineTrailStatus.AWAITING_QUOTES,
          EnquiryLineTrailStatus.QUOTES_RECEIVED,
          EnquiryLineTrailStatus.UNDER_EVALUATION,
        ],
      },
      craneTypeCode: { not: null },
      capacityT: { not: null },
      ...(query.search
        ? {
            OR: [
              {
                enquiry: {
                  enquiryNo: { contains: query.search, mode: "insensitive" as const },
                },
              },
              {
                craneType: {
                  name: { contains: query.search, mode: "insensitive" as const },
                },
              },
              { craneTypeCode: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      enquiryId: true,
      lineNo: true,
      craneTypeCode: true,
      capacityT: true,
      capacityRule: true,
      quantity: true,
      requiredStartDate: true,
      trailStatus: true,
      craneType: { select: { name: true } },
      enquiry: {
        select: {
          enquiryNo: true,
          siteLocation: true,
          sitePincode: true,
          siteState: { select: { name: true } },
        },
      },
      _count: { select: { rfqs: true } },
    },
    orderBy: [{ createdAt: "desc" }, { lineNo: "asc" }],
    take: 200,
  });

  return rows.map((row) => ({
    id: row.id,
    enquiryId: row.enquiryId,
    enquiryNo: row.enquiry.enquiryNo,
    lineNo: row.lineNo,
    craneTypeCode: row.craneTypeCode,
    craneTypeName: row.craneType?.name ?? null,
    capacityT: num(row.capacityT),
    capacityRule: row.capacityRule,
    quantity: row.quantity,
    requiredStartDate: row.requiredStartDate,
    startDateTbc: row.requiredStartDate === null,
    siteLocation: row.enquiry.siteLocation,
    siteStateName: row.enquiry.siteState?.name ?? null,
    sitePincode: row.enquiry.sitePincode,
    trailStatus: row.trailStatus,
    rfqCount: row._count.rfqs,
  }));
}

export async function getEnquiryDetail(enquiryId: string, actor: Actor) {
  assertInternal(actor);
  const row = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: {
      ...ENQUIRY_SELECT,
      lines: { select: LINE_SELECT, orderBy: { lineNo: "asc" } },
    },
  });
  if (!row) throw AppError.notFound("That enquiry does not exist");
  return toEnquiryDetailView(row as unknown as EnquiryRow);
}

// --- lines ----------------------------------------------------------------

async function loadLine(lineId: string): Promise<{
  id: string;
  enquiryId: string;
  lineNo: number;
  craneTypeCode: string | null;
  capacityT: unknown;
  capacityRule: CapacityRule;
  trailStatus: EnquiryLineTrailStatus;
}> {
  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      enquiryId: true,
      lineNo: true,
      craneTypeCode: true,
      capacityT: true,
      capacityRule: true,
      trailStatus: true,
    },
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");
  return line;
}

export async function addLine(enquiryId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: AddLineInput = addLineSchema.parse(raw);
  await assertCraneType(input.craneTypeCode);

  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { id: true },
  });
  if (!enquiry) throw AppError.notFound("That enquiry does not exist");

  const last = await prisma.enquiryLineItem.findFirst({
    where: { enquiryId },
    orderBy: { lineNo: "desc" },
    select: { lineNo: true },
  });

  const row = await prisma.enquiryLineItem.create({
    data: { ...input, enquiryId, lineNo: (last?.lineNo ?? 0) + 1 },
    select: LINE_SELECT,
  });

  await recordAudit({
    entity: "enquiry_line",
    entityId: row.id,
    action: "create",
    newValue: { enquiryId, lineNo: row.lineNo },
    actor: auditActor(actor),
  });
  await trail.recomputeRollup(enquiryId, actor);
  return toLineView(row as unknown as LineRow);
}

export async function updateLine(lineId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: UpdateLineInput = updateLineSchema.parse(raw);
  await loadLine(lineId);
  await assertCraneType(input.craneTypeCode);

  const row = await prisma.enquiryLineItem.update({
    where: { id: lineId },
    data: { ...input },
    select: LINE_SELECT,
  });

  await recordAudit({
    entity: "enquiry_line",
    entityId: lineId,
    action: "update",
    actor: auditActor(actor),
  });
  return toLineView(row as unknown as LineRow);
}

export async function cancelLine(lineId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: CancelLineInput = cancelLineSchema.parse(raw);
  const line = await loadLine(lineId);

  await prisma.enquiryLineItem.update({
    where: { id: lineId },
    data: { cancelledAt: new Date(), cancelReason: input.reason },
  });
  await trail.onCancelledLine(lineId, actor, input.reason);
  return toLineView(
    (await prisma.enquiryLineItem.findUnique({ where: { id: lineId }, select: LINE_SELECT })) as LineRow,
  );
}

/**
 * The manual internal availability check (P1 section 5). There is no SML fleet
 * in this platform, so this records the CR team's manual outcome rather than a
 * machine match: either internal means can meet the requirement (the line is
 * Fulfilled internally) or they cannot.
 */
export async function recordInternalCheck(lineId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: InternalCheckInput = internalCheckSchema.parse(raw);
  await loadLine(lineId);

  if (input.outcome === "FULFILLED_INTERNALLY") {
    await trail.onFulfilledInternally(lineId, actor, input.notes);
  } else {
    await trail.onAvailabilityCheck(lineId, actor);
    await recordAudit({
      entity: "enquiry_line",
      entityId: lineId,
      action: "internal_check_unavailable",
      newValue: { notes: input.notes },
      actor: auditActor(actor),
    });
  }

  return toLineView(
    (await prisma.enquiryLineItem.findUnique({ where: { id: lineId }, select: LINE_SELECT })) as LineRow,
  );
}

export async function markUnderEvaluation(lineId: string, actor: Actor) {
  assertInternal(actor);
  await loadLine(lineId);
  await trail.onUnderEvaluation(lineId, actor);
  return toLineView(
    (await prisma.enquiryLineItem.findUnique({ where: { id: lineId }, select: LINE_SELECT })) as LineRow,
  );
}

// --- RFQ from a line ------------------------------------------------------

/** The largest jib the line requires, since the RFQ carries one jib length. */
function requiredJib(line: {
  requiredLuffingJibM: unknown;
  requiredFixedJibM: unknown;
  requiredWindJibM: unknown;
}): number | null {
  const candidates = [
    num(line.requiredLuffingJibM),
    num(line.requiredFixedJibM),
    num(line.requiredWindJibM),
  ].filter((v): v is number => v !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Raise an RFQ from an enquiry line (P1 section 2).
 *
 * Prefills from the line and the enquiry header's **vendor-safe subset**: the
 * customer name/address and the rental budget are never read here, so they
 * cannot leak into the RFQ. The RFQ is a snapshot; later edits to the line do
 * not rewrite it.
 */
export async function createRfqFromLine(lineId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: RfqFromLineInput = rfqFromLineSchema.parse(raw);

  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: {
      ...LINE_SELECT,
      enquiry: {
        select: {
          enquiryNo: true,
          siteLocation: true,
          siteStateCode: true,
          sitePincode: true,
        },
      },
    },
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");
  if (!line.craneTypeCode || num(line.capacityT) === null) {
    throw AppError.badRequest(
      "This line needs a crane type and capacity before an RFQ can be raised from it",
    );
  }

  const jib = requiredJib(line);

  const rfq = await createRfq(
    {
      enquiryLineId: line.id,
      craneType: line.craneTypeCode,
      capacityT: num(line.capacityT),
      capacityRule: line.capacityRule,
      capacityNote: line.capacityNote,
      quantity: line.quantity,
      applicationDescription: line.applicationDescription,
      loadDescription: line.loadDescription,
      mainBoomM: num(line.requiredMainBoomM) ?? undefined,
      jibLengthM: jib ?? undefined,
      // A line without a start date means "to be confirmed"; the template's
      // free-text TBC is represented by the absence of a date.
      startDateTbc: line.requiredStartDate === null,
      workingDaysPerMonth: line.workingDaysPerMonth ?? undefined,
      siteLocation: line.enquiry.siteLocation,
      siteStateCode: line.enquiry.siteStateCode,
      sitePincode: line.enquiry.sitePincode,
      requiredStartDate: line.requiredStartDate ?? new Date(),
      durationValue: num(line.durationValue) ?? 1,
      durationUnit: line.durationUnit ?? DurationUnit.DAYS,
      configuration: line.configurationNotes,
      submissionDeadline: input.submissionDeadline,
      otCharges: line.otCharges,
      breakdownTerms: line.breakdownTerms,
      dieselScope: line.dieselScope,
      workingHoursShift: line.workingHoursShift,
      craneAgeCriteriaYears: line.craneAgeCriteriaYears,
      accommodationConveyance: line.accommodationConveyance,
      paymentTerms: line.paymentTerms,
      mobilisationTerms: line.mobilisationTerms,
      supportCrane: line.supportCraneScope,
      steelMatsGroundPrep: line.steelMatsGroundPrepScope,
      ehsHrRequirements: line.ehsHrCompliance,
      insuranceTerms: line.insuranceTerms,
      extensionClause: line.extensionClause,
      notes: line.otherTerms,
      commercialTermsExtra: {
        demobilisationTerms: line.demobilisationTerms ?? null,
        additionalManpowerScope: line.additionalManpowerScope ?? null,
        intraSiteMovementScope: line.intraSiteMovementScope ?? null,
        prereleaseTerms: line.prereleaseTerms ?? null,
        ppeScope: line.ppeScope ?? null,
        rowScope: line.rowScope ?? null,
      },
    },
    actor,
  );

  // A line with an RFQ is no longer merely shortlisted; the dispatch trigger
  // moves it to RFQ Sent. Reaching the create step moves it to Shortlisted.
  await trail.onVendorShortlisted(lineId, actor);

  return rfq;
}

// --- one line --------------------------------------------------------------

/**
 * One line item on its own. The line editor needs it to prefill the form;
 * nothing else about the line's sourcing history is returned here.
 */
export async function getLine(lineId: string, actor: Actor) {
  assertInternal(actor);
  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: LINE_SELECT,
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");
  return { line: toLineView(line as unknown as LineRow) };
}

export type { CreateEnquiryInput };

// --- recommendations (P2) -------------------------------------------------

/** The latest recommendations plus the snapshot history. */
export async function getLineRecommendations(lineId: string, actor: Actor) {
  assertInternal(actor);
  const recommendations = await getOrEvaluateLatest(lineId, actor);
  const snapshots = await listSnapshots(lineId);
  return { recommendations, snapshots };
}

/** Re-run the engine and keep the earlier snapshots. */
export async function refreshLineRecommendations(lineId: string, actor: Actor) {
  assertInternal(actor);
  const recommendations = await evaluateAndStore(lineId, actor, "refresh");
  const snapshots = await listSnapshots(lineId);
  return { recommendations, snapshots };
}

// --- comparison (P3) ------------------------------------------------------

/** The line's comparable quotations, ranked (BPD 6.15). */
export function getLineComparison(lineId: string, actor: Actor) {
  return compareQuotationsForLine(lineId, actor);
}


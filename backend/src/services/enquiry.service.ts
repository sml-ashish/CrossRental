import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { CoordinateSource } from "../generated/prisma/client";
import { tryGeocode, getGeoProvider } from "../lib/geo";
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
} from "../generated/prisma/client";

/**
 * Native enquiry intake and the line-item sourcing workspace (P1).
 *
 * **One adapter point.** All creation goes through `createEnquiry(payload,
 * actor)`. The single-crane form, the bulk upload and any future caller share
 * it, so numbering, audit and the status trail cannot drift. Nothing here talks
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
  customerName: true,
  customerAddress: true,
  siteLocation: true,
  siteStateCode: true,
  sitePincode: true,
  region: true,
  overallStatus: true,
  // The job site's pin, resolved once through the geocoding seam. The list
  // screen draws it as a small map, so it has to survive the view mapping.
  siteLatitude: true,
  siteLongitude: true,
  siteCoordinateSource: true,
  createdAt: true,
  updatedAt: true,
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
  closureStatus: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  craneType: { select: { name: true } },
} as const;

/**
 * The detail view's line, plus the RFQs raised from it.
 *
 * The enquiry screen's right-hand panel has to answer "what is the next action
 * on this line", which means knowing whether an RFQ exists and how many quotes
 * came back. Counting them here keeps the panel to one request instead of one
 * per line.
 */
const DETAIL_LINE_SELECT = {
  ...LINE_SELECT,
  rfqs: {
    select: {
      id: true,
      rfqNumber: true,
      _count: { select: { quotations: true } },
    },
    orderBy: { createdAt: "desc" },
  },
} as const;

/**
 * Rows come back as Prisma results with a handful of relations attached; the
 * views below copy them through and normalise decimals. `enquiryNo` is named
 * explicitly because the bulk import reports it back per created row.
 */
type EnquiryRow = Record<string, unknown> & { enquiryNo?: string };
type LineRow = Record<string, unknown>;

/** Decimals become numbers for the API; dates stay as dates (serialised by Express). */
export function toLineView(row: LineRow) {
  // `rfqs` is only selected on the detail screen. It is folded into two facts
  // (the latest RFQ, how many quotes are in) rather than passed through, so the
  // line payload stays the same shape everywhere it is used.
  const { rfqs, ...line } = row;
  const rfqList =
    (rfqs as
      | Array<{ id: string; rfqNumber: string; _count?: { quotations?: number } }>
      | undefined) ?? [];
  const latest = rfqList[0] ?? null;

  return {
    ...line,
    capacityT: num(row.capacityT),
    liftLoadT: num(row.liftLoadT),
    workingRadiusM: num(row.workingRadiusM),
    requiredMainBoomM: num(row.requiredMainBoomM),
    requiredFixedJibM: num(row.requiredFixedJibM),
    requiredLuffingJibM: num(row.requiredLuffingJibM),
    requiredWindJibM: num(row.requiredWindJibM),
    durationValue: num(row.durationValue),
    craneTypeName: (row.craneType as { name: string } | null)?.name ?? null,
    rfqId: latest?.id ?? null,
    rfqNumber: latest?.rfqNumber ?? null,
    quoteCount: rfqList.reduce((sum, rfq) => sum + (rfq._count?.quotations ?? 0), 0),
  };
}

export function toEnquiryView(row: EnquiryRow) {
  return {
    ...row,
    siteStateName: (row.siteState as { name: string } | null)?.name ?? null,
    siteLatitude: num(row.siteLatitude),
    siteLongitude: num(row.siteLongitude),
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

/**
 * Pin the job site at intake.
 *
 * The enquiry screen draws the site on a small map before anyone raises an RFQ,
 * so the pin cannot wait for the recommendation run that used to be the only
 * thing that geocoded it. This is the same provider seam the RFQ and crane
 * paths use, and the same rule applies: a failed lookup leaves the coordinates
 * empty rather than blocking the enquiry. The panel then says the pin is
 * missing instead of showing a fabricated one.
 */
async function sitePin(input: {
  siteLocation: string;
  siteStateCode: string;
  sitePincode: string | null;
}): Promise<{
  siteLatitude: number | null;
  siteLongitude: number | null;
  siteCoordinateSource: CoordinateSource | null;
}> {
  const result = await tryGeocode({
    location: input.siteLocation,
    state: await stateNameOf(input.siteStateCode),
    pincode: input.sitePincode,
  });

  if (!result.ok) {
    return { siteLatitude: null, siteLongitude: null, siteCoordinateSource: null };
  }

  // "auto" means a provider produced the point; the stub invents its
  // coordinates, so those are labelled manual rather than passed off as real.
  return {
    siteLatitude: result.point.lat,
    siteLongitude: result.point.lng,
    siteCoordinateSource: getGeoProvider().isAuthoritative
      ? CoordinateSource.auto
      : CoordinateSource.manual,
  };
}

// --- create / update ------------------------------------------------------

/** The adapter point (P1 section 1). Nothing else creates an enquiry. */
export async function createEnquiry(raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input = createEnquirySchema.parse(raw);
  await stateNameOf(input.siteStateCode);
  for (const line of input.lines) await assertCraneType(line.craneTypeCode);

  const enquiryNo = await nextEnquiryNumber();

  const row = await prisma.enquiry.create({
    data: {
      enquiryNo,
      enquiryDate: input.enquiryDate ?? new Date(),
      createdById: actor.id,
      ...headerData(input),
      ...(await sitePin(input)),
      lines: {
        create: input.lines.map((line, index) => ({
          ...line,
          lineNo: index + 1,
        })),
      },
    },
    select: {
      ...ENQUIRY_SELECT,
      lines: { select: DETAIL_LINE_SELECT, orderBy: { lineNo: "asc" } },
    },
  });

  await recordAudit({
    entity: "enquiry",
    entityId: row.id,
    action: "create",
    newValue: { enquiryNo, lines: input.lines.length },
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
    select: {
      id: true,
      siteStateCode: true,
      siteLocation: true,
      sitePincode: true,
    },
  });
  if (!existing) throw AppError.notFound("That enquiry does not exist");
  await stateNameOf(input.siteStateCode);

  // Moving the site moves the pin. A saved address that no longer matches its
  // coordinates is worse than no pin: the map would confidently point at the
  // previous job.
  const siteChanged =
    existing.siteLocation !== input.siteLocation ||
    existing.siteStateCode !== input.siteStateCode ||
    existing.sitePincode !== input.sitePincode;

  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: {
      ...headerData(input),
      ...(siteChanged ? await sitePin(input) : {}),
    },
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

/**
 * A line as the list screen needs it: how many cranes, where it is in the trail,
 * and whether any RFQ or quote exists. Kept narrow on purpose — the list must
 * not drag every template field of every line across the wire.
 */
const LIST_LINE_SELECT = {
  quantity: true,
  trailStatus: true,
  requiredStartDate: true,
  cancelledAt: true,
  applicationDescription: true,
  rfqs: {
    select: { id: true, _count: { select: { quotations: true } } },
  },
} as const;

interface ListLineRow {
  quantity: number;
  trailStatus: EnquiryLineTrailStatus;
  requiredStartDate: Date | string | null;
  cancelledAt: Date | null;
  applicationDescription: string | null;
  rfqs: Array<{ id: string; _count?: { quotations?: number } }>;
}

/** A line is sourced once a vendor is chosen for it. */
const SOURCED_TRAIL_STATUSES: EnquiryLineTrailStatus[] = [
  EnquiryLineTrailStatus.VENDOR_FINALISED,
  EnquiryLineTrailStatus.BOOKED,
  EnquiryLineTrailStatus.FULFILLED_INTERNALLY,
];

/**
 * Progress is measured in cranes, not lines: a line for three cranes is three
 * cranes to find, and a two-line enquiry with one three-crane line awarded is
 * further along than a two-line enquiry with one single-crane line awarded.
 */
function metricsOf(lines: ListLineRow[]) {
  const live = lines.filter((line) => !line.cancelledAt);
  const craneCount = live.reduce((sum, line) => sum + line.quantity, 0);
  const sourcedCranes = live
    .filter((line) => SOURCED_TRAIL_STATUSES.includes(line.trailStatus))
    .reduce((sum, line) => sum + line.quantity, 0);
  const rfqCount = live.reduce((sum, line) => sum + line.rfqs.length, 0);
  const quoteCount = live.reduce(
    (sum, line) =>
      sum + line.rfqs.reduce((n, rfq) => n + (rfq._count?.quotations ?? 0), 0),
    0,
  );
  const upcoming = live
    .filter(
      (line) =>
        !SOURCED_TRAIL_STATUSES.includes(line.trailStatus) && line.requiredStartDate,
    )
    .map((line) => new Date(line.requiredStartDate as string).getTime())
    .filter((value) => Number.isFinite(value));

  const sourcedLines = live.filter((line) => SOURCED_TRAIL_STATUSES.includes(line.trailStatus));

  return {
    lineCount: lines.length,
    craneCount,
    sourcedCranes,
    // A segment per line is drawn from this, so it has to be lines, not cranes.
    sourcedLineCount: sourcedLines.length,
    sourcedPercent: craneCount === 0 ? 0 : Math.round((sourcedCranes / craneCount) * 100),
    rfqCount,
    quoteCount,
    nextUnsourcedStart: upcoming.length ? new Date(Math.min(...upcoming)) : null,
  };
}

/** The four KPI buckets, plus closed. Mutually exclusive, checked in this order. */
export type EnquiryBucket = "pending" | "awaiting" | "quotes" | "finalised" | "closed";

function bucketOf(
  status: EnquiryOverallStatus,
  metrics: ReturnType<typeof metricsOf>,
  lines: ListLineRow[],
): EnquiryBucket {
  if (status === EnquiryOverallStatus.CLOSED) return "closed";
  const live = lines.filter((line) => !line.cancelledAt);
  if (live.length > 0 && live.every((line) => SOURCED_TRAIL_STATUSES.includes(line.trailStatus))) {
    return "finalised";
  }
  if (metrics.quoteCount > 0) return "quotes";
  if (metrics.rfqCount > 0) return "awaiting";
  return "pending";
}

function stageCountsOf(lines: Array<{ trailStatus: unknown }>) {
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
    summary: stageCountsOf(lines as Array<{ trailStatus: unknown }>),
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
              // "Project" is the line's application description; the enquiry
              // itself has no project column, so a search has to reach the line.
              { siteLocation: { contains: query.search, mode: "insensitive" as const } },
              {
                lines: {
                  some: {
                    applicationDescription: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                },
              },
            ],
          }
        : {}),
    },
    select: {
      ...ENQUIRY_SELECT,
      lines: { select: LIST_LINE_SELECT, orderBy: { lineNo: "asc" } },
    },
    orderBy: [{ enquiryDate: "desc" }, { createdAt: "desc" }],
  });

  const mapped = rows.map((row) => {
    const lines = (row.lines ?? []) as ListLineRow[];
    const metrics = metricsOf(lines);
    return {
      ...toEnquiryView(row as unknown as EnquiryRow),
      ...metrics,
      bucket: bucketOf(row.overallStatus, metrics, lines),
      // The card's second line. The enquiry has no project field, so the first
      // line's application description stands in for it — it is what the work
      // is, and it is already written by whoever raised the enquiry.
      project:
        lines.find((line) => !line.cancelledAt && line.applicationDescription)
          ?.applicationDescription ?? null,
      summary: stageCountsOf(lines),
    };
  });

  // "Soonest start" and "least progress" are orderings over computed values, so
  // they are applied after the read rather than pushed into the query.
  if (query.sort === "startDate") {
    mapped.sort((a, b) => {
      const left = a.nextUnsourcedStart?.getTime() ?? Number.POSITIVE_INFINITY;
      const right = b.nextUnsourcedStart?.getTime() ?? Number.POSITIVE_INFINITY;
      return left - right;
    });
  } else if (query.sort === "progress") {
    mapped.sort((a, b) => a.sourcedPercent - b.sourcedPercent);
  }

  return mapped;
}

/**
 * The enquiry screen's KPI cards.
 *
 * Computed over every enquiry the caller may see, not over the filtered list —
 * a KPI that changes when a filter is applied is a filter, not a KPI. The
 * buckets are mutually exclusive (see `bucketOf`), so they add up.
 */
export async function enquirySummary(actor: Actor) {
  assertInternal(actor);

  const rows = await prisma.enquiry.findMany({
    select: {
      overallStatus: true,
      enquiryDate: true,
      lines: { select: LIST_LINE_SELECT },
    },
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const counts = {
    total: rows.length,
    active: 0,
    pendingSourcing: 0,
    awaitingQuotes: 0,
    quotesIn: 0,
    finalised: 0,
    closed: 0,
    raisedToday: 0,
    /** The KPI card's delta: how many of each bucket arrived today. */
    raisedTodayByBucket: {
      pending: 0,
      awaiting: 0,
      quotes: 0,
      finalised: 0,
      closed: 0,
    } as Record<EnquiryBucket, number>,
  };

  for (const row of rows) {
    const lines = (row.lines ?? []) as ListLineRow[];
    const bucket = bucketOf(row.overallStatus, metricsOf(lines), lines);
    if (bucket === "closed") counts.closed += 1;
    else counts.active += 1;
    if (bucket === "pending") counts.pendingSourcing += 1;
    if (bucket === "awaiting") counts.awaitingQuotes += 1;
    if (bucket === "quotes") counts.quotesIn += 1;
    if (bucket === "finalised") counts.finalised += 1;
    if (new Date(row.enquiryDate) >= startOfToday) {
      counts.raisedToday += 1;
      counts.raisedTodayByBucket[bucket] += 1;
    }
  }

  return counts;
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
      lines: { select: DETAIL_LINE_SELECT, orderBy: { lineNo: "asc" } },
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


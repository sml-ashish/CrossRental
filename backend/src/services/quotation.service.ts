import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { recordAudit } from "./audit.service";
import { distanceBetween } from "./distance.service";
import { sendTemplate } from "./email.service";
import {
  submitQuotationSchema,
  reviseQuotationSchema,
  withdrawQuotationSchema,
  declineRfqSchema,
  vendorInboxQuerySchema,
  calculateTotal,
  type SubmitQuotationInput,
  type ReviseQuotationInput,
  type VendorInboxQuery,
} from "../validation/quotationFields";
import {
  startOfUtcDay,
  todayUtcMidnight,
  toCalendarDateString,
} from "../lib/dates";
import {
  AttachmentKind,
  CraneStatus,
  DistanceMethod,
  QuotationStatus,
  RateBasis,
  ResponseStatus,
  RfqRollupStatus,
  RfqStatus,
} from "../generated/prisma/client";
import { storage } from "../lib/storage";
import type { ValidatedUpload } from "../middleware/upload";

/**
 * Vendor RFQ inbox and quotation submission (brief 7.6–7.8, with the rules of 6.7).
 *
 * **This is a different surface from M4's internal RFQ service.** That file owns
 * the `Rfq` and refuses every vendor. This one owns the vendor's relationship to
 * an RFQ, which is their own `RfqVendorRecipient` row. A vendor is never handed
 * an `Rfq` by id: every read resolves through their recipient row, so an RFQ
 * they were not sent does not exist as far as this service is concerned — not as
 * a 403 they could read into an existence answer.
 *
 * **Brief 6.7 splits rules into blocks and warnings, and this file keeps that
 * split exactly.** Blocks (crane ownership, status, rate, validity, deadline)
 * throw. Warnings (wrong type, too old, frees up late) are computed, stored on
 * the quotation and shown to both sides. Making a warning a block would stop a
 * vendor offering their best alternative crane, which is precisely what they do
 * when their nearest machine is out on another job.
 *
 * **Revisions never overwrite.** Each revision is a new version row and the old
 * one stays, because "the latest counts" is a statement about which row sales
 * should compare, not a licence to delete what the vendor said last Tuesday.
 */
export interface Actor {
  id: string;
  email: string;
  role: AuthedRequest["user"]["role"];
  vendorId: string | null;
}

function auditActor(actor: Actor): AuthedRequest["user"] {
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];
}

/**
 * A vendor needs a vendor record before they can hold a recipient row or a crane.
 * A vendor account without one is a provisioning fault, and failing open here
 * would put one vendor's RFQs in front of another.
 */
function requireVendorId(actor: Actor): string {
  if (!actor.vendorId) {
    throw AppError.forbidden("Your account is not linked to a vendor");
  }
  return actor.vendorId;
}

/**
 * Internal users may read quotations for support, but only a vendor's own may
 * change them. Internal access to this file at all is for the award service,
 * which arrives with M7.
 */
function assertVendor(actor: Actor): void {
  if (actor.role !== "vendor_user") {
    throw AppError.forbidden("Only a vendor can answer an RFQ");
  }
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

const RECIPIENT_SELECT = {
  id: true,
  vendorId: true,
  responseStatus: true,
  declineReason: true,
  declineNote: true,
  respondedAt: true,
  firstViewedAt: true,
  reminderCount: true,
  emails: true,
  rfq: {
    select: {
      id: true,
      rfqNumber: true,
      enquiryNo: true,
      lineNo: true,
      craneType: true,
      capacityT: true,
      quantity: true,
      siteLocation: true,
      siteStateCode: true,
      sitePincode: true,
      siteLatitude: true,
      siteLongitude: true,
      requiredStartDate: true,
      durationValue: true,
      durationUnit: true,
      configuration: true,
      otCharges: true,
      breakdownTerms: true,
      dieselScope: true,
      workingHoursShift: true,
      craneAgeCriteriaYears: true,
      accommodationConveyance: true,
      paymentTerms: true,
      notes: true,
      commercialTermsExtra: true,
      smlContactName: true,
      smlContactMobile: true,
      smlContactEmail: true,
      submissionDeadline: true,
      status: true,
      createdAt: true,
      siteState: { select: { name: true } },
      craneTypeRef: { select: { name: true } },
    },
  },
} satisfies Prisma.RfqVendorRecipientSelect;

type RecipientRow = Prisma.RfqVendorRecipientGetPayload<{
  select: typeof RECIPIENT_SELECT;
}>;

type LiveQuotationRow = {
  id: string;
  rfqId: string;
  version: number;
  totalQuotedValue: Prisma.Decimal;
  status: QuotationStatus;
  submittedAt: Date;
};

/**
 * This vendor's live (latest, not withdrawn) quotations for the given RFQs,
 * keyed by RFQ id.
 *
 * Fetched separately rather than through the recipient: quotations hang off the
 * RFQ and the vendor, and `RfqVendorRecipient` deliberately has no quotations
 * relation. Every query still filters on the token's `vendorId`.
 */
async function liveQuotationsByRfq(
  rfqIds: string[],
  vendorId: string,
): Promise<Map<string, LiveQuotationRow[]>> {
  const grouped = new Map<string, LiveQuotationRow[]>();
  if (rfqIds.length === 0) return grouped;

  const quotations = await prisma.quotation.findMany({
    where: {
      rfqId: { in: rfqIds },
      vendorId,
      isLatest: true,
      status: { not: QuotationStatus.WITHDRAWN },
    },
    select: {
      id: true,
      rfqId: true,
      version: true,
      totalQuotedValue: true,
      status: true,
      submittedAt: true,
    },
    // Newest submission first, because the inbox reports one figure as "your
    // quote" for an RFQ. Version order only means anything inside a single
    // crane's series: two cranes quoted once each are both version 1, so ordering
    // by version left which total the vendor saw up to the database.
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
  });

  for (const quotation of quotations) {
    const rows = grouped.get(quotation.rfqId) ?? [];
    rows.push(quotation);
    grouped.set(quotation.rfqId, rows);
  }
  return grouped;
}

/**
 * Loads the caller's own recipient row for an RFQ.
 *
 * The vendor id comes from the token and is part of the where clause, so a
 * guessed RFQ id cannot reach another vendor's recipient — there is no query to
 * filter afterwards and therefore nothing to forget.
 *
 * A cancelled RFQ is still readable: the vendor needs to see why it stopped, and
 * an empty inbox entry would be a worse answer than an explanation.
 */
async function loadRecipient(
  rfqId: string,
  actor: Actor,
): Promise<RecipientRow> {
  const vendorId = requireVendorId(actor);
  const recipient = await prisma.rfqVendorRecipient.findFirst({
    where: { rfqId, vendorId },
    select: RECIPIENT_SELECT,
  });
  // Deliberately 404 rather than 403 for an RFQ this vendor was never sent.
  if (!recipient) throw AppError.notFound("That RFQ was not sent to you");

  return recipient;
}

/**
 * A cancelled RFQ is readable but dead: the vendor must see the reason, and no
 * action can be taken on it even if the deadline has not passed yet.
 */
function assertNotCancelled(recipient: RecipientRow): void {
  if (recipient.rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict(
      "SML cancelled this RFQ, so it can no longer be quoted. Contact SML if that looks wrong.",
    );
  }
}

/**
 * After the deadline the RFQ is read-only (brief 6.7).
 *
 * The lock is on the RFQ's own `submissionDeadline`, not on any receipt status,
 * so an internal user extending the deadline genuinely reopens the RFQ for
 * everyone still Pending — which is the point of extending it.
 */
function assertBeforeDeadline(recipient: RecipientRow, now = new Date()): void {
  if (recipient.rfq.submissionDeadline.getTime() <= now.getTime()) {
    throw AppError.conflict(
      "The deadline for this RFQ has passed, so quotations can no longer be submitted or changed.",
    );
  }
}

/** A cancelled, declined or expired RFQ cannot be acted on. */
function assertActionable(recipient: RecipientRow): void {
  assertNotCancelled(recipient);
  if (recipient.responseStatus === ResponseStatus.DECLINED) {
    throw AppError.conflict("You have declined this RFQ.");
  }
  if (recipient.responseStatus === ResponseStatus.EXPIRED) {
    throw AppError.conflict(
      "This RFQ expired before you responded. Ask SML to extend the deadline.",
    );
  }
}

// ---------------------------------------------------------------------------
// Crane eligibility and warnings
// ---------------------------------------------------------------------------

const CRANE_SELECT = {
  id: true,
  serialRegistrationNo: true,
  typeOfCraneCode: true,
  capacityT: true,
  yom: true,
  make: true,
  model: true,
  currentStatus: true,
  currentLocation: true,
  stateCode: true,
  latitude: true,
  longitude: true,
  availableFrom: true,
  isActive: true,
  loadChartFileRef: true,
  loadChartFileName: true,
  typeOfCrane: { select: { name: true } },
  state: { select: { name: true } },
} satisfies Prisma.CraneSelect;

type QuotingCrane = Prisma.CraneGetPayload<{ select: typeof CRANE_SELECT }>;

/**
 * Loads a crane and checks it is the vendor's to quote.
 *
 * Ownership is part of the where clause, not a comparison afterwards: a vendor
 * who posts another vendor's crane id gets the same 404 as a nonexistent one, so
 * the endpoint cannot be used to discover that a particular crane exists.
 */
async function loadQuotingCrane(
  craneId: string,
  actor: Actor,
): Promise<QuotingCrane> {
  const vendorId = requireVendorId(actor);
  const crane = await prisma.crane.findFirst({
    where: { id: craneId, vendorId },
    select: CRANE_SELECT,
  });
  if (!crane) throw AppError.notFound("That crane is not in your fleet");
  return crane;
}

/**
 * The statuses that cannot be quoted (brief 6.7).
 *
 * Under Maintenance is a vendor's own statement that the crane is not working.
 * Booked and Hired are SML's, so the crane is already committed elsewhere and
 * quoting it would put two jobs on one machine.
 */
function assertCraneQuotable(crane: QuotingCrane): void {
  if (!crane.isActive) {
    throw AppError.badRequest("That crane is deactivated");
  }
  if (crane.currentStatus === CraneStatus.UNDER_MAINTENANCE) {
    throw AppError.badRequest(
      "That crane is under maintenance and cannot be quoted",
    );
  }
  if (
    crane.currentStatus === CraneStatus.BOOKED ||
    crane.currentStatus === CraneStatus.HIRED
  ) {
    throw AppError.badRequest(
      "That crane is committed to SML on another contract and cannot be quoted",
    );
  }
}

/**
 * Advisories for sales, stored not thrown (brief 6.7).
 *
 * Each one is a mismatch between the crane and the requirement that the vendor
 * may be answering deliberately:
 *
 * - a different crane type or a smaller capacity is usually the vendor offering
 *   a substitute, which is a legitimate and useful answer;
 * - a YOM outside the customer's age criteria is a commercial decision, not a
 *   data error — the customer's own criteria are sometimes negotiable;
 * - an Engaged crane whose release date falls after the required start means the
 *   work cannot begin on time, which sales must see even though the vendor is
 *   within their rights to offer it.
 *
 * Returns codes plus a sentence for each, so the stored `warnings` column is
 * machine-readable for the M7 comparison screen and human-readable in the email.
 */
export function computeWarnings(
  rfq: RecipientRow["rfq"],
  crane: QuotingCrane,
): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];

  if (crane.typeOfCraneCode !== rfq.craneType) {
    warnings.push({
      code: "crane_type_differs",
      message:
        `Crane type is ${crane.typeOfCrane.name}, but the requirement is ` +
        `${rfq.craneTypeRef.name}.`,
    });
  }

  // "Differs from the requirement" (brief 6.7), not merely "is smaller": a
  // 100 t crane offered against a 60 t requirement is still a difference sales
  // should see before they promise that machine to the customer. Kept separate
  // from the type warning so the UI can say which of the two moved.
  if (Number(crane.capacityT) !== Number(rfq.capacityT)) {
    warnings.push({
      code:
        Number(crane.capacityT) < Number(rfq.capacityT)
          ? "capacity_below_requirement"
          : "capacity_above_requirement",
      message:
        Number(crane.capacityT) < Number(rfq.capacityT)
          ? `Crane capacity is ${crane.capacityT} t, below the ${rfq.capacityT} t required.`
          : `Crane capacity is ${crane.capacityT} t, against the ${rfq.capacityT} t required.`,
    });
  }

  if (
    rfq.craneAgeCriteriaYears !== null &&
    crane.yom !== null &&
    new Date().getUTCFullYear() - crane.yom > rfq.craneAgeCriteriaYears
  ) {
    warnings.push({
      code: "yom_outside_criteria",
      message:
        `Crane is ${new Date().getUTCFullYear() - crane.yom} years old, ` +
        `outside the customer's criterion of ${rfq.craneAgeCriteriaYears} years or newer.`,
    });
  }

  if (
    crane.currentStatus === CraneStatus.ENGAGED &&
    crane.availableFrom !== null &&
    crane.availableFrom.getTime() > rfq.requiredStartDate.getTime()
  ) {
    warnings.push({
      code: "available_after_required_start",
      message: `This crane becomes available on ${crane.availableFrom
        .toISOString()
        .slice(0, 10)}, after the required start date of ${rfq.requiredStartDate
        .toISOString()
        .slice(0, 10)}.`,
    });
  }

  return warnings;
}

/**
 * The load-chart rule (brief 6.7): a load chart must exist on the crane or be
 * attached to the quotation.
 *
 * Three ways to satisfy it, in the order a vendor would try them: the file
 * already on the crane record, a file uploaded with this submission, or one
 * already attached to this crane's earlier version of this RFQ — a revision is
 * the same crane on the same job, so making the vendor re-upload the same chart
 * would be pure friction. The message names the missing thing, because "load
 * chart required" tells a vendor nothing about what to do next.
 */
function assertLoadChart(
  crane: QuotingCrane,
  attachedToSeries: boolean,
  file: ValidatedUpload | null,
): void {
  if (crane.loadChartFileRef || crane.loadChartFileName) return;
  if (attachedToSeries || file !== null) return;
  throw AppError.badRequest(
    "Upload a load chart for this crane, or attach one to this quotation, before quoting",
  );
}

/**
 * Whether this crane's series already carries a load chart.
 *
 * Used to let a revision rely on the chart submitted with version 1.
 */
async function seriesHasLoadChart(
  rfqId: string,
  vendorId: string,
  craneId: string,
): Promise<boolean> {
  const existing = await prisma.quotation.findFirst({
    where: {
      rfqId,
      vendorId,
      craneId,
      attachments: { some: { kind: AttachmentKind.LOAD_CHART } },
    },
    select: { id: true },
  });
  return existing !== null;
}

// ---------------------------------------------------------------------------
// Total and warnings preview
// ---------------------------------------------------------------------------

/**
 * The figures a vendor sees before submitting (brief 6.7: "the vendor sees the
 * total before submitting").
 *
 * This is a read: it prices a hypothetical quotation so the form can show the
 * total and the warnings without the vendor having to submit to find out. It
 * touches no rows, and it deliberately does not email anyone.
 */
export async function previewQuotation(
  rfqId: string,
  raw: unknown,
  actor: Actor,
) {
  assertVendor(actor);
  const recipient = await loadRecipient(rfqId, actor);
  const input: SubmitQuotationInput = submitQuotationSchema.parse(raw);
  const crane = await loadQuotingCrane(input.craneId, actor);
  assertCraneQuotable(crane);

  const { rentalCharge, total, note } = calculateTotal({
    rentalRate: input.rentalRate,
    rateBasis: input.rateBasis,
    durationValue: Number(recipient.rfq.durationValue),
    durationUnit: recipient.rfq.durationUnit,
    mobilisationCharges: input.mobilisationCharges,
  });

  const distance = await distanceToSite(recipient.rfq, crane);

  // The same guards the submit path runs, reported instead of thrown: a preview
  // that quietly adds up numbers for an RFQ the vendor can no longer act on
  // reads as an invitation the API will then refuse.
  let blockedReason: string | null = null;
  try {
    assertActionable(recipient);
    assertBeforeDeadline(recipient);
    assertCraneQuotable(crane);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    blockedReason = error.message;
  }

  return {
    preview: {
      rentalCharge,
      mobilisationCharges: input.mobilisationCharges,
      totalQuotedValue: total,
      calculationNote: note,
      warnings: computeWarnings(recipient.rfq, crane),
      loadChartOnFile: Boolean(
        crane.loadChartFileRef || crane.loadChartFileName,
      ),
      // Submission still needs a load chart on the file or attached to the
      // quotation, and preview has no attachment yet.
      loadChartSatisfied: Boolean(
        crane.loadChartFileRef || crane.loadChartFileName,
      ),
      distanceKm: distance?.km ?? null,
      distanceMethod: distance?.method ?? null,
      distanceApproximate: distance?.approximate ?? false,
      canSubmit: blockedReason === null,
      blockedReason,
    },
  };
}

// ---------------------------------------------------------------------------
// Distance and crane snapshot
// ---------------------------------------------------------------------------

/**
 * Distance from the crane to the job site, for storage on the quotation.
 *
 * Stored, never recalculated on read, because the number in the comparison
 * screen has to be the one the vendor was shown when they quoted. Returns null
 * when either end has no pin — the same honest "unavailable" the picker uses,
 * rather than a straight-line figure presented as though it were road distance.
 */
async function distanceToSite(rfq: RecipientRow["rfq"], crane: QuotingCrane) {
  if (
    rfq.siteLatitude === null ||
    rfq.siteLongitude === null ||
    crane.latitude === null ||
    crane.longitude === null
  ) {
    return null;
  }
  return distanceBetween(
    { lat: Number(crane.latitude), lng: Number(crane.longitude) },
    { lat: Number(rfq.siteLatitude), lng: Number(rfq.siteLongitude) },
  );
}

/** Crane state at the moment of quoting, so history can show what was offered. */
function craneSnapshot(crane: QuotingCrane) {
  return {
    craneId: crane.id,
    serialRegistrationNo: crane.serialRegistrationNo,
    typeOfCraneCode: crane.typeOfCraneCode,
    typeOfCraneName: crane.typeOfCrane.name,
    capacityT: Number(crane.capacityT),
    make: crane.make,
    model: crane.model,
    yom: crane.yom,
    currentStatus: crane.currentStatus,
    currentLocation: crane.currentLocation,
    stateCode: crane.stateCode,
    stateName: crane.state.name,
    latitude: crane.latitude === null ? null : Number(crane.latitude),
    longitude: crane.longitude === null ? null : Number(crane.longitude),
  } as const;
}

function craneLabel(crane: QuotingCrane): string {
  return `${crane.typeOfCrane.name} ${crane.capacityT} t — ${crane.serialRegistrationNo}`;
}

// ---------------------------------------------------------------------------
// Inbox (brief 7.6)
// ---------------------------------------------------------------------------

/**
 * The vendor's RFQ list.
 *
 * Reads recipient rows for the caller's vendor only, in deadline order, soonest
 * first, because that is the date the vendor is working against.
 *
 * An already-overdue RFQ therefore sorts to the top, because its date is the
 * earliest. It is not hidden and not deprioritised here: whether a row can still
 * be acted on is reported per row as `overdue` and `canRespond`, and the screen
 * decides how to present a closed one. Overstating the sort as "most actionable
 * first" would be a rule this query does not actually implement.
 */
export async function listVendorRfqs(rawQuery: unknown, actor: Actor) {
  assertVendor(actor);
  const vendorId = requireVendorId(actor);
  const query: VendorInboxQuery = vendorInboxQuerySchema.parse(rawQuery ?? {});

  const recipients = await prisma.rfqVendorRecipient.findMany({
    where: {
      vendorId,
      ...(query.responseStatus
        ? { responseStatus: query.responseStatus as ResponseStatus }
        : {}),
      ...(query.search
        ? {
            rfq: {
              OR: [
                { rfqNumber: { contains: query.search, mode: "insensitive" } },
                { enquiryNo: { contains: query.search, mode: "insensitive" } },
                {
                  siteLocation: { contains: query.search, mode: "insensitive" },
                },
              ],
            },
          }
        : {}),
    },
    select: RECIPIENT_SELECT,
    orderBy: { rfq: { submissionDeadline: "asc" } },
  });

  const liveByRfq = await liveQuotationsByRfq(
    recipients.map((recipient) => recipient.rfq.id),
    vendorId,
  );

  const now = Date.now();
  return {
    rfqs: recipients.map((recipient) => {
      const live = (liveByRfq.get(recipient.rfq.id) ?? []).filter(
        (q) =>
          q.status === QuotationStatus.SUBMITTED ||
          q.status === QuotationStatus.UNDER_REVIEW ||
          q.status === QuotationStatus.SHORTLISTED,
      );
      return {
        recipientId: recipient.id,
        rfqId: recipient.rfq.id,
        rfqNumber: recipient.rfq.rfqNumber,
        craneType: recipient.rfq.craneType,
        craneTypeName: recipient.rfq.craneTypeRef.name,
        capacityT: Number(recipient.rfq.capacityT),
        quantity: recipient.rfq.quantity,
        siteLocation: recipient.rfq.siteLocation,
        siteStateCode: recipient.rfq.siteStateCode,
        siteStateName: recipient.rfq.siteState.name,
        requiredStartDate: recipient.rfq.requiredStartDate.toISOString(),
        durationValue: Number(recipient.rfq.durationValue),
        durationUnit: recipient.rfq.durationUnit,
        submissionDeadline: recipient.rfq.submissionDeadline.toISOString(),
        responseStatus: recipient.responseStatus,
        respondedAt: recipient.respondedAt?.toISOString() ?? null,
        firstViewedAt: recipient.firstViewedAt?.toISOString() ?? null,
        reminderCount: recipient.reminderCount,
        unread: recipient.firstViewedAt === null,
        overdue: recipient.rfq.submissionDeadline.getTime() < now,
        // Whether the vendor may still act, so the UI does not offer a button the
        // backend will refuse.
        canRespond:
          recipient.rfq.submissionDeadline.getTime() > now &&
          recipient.responseStatus === ResponseStatus.PENDING,
        quotationCount: live.length,
        latestQuotationTotal: live[0] ? Number(live[0].totalQuotedValue) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Vendor RFQ detail (brief 7.7)
// ---------------------------------------------------------------------------

/**
 * One RFQ as the vendor sees it, with their own quotations and every version.
 *
 * Opening it records `first_viewed_at` (brief 6.7), which is what the internal
 * tracking screen shows and what makes the unread indicator meaningful. That
 * write happens on the read path deliberately: the alternative is a separate
 * "mark read" call the client could forget.
 *
 * Another vendor's quotations are not merely hidden by the response shape —
 * they were never loaded, because the recipient row is resolved by token first.
 */
const QUOTATION_SELECT = {
  id: true,
  craneId: true,
  version: true,
  isLatest: true,
  rentalRate: true,
  rateBasis: true,
  mobilisationCharges: true,
  totalQuotedValue: true,
  calculationNote: true,
  availabilityConfirmed: true,
  availableFrom: true,
  validityDate: true,
  acceptsCommercialTerms: true,
  deviationText: true,
  remarks: true,
  warnings: true,
  submittedAt: true,
  status: true,
  distanceToSiteKm: true,
  distanceMethod: true,
  craneLocationSnapshot: true,
  attachments: { select: { id: true, kind: true, fileName: true } },
  crane: {
    select: {
      id: true,
      serialRegistrationNo: true,
      typeOfCrane: { select: { name: true } },
      capacityT: true,
    },
  },
} satisfies Prisma.QuotationSelect;

type QuotationRow = Prisma.QuotationGetPayload<{
  select: typeof QUOTATION_SELECT;
}>;

export async function getVendorRfqDetail(rfqId: string, actor: Actor) {
  assertVendor(actor);
  const vendorId = requireVendorId(actor);
  const recipient = await prisma.rfqVendorRecipient.findFirst({
    where: { rfqId, vendorId },
    select: RECIPIENT_SELECT,
  });
  if (!recipient) throw AppError.notFound("That RFQ was not sent to you");

  const quotations = await prisma.quotation.findMany({
    where: { rfqId, vendorId },
    select: QUOTATION_SELECT,
    orderBy: [{ craneId: "asc" }, { version: "desc" }],
  });

  if (recipient.firstViewedAt === null) {
    await prisma.rfqVendorRecipient.update({
      where: { id: recipient.id },
      data: { firstViewedAt: new Date() },
    });
  }

  const rfq = recipient.rfq;
  const locked = rfq.submissionDeadline.getTime() <= Date.now();

  return {
    rfq: {
      rfqId: rfq.id,
      rfqNumber: rfq.rfqNumber,
      enquiryNo: rfq.enquiryNo,
      lineNo: rfq.lineNo,
      craneType: rfq.craneType,
      craneTypeName: rfq.craneTypeRef.name,
      capacityT: Number(rfq.capacityT),
      quantity: rfq.quantity,
      siteLocation: rfq.siteLocation,
      siteStateCode: rfq.siteStateCode,
      siteStateName: rfq.siteState.name,
      sitePincode: rfq.sitePincode,
      requiredStartDate: rfq.requiredStartDate.toISOString(),
      durationValue: Number(rfq.durationValue),
      durationUnit: rfq.durationUnit,
      configuration: rfq.configuration,
      commercialTerms: {
        otCharges: rfq.otCharges,
        breakdownTerms: rfq.breakdownTerms,
        dieselScope: rfq.dieselScope,
        workingHoursShift: rfq.workingHoursShift,
        accommodationConveyance: rfq.accommodationConveyance,
        paymentTerms: rfq.paymentTerms,
        extra: rfq.commercialTermsExtra,
      },
      smlContact: {
        name: rfq.smlContactName,
        mobile: rfq.smlContactMobile,
        email: rfq.smlContactEmail,
      },
      submissionDeadline: rfq.submissionDeadline.toISOString(),
      locked,
      notes: rfq.notes,
    },
    response: {
      responseStatus: recipient.responseStatus,
      declineReason: recipient.declineReason,
      declineNote: recipient.declineNote,
      respondedAt: recipient.respondedAt?.toISOString() ?? null,
      reminderCount: recipient.reminderCount,
      // False once declined, so the UI stops offering to decline.
      canRespond:
        !locked && recipient.responseStatus === ResponseStatus.PENDING,
    },
    // Every version, newest first, per crane series (brief 6.7: "all versions
    // stay in history").
    quotations: quotations.map((q: QuotationRow, index: number) => ({
      quotationId: q.id,
      craneId: q.craneId,
      craneLabel: `${q.crane.typeOfCrane.name} ${q.crane.capacityT} t — ${q.crane.serialRegistrationNo}`,
      version: q.version,
      isLatest: q.isLatest,
      rentalRate: Number(q.rentalRate),
      rateBasis: q.rateBasis,
      mobilisationCharges: Number(q.mobilisationCharges),
      totalQuotedValue: Number(q.totalQuotedValue),
      calculationNote: q.calculationNote,
      availabilityConfirmed: q.availabilityConfirmed,
      availableFrom: q.availableFrom?.toISOString() ?? null,
      validityDate: q.validityDate.toISOString(),
      acceptsCommercialTerms: q.acceptsCommercialTerms,
      deviationText: q.deviationText,
      remarks: q.remarks,
      warnings: (q.warnings ?? []) as Array<{ code: string; message: string }>,
      submittedAt: q.submittedAt.toISOString(),
      status: q.status,
      distanceToSiteKm:
        q.distanceToSiteKm === null ? null : Number(q.distanceToSiteKm),
      distanceMethod: q.distanceMethod,
      // Locked quotations are read-only, and so is anything on an expired RFQ.
      //
      // "Latest" is the first row of its crane's series — the rows arrive ordered
      // by crane then version descending — rather than the isLatest flag, because
      // withdrawal clears that flag on the row it withdraws. A withdrawn series
      // head stays editable so the vendor can revive it, which is the only way
      // back once `submit` refuses a second quote for the same crane.
      editable:
        index === quotations.findIndex((other) => other.craneId === q.craneId) &&
        (q.status === QuotationStatus.SUBMITTED ||
          q.status === QuotationStatus.WITHDRAWN) &&
        !locked,
    })),
  };
}

// ---------------------------------------------------------------------------
// Submitting (brief 6.7)
// ---------------------------------------------------------------------------

/**
 * Submits a quotation.
 *
 * The version number starts at 1 and is only ever that here — a second
 * submission for the same crane is a revision, handled below, so a duplicate
 * submit cannot silently overwrite or duplicate.
 *
 * Two things happen that the vendor cannot see and sales depends on: the RFQ
 * rolls up to Quotes Received on the first quotation, and the creator is emailed.
 */
export async function submitQuotation(
  rfqId: string,
  raw: unknown,
  actor: Actor,
  file: ValidatedUpload | null = null,
) {
  assertVendor(actor);
  const vendorId = requireVendorId(actor);
  const recipient = await loadRecipient(rfqId, actor);
  assertBeforeDeadline(recipient);
  assertActionable(recipient);

  const input: SubmitQuotationInput = submitQuotationSchema.parse(raw);
  const crane = await loadQuotingCrane(input.craneId, actor);
  assertCraneQuotable(crane);
  assertLoadChart(
    crane,
    await seriesHasLoadChart(rfqId, vendorId, crane.id),
    file,
  );

  // A vendor quoting the same crane twice by accident is a double submission, not
  // a revision: revisions go through reviseQuotation, which records the history.
  const existing = await prisma.quotation.findFirst({
    where: { rfqId, vendorId, craneId: crane.id },
    select: { id: true },
  });
  if (existing) {
    throw AppError.conflict(
      "You have already quoted this crane. Revise the existing quotation instead.",
    );
  }

  const rfq = recipient.rfq;
  const { rentalCharge, total, note } = calculateTotal({
    rentalRate: input.rentalRate,
    rateBasis: input.rateBasis,
    durationValue: Number(rfq.durationValue),
    durationUnit: rfq.durationUnit,
    mobilisationCharges: input.mobilisationCharges,
  });

  const warnings = computeWarnings(rfq, crane);
  const distance = await distanceToSite(rfq, crane);

  // Saved before the row so the attachment can reference it, and removed again if
  // the database write fails: an orphaned file is untidy, but a quotation that
  // claims a load chart it does not have would be a lie in the comparison screen.
  const storedChart =
    file === null
      ? null
      : await storage().save(file.buffer, {
          fileName: file.fileName,
          mimeType: file.mimeType,
          scope: `vendors/${vendorId}/rfqs/${rfqId}`,
        });

  let quotation;
  try {
    quotation = await prisma.quotation.create({
      data: {
        rfqId,
        vendorId,
        craneId: crane.id,
        version: 1,
        isLatest: true,
        rentalRate: input.rentalRate,
        rateBasis: input.rateBasis,
        mobilisationCharges: input.mobilisationCharges,
        totalQuotedValue: total,
        calculationNote: note,
        availabilityConfirmed: true,
        availableFrom: input.availableFrom,
        validityDate: startOfUtcDay(input.validityDate),
        acceptsCommercialTerms: input.acceptsCommercialTerms,
        deviationText: input.deviationText,
        remarks: input.remarks,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        craneLocationSnapshot: craneSnapshot(
          crane,
        ) as unknown as Prisma.InputJsonValue,
        distanceToSiteKm: distance?.km ?? null,
        distanceMethod:
          (distance?.method as DistanceMethod | undefined) ?? null,
        ...(storedChart === null
          ? {}
          : {
              attachments: {
                create: {
                  kind: AttachmentKind.LOAD_CHART,
                  fileRef: storedChart.fileRef,
                  fileName: storedChart.fileName,
                  mimeType: storedChart.mimeType,
                  sizeBytes: storedChart.sizeBytes,
                },
              },
            }),
      },
      select: { id: true, version: true, totalQuotedValue: true },
    });
  } catch (error) {
    if (storedChart !== null) {
      try {
        await storage().remove(storedChart.fileRef);
      } catch (cleanupError) {
        console.error(
          "[quotation] orphaned load chart could not be removed",
          cleanupError,
        );
      }
    }
    throw error;
  }

  await markResponded(recipient.id, actor);
  await rollUpToQuotesReceived(rfq.id);
  await notifyVendorOfReceipt(recipient, quotation.id, "submitted");
  await notifyCreatorOfQuotation(
    rfq,
    recipient,
    quotation.version,
    crane,
    total,
    distance,
    warnings,
  );

  await recordAudit({
    entity: "quotation",
    entityId: quotation.id,
    action: "submit",
    newValue: {
      rfqNumber: rfq.rfqNumber,
      craneId: crane.id,
      version: 1,
      totalQuotedValue: total,
      warnings: warnings.map((w) => w.code),
    },
    actor: auditActor(actor),
  });

  return {
    quotation: {
      quotationId: quotation.id,
      version: quotation.version,
      totalQuotedValue: total,
      rentalCharge,
      calculationNote: note,
      warnings,
      distanceKm: distance?.km ?? null,
      distanceMethod: distance?.method ?? null,
      distanceApproximate: distance?.approximate ?? false,
    },
  };
}

/**
 * Marks the recipient as having responded.
 *
 * `QUOTED` is kept even if every quotation is later withdrawn, because the vendor
 * did answer and the tracking screen needs to distinguish "declined", "quoted then
 * withdrew" and "never replied" — three different conversations with a customer.
 */
async function markResponded(recipientId: string, actor: Actor): Promise<void> {
  await prisma.rfqVendorRecipient.update({
    where: { id: recipientId },
    data: {
      responseStatus: ResponseStatus.QUOTED,
      respondedAt: new Date(),
    },
  });
}

/**
 * The first quotation moves the RFQ roll-up to Quotes Received (brief 6.7).
 *
 * Only forward, and never off Quotes Received once set: a vendor withdrawing
 * after submitting does not put the RFQ back into "awaiting", because the sales
 * user has already seen a price and may have quoted it to the customer.
 */
async function rollUpToQuotesReceived(rfqId: string): Promise<void> {
  await prisma.rfq.updateMany({
    where: { id: rfqId, rollupStatus: RfqRollupStatus.AWAITING_QUOTES },
    data: { rollupStatus: RfqRollupStatus.QUOTES_RECEIVED },
  });
}

/**
 * The vendor's own receipt for a submission, revision or withdrawal (brief 7.4's
 * "Quotation receipt").
 *
 * Sent to the addresses the RFQ was actually dispatched to, not to a profile
 * email, because those are the inboxes that received the enquiry. A failed send
 * is logged and swallowed: the version is already stored and the portal shows
 * the history, so an SMTP outage must not fail the vendor's request.
 */
async function notifyVendorOfReceipt(
  recipient: RecipientRow,
  quotationId: string,
  action: "submitted" | "revised" | "withdrawn",
): Promise<void> {
  if (recipient.emails.length === 0) return;

  // Re-read rather than passed in: submission already has the values in hand,
  // withdrawal does not, and one query is cheaper than threading seven fields
  // through two call sites to save it. Scoped by vendor id as well as id.
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, vendorId: recipient.vendorId },
    select: {
      version: true,
      rentalRate: true,
      rateBasis: true,
      mobilisationCharges: true,
      totalQuotedValue: true,
      validityDate: true,
      calculationNote: true,
      crane: {
        select: {
          serialRegistrationNo: true,
          typeOfCrane: { select: { name: true } },
          capacityT: true,
        },
      },
    },
  });
  if (!quotation) return;

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  await sendTemplate({
    to: recipient.emails[0],
    cc: recipient.emails.slice(1),
    template: "quotation_receipt",
    entity: "quotation",
    entityId: recipient.rfq.id,
    vars: {
      rfqNumber: recipient.rfq.rfqNumber,
      action,
      vendorName: await vendorNameOf(recipient.vendorId),
      craneLabel: `${quotation.crane.typeOfCrane.name} ${quotation.crane.capacityT} t — ${quotation.crane.serialRegistrationNo}`,
      version: String(quotation.version),
      rentalRate: Number(quotation.rentalRate).toFixed(2),
      rateBasis: rateBasisLabel(quotation.rateBasis),
      mobilisationCharges: Number(quotation.mobilisationCharges).toFixed(2),
      totalQuotedValue: Number(quotation.totalQuotedValue).toFixed(2),
      validityDate: toCalendarDateString(quotation.validityDate),
      calculationNote: quotation.calculationNote ?? "",
      rfqUrl: `${portalBase}/app/rfqs/${recipient.rfq.id}`,
    },
  }).catch((err) => console.error("[quotation] vendor receipt failed", err));
}

function rateBasisLabel(basis: RateBasis): string {
  return basis === RateBasis.PER_MONTH ? "month" : "day";
}

/** The sales user who created the RFQ, if they are still an active user. */
async function creatorEmailOf(rfqId: string): Promise<string | null> {
  const rfq = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: { createdBy: { select: { email: true, isActive: true } } },
  });
  if (!rfq?.createdBy.isActive) return null;
  return rfq.createdBy.email;
}

async function notifyCreatorOfQuotation(
  rfq: RecipientRow["rfq"],
  recipient: RecipientRow,
  version: number,
  crane: QuotingCrane,
  total: number,
  distance: Awaited<ReturnType<typeof distanceToSite>>,
  warnings: Array<{ code: string; message: string }>,
): Promise<void> {
  // The internal user who raised the RFQ, not the customer's contact address:
  // a quotation carries this vendor's price, which must never reach the customer
  // by email. No address means no email, not a failed send — the quotation is
  // already stored and the tracking screen already shows it.
  const to = await creatorEmailOf(rfq.id);
  if (!to) return;

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const distanceText =
    distance === null
      ? "Not available (no map pin)"
      : `${distance.km} km${distance.approximate ? " (approximate, straight-line)" : ""}`;

  await sendTemplate({
    to,
    template: "quotation_received",
    entity: "rfq",
    entityId: rfq.id,
    vars: {
      rfqNumber: rfq.rfqNumber,
      vendorName: await vendorNameOf(recipient.vendorId),
      craneLabel: craneLabel(crane),
      totalQuotedValue: total.toFixed(2),
      distanceText,
      version: String(version),
      warningsBlock: warningsBlock(warnings),
      rfqUrl: `${portalBase}/app/rfqs/${rfq.id}`,
    },
  }).catch((err) =>
    console.error("[quotation] creator notification failed", err),
  );
}

/** Warnings as a pre-escaped list, so a note cannot inject markup into the mail. */
function warningsBlock(
  warnings: Array<{ code: string; message: string }>,
): string {
  if (warnings.length === 0) {
    return `<p style="margin:0;font-size:13px;color:#64748b">No advisories on this quotation.</p>`;
  }
  const items = warnings
    .map((w) => `<li style="margin:0 0 4px">${escapeHtml(w.message)}</li>`)
    .join("");
  return `<p style="margin:0 0 6px;font-size:13px;color:#b45309"><strong>Advisories for your review:</strong></p><ul style="margin:0 0 12px;padding-left:20px;font-size:13px;color:#b45309">${items}</ul>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function vendorNameOf(vendorId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { name: true },
  });
  return vendor?.name ?? "The vendor";
}

// ---------------------------------------------------------------------------
// Revising and withdrawing (brief 6.7)
// ---------------------------------------------------------------------------

/**
 * Revises a quotation by adding a version.
 *
 * The previous version is kept and marked `isLatest: false` rather than updated,
 * because brief 6.7 requires every version in history and "the latest counts" is
 * about which row to compare, not a licence to erase what was said before.
 *
 * Ownership and the deadline are both re-checked: a revision is a new act by the
 * vendor, and it happens after the original submission, often much later.
 */
export async function reviseQuotation(
  quotationId: string,
  raw: unknown,
  actor: Actor,
  file: ValidatedUpload | null = null,
) {
  assertVendor(actor);

  // Ownership before validation: a request for someone else's quotation is a 404
  // whatever it contains, and there is no reason to parse a body for a row the
  // caller is not allowed to touch.
  const existing = await loadOwnQuotation(quotationId, actor);
  const input: ReviseQuotationInput = reviseQuotationSchema.parse(raw);

  const recipient = await loadRecipient(existing.rfqId, actor);
  assertNotCancelled(recipient);
  assertBeforeDeadline(recipient);

  // A withdrawn latest version may be revised, and that is the only way back.
  // `submitQuotation` refuses a second quote for a crane that already has one —
  // correctly, since a double submission is not a revision — so if withdrawal
  // also refused a revision, retracting an offer would lock that crane out of the
  // RFQ for good. Reviving through a new version keeps the withdrawn one in
  // history, which is what "all versions stay in history" (brief 6.7) asks for.
  if (
    existing.status !== QuotationStatus.SUBMITTED &&
    existing.status !== QuotationStatus.WITHDRAWN
  ) {
    throw AppError.conflict(
      `This quotation is ${existing.status.toLowerCase().replace(/_/g, " ")} and can no longer be revised.`,
    );
  }
  // "Latest" is asked of the database rather than read off the isLatest flag,
  // because withdrawal clears that flag on the row it withdraws. Trusting it here
  // would make a withdrawn version permanently unrevisable, and a stale flag would
  // equally let a superseded version be revised.
  const superseded = await prisma.quotation.findFirst({
    where: {
      rfqId: existing.rfqId,
      vendorId: existing.vendorId,
      craneId: existing.craneId,
      version: { gt: existing.version },
    },
    select: { id: true },
  });
  if (superseded) {
    throw AppError.conflict("Only the latest version can be revised");
  }

  // Re-checked, not assumed from the first submission: a crane booked or sent to
  // maintenance in the meantime must not collect a second version of a price.
  const crane = await loadQuotingCrane(existing.craneId, actor);
  assertCraneQuotable(crane);
  assertLoadChart(
    crane,
    await seriesHasLoadChart(
      existing.rfqId,
      existing.vendorId,
      existing.craneId,
    ),
    file,
  );

  const rfq = recipient.rfq;
  const { rentalCharge, total, note } = calculateTotal({
    rentalRate: input.rentalRate,
    rateBasis: input.rateBasis,
    durationValue: Number(rfq.durationValue),
    durationUnit: rfq.durationUnit,
    mobilisationCharges: input.mobilisationCharges,
  });

  const warnings = computeWarnings(rfq, crane);
  const distance = await distanceToSite(rfq, crane);
  const nextVersion = existing.version + 1;

  const storedChart =
    file === null
      ? null
      : await storage().save(file.buffer, {
          fileName: file.fileName,
          mimeType: file.mimeType,
          scope: `vendors/${existing.vendorId}/rfqs/${existing.rfqId}`,
        });

  let quotation;
  try {
    quotation = await prisma.$transaction(async (tx) => {
      // The unique index on (rfqId, vendorId, craneId, version) is what actually
      // prevents two concurrent revisions claiming the same number; this makes the
      // intent explicit and keeps the old row's isLatest honest.
      await tx.quotation.update({
        where: { id: existing.id },
        data: { isLatest: false },
      });
      return tx.quotation.create({
        data: {
          rfqId: existing.rfqId,
          vendorId: existing.vendorId,
          craneId: existing.craneId,
          version: nextVersion,
          isLatest: true,
          rentalRate: input.rentalRate,
          rateBasis: input.rateBasis,
          mobilisationCharges: input.mobilisationCharges,
          totalQuotedValue: total,
          calculationNote: note,
          availabilityConfirmed: true,
          availableFrom: input.availableFrom,
          validityDate: startOfUtcDay(input.validityDate),
          acceptsCommercialTerms: input.acceptsCommercialTerms,
          deviationText: input.deviationText,
          remarks: input.remarks,
          warnings: warnings as unknown as Prisma.InputJsonValue,
          craneLocationSnapshot: craneSnapshot(
            crane,
          ) as unknown as Prisma.InputJsonValue,
          distanceToSiteKm: distance?.km ?? null,
          distanceMethod:
            (distance?.method as DistanceMethod | undefined) ?? null,
          ...(storedChart === null
            ? {}
            : {
                attachments: {
                  create: {
                    kind: AttachmentKind.LOAD_CHART,
                    fileRef: storedChart.fileRef,
                    fileName: storedChart.fileName,
                    mimeType: storedChart.mimeType,
                    sizeBytes: storedChart.sizeBytes,
                  },
                },
              }),
        },
        select: { id: true, version: true },
      });
    });
  } catch (error) {
    if (storedChart !== null) {
      try {
        await storage().remove(storedChart.fileRef);
      } catch (cleanupError) {
        console.error(
          "[quotation] orphaned load chart could not be removed",
          cleanupError,
        );
      }
    }
    throw error;
  }

  await notifyVendorOfReceipt(recipient, quotation.id, "revised");
  await notifyCreatorOfQuotation(
    rfq,
    recipient,
    quotation.version,
    crane,
    total,
    distance,
    warnings,
  );

  await recordAudit({
    entity: "quotation",
    entityId: quotation.id,
    action: "revise",
    oldValue: {
      version: existing.version,
      totalQuotedValue: Number(existing.totalQuotedValue),
    },
    newValue: { version: quotation.version, totalQuotedValue: total },
    actor: auditActor(actor),
  });

  return {
    quotation: {
      quotationId: quotation.id,
      version: quotation.version,
      totalQuotedValue: total,
      rentalCharge,
      calculationNote: note,
      warnings,
    },
  };
}

/**
 * Withdraws the latest version of a quotation.
 *
 * The row is kept and marked withdrawn rather than deleted: brief 6.7 keeps all
 * versions in history, and a withdrawn quotation that had been shown to a
 * customer must remain visible to sales. The previous version does *not* come
 * back — the vendor withdrew, not rolled back.
 */
export async function withdrawQuotation(
  quotationId: string,
  raw: unknown,
  actor: Actor,
) {
  assertVendor(actor);

  // Ownership before validation, for the same reason as reviseQuotation.
  const existing = await loadOwnQuotation(quotationId, actor);
  const input = withdrawQuotationSchema.parse(raw ?? {});

  const recipient = await loadRecipient(existing.rfqId, actor);
  assertNotCancelled(recipient);
  assertBeforeDeadline(recipient);

  if (!existing.isLatest || existing.status !== QuotationStatus.SUBMITTED) {
    throw AppError.conflict("Only your latest live quotation can be withdrawn");
  }

  const withdrawn = await prisma.quotation.update({
    where: { id: quotationId },
    data: { status: QuotationStatus.WITHDRAWN, isLatest: false },
    select: { id: true, version: true },
  });

  // The reason has no column of its own — there is nowhere on the quotation for
  // it — so it is kept in the audit trail, which is where "why did this vendor
  // pull out" belongs anyway.
  await recordAudit({
    entity: "quotation",
    entityId: quotationId,
    action: "withdraw",
    oldValue: { version: existing.version, status: existing.status },
    newValue: {
      version: withdrawn.version,
      status: QuotationStatus.WITHDRAWN,
      reason: input.reason ?? null,
    },
    actor: auditActor(actor),
  });

  await notifyVendorOfReceipt(recipient, quotationId, "withdrawn");

  return { withdrawn: true, quotationId, version: withdrawn.version };
}

// ---------------------------------------------------------------------------
// History (brief 7.8)
// ---------------------------------------------------------------------------

/**
 * Every version of every quotation this vendor has on an RFQ (brief 7.8).
 *
 * Ordered newest first within each crane series, so the latest is the row a
 * reader looks at first and the earlier ones are still there underneath it.
 */
export async function listQuotationHistory(rfqId: string, actor: Actor) {
  assertVendor(actor);
  const recipient = await loadRecipient(rfqId, actor);

  const quotations = await prisma.quotation.findMany({
    where: { rfqId, vendorId: requireVendorId(actor) },
    select: {
      id: true,
      craneId: true,
      version: true,
      isLatest: true,
      rentalRate: true,
      rateBasis: true,
      mobilisationCharges: true,
      totalQuotedValue: true,
      calculationNote: true,
      validityDate: true,
      status: true,
      submittedAt: true,
      warnings: true,
      crane: {
        select: {
          serialRegistrationNo: true,
          typeOfCrane: { select: { name: true } },
          capacityT: true,
        },
      },
    },
    orderBy: [{ craneId: "asc" }, { version: "desc" }],
  });

  const series = new Map<string, typeof quotations>();
  for (const q of quotations) {
    const list = series.get(q.craneId) ?? [];
    list.push(q);
    series.set(q.craneId, list);
  }

  return {
    rfqId: recipient.rfq.id,
    rfqNumber: recipient.rfq.rfqNumber,
    series: [...series.entries()].map(([craneId, list]) => ({
      craneId,
      craneLabel: `${list[0].crane.typeOfCrane.name} ${list[0].crane.capacityT} t — ${list[0].crane.serialRegistrationNo}`,
      versions: list.map((q) => ({
        quotationId: q.id,
        version: q.version,
        isLatest: q.isLatest,
        rentalRate: Number(q.rentalRate),
        rateBasis: q.rateBasis,
        mobilisationCharges: Number(q.mobilisationCharges),
        totalQuotedValue: Number(q.totalQuotedValue),
        calculationNote: q.calculationNote,
        validityDate: q.validityDate.toISOString(),
        status: q.status,
        submittedAt: q.submittedAt.toISOString(),
        warnings: (q.warnings ?? []) as Array<{
          code: string;
          message: string;
        }>,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Declining (brief 6.7)
// ---------------------------------------------------------------------------

/**
 * Declines the RFQ.
 *
 * `note` exists because the enquiry mail asks the vendor to say what else they
 * can offer. Both text fields are stored on the recipient, not on a quotation,
 * because declining is a response to the RFQ rather than to a price.
 */
export async function declineRfq(rfqId: string, raw: unknown, actor: Actor) {
  assertVendor(actor);
  const input = declineRfqSchema.parse(raw ?? {});
  const recipient = await loadRecipient(rfqId, actor);
  assertNotCancelled(recipient);
  assertBeforeDeadline(recipient);

  if (recipient.responseStatus === ResponseStatus.DECLINED) {
    throw AppError.conflict("You have already declined this RFQ");
  }
  if (recipient.responseStatus === ResponseStatus.QUOTED) {
    throw AppError.conflict(
      "You have already quoted this RFQ. Withdraw the quotation if you cannot proceed.",
    );
  }

  const updated = await prisma.rfqVendorRecipient.update({
    where: { id: recipient.id },
    data: {
      responseStatus: ResponseStatus.DECLINED,
      declineReason: input.reason,
      declineNote: input.note,
      respondedAt: new Date(),
    },
    select: { id: true, responseStatus: true, respondedAt: true },
  });

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "decline",
    newValue: { reason: input.reason, vendorId: requireVendorId(actor) },
    actor: auditActor(actor),
  });

  return {
    declined: true,
    responseStatus: updated.responseStatus,
    respondedAt: updated.respondedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

/**
 * Loads a quotation the caller owns.
 *
 * Vendor id in the where clause, so another vendor's quotation id is a 404
 * rather than a 403 that would confirm it exists. This is the rule brief 6.6
 * exists to enforce and the one M5's done-when calls out explicitly.
 */
async function loadOwnQuotation(quotationId: string, actor: Actor) {
  const vendorId = requireVendorId(actor);
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, vendorId },
    select: {
      id: true,
      rfqId: true,
      vendorId: true,
      craneId: true,
      version: true,
      isLatest: true,
      status: true,
      totalQuotedValue: true,
    },
  });
  if (!quotation) throw AppError.notFound("That quotation was not found");
  return quotation;
}

/** Exported for the internal tracking screen: a quotation's own attachments. */
export async function listQuotationAttachments(
  quotationId: string,
  actor: Actor,
) {
  assertVendor(actor);
  await loadOwnQuotation(quotationId, actor);
  const attachments = await prisma.quotationAttachment.findMany({
    where: { quotationId },
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
    },
    orderBy: { id: "asc" },
  });
  return { attachments };
}

/** Exported for the internal tracking screen: a quotation's own attachments. */

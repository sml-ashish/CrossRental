import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { recordAudit } from "./audit.service";
import { nextRfqNumber } from "./rfqNumber.service";
import { candidatesForRfq, type CandidateCrane } from "./candidate.service";
import { invalidateDistancesFrom } from "./distance.service";
import { onRfqSent } from "./enquiryTrail.service";
import { tryGeocode, isInsideIndia, type GeoPoint } from "../lib/geo";
import { sendTemplate, optionalBlock } from "./email.service";
import {
  isWhatsAppConfigured,
  normaliseWhatsAppNumber,
  sendWhatsAppTemplate,
} from "./whatsapp.service";
import { getSettings } from "../utils/settings";
import {
  createRfqSchema,
  updateRfqSchema,
  sendRfqSchema,
  extendDeadlineSchema,
  cancelRfqSchema,
  remindRfqSchema,
  confirmSitePinSchema,
  listRfqsQuerySchema,
  listApprovedVendorsQuerySchema,
  candidateQuerySchema,
  type CreateRfqInput,
  type UpdateRfqInput,
  type SendRfqInput,
  type ExtendDeadlineInput,
  type CancelRfqInput,
  type RemindRfqInput,
  type ConfirmSitePinInput,
  type ListRfqsQuery,
  type ListApprovedVendorsQuery,
  type CandidateQuery,
} from "../validation/rfqFields";
import {
  CoordinateSource,
  DistanceMethod,
  DurationUnit,
  EmailDeliveryStatus,
  EnquiryLineTrailStatus,
  MessageChannel,
  OnboardingStatus,
  ResponseStatus,
  RfqRollupStatus,
  RfqStatus,
} from "../generated/prisma/client";

/**
 * Internal RFQ creation, dispatch and tracking (brief 7.9, with the rules of 6.7).
 *
 * Four things shape this file.
 *
 * **Only internal users get here.** Every function requires `rfq:create`,
 * `rfq:dispatch` or `rfq:track`, which no vendor role holds. The vendor inbox
 * (M5) reads recipients, not this file — a vendor never receives an `Rfq` by id,
 * they receive their own `RfqVendorRecipient` scoped by their token.
 *
 * **Recipient addresses are resolved here, never taken from the client.** Brief
 * 6.7 restricts recipients to approved vendors with an active user, so
 * `vendorIds` go in and that vendor's own active addresses come out. A client
 * that posts an arbitrary address list is ignored, because otherwise the RFQ —
 * which carries the requirement, the deadline and the customer's terms — could
 * be mailed to anyone.
 *
 * **A failed send is recorded, not thrown.** Brief 6.7 wants failed deliveries
 * visible on the dashboard, which means the send loop cannot abort on the first
 * bounce: every recipient is attempted, each gets its own delivery status, and
 * the RFQ is still marked Sent because it *was* dispatched. Losing the other
 * four recipients because one mailbox was full would be the worse bug.
 *
 * **Snapshots are never recomputed.** Brief 6.9 stores the candidates and
 * distances shown at send time, because cranes move and re-deriving them later
 * would quietly rewrite history about what a vendor was offered.
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

/** Every RFQ function is internal-only; this makes that explicit in one place. */
function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can work with RFQs");
  }
}

const RFQ_SELECT = {
  id: true,
  rfqNumber: true,
  enquiryNo: true,
  lineNo: true,
  enquiryLineId: true,
  craneType: true,
  capacityT: true,
  capacityRule: true,
  capacityNote: true,
  applicationDescription: true,
  loadDescription: true,
  mainBoomM: true,
  jibLengthM: true,
  startDateTbc: true,
  workingDaysPerMonth: true,
  quantity: true,
  siteLocation: true,
  siteStateCode: true,
  sitePincode: true,
  siteLatitude: true,
  siteLongitude: true,
  siteCoordinateSource: true,
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
  mobilisationTerms: true,
  supportCrane: true,
  steelMatsGroundPrep: true,
  ehsHrRequirements: true,
  insuranceTerms: true,
  extensionClause: true,
  notes: true,
  commercialTermsExtra: true,
  smlContactName: true,
  smlContactMobile: true,
  smlContactEmail: true,
  submissionDeadline: true,
  status: true,
  rollupStatus: true,
  cancelledAt: true,
  cancelReason: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  sentAt: true,
  channels: true,
  siteState: { select: { name: true } },
  craneTypeRef: { select: { name: true } },
  createdBy: { select: { id: true, email: true, fullName: true } },
} as const;

type RfqRow = {
  id: string;
  rfqNumber: string;
  enquiryLineId: string | null;
  capacityT: unknown;
  siteLatitude: unknown;
  siteLongitude: unknown;
  sitePincode: string | null;
  siteCoordinateSource: CoordinateSource | null;
  siteLocation: string;
  siteStateCode: string;
  requiredStartDate: Date;
  submissionDeadline: Date;
  status: string;
  rollupStatus: string | null;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** View shape for the tracking list. Decimals become numbers; nothing else changes. */
export function toRfqView(row: Record<string, unknown>) {
  return {
    ...row,
    capacityT: num(row.capacityT) ?? 0,
    mainBoomM: num(row.mainBoomM),
    jibLengthM: num(row.jibLengthM),
    durationValue: num(row.durationValue) ?? 0,
    siteLatitude: num(row.siteLatitude),
    siteLongitude: num(row.siteLongitude),
    siteLocationUnverified:
      num(row.siteLatitude) === null || num(row.siteLongitude) === null,
  };
}

/**
 * Resolve the job-site pin (brief 6.9).
 *
 * A pin the sales user supplied wins outright — they have confirmed it, and a
 * fresh lookup must not overwrite a human correction. Otherwise the site is
 * geocoded, and a failure is not fatal: the RFQ saves without coordinates and
 * the picker says distances are unavailable until someone confirms the pin.
 */
async function resolveSite(input: {
  siteLocation: string;
  siteStateCode: string;
  sitePincode: string | null;
  siteLatitude?: number | null;
  siteLongitude?: number | null;
  stateName: string;
}): Promise<{
  siteLatitude: number | null;
  siteLongitude: number | null;
  siteCoordinateSource: CoordinateSource | null;
}> {
  if (input.siteLatitude != null && input.siteLongitude != null) {
    return {
      siteLatitude: input.siteLatitude,
      siteLongitude: input.siteLongitude,
      siteCoordinateSource: CoordinateSource.manual,
    };
  }

  const result = await tryGeocode({
    location: input.siteLocation,
    state: input.stateName,
    pincode: input.sitePincode,
  });

  if (!result.ok)
    return {
      siteLatitude: null,
      siteLongitude: null,
      siteCoordinateSource: null,
    };

  // The schema stores *how* the point was obtained, not which vendor supplied it:
  // anything a provider returned is `auto`, anything a human confirmed is
  // `manual`. Crane.geocodedBy carries the provider name; the RFQ header has no
  // such column, so the distinction that matters here is human versus machine.
  return {
    siteLatitude: result.point.lat,
    siteLongitude: result.point.lng,
    siteCoordinateSource: CoordinateSource.auto,
  };
}

/**
 * The commercial-terms and SML-contact columns (brief 5.4).
 *
 * Extracted because create and update were writing the same fields twice, and
 * a list that appears twice is a list that will drift: the day a term is added
 * to the schema, one copy is missed and the field silently stops being editable
 * on drafts.
 */
function termColumns(input: CreateRfqInput | UpdateRfqInput) {
  return {
    otCharges: input.otCharges,
    breakdownTerms: input.breakdownTerms,
    dieselScope: input.dieselScope,
    workingHoursShift: input.workingHoursShift,
    craneAgeCriteriaYears: input.craneAgeCriteriaYears,
    accommodationConveyance: input.accommodationConveyance,
    paymentTerms: input.paymentTerms,
    mobilisationTerms: input.mobilisationTerms,
    supportCrane: input.supportCrane,
    steelMatsGroundPrep: input.steelMatsGroundPrep,
    ehsHrRequirements: input.ehsHrRequirements,
    insuranceTerms: input.insuranceTerms,
    extensionClause: input.extensionClause,
    notes: input.notes,
    commercialTermsExtra: (input.commercialTermsExtra ??
      undefined) as Prisma.InputJsonValue | undefined,
    smlContactName: input.smlContactName,
    smlContactMobile: input.smlContactMobile,
    smlContactEmail: input.smlContactEmail,
  };
}

/** The crane type must exist, or the candidate picker silently matches nothing. */
async function assertCraneType(code: string): Promise<void> {
  const found = await prisma.craneType.findUnique({
    where: { code },
    select: { code: true },
  });
  if (!found) {
    throw AppError.badRequest(`"${code}" is not a known crane type`);
  }
}

async function stateNameOf(code: string): Promise<string> {
  const state = await prisma.state.findUnique({
    where: { code },
    select: { name: true },
  });
  if (!state) throw AppError.badRequest(`"${code}" is not a known state`);
  return state.name;
}

// --- create / update ------------------------------------------------------

/**
 * Resolve the enquiry line an RFQ is being raised against.
 *
 * Returns the enquiry number and line number *from the line itself*, so the two
 * snapshot columns can never drift from the line they claim to belong to. A
 * cancelled line is refused here as well as in the workspace UI: the trail has
 * already ended, and an RFQ against it would be untraceable.
 */
async function lineIdentityOf(enquiryLineId: string) {
  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: enquiryLineId },
    select: {
      lineNo: true,
      cancelledAt: true,
      trailStatus: true,
      enquiry: { select: { enquiryNo: true } },
    },
  });
  if (!line) throw AppError.badRequest("That enquiry line does not exist");
  if (line.cancelledAt) {
    throw AppError.badRequest(
      "That enquiry line is cancelled — raise the RFQ from an active line",
    );
  }
  // Sourcing has ended for these; a new RFQ would reopen a closed trail.
  if (
    line.trailStatus === EnquiryLineTrailStatus.VENDOR_FINALISED ||
    line.trailStatus === EnquiryLineTrailStatus.BOOKED ||
    line.trailStatus === EnquiryLineTrailStatus.CLOSED ||
    line.trailStatus === EnquiryLineTrailStatus.FULFILLED_INTERNALLY
  ) {
    throw AppError.badRequest(
      "That enquiry line is already finalised — raise the RFQ from a line still in sourcing",
    );
  }
  return {
    enquiryNo: line.enquiry.enquiryNo,
    lineNo: String(line.lineNo),
  };
}

export async function createRfq(raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: CreateRfqInput = createRfqSchema.parse(raw);
  await assertCraneType(input.craneType);
  const stateName = await stateNameOf(input.siteStateCode);

  // The line is the source of truth when supplied; the legacy SAP pair is only
  // a fallback for callers that arrive without a native line.
  const identity = input.enquiryLineId
    ? await lineIdentityOf(input.enquiryLineId)
    : { enquiryNo: input.enquiryNo, lineNo: input.lineNo };
  if (!identity.enquiryNo || !identity.lineNo) {
    throw AppError.badRequest("Choose the enquiry line this RFQ is for");
  }

  const site = await resolveSite({
    siteLocation: input.siteLocation,
    siteStateCode: input.siteStateCode,
    sitePincode: input.sitePincode,
    siteLatitude: input.siteLatitude ?? null,
    siteLongitude: input.siteLongitude ?? null,
    stateName,
  });

  const rfqNumber = await nextRfqNumber();

  // Annotated rather than inlined: this payload mixes scalar foreign keys with
  // plain columns, and Prisma resolves an inline literal against its
  // checked/unchecked XOR, which reports keys the payload legitimately has.
  const data: Prisma.RfqUncheckedCreateInput = {
    rfqNumber,
    enquiryNo: identity.enquiryNo,
    lineNo: identity.lineNo,
    enquiryLineId: input.enquiryLineId ?? null,
    craneType: input.craneType,
    capacityT: input.capacityT,
    capacityRule: input.capacityRule,
    capacityNote: input.capacityNote,
    applicationDescription: input.applicationDescription,
    loadDescription: input.loadDescription,
    mainBoomM: input.mainBoomM ?? null,
    jibLengthM: input.jibLengthM ?? null,
    startDateTbc: input.startDateTbc,
    workingDaysPerMonth: input.workingDaysPerMonth ?? null,
    quantity: input.quantity,
    siteLocation: input.siteLocation,
    siteStateCode: input.siteStateCode,
    sitePincode: input.sitePincode,
    siteLatitude: site.siteLatitude,
    siteLongitude: site.siteLongitude,
    siteCoordinateSource: site.siteCoordinateSource,
    requiredStartDate: input.requiredStartDate,
    durationValue: input.durationValue,
    durationUnit: input.durationUnit,
    configuration: input.configuration,
    submissionDeadline: input.submissionDeadline,
    status: RfqStatus.DRAFT,
    createdById: actor.id,
    ...termColumns(input),
  };

  const row = await prisma.rfq.create({ data, select: RFQ_SELECT });

  await recordAudit({
    entity: "rfq",
    entityId: row.id,
    action: "create",
    newValue: { rfqNumber, status: RfqStatus.DRAFT },
    actor: auditActor(actor),
  });

  return toRfqView(row);
}

export async function updateRfq(rfqId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: UpdateRfqInput = updateRfqSchema.parse(raw);
  const existing = await loadRfq(rfqId);

  // Only a draft is editable. Once sent, the requirement is in vendor inboxes and
  // changing it silently would invalidate quotations already being prepared.
  if (existing.status !== RfqStatus.DRAFT) {
    throw AppError.conflict(
      `This RFQ has been ${existing.status.toLowerCase()} and can no longer be edited. Cancel it and raise a new one.`,
    );
  }

  await assertCraneType(input.craneType);
  const stateName = await stateNameOf(input.siteStateCode);

  // Re-geocode when the site text moved and the user supplied no new pin, keeping
  // the same precedence as M3's crane rule.
  const siteChanged =
    input.siteLocation !== existing.siteLocation ||
    input.siteStateCode !== existing.siteStateCode ||
    input.sitePincode !== existing.sitePincode;
  const hasNewPin = input.siteLatitude != null && input.siteLongitude != null;
  const site =
    siteChanged && !hasNewPin
      ? await resolveSite({
          siteLocation: input.siteLocation,
          siteStateCode: input.siteStateCode,
          sitePincode: input.sitePincode,
          stateName,
        })
      : hasNewPin
        ? await resolveSite({
            siteLocation: input.siteLocation,
            siteStateCode: input.siteStateCode,
            sitePincode: input.sitePincode,
            siteLatitude: input.siteLatitude,
            siteLongitude: input.siteLongitude,
            stateName,
          })
        : {
            siteLatitude: num(existing.siteLatitude),
            siteLongitude: num(existing.siteLongitude),
            siteCoordinateSource: existing.siteCoordinateSource,
          };

  // The site moved, so every distance cached from the *old* pin is now wrong,
  // and any distance already cached from the new pin may predate the move.
  if (siteChanged) {
    const oldLat = num(existing.siteLatitude);
    const oldLng = num(existing.siteLongitude);
    const oldPoint: GeoPoint | null =
      oldLat !== null && oldLng !== null ? { lat: oldLat, lng: oldLng } : null;
    const newPoint: GeoPoint | null =
      site.siteLatitude !== null && site.siteLongitude !== null
        ? { lat: site.siteLatitude, lng: site.siteLongitude }
        : null;

    for (const point of [oldPoint, newPoint]) {
      if (point) await invalidateDistancesFrom(point);
    }
  }

  // Annotated rather than inlined: this payload mixes scalar foreign keys with
  // plain columns, and Prisma's `Update | UncheckedUpdate` overload union then
  // resolves the object literal to a type missing keys it genuinely has.
  const data: Prisma.RfqUncheckedUpdateInput = {
    // `enquiryNo`/`lineNo` are a snapshot of the line and are not editable.
    craneType: input.craneType,
    capacityT: input.capacityT,
    capacityRule: input.capacityRule,
    capacityNote: input.capacityNote,
    applicationDescription: input.applicationDescription,
    loadDescription: input.loadDescription,
    mainBoomM: input.mainBoomM ?? null,
    jibLengthM: input.jibLengthM ?? null,
    startDateTbc: input.startDateTbc,
    workingDaysPerMonth: input.workingDaysPerMonth ?? null,
    quantity: input.quantity,
    siteLocation: input.siteLocation,
    siteStateCode: input.siteStateCode,
    sitePincode: input.sitePincode,
    siteLatitude: site.siteLatitude,
    siteLongitude: site.siteLongitude,
    siteCoordinateSource: site.siteCoordinateSource,
    requiredStartDate: input.requiredStartDate,
    durationValue: input.durationValue,
    durationUnit: input.durationUnit,
    configuration: input.configuration,
    submissionDeadline: input.submissionDeadline,
    ...termColumns(input),
  };

  const row = await prisma.rfq.update({
    where: { id: rfqId },
    data,
    select: RFQ_SELECT,
  });

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "update",
    actor: auditActor(actor),
  });

  return toRfqView(row);
}

/** Confirming the job-site pin without touching the rest of the RFQ (brief 6.9). */
export async function confirmSitePin(
  rfqId: string,
  raw: unknown,
  actor: Actor,
) {
  assertInternal(actor);
  const input: ConfirmSitePinInput = confirmSitePinSchema.parse(raw);
  const existing = await loadRfq(rfqId);

  const row = await prisma.rfq.update({
    where: { id: rfqId },
    data: {
      siteLatitude: input.siteLatitude,
      siteLongitude: input.siteLongitude,
      siteCoordinateSource: CoordinateSource.manual,
    },
    select: RFQ_SELECT,
  });

  // The site moved, so anything cached from the old pin is now meaningless.
  const oldLat = num(existing.siteLatitude);
  const oldLng = num(existing.siteLongitude);
  const previous: GeoPoint | null =
    oldLat !== null && oldLng !== null ? { lat: oldLat, lng: oldLng } : null;

  for (const point of [
    previous,
    { lat: input.siteLatitude, lng: input.siteLongitude } as GeoPoint,
  ]) {
    if (point) await invalidateDistancesFrom(point);
  }

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "confirm_site_pin",
    oldValue: {
      siteLatitude: num(existing.siteLatitude),
      siteLongitude: num(existing.siteLongitude),
    },
    newValue: {
      siteLatitude: input.siteLatitude,
      siteLongitude: input.siteLongitude,
    },
    actor: auditActor(actor),
  });

  return toRfqView(row);
}

// --- reads ---------------------------------------------------------------

export async function listRfqs(rawQuery: unknown, actor: Actor) {
  assertInternal(actor);
  const query: ListRfqsQuery = listRfqsQuerySchema.parse(rawQuery ?? {});

  const rows = await prisma.rfq.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { rfqNumber: { contains: query.search, mode: "insensitive" } },
              { enquiryNo: { contains: query.search, mode: "insensitive" } },
              { siteLocation: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(query.awaitingResponse
        ? { recipients: { some: { responseStatus: ResponseStatus.PENDING } } }
        : {}),
    },
    select: {
      ...RFQ_SELECT,
      _count: { select: { recipients: true, quotations: true } },
      recipients: {
        select: {
          id: true,
          emailDeliveryStatus: true,
          whatsappDeliveryStatus: true,
          responseStatus: true,
          vendor: { select: { name: true } },
        },
      },
    },
    orderBy: [{ status: "asc" }, { submissionDeadline: "asc" }],
  });

  return rows.map((row) => {
    const recipients = row.recipients as unknown as Array<{
      id: string;
      emailDeliveryStatus: string;
      whatsappDeliveryStatus: string | null;
      responseStatus: string;
      vendor: { name: string };
    }>;
    return {
      ...toRfqView(row),
      recipientCount: recipients.length,
      quotedCount: recipients.filter(
        (r) => r.responseStatus === ResponseStatus.QUOTED,
      ).length,
      failedCount: recipients.filter(
        (r) =>
          r.emailDeliveryStatus === EmailDeliveryStatus.FAILED ||
          r.whatsappDeliveryStatus === EmailDeliveryStatus.FAILED,
      ).length,
      pendingCount: recipients.filter(
        (r) => r.responseStatus === ResponseStatus.PENDING,
      ).length,
      recipients: recipients.map((r) => ({
        recipientId: r.id,
        vendorName: r.vendor.name,
        emailDeliveryStatus: r.emailDeliveryStatus,
        whatsappDeliveryStatus: r.whatsappDeliveryStatus,
        responseStatus: r.responseStatus,
      })),
    };
  });
}

async function loadRfq(rfqId: string): Promise<RfqRow> {
  const row = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: {
      id: true,
      rfqNumber: true,
      enquiryLineId: true,
      capacityT: true,
      siteLatitude: true,
      siteLongitude: true,
      siteLocation: true,
      siteStateCode: true,
      requiredStartDate: true,
      submissionDeadline: true,
      status: true,
      rollupStatus: true,
      siteState: { select: { name: true } },
    },
  });
  if (!row) throw AppError.notFound("That RFQ does not exist");
  return row as unknown as RfqRow;
}

/** Full detail for the tracking screen: recipients, delivery and response state. */
export async function getRfqDetail(rfqId: string, actor: Actor) {
  assertInternal(actor);

  const rfq = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: {
      ...RFQ_SELECT,
      recipients: {
        select: {
          id: true,
          vendorId: true,
          emails: true,
          emailDeliveryStatus: true,
          emailDeliveryError: true,
          whatsappPhones: true,
          whatsappDeliveryStatus: true,
          whatsappDeliveryError: true,
          whatsappMessageIds: true,
          firstViewedAt: true,
          responseStatus: true,
          respondedAt: true,
          declineReason: true,
          declineNote: true,
          reminderCount: true,
          lastReminderAt: true,
          candidateSnapshot: true,
          vendor: { select: { name: true, onboardingStatus: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      attachments: {
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
      },
    },
  });
  if (!rfq) throw AppError.notFound("That RFQ does not exist");

  const recipients = (rfq.recipients ?? []) as unknown as Array<
    Record<string, unknown>
  >;

  return {
    ...toRfqView(rfq),
    recipients: recipients.map((r) => ({
      recipientId: r.id,
      vendorId: r.vendorId,
      vendorName: (r.vendor as { name: string }).name,
      vendorOnboardingStatus: (r.vendor as { onboardingStatus: string })
        .onboardingStatus,
      emails: r.emails,
      emailDeliveryStatus: r.emailDeliveryStatus,
      emailDeliveryError: r.emailDeliveryError,
      whatsappPhones: r.whatsappPhones,
      whatsappDeliveryStatus: r.whatsappDeliveryStatus,
      whatsappDeliveryError: r.whatsappDeliveryError,
      firstViewedAt: r.firstViewedAt,
      responseStatus: r.responseStatus,
      respondedAt: r.respondedAt,
      declineReason: r.declineReason,
      /** Brief C4: what else the vendor offered when declining. */
      declineNote: r.declineNote,
      reminderCount: r.reminderCount,
      lastReminderAt: r.lastReminderAt,
      candidateSnapshot: r.candidateSnapshot,
    })),
    attachments: rfq.attachments ?? [],
    /** Brief 7.9's received-quotations table. Empty until M5 writes quotations. */
    quotations: await listQuotationsForRfq(rfqId),
  };
}

/**
 * Received quotations (brief 7.9, read-only).
 *
 * Written to be correct before anything writes to it: M5 will populate this and
 * the shape must not change afterwards, because the comparison screens will
 * read the same fields.
 */
async function listQuotationsForRfq(rfqId: string) {
  const rows = await prisma.quotation.findMany({
    where: { rfqId },
    select: {
      id: true,
      vendorId: true,
      version: true,
      isLatest: true,
      craneId: true,
      rentalRate: true,
      rateBasis: true,
      mobilisationCharges: true,
      demobilisationCharges: true,
      taxBasis: true,
      totalQuotedValue: true,
      validityDate: true,
      distanceToSiteKm: true,
      distanceMethod: true,
      warnings: true,
      source: true,
      status: true,
      submittedAt: true,
      vendor: { select: { name: true } },
      crane: {
        select: {
          make: true,
          model: true,
          capacityT: true,
          typeOfCrane: { select: { name: true } },
        },
      },
    },
    orderBy: [{ submittedAt: "desc" }],
  });

  return rows.map((r) => ({
    quotationId: r.id,
    vendorId: r.vendorId,
    vendorName: r.vendor.name,
    version: r.version,
    isLatest: r.isLatest,
    craneId: r.craneId,
    craneDescription: `${r.crane.typeOfCrane.name} ${r.crane.capacityT}t ${r.crane.make} ${r.crane.model}`,
    rentalRate: num(r.rentalRate) ?? 0,
    rateBasis: r.rateBasis,
    mobilisationCharges: num(r.mobilisationCharges) ?? 0,
    demobilisationCharges: num(r.demobilisationCharges) ?? 0,
    taxBasis: r.taxBasis,
    totalQuotedValue: num(r.totalQuotedValue) ?? 0,
    validityDate: r.validityDate,
    distanceToSiteKm: num(r.distanceToSiteKm),
    distanceMethod: r.distanceMethod,
    distanceApproximate: r.distanceMethod === DistanceMethod.straight_line,
    warnings: (r.warnings as string[] | null) ?? [],
    source: r.source,
    status: r.status,
    submittedAt: r.submittedAt,
  }));
}

/** Approved vendors with an active user — brief 6.7's recipient rule. */
export async function listApprovedVendors(rawQuery: unknown, actor: Actor) {
  assertInternal(actor);
  const query: ListApprovedVendorsQuery = listApprovedVendorsQuerySchema.parse(
    rawQuery ?? {},
  );

  return prisma.vendor.findMany({
    where: {
      onboardingStatus: OnboardingStatus.APPROVED,
      // P0 B2: a suspended vendor is not a candidate for a new enquiry.
      suspendedAt: null,
      ...(query.search
        ? {
            OR: [
              {
                name: { contains: query.search, mode: "insensitive" as const },
              },
              {
                email: { contains: query.search, mode: "insensitive" as const },
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      operatingRegions: {
        select: { stateCode: true, state: { select: { name: true } } },
      },
      users: {
        where: { role: "vendor_user", isActive: true },
        select: { id: true, email: true, fullName: true },
      },
    },
    orderBy: { name: "asc" },
  });
}

// --- dispatch ------------------------------------------------------------

/**
 * Resolve recipient addresses from vendor ids (brief 6.7).
 *
 * Approved status and an active user are re-checked here rather than trusted
 * from the picker: between rendering the candidate list and pressing send, a
 * vendor can be suspended. A vendor with no active user is refused with a reason
 * rather than silently skipped, because "nobody was emailed" is otherwise
 * indistinguishable from "the send failed".
 */
async function resolveRecipients(
  vendorIds: string[],
  channels: MessageChannel[],
): Promise<
  Array<{ vendorId: string; vendorName: string; emails: string[]; phones: string[] }>
> {
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: {
      id: true,
      name: true,
      onboardingStatus: true,
      suspendedAt: true,
      users: {
        where: { role: "vendor_user", isActive: true },
        select: { email: true },
      },
      contacts: {
        select: { email: true, mobile: true, isPrimary: true, receivesRfqs: true },
      },
    },
  });

  const found = new Map(vendors.map((v) => [v.id, v]));
  const refused: string[] = [];

  const resolved = vendorIds.flatMap((id) => {
    const vendor = found.get(id);
    if (!vendor) {
      refused.push("a selected vendor no longer exists");
      return [];
    }
    if (vendor.onboardingStatus !== OnboardingStatus.APPROVED) {
      refused.push(`${vendor.name ?? "A vendor"} is no longer approved`);
      return [];
    }
    // P0 B2: a suspended vendor must not receive new enquiries.
    if (vendor.suspendedAt) {
      refused.push(`${vendor.name ?? "A vendor"} is suspended`);
      return [];
    }

    // Brief 5.3 (open item 3 aside): RFQ emails go to the contacts the vendor
    // ticked "receives RFQ emails" for. Only when nobody on file is ticked
    // does the old rule apply — the active portal users, whose email is the
    // primary contact's in practice.
    const rfqContacts = vendor.contacts.filter(
      (c) => c.receivesRfqs && c.email && c.email.length > 0,
    );
    const emails = rfqContacts.map((c) => c.email as string);
    if (emails.length === 0) {
      emails.push(...vendor.users.map((u) => u.email));
    }
    if (channels.includes(MessageChannel.EMAIL) && emails.length === 0) {
      refused.push(`${vendor.name ?? "A vendor"} has no active user to email`);
      return [];
    }

    // P6 WhatsApp: the same RFQ contacts' mobiles, then the primary contact,
    // then the vendor's switchboard number. Sent numbers are normalised at send
    // time and stored on the recipient row so a reply can be matched back.
    const whatsappContacts = vendor.contacts.filter(
      (c) => c.receivesRfqs && c.mobile && c.mobile.trim().length > 0,
    );
    const phoneSource =
      whatsappContacts.length > 0
        ? whatsappContacts
        : vendor.contacts.filter((c) => c.isPrimary && c.mobile);
    const phones = [
      ...new Set(
        phoneSource
          .map((c) => normaliseWhatsAppNumber(c.mobile))
          .filter((phone): phone is string => phone !== null),
      ),
    ];
    if (channels.includes(MessageChannel.WHATSAPP) && phones.length === 0) {
      refused.push(`${vendor.name ?? "A vendor"} has no contact mobile for WhatsApp`);
      return [];
    }

    return [
      {
        vendorId: vendor.id,
        vendorName: vendor.name ?? "Unnamed vendor",
        emails,
        phones,
      },
    ];
  });

  if (refused.length > 0) {
    throw AppError.badRequest(
      `Only approved vendors with an active user can receive an RFQ: ${refused.join("; ")}`,
    );
  }

  return resolved;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Deterministic date formatting for email bodies.
 *
 * Deliberately not `toLocaleString`: the server's locale would decide whether a
 * vendor in Gujarat reads "11/4/2026" or "04/11/2026", and the same enquiry mail
 * has to mean one date everywhere. Month names are spelled out rather than
 * localised for the same reason — these strings are asserted in tests.
 */
function formatDate(date: Date): string {
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatDateTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)}, ${hh}:${mm}`;
}

/** "5 days" / "2 months" — the template's `durationText`. */
function durationText(value: number, unit: string): string {
  const n = Number.isInteger(value) ? String(value) : String(value);
  return unit === DurationUnit.MONTHS
    ? `${n} month${value === 1 ? "" : "s"}`
    : `${n} day${value === 1 ? "" : "s"}`;
}

/** The full row needed to render the enquiry mail, with the state name resolved. */
async function loadRfqForMail(rfqId: string) {
  const row = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: RFQ_SELECT,
  });
  if (!row) throw AppError.notFound("That RFQ does not exist");
  return row;
}

/**
 * Template variables for `rfq_invitation`, built from the stored RFQ.
 *
 * Every commercial term is echoed even when blank, because the enquiry mail
 * mirrors the paper form row for row — a vendor comparing the portal against
 * their inbox should find the same empty boxes, not silently missing ones. A
 * placeholder dash marks "not specified" so it cannot read as a value.
 */
function invitationVars(
  rfq: Record<string, unknown>,
  rfqId: string,
  portalBase: string,
) {
  const orDash = (v: unknown) =>
    v === null || v === undefined || v === "" ? "—" : String(v);
  return {
    rfqNumber: String(rfq.rfqNumber),
    siteLocation: String(rfq.siteLocation),
    siteState: String((rfq.siteState as { name: string }).name),
    craneType: String((rfq.craneTypeRef as { name: string }).name),
    capacityT: num(rfq.capacityT) ?? 0,
    // Brief A3: the matching rule is quoted so a vendor reading "exactly"
    // knows offering a bigger machine is not what was asked for.
    capacityRule:
      rfq.capacityRule === "EXACT"
        ? `exactly ${num(rfq.capacityT) ?? 0} t`
        : `at least ${num(rfq.capacityT) ?? 0} t`,
    capacityNote: orDash(rfq.capacityNote),
    applicationDescription: orDash(rfq.applicationDescription),
    loadDescription: orDash(rfq.loadDescription),
    mainBoomText:
      rfq.mainBoomM === null || rfq.mainBoomM === undefined
        ? "—"
        : `${num(rfq.mainBoomM)} m`,
    jibText:
      rfq.jibLengthM === null || rfq.jibLengthM === undefined
        ? "—"
        : `${num(rfq.jibLengthM)} m`,
    quantity: rfq.quantity as number,
    configuration: orDash(rfq.configuration),
    requiredStartDate:
      rfq.startDateTbc === true
        ? "To be confirmed"
        : formatDate(rfq.requiredStartDate as Date),
    durationText: durationText(
      num(rfq.durationValue) ?? 0,
      String(rfq.durationUnit),
    ),
    otCharges: orDash(rfq.otCharges),
    breakdownTerms: orDash(rfq.breakdownTerms),
    dieselScope: orDash(rfq.dieselScope),
    workingHoursShift: orDash(rfq.workingHoursShift),
    craneAgeCriteria:
      rfq.craneAgeCriteriaYears === null ||
      rfq.craneAgeCriteriaYears === undefined
        ? "—"
        : `Up to ${rfq.craneAgeCriteriaYears} years old`,
    accommodationConveyance: orDash(rfq.accommodationConveyance),
    paymentTerms: orDash(rfq.paymentTerms),
    mobilisationTerms: orDash(rfq.mobilisationTerms),
    supportCrane: orDash(rfq.supportCrane),
    steelMatsGroundPrep: orDash(rfq.steelMatsGroundPrep),
    ehsHrRequirements: orDash(rfq.ehsHrRequirements),
    insuranceTerms: orDash(rfq.insuranceTerms),
    extensionClause: orDash(rfq.extensionClause),
    submissionDeadline: formatDateTime(rfq.submissionDeadline as Date),
    smlContactName: orDash(rfq.smlContactName),
    smlContactMobile: orDash(rfq.smlContactMobile),
    smlContactEmail: orDash(rfq.smlContactEmail),
    rfqUrl: `${portalBase}/app/rfqs/${rfqId}`,
  };
}

/**
 * Send an RFQ by email (brief 6.7 dispatch).
 *
 * Every recipient is attempted even if an earlier one fails, each with its own
 * delivery status and error. The RFQ moves to Sent regardless: it was dispatched,
 * and the dashboard's job is to show which vendor did not get it.
 */
export async function sendRfq(rfqId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: SendRfqInput = sendRfqSchema.parse(raw);
  const rfq = await loadRfq(rfqId);

  if (rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict("This RFQ was cancelled and cannot be sent");
  }
  if (rfq.submissionDeadline.getTime() <= Date.now()) {
    throw AppError.conflict(
      "The submission deadline has passed, so this RFQ can no longer be sent",
    );
  }

  const channels = input.channels as MessageChannel[];
  if (channels.includes(MessageChannel.WHATSAPP) && !isWhatsAppConfigured()) {
    throw AppError.conflict(
      "WhatsApp is not configured on this deployment, so choose email only or ask an admin to finish the WhatsApp setup",
    );
  }

  const recipients = await resolveRecipients(input.vendorIds, channels);
  const full = await loadRfqForMail(rfqId);

  // The snapshot is what the sales user saw, filtered to each vendor's own cranes.
  const picker = await candidatesForRfq({
    id: rfq.id,
    craneType: full.craneType,
    capacityT: full.capacityT,
    capacityRule: full.capacityRule,
    requiredStartDate: full.requiredStartDate,
    durationValue: full.durationValue,
    durationUnit: full.durationUnit,
    startDateTbc: full.startDateTbc,
    workingDaysPerMonth: full.workingDaysPerMonth,
    siteLocation: full.siteLocation,
    siteStateCode: full.siteStateCode,
    siteLatitude: full.siteLatitude,
    siteLongitude: full.siteLongitude,
    site: full.siteState,
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const vars = invitationVars(full, rfqId, portalBase);
  const results: Array<{
    vendorId: string;
    status: string;
    emailStatus: string | null;
    whatsappStatus: string | null;
    error?: string;
  }> = [];

  for (const recipient of recipients) {
    const offered = [
      ...picker.located.flatMap((g) => g.cranes),
      ...picker.unverified,
    ].filter((c) => c.vendorId === recipient.vendorId);

    let emailStatus: EmailDeliveryStatus | null = null;
    let emailError: string | null = null;
    if (channels.includes(MessageChannel.EMAIL)) {
      emailStatus = EmailDeliveryStatus.SENT;
      for (const address of recipient.emails) {
        try {
          const sent = await sendTemplate({
            to: address,
            template: "rfq_invitation",
            entity: "rfq",
            entityId: rfqId,
            vars,
          });
          if (!sent.sent) {
            emailStatus = EmailDeliveryStatus.FAILED;
            emailError = sent.error ?? "The mail server refused the message";
          }
        } catch (err) {
          emailStatus = EmailDeliveryStatus.FAILED;
          emailError =
            err instanceof Error ? err.message : "The mail server refused the message";
        }
      }
    }

    let whatsappStatus: EmailDeliveryStatus | null = null;
    let whatsappError: string | null = null;
    const whatsappMessageIds: string[] = [];
    if (channels.includes(MessageChannel.WHATSAPP)) {
      whatsappStatus = EmailDeliveryStatus.SENT;
      // One message per vendor contact would spam the same office. The first
      // number is the RFQ contact; the row keeps every number for matching.
      for (const phone of recipient.phones.slice(0, 1)) {
        const sent = await sendWhatsAppTemplate({
          to: phone,
          vendorName: recipient.vendorName,
          rfqNumber: full.rfqNumber,
          siteLocation: full.siteLocation,
          submissionDeadline: String(vars.submissionDeadline),
          portalUrl: String(vars.rfqUrl),
        });
        if (sent.sent) {
          if (sent.messageId) whatsappMessageIds.push(sent.messageId);
        } else {
          whatsappStatus = EmailDeliveryStatus.FAILED;
          whatsappError = sent.error ?? "WhatsApp rejected the message";
        }
      }
    }

    const attempted: Array<EmailDeliveryStatus | null> = [emailStatus, whatsappStatus];
    const overall = attempted
      .filter((status): status is EmailDeliveryStatus => status !== null)
      .every((status) => status === EmailDeliveryStatus.SENT)
      ? EmailDeliveryStatus.SENT
      : EmailDeliveryStatus.FAILED;
    const error = [emailError, whatsappError].filter(Boolean).join("; ") || null;

    // Stored now, never recomputed: cranes move, and re-deriving this later would
    // rewrite what the vendor was actually offered.
    const snapshot = {
      capturedAt: new Date().toISOString(),
      siteDistanceMethod: picker.site.locationUnverified
        ? null
        : (picker.located[0]?.distanceMethod ?? null),
      cranes: offered,
    };

    await prisma.rfqVendorRecipient.upsert({
      where: { rfqId_vendorId: { rfqId, vendorId: recipient.vendorId } },
      create: {
        rfqId,
        vendorId: recipient.vendorId,
        emails: recipient.emails,
        emailDeliveryStatus: emailStatus ?? EmailDeliveryStatus.QUEUED,
        emailDeliveryError: emailError,
        whatsappPhones: recipient.phones,
        whatsappDeliveryStatus: whatsappStatus,
        whatsappDeliveryError: whatsappError,
        whatsappMessageIds,
        candidateSnapshot: snapshot as never,
      },
      update: {
        emails: recipient.emails,
        candidateSnapshot: snapshot as never,
        ...(emailStatus === null
          ? {}
          : {
              emailDeliveryStatus: emailStatus,
              emailDeliveryError: emailError,
            }),
        ...(whatsappStatus === null
          ? {}
          : {
              whatsappPhones: recipient.phones,
              whatsappDeliveryStatus: whatsappStatus,
              whatsappDeliveryError: whatsappError,
              whatsappMessageIds,
            }),
      },
    });

    results.push({
      vendorId: recipient.vendorId,
      status: overall,
      emailStatus,
      whatsappStatus,
      error: error ?? undefined,
    });
  }

  await prisma.rfq.update({
    where: { id: rfqId },
    data: {
      status: RfqStatus.SENT,
      sentAt: new Date(),
      channels,
      // Brief 6.7's roll-up, kept as an extension point for the later line-item
      // status trail. A re-send must not roll a Quotes-Received RFQ backwards.
      rollupStatus:
        (rfq.rollupStatus as RfqRollupStatus | null) ??
        RfqRollupStatus.AWAITING_QUOTES,
    },
  });

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "send",
    newValue: {
      recipients: results.length,
      failures: results.filter((r) => r.status === EmailDeliveryStatus.FAILED)
        .length,
    },
    actor: auditActor(actor),
  });

  // P1: dispatching an RFQ raised from an enquiry line moves that line's trail
  // to RFQ Sent. A hand-typed or SAP-fed RFQ has no line and skips this.
  if (rfq.enquiryLineId) {
    await onRfqSent(rfq.enquiryLineId, actor);
  }

  return {
    sent: results.filter((r) => r.status === EmailDeliveryStatus.SENT).length,
    failed: results.filter((r) => r.status === EmailDeliveryStatus.FAILED)
      .length,
    results,
  };
}

/** Candidate picker for an unsaved or saved RFQ (brief 7.9). */
export async function getCandidates(
  rfqId: string,
  rawQuery: unknown,
  actor: Actor,
) {
  assertInternal(actor);
  const query: CandidateQuery = candidateQuerySchema.parse(rawQuery ?? {});
  const rfq = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: {
      id: true,
      craneType: true,
      capacityT: true,
      capacityRule: true,
      requiredStartDate: true,
      durationValue: true,
      durationUnit: true,
      startDateTbc: true,
      workingDaysPerMonth: true,
      siteLocation: true,
      siteStateCode: true,
      siteLatitude: true,
      siteLongitude: true,
      siteState: { select: { name: true } },
    },
  });
  if (!rfq) throw AppError.notFound("That RFQ does not exist");
  return candidatesForRfq({ ...rfq, site: rfq.siteState }, { mode: query.mode });
}

// --- deadline actions ----------------------------------------------------

/** Extending the deadline (brief 6.7), with the notification section 8 requires. */
export async function extendDeadline(
  rfqId: string,
  raw: unknown,
  actor: Actor,
) {
  assertInternal(actor);
  const input: ExtendDeadlineInput = extendDeadlineSchema.parse(raw);
  const rfq = await loadRfq(rfqId);

  if (rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict(
      "This RFQ was cancelled and its deadline cannot be changed",
    );
  }
  if (input.submissionDeadline.getTime() <= rfq.submissionDeadline.getTime()) {
    throw AppError.badRequest(
      "A new deadline must be later than the current one. To bring a deadline forward, cancel the RFQ.",
    );
  }

  const previous = rfq.submissionDeadline;
  await prisma.rfq.update({
    where: { id: rfqId },
    data: { submissionDeadline: input.submissionDeadline },
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const pending = await prisma.rfqVendorRecipient.findMany({
    where: { rfqId, responseStatus: ResponseStatus.PENDING },
    select: { id: true, emails: true },
  });

  // C1: extending revives recipients who ran out of time without ever
  // responding. Expired means the sweep moved them there from Pending, so it
  // only ever holds vendors who never quoted — a vendor who did respond is
  // Quoted (or held a Quoted state) and is untouched. The window is open again,
  // so `lastReminderAt` is cleared to let the reminder job fire against the new
  // deadline rather than staying dampened by a stamp from the old one.
  const revived = await prisma.rfqVendorRecipient.findMany({
    where: { rfqId, responseStatus: ResponseStatus.EXPIRED },
    select: { id: true, emails: true },
  });
  if (revived.length > 0) {
    await prisma.rfqVendorRecipient.updateMany({
      where: { id: { in: revived.map((r) => r.id) } },
      data: { responseStatus: ResponseStatus.PENDING, lastReminderAt: null },
    });
  }

  for (const recipient of [...pending, ...revived]) {
    for (const address of recipient.emails) {
      await sendTemplate({
        to: address,
        template: "rfq_deadline_changed",
        entity: "rfq",
        entityId: rfqId,
        vars: {
          rfqNumber: rfq.rfqNumber,
          // The template's subject and body both interpolate {{changeKind}}, and
          // the reason is injected as a pre-escaped block rather than as text, so
          // a vendor's free-text reason cannot inject markup into the mail.
          changeKind: "extended",
          submissionDeadline: input.submissionDeadline.toISOString(),
          reasonBlock: optionalBlock(input.reason),
          rfqUrl: `${portalBase}/app/rfqs/${rfqId}`,
        },
      }).catch((err) =>
        console.error("[rfq] deadline-change mail failed", err),
      );
    }
  }

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "extend_deadline",
    oldValue: { submissionDeadline: previous.toISOString() },
    newValue: {
      submissionDeadline: input.submissionDeadline.toISOString(),
      reason: input.reason,
    },
    actor: auditActor(actor),
  });

  return {
    submissionDeadline: input.submissionDeadline.toISOString(),
    notified: pending.length + revived.length,
    revived: revived.length,
  };
}

/** Cancelling (brief 6.7). The reason is required and stored. */
export async function cancelRfq(rfqId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: CancelRfqInput = cancelRfqSchema.parse(raw);
  const rfq = await loadRfq(rfqId);

  if (rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict("This RFQ is already cancelled");
  }

  await prisma.rfq.update({
    where: { id: rfqId },
    data: {
      status: RfqStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    },
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const recipients = await prisma.rfqVendorRecipient.findMany({
    where: {
      rfqId,
      responseStatus: { in: [ResponseStatus.PENDING, ResponseStatus.QUOTED] },
    },
    select: { emails: true },
  });

  for (const recipient of recipients) {
    for (const address of recipient.emails) {
      await sendTemplate({
        to: address,
        template: "rfq_deadline_changed",
        entity: "rfq",
        entityId: rfqId,
        vars: {
          rfqNumber: rfq.rfqNumber,
          // Same template as an extension, so the subject line and body read
          // "cancelled" rather than "deadline changed". Both placeholders are
          // required: `render` leaves an unknown {{name}} untouched rather than
          // blanking it, so omitting them would email the vendor the literal
          // text "{{changeKind}}".
          changeKind: "cancelled",
          submissionDeadline: rfq.submissionDeadline.toISOString(),
          reasonBlock: optionalBlock(input.reason),
          rfqUrl: `${portalBase}/app/rfqs/${rfqId}`,
        },
      }).catch((err) => console.error("[rfq] cancellation mail failed", err));
    }
  }

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "cancel",
    newValue: { reason: input.reason },
    actor: auditActor(actor),
  });

  return { status: RfqStatus.CANCELLED, notified: recipients.length };
}

/**
 * A manual reminder (brief 6.7).
 *
 * Only Pending recipients: reminding someone who has already quoted or declined
 * is noise, and it would inflate a `reminderCount` that is meant to show chase
 * pressure.
 */
export async function remindRfq(rfqId: string, raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: RemindRfqInput = remindRfqSchema.parse(raw);
  const rfq = await loadRfq(rfqId);

  if (rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict(
      "This RFQ was cancelled, so there is nothing to remind about",
    );
  }

  const recipients = await prisma.rfqVendorRecipient.findMany({
    where: {
      rfqId,
      responseStatus: ResponseStatus.PENDING,
      ...(input.recipientIds?.length ? { id: { in: input.recipientIds } } : {}),
    },
    select: { id: true, emails: true, reminderCount: true },
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  // Resolved once, not per recipient: the state cannot change mid-loop, and the
  // reminder mail needs the name rather than the code the RFQ row carries.
  const siteStateName = await stateNameOf(rfq.siteStateCode);
  let sent = 0;

  for (const recipient of recipients) {
    for (const address of recipient.emails) {
      const result = await sendTemplate({
        to: address,
        template: "rfq_reminder",
        entity: "rfq",
        entityId: rfqId,
        vars: {
          rfqNumber: rfq.rfqNumber,
          submissionDeadline: rfq.submissionDeadline.toISOString(),
          siteLocation: rfq.siteLocation,
          siteState: siteStateName,
          rfqUrl: `${portalBase}/app/rfqs/${rfqId}`,
        },
      });
      if (result.sent) sent += 1;
    }
    await prisma.rfqVendorRecipient.update({
      where: { id: recipient.id },
      data: { reminderCount: { increment: 1 }, lastReminderAt: new Date() },
    });
  }

  await recordAudit({
    entity: "rfq",
    entityId: rfqId,
    action: "remind",
    newValue: { recipients: recipients.length, sent },
    actor: auditActor(actor),
  });

  return { reminded: recipients.length, sent };
}

/**
 * Expire recipients still Pending past the deadline (brief 6.7).
 *
 * Exposed as a callable function rather than wired to a timer: the scheduled
 * sweep is M7, and M4's acceptance is that the rule exists and can be run.
 *
 * The sweep only ever moves Pending forward. Revival is the other direction and
 * lives in `extendDeadline` (C1): a recipient the sweep expired — necessarily
 * one who never responded — is returned to Pending when SML gives the RFQ a
 * later deadline, so the vendor gets another working window instead of being
 * dead lettered over a deadline sales has since moved.
 */
export async function expireOverdueRecipients(
  now: Date = new Date(),
): Promise<number> {
  const overdue = await prisma.rfq.findMany({
    where: {
      submissionDeadline: { lt: now },
      status: { in: [RfqStatus.SENT, RfqStatus.DRAFT] },
      recipients: { some: { responseStatus: ResponseStatus.PENDING } },
    },
    select: { id: true },
  });

  const result = await prisma.rfqVendorRecipient.updateMany({
    where: {
      rfqId: { in: overdue.map((r) => r.id) },
      responseStatus: ResponseStatus.PENDING,
    },
    data: { responseStatus: ResponseStatus.EXPIRED },
  });

  return result.count;
}

/** Manual trigger for the sweep, for the internal screens and for tests. */
export async function runExpirySweep(actor: Actor) {
  assertInternal(actor);
  const expired = await expireOverdueRecipients();
  await recordAudit({
    entity: "rfq",
    entityId: "sweep",
    action: "expire_pending",
    newValue: { expired },
    actor: auditActor(actor),
  });
  return { expired };
}

/**
 * Automatic pre-deadline reminders (brief 6.7 as revised by C2).
 *
 * Pending recipients are reminded once the deadline is inside a per-RFQ lead
 * window: the smaller of the configured `RFQ_REMINDER_LEAD_HOURS` (default 24)
 * and half the RFQ's response window (send → deadline). Half the window is the
 * ceiling because an RFQ sent a couple of hours before its deadline must not be
 * chased the moment it goes out — the reminder belongs in the last half of the
 * time the vendor actually has. A window shorter than
 * `RFQ_REMINDER_MIN_WINDOW_HOURS` (default 4) is never chased at all: there is
 * no room to act on a nudge, only a deadline to meet.
 *
 * A manual reminder sent to the same recipient counts as the chase: re-sending
 * within a day of any reminder would be duplication, so the sweep skips anyone
 * whose `lastReminderAt` is inside the last 24 hours.
 *
 * Only live RFQs are chased: a draft was never dispatched, a cancelled one says
 * so already, and a closed one has an outcome. Losses on send are swallowed and
 * logged — the deadline is what it is, and the sweep's job is to try.
 */
export async function runAutomaticRfqReminders(
  now: Date = new Date(),
): Promise<{ reminded: number; sent: number }> {
  const settings = await getSettings();
  const leadMs = settings.rfqReminderLeadHours * 3_600_000;
  const minWindowMs = settings.rfqReminderMinWindowHours * 3_600_000;
  // The per-RFQ window is at most the lead, so this is a safe upper bound; the
  // half-window cases are trimmed below.
  const horizon = new Date(now.getTime() + leadMs);
  const freshReminderMs = 24 * 3_600_000;

  const candidates = await prisma.rfqVendorRecipient.findMany({
    where: {
      responseStatus: ResponseStatus.PENDING,
      rfq: {
        status: RfqStatus.SENT,
        submissionDeadline: { gt: now, lte: horizon },
      },
      OR: [
        { lastReminderAt: null },
        { lastReminderAt: { lt: new Date(now.getTime() - freshReminderMs) } },
      ],
    },
    select: {
      id: true,
      emails: true,
      rfq: {
        select: {
          id: true,
          rfqNumber: true,
          submissionDeadline: true,
          sentAt: true,
          createdAt: true,
          siteLocation: true,
          siteState: { select: { name: true } },
        },
      },
    },
  });

  const due = candidates.filter((candidate) => {
    const sentAt = candidate.rfq.sentAt ?? candidate.rfq.createdAt;
    const windowMs = candidate.rfq.submissionDeadline.getTime() - sentAt.getTime();
    if (windowMs < minWindowMs) return false;
    const reminderLeadMs = Math.min(leadMs, windowMs / 2);
    return now.getTime() >= candidate.rfq.submissionDeadline.getTime() - reminderLeadMs;
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  let sent = 0;

  for (const candidate of due) {
    for (const address of candidate.emails) {
      const result = await sendTemplate({
        to: address,
        template: "rfq_reminder",
        entity: "rfq",
        entityId: candidate.rfq.id,
        vars: {
          rfqNumber: candidate.rfq.rfqNumber,
          submissionDeadline: candidate.rfq.submissionDeadline.toISOString(),
          siteLocation: candidate.rfq.siteLocation,
          siteState: candidate.rfq.siteState?.name ?? "",
          rfqUrl: `${portalBase}/app/rfqs/${candidate.rfq.id}`,
        },
      }).catch((err) => {
        console.error("[rfq] automatic reminder failed", err);
        return null;
      });
      if (result?.sent) sent += 1;
    }

    await prisma.rfqVendorRecipient.update({
      where: { id: candidate.id },
      data: { reminderCount: { increment: 1 }, lastReminderAt: now },
    });
  }

  return { reminded: due.length, sent };
}

export type { CandidateCrane };

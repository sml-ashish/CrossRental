import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { recordAudit } from "./audit.service";
import { nextRfqNumber } from "./rfqNumber.service";
import { candidatesForRfq, type CandidateCrane } from "./candidate.service";
import { invalidateDistancesFrom } from "./distance.service";
import { tryGeocode, isInsideIndia, type GeoPoint } from "../lib/geo";
import { sendTemplate, optionalBlock } from "./email.service";
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
  type CreateRfqInput,
  type UpdateRfqInput,
  type SendRfqInput,
  type ExtendDeadlineInput,
  type CancelRfqInput,
  type RemindRfqInput,
  type ConfirmSitePinInput,
  type ListRfqsQuery,
  type ListApprovedVendorsQuery,
} from "../validation/rfqFields";
import {
  CoordinateSource,
  DistanceMethod,
  DurationUnit,
  EmailDeliveryStatus,
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
  craneType: true,
  capacityT: true,
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
  siteState: { select: { name: true } },
  craneTypeRef: { select: { name: true } },
  createdBy: { select: { id: true, email: true, fullName: true } },
} as const;

type RfqRow = {
  id: string;
  rfqNumber: string;
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
 * Extracted because create and update were writing the same eleven fields twice,
 * and a list that appears twice is a list that will drift: the day a term is
 * added to the schema, one copy is missed and the field silently stops being
 * editable on drafts.
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
    notes: input.notes,
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

export async function createRfq(raw: unknown, actor: Actor) {
  assertInternal(actor);
  const input: CreateRfqInput = createRfqSchema.parse(raw);
  await assertCraneType(input.craneType);
  const stateName = await stateNameOf(input.siteStateCode);

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
    enquiryNo: input.enquiryNo,
    lineNo: input.lineNo,
    craneType: input.craneType,
    capacityT: input.capacityT,
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
    enquiryNo: input.enquiryNo,
    lineNo: input.lineNo,
    craneType: input.craneType,
    capacityT: input.capacityT,
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
        (r) => r.emailDeliveryStatus === EmailDeliveryStatus.FAILED,
      ).length,
      pendingCount: recipients.filter(
        (r) => r.responseStatus === ResponseStatus.PENDING,
      ).length,
      recipients: recipients.map((r) => ({
        recipientId: r.id,
        vendorName: r.vendor.name,
        emailDeliveryStatus: r.emailDeliveryStatus,
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
          firstViewedAt: true,
          responseStatus: true,
          respondedAt: true,
          declineReason: true,
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
      firstViewedAt: r.firstViewedAt,
      responseStatus: r.responseStatus,
      respondedAt: r.respondedAt,
      declineReason: r.declineReason,
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
      totalQuotedValue: true,
      validityDate: true,
      distanceToSiteKm: true,
      distanceMethod: true,
      warnings: true,
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
    totalQuotedValue: num(r.totalQuotedValue) ?? 0,
    validityDate: r.validityDate,
    distanceToSiteKm: num(r.distanceToSiteKm),
    distanceMethod: r.distanceMethod,
    distanceApproximate: r.distanceMethod === DistanceMethod.straight_line,
    warnings: (r.warnings as string[] | null) ?? [],
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
): Promise<Array<{ vendorId: string; vendorName: string; emails: string[] }>> {
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: {
      id: true,
      name: true,
      onboardingStatus: true,
      users: {
        where: { role: "vendor_user", isActive: true },
        select: { email: true },
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
    const emails = vendor.users.map((u) => u.email);
    if (emails.length === 0) {
      refused.push(`${vendor.name ?? "A vendor"} has no active user to email`);
      return [];
    }
    return [
      {
        vendorId: vendor.id,
        vendorName: vendor.name ?? "Unnamed vendor",
        emails,
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
    quantity: rfq.quantity as number,
    configuration: orDash(rfq.configuration),
    requiredStartDate: formatDate(rfq.requiredStartDate as Date),
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

  const recipients = await resolveRecipients(input.vendorIds);
  const full = await loadRfqForMail(rfqId);

  // The snapshot is what the sales user saw, filtered to each vendor's own cranes.
  const picker = await candidatesForRfq({
    id: rfq.id,
    craneType: full.craneType,
    capacityT: full.capacityT,
    requiredStartDate: full.requiredStartDate,
    siteLocation: full.siteLocation,
    siteStateCode: full.siteStateCode,
    siteLatitude: full.siteLatitude,
    siteLongitude: full.siteLongitude,
    site: full.siteState,
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const vars = invitationVars(full, rfqId, portalBase);
  const results: Array<{ vendorId: string; status: string; error?: string }> =
    [];

  for (const recipient of recipients) {
    const offered = [
      ...picker.located.flatMap((g) => g.cranes),
      ...picker.unverified,
    ].filter((c) => c.vendorId === recipient.vendorId);

    let delivery: EmailDeliveryStatus = EmailDeliveryStatus.SENT;
    let error: string | null = null;

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
          delivery = EmailDeliveryStatus.FAILED;
          error = sent.error ?? "The mail server refused the message";
        }
      } catch (err) {
        delivery = EmailDeliveryStatus.FAILED;
        error =
          err instanceof Error
            ? err.message
            : "The mail server refused the message";
      }
    }

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
        emailDeliveryStatus: delivery,
        emailDeliveryError: error,
        candidateSnapshot: snapshot as never,
      },
      update: {
        emails: recipient.emails,
        emailDeliveryStatus: delivery,
        emailDeliveryError: error,
        candidateSnapshot: snapshot as never,
      },
    });

    results.push({
      vendorId: recipient.vendorId,
      status: delivery,
      error: error ?? undefined,
    });
  }

  await prisma.rfq.update({
    where: { id: rfqId },
    data: {
      status: RfqStatus.SENT,
      sentAt: new Date(),
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

  return {
    sent: results.filter((r) => r.status === EmailDeliveryStatus.SENT).length,
    failed: results.filter((r) => r.status === EmailDeliveryStatus.FAILED)
      .length,
    results,
  };
}

/** Candidate picker for an unsaved or saved RFQ (brief 7.9). */
export async function getCandidates(rfqId: string, actor: Actor) {
  assertInternal(actor);
  const rfq = await prisma.rfq.findUnique({
    where: { id: rfqId },
    select: {
      id: true,
      craneType: true,
      capacityT: true,
      requiredStartDate: true,
      siteLocation: true,
      siteStateCode: true,
      siteLatitude: true,
      siteLongitude: true,
      siteState: { select: { name: true } },
    },
  });
  if (!rfq) throw AppError.notFound("That RFQ does not exist");
  return candidatesForRfq({ ...rfq, site: rfq.siteState });
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

  for (const recipient of pending) {
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
    notified: pending.length,
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
 * Extending the deadline does *not* revive an already Expired recipient.
 * Extending exists so a vendor who quoted can keep revising and so a
 * still-Pending recipient gets a longer window; Expired is a response state the
 * vendor can see (brief 6.8 lists it in their RFQ list), so rewriting it would
 * contradict what they were already shown. The brief requires no revival, and
 * the sweep only ever moves Pending forward.
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

export type { CandidateCrane };

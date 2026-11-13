import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { recordAudit } from "./audit.service";
import { onBooked, onVendorFinalised } from "./enquiryTrail.service";
import { sendTemplate, optionalBlock } from "./email.service";
import { getSettings } from "../utils/settings";
import { getMasterLists } from "../utils/masterLists";
import {
  findOverlappingReservation,
  craneLabelOf,
  reservationWindowForRfq,
} from "./reservations.service";
import { type DayBasisContext } from "../validation/quotationFields";
import type { AuthedRequest } from "../middleware/auth";
import { awardQuotationSchema, type AwardQuotationInput } from "../validation/awardFields";
import {
  CraneStatus,
  QuotationStatus,
  ReservationStatus,
  ReservationType,
  ResponseStatus,
  RfqStatus,
} from "../generated/prisma/client";

/**
 * Award (brief 6.7 as revised, M7 + phase B2).
 *
 * Sales-side comparison and selection screens are out of scope; they ship later
 * and will call this same function. That is why every rule lives here and the
 * controller only shapes HTTP — the future screen gets the behaviour for free
 * and cannot re-derive it differently.
 *
 * Phase B2 reworks what an award *is*. It no longer flips a flag on the crane;
 * it creates a dated **reservation** (brief 5.3/6.1). The consequences:
 *
 * - **Booked/Hired are never stored.** The winning crane keeps whatever status
 *   its vendor last set; its commitment is the reservation, and the badge is
 *   derived from that everywhere (see `reservations.service.ts`).
 * - **The window must be real.** The reservation is derived from the RFQ's
 *   required start and duration, or supplied explicitly when the start date is
 *   TBC, because a reservation without dates is the flag we just removed.
 * - **A crane cannot be double-booked.** The award refuses a crane that is Under
 *   Maintenance or already has an overlapping ACTIVE reservation — the same rule
 *   the database enforces with `reservations_active_no_overlap`, so a second
 *   contract for the same crane in the same window is refused ("crane now
 *   reserved") rather than silently colliding.
 * - **Awards are partial until the quantity is met.** The RFQ's `quantity` is
 *   how many cranes the requirement is for, so one award on a quantity-2 RFQ
 *   leaves the other quotations open; only the award that reaches the quantity
 *   sets the remaining latest Submitted quotations to Not Awarded and closes the
 *   RFQ.
 *
 * Emails and audit entries follow the transaction. A failed email is logged and
 * swallowed: the award has happened, and the portal shows the result, so an SMTP
 * outage must not roll it back.
 *
 * P3 widens *who* may award: this one function is now the CR path from the
 * comparison screen (BPD 6.16), so `sales_user` may call it as well as admin.
 * There is still exactly one implementation — the screen calls this, not a copy.
 */

/**
 * Award is the one SML action that books a crane and emails every vendor on the
 * RFQ. Since P3 both internal roles may take it (the CR team owns the award; an
 * admin holds it as an override), but nobody else can. The service re-checks the
 * role, because a route mounted too loosely later must not widen this.
 */
function assertCanAward(actor: {
  role: AuthedRequest["user"]["role"];
}): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can award a quotation");
  }
}

/**
 * Loads the quotation to award, with everything the transaction needs. The RFQ
 * carries the dates and quantity the reservation is built from.
 */
async function loadAwardableQuotation(rfqId: string, quotationId: string) {
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, rfqId },
    select: {
      id: true,
      rfqId: true,
      vendorId: true,
      craneId: true,
      version: true,
      isLatest: true,
      status: true,
      totalQuotedValue: true,
      rfq: {
        select: {
          id: true,
          rfqNumber: true,
          status: true,
          enquiryLineId: true,
          quantity: true,
          requiredStartDate: true,
          durationValue: true,
          durationUnit: true,
          startDateTbc: true,
          workingDaysPerMonth: true,
        },
      },
      vendor: { select: { name: true } },
      crane: {
        select: {
          id: true,
          currentStatus: true,
          isActive: true,
          serialRegistrationNo: true,
          capacityT: true,
          typeOfCrane: { select: { name: true } },
        },
      },
    },
  });
  if (!quotation) throw AppError.notFound("That quotation was not found on this RFQ");
  return quotation;
}

type AwardableQuotation = Awaited<ReturnType<typeof loadAwardableQuotation>>;

/**
 * The reservation window the award will book.
 *
 * The RFQ knows the start and duration, so the window is usually derived. When
 * the start date is TBC the RFQ has no datable start, so the caller must supply
 * both ends — the alternative is the undated flag phase B removed.
 */
function reservationWindow(
  rfq: AwardableQuotation["rfq"],
  input: AwardQuotationInput,
  dayBasis: DayBasisContext,
): { start: Date; end: Date } {
  if (input.startDate && input.endDate) {
    return { start: input.startDate, end: input.endDate };
  }
  if (input.startDate || input.endDate) {
    throw AppError.badRequest(
      "Provide both the reservation start and end dates, or neither",
    );
  }

  const derived = reservationWindowForRfq(rfq, dayBasis);
  if (!derived) {
    throw AppError.badRequest(
      "This RFQ's start date is to be confirmed: enter the reservation dates when awarding",
    );
  }
  return derived;
}

/** The quotes that can realistically be awarded, with their reasons for refusal. */
function assertAwardable(quotation: AwardableQuotation) {
  if (!quotation.isLatest) {
    throw AppError.conflict(
      `This quotation is superseded by version ${quotation.version + 1} or later. Award the latest version.`,
    );
  }
  if (
    quotation.status !== QuotationStatus.SUBMITTED &&
    quotation.status !== QuotationStatus.UNDER_REVIEW &&
    quotation.status !== QuotationStatus.SHORTLISTED
  ) {
    throw AppError.conflict(
      `This quotation is ${quotation.status.toLowerCase().replace(/_/g, " ")} and cannot be awarded.`,
    );
  }
  if (quotation.rfq.status === RfqStatus.CANCELLED) {
    throw AppError.conflict("This RFQ was cancelled and cannot be awarded");
  }
  if (quotation.rfq.status === RfqStatus.CLOSED) {
    throw AppError.conflict("This RFQ has already been finalised");
  }
  if (!quotation.crane.isActive) {
    throw AppError.conflict(
      "The crane on this quotation has been deactivated by the vendor, so the award cannot be booked",
    );
  }
  if (quotation.crane.currentStatus === CraneStatus.UNDER_MAINTENANCE) {
    throw AppError.conflict(
      "The crane on this quotation is under maintenance and cannot be awarded",
    );
  }
  if (
    quotation.crane.currentStatus === CraneStatus.BOOKED ||
    quotation.crane.currentStatus === CraneStatus.HIRED
  ) {
    throw AppError.conflict(
      "The crane on this quotation is already committed to SML on another contract",
    );
  }
}

export interface AwardResult {
  awarded: true;
  quotationId: string;
  craneId: string;
  reservationId: string;
  reservationStart: string;
  reservationEnd: string;
  rfqNumber: string;
  /** False while the RFQ's quantity is not yet reached. */
  partial: boolean;
  quantity: number;
  awardedCount: number;
  rfqClosed: boolean;
  notAwardedCount: number;
  notifiedAwarded: number;
  notifiedNotAwarded: number;
}

export async function awardQuotation(
  rfqId: string,
  quotationId: string,
  raw: unknown,
  actor: { id: string; email: string; role: AuthedRequest["user"]["role"]; vendorId: string | null },
): Promise<AwardResult> {
  assertCanAward(actor);
  const input: AwardQuotationInput = awardQuotationSchema.parse(raw ?? {});

  // The award reason code is checked against the admin's list when it is
  // configured; an empty list means "not set up yet", not "no code allowed".
  if (input.reasonCode !== null && input.reasonCode !== undefined) {
    const codes = (await getMasterLists()).AWARD_REASON_CODES;
    const known = codes.some(
      (code) => code.toLowerCase() === input.reasonCode?.toLowerCase(),
    );
    if (codes.length > 0 && !known) {
      throw AppError.badRequest(
        `"${input.reasonCode}" is not one of the configured award reason codes`,
      );
    }
  }

  const quotation = await loadAwardableQuotation(rfqId, quotationId);
  assertAwardable(quotation);

  const settings = await getSettings();
  const dayBasis: DayBasisContext = {
    rateDayBasis: settings.rateDayBasis,
    workingDaysPerMonth: quotation.rfq.workingDaysPerMonth,
  };
  const window = reservationWindow(quotation.rfq, input, dayBasis);

  // One crane, one window. The database refuses a collision too; this is the
  // friendly check that names the clash, so a partial-award or parallel-RFQ
  // attempt reads as "crane now reserved" rather than a constraint error.
  const clash = await findOverlappingReservation(
    quotation.craneId,
    window.start,
    window.end,
  );
  if (clash) {
    throw AppError.conflict(
      `This crane is already reserved for ${clash.startDate.toISOString().slice(0, 10)} to ` +
        `${clash.endDate.toISOString().slice(0, 10)}; the crane is now reserved and cannot be awarded for an overlapping period`,
    );
  }

  const alreadyAwarded = await prisma.quotation.count({
    where: { rfqId, status: QuotationStatus.SELECTED },
  });
  const quantity = quotation.rfq.quantity;
  if (alreadyAwarded >= quantity) {
    throw AppError.conflict("This RFQ has already been finalised");
  }
  const awardedCount = alreadyAwarded + 1;
  const closing = awardedCount >= quantity;

  const auditActor = {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];

  // Not-awarded covers every *live* quotation on the RFQ: superseded versions
  // and withdrawn ones stay as they are, because their vendor already knows
  // their state and rewriting it would contradict what the history shows. Only
  // read when closing, since a partial award leaves them open.
  const liveOthers = closing
    ? await prisma.quotation.findMany({
        where: {
          rfqId,
          id: { not: quotation.id },
          isLatest: true,
          status: {
            in: [
              QuotationStatus.SUBMITTED,
              QuotationStatus.UNDER_REVIEW,
              QuotationStatus.SHORTLISTED,
              // A quotation the CR team rejected internally is still a live
              // offer to the vendor; on close it must become Not Awarded rather
              // than linger as a mark the vendor would read as Submitted.
              QuotationStatus.REJECTED,
            ],
          },
        },
        select: {
          id: true,
          vendorId: true,
          crane: { select: { typeOfCrane: { select: { name: true } }, capacityT: true, serialRegistrationNo: true } },
          vendor: { select: { name: true } },
          totalQuotedValue: true,
        },
      })
    : [];

  const recipients = await prisma.rfqVendorRecipient.findMany({
    where: { rfqId },
    select: { vendorId: true, emails: true },
  });
  const emailsByVendor = new Map(recipients.map((r) => [r.vendorId, r.emails]));

  let reservationId = "";
  /** Recipients moved from Pending to Finalised by this closing award. */
  let finalisedRecipients = 0;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id: quotation.id },
        data: {
          status: QuotationStatus.SELECTED,
          statusReasonCode: input.reasonCode,
          statusReasonText: input.reason,
          statusChangedAt: new Date(),
          statusChangedById: actor.id,
        },
      });

      // The commitment is the reservation, not a status write (brief 6.1).
      const reservation = await tx.reservation.create({
        data: {
          craneId: quotation.craneId,
          startDate: window.start,
          endDate: window.end,
          type: ReservationType.BOOKED,
          status: ReservationStatus.ACTIVE,
          rfqId,
          quotationId: quotation.id,
          enquiryLineId: quotation.rfq.enquiryLineId,
          createdById: actor.id,
        },
        select: { id: true },
      });
      reservationId = reservation.id;

      // The award also marks the winning crane Engaged and moves its
      // availability date to the end of the booking, so the vendor's own fleet
      // reads it as committed rather than still Available. Recorded as an
      // on-behalf change: an SML user made it for the vendor.
      await tx.crane.update({
        where: { id: quotation.craneId },
        data: {
          currentStatus: CraneStatus.ENGAGED,
          availableFrom: window.end,
          statusUpdatedAt: new Date(),
          updatedOnBehalf: true,
          updatedBy: actor.id,
        },
      });

      if (closing) {
        if (liveOthers.length > 0) {
          await tx.quotation.updateMany({
            where: { id: { in: liveOthers.map((q) => q.id) } },
            data: { status: QuotationStatus.NOT_AWARDED },
          });
        }

        // A vendor who never quoted has no quotation row to carry the outcome,
        // so the recipient row is the only place it can live. Left PENDING it
        // would keep reading "Awaiting your quote" and stay in that vendor's
        // to-do list even though the RFQ is finalised. Only PENDING moves: a
        // vendor who did quote keeps QUOTED, and their quotation already says
        // Not Awarded.
        const finalised = await tx.rfqVendorRecipient.updateMany({
          where: { rfqId, responseStatus: ResponseStatus.PENDING },
          data: { responseStatus: ResponseStatus.FINALISED },
        });
        finalisedRecipients = finalised.count;

        await tx.rfq.update({
          where: { id: rfqId },
          data: { status: RfqStatus.CLOSED },
        });
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("reservations_active_no_overlap")) {
      throw AppError.conflict(
        "This crane was just reserved for an overlapping period and cannot be awarded",
      );
    }
    throw error;
  }

  // P1: an award creates the reservation, which is what "Booked" means for the
  // enquiry line. A partial award books its own line too; the roll-up then
  // reads Partially or Fully Finalised from the lines.
  //
  // P3 (BPD 6.16) puts Vendor Finalised before Booked, even though the trail
  // would let the reservation jump straight to Booked: the sequence is the
  // record of "a vendor was chosen" then "the crane was reserved", and audit
  // readers look for both.
  if (quotation.rfq.enquiryLineId) {
    await onVendorFinalised(quotation.rfq.enquiryLineId, actor);
    await onBooked(quotation.rfq.enquiryLineId, actor);
  }

  await recordAudit({
    entity: "quotation",
    entityId: quotation.id,
    action: "award",
    oldValue: { status: quotation.status, version: quotation.version },
    newValue: {
      status: QuotationStatus.SELECTED,
      craneId: quotation.craneId,
      reservationId,
      reservationStart: window.start.toISOString(),
      reservationEnd: window.end.toISOString(),
      craneStatus: CraneStatus.ENGAGED,
      craneAvailableFrom: window.end.toISOString(),
      awardedCount,
      quantity,
      partial: !closing,
      rfqStatus: closing ? RfqStatus.CLOSED : quotation.rfq.status,
      notAwarded: liveOthers.map((q) => q.id),
      finalisedRecipients,
      reason: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
    },
    craneId: quotation.craneId,
    actor: auditActor,
  });

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  const rfqUrl = `${portalBase}/app/rfqs/${rfqId}`;
  const periodText =
    window.start.getTime() === window.end.getTime()
      ? window.start.toISOString().slice(0, 10)
      : `${window.start.toISOString().slice(0, 10)} to ${window.end.toISOString().slice(0, 10)}`;

  const awardedEmails = emailsByVendor.get(quotation.vendorId) ?? [];
  let notifiedAwarded = 0;
  for (const address of awardedEmails) {
    await sendTemplate({
      to: address,
      template: "quotation_awarded",
      entity: "quotation",
      entityId: quotation.id,
      vars: {
        rfqNumber: quotation.rfq.rfqNumber,
        vendorName: quotation.vendor.name ?? "The vendor",
        craneLabel: craneLabelOf(quotation.crane),
        totalQuotedValue: Number(quotation.totalQuotedValue).toFixed(2),
        periodText,
        reasonBlock: optionalBlock(input.reason),
        rfqUrl,
      },
    })
      .then((r) => {
        if (r.sent) notifiedAwarded += 1;
      })
      .catch((err) => console.error("[award] awarded email failed", err));
  }

  // Whichever vendor the RFQ was dispatched to, whichever address received the
  // enquiry receives the outcome — the same fail-per-address tolerance the
  // dispatch loop uses. Only a closing award has an outcome to tell the others.
  let notifiedNotAwarded = 0;
  for (const other of liveOthers) {
    for (const address of emailsByVendor.get(other.vendorId) ?? []) {
      await sendTemplate({
        to: address,
        template: "quotation_not_awarded",
        entity: "quotation",
        entityId: other.id,
        vars: {
          rfqNumber: quotation.rfq.rfqNumber,
          vendorName: other.vendor.name ?? "The vendor",
          craneLabel: craneLabelOf(other.crane),
          reasonBlock: optionalBlock(input.reason),
          rfqUrl,
        },
      })
        .then((r) => {
          if (r.sent) notifiedNotAwarded += 1;
        })
        .catch((err) =>
          console.error("[award] not-awarded email failed", err),
        );
    }
  }

  return {
    awarded: true,
    quotationId: quotation.id,
    craneId: quotation.craneId,
    reservationId,
    reservationStart: window.start.toISOString(),
    reservationEnd: window.end.toISOString(),
    rfqNumber: quotation.rfq.rfqNumber,
    partial: !closing,
    quantity,
    awardedCount,
    rfqClosed: closing,
    notAwardedCount: liveOthers.length,
    notifiedAwarded,
    notifiedNotAwarded,
  };
}

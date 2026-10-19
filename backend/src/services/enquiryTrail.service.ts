import { prisma } from "../lib/database";
import type { AuthedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { recordAudit } from "./audit.service";
import {
  EnquiryLineTrailStatus,
  EnquiryOverallStatus,
} from "../generated/prisma/client";

/**
 * The line-item status trail (BPD 6.5, P1 section 3) and the enquiry roll-up
 * (P1 section 4).
 *
 * Status is event driven and never typed in: every entry point here is called
 * from the action that causes the move (an RFQ dispatch, a quotation arriving,
 * an award, an internal check), and each change is audited. The forward rank
 * table means a re-send cannot roll a line back from Quotes Received to RFQ
 * Sent — the only statuses that can move a line backwards are the terminal
 * CANCELLED and an explicit internal-fulfilment outcome.
 *
 * Kept in its own module so `rfq`, `quotation` and `award` services can call it
 * without importing each other (which would be a cycle).
 */

export interface TrailActor {
  id: string;
  email: string;
  role: AuthedRequest["user"]["role"];
  vendorId: string | null;
}

function auditActor(actor: TrailActor | null): AuthedRequest["user"] | null {
  if (!actor) return null;
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];
}

/** Forward order of the trail. Higher rank means further along. */
const RANK: Record<EnquiryLineTrailStatus, number> = {
  NEW: 0,
  AVAILABILITY_CHECK: 1,
  VENDOR_SHORTLISTED: 2,
  RFQ_SENT: 3,
  AWAITING_QUOTES: 4,
  QUOTES_RECEIVED: 5,
  UNDER_EVALUATION: 6,
  VENDOR_FINALISED: 7,
  BOOKED: 8,
  CLOSED: 9,
  FULFILLED_INTERNALLY: 9,
  CANCELLED: 99,
};

/** A line that has reached a finished outcome, whatever the outcome was. */
const DONE: EnquiryLineTrailStatus[] = [
  EnquiryLineTrailStatus.VENDOR_FINALISED,
  EnquiryLineTrailStatus.BOOKED,
  EnquiryLineTrailStatus.FULFILLED_INTERNALLY,
  EnquiryLineTrailStatus.CLOSED,
];

const CLOSED: EnquiryLineTrailStatus[] = [
  EnquiryLineTrailStatus.CLOSED,
  EnquiryLineTrailStatus.CANCELLED,
];

const QUOTED: EnquiryLineTrailStatus[] = [
  EnquiryLineTrailStatus.QUOTES_RECEIVED,
  EnquiryLineTrailStatus.UNDER_EVALUATION,
];

/** The enquiry header status implied by its lines (P1 section 4). */
export function rollupOf(
  statuses: EnquiryLineTrailStatus[],
): EnquiryOverallStatus {
  if (statuses.length === 0) {
    return EnquiryOverallStatus.RECEIVED_PENDING_SOURCING;
  }
  if (statuses.every((s) => CLOSED.includes(s))) {
    return EnquiryOverallStatus.CLOSED;
  }
  if (statuses.every((s) => DONE.includes(s))) {
    return EnquiryOverallStatus.FULLY_FINALISED;
  }
  if (statuses.some((s) => DONE.includes(s))) {
    return EnquiryOverallStatus.PARTIALLY_FINALISED;
  }
  if (statuses.some((s) => QUOTED.includes(s))) {
    return EnquiryOverallStatus.PARTIALLY_QUOTED;
  }
  return EnquiryOverallStatus.RECEIVED_PENDING_SOURCING;
}

export async function recomputeRollup(
  enquiryId: string,
  actor: TrailActor | null = null,
): Promise<EnquiryOverallStatus> {
  const lines = await prisma.enquiryLineItem.findMany({
    where: { enquiryId },
    select: { trailStatus: true },
  });
  const next = rollupOf(lines.map((l) => l.trailStatus));

  const current = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { overallStatus: true },
  });
  if (!current) throw AppError.notFound("That enquiry does not exist");

  if (current.overallStatus !== next) {
    await prisma.enquiry.update({
      where: { id: enquiryId },
      data: { overallStatus: next },
    });
    await recordAudit({
      entity: "enquiry",
      entityId: enquiryId,
      action: "rollup",
      oldValue: { overallStatus: current.overallStatus },
      newValue: { overallStatus: next },
      actor: auditActor(actor),
    });
  }
  return next;
}

/**
 * Move a line to `next`, unless the move would go backwards or is a no-op.
 * Terminal outcomes (CANCELLED, FULFILLED_INTERNALLY) always apply.
 */
export async function advanceLine(
  lineId: string,
  next: EnquiryLineTrailStatus,
  actor: TrailActor | null,
  detail: Record<string, unknown> = {},
): Promise<{ changed: boolean; status: EnquiryLineTrailStatus }> {
  const line = await prisma.enquiryLineItem.findUnique({
    where: { id: lineId },
    select: { id: true, enquiryId: true, trailStatus: true },
  });
  if (!line) throw AppError.notFound("That enquiry line does not exist");

  // A cancelled line is final: nothing revives it, not even another terminal
  // outcome. A new requirement is a new line.
  if (line.trailStatus === EnquiryLineTrailStatus.CANCELLED) {
    return { changed: false, status: line.trailStatus };
  }

  const forward = RANK[next] >= RANK[line.trailStatus];
  const terminal =
    next === EnquiryLineTrailStatus.CANCELLED ||
    next === EnquiryLineTrailStatus.FULFILLED_INTERNALLY;
  if (!forward && !terminal) {
    return { changed: false, status: line.trailStatus };
  }
  if (next === line.trailStatus) {
    return { changed: false, status: line.trailStatus };
  }

  await prisma.enquiryLineItem.update({
    where: { id: lineId },
    data: { trailStatus: next },
  });
  await recordAudit({
    entity: "enquiry_line",
    entityId: lineId,
    action: "trail",
    oldValue: { trailStatus: line.trailStatus },
    newValue: { trailStatus: next, ...detail },
    actor: auditActor(actor),
  });
  await recomputeRollup(line.enquiryId, actor);
  return { changed: true, status: next };
}

// --- triggers -------------------------------------------------------------

/** At least one vendor ticked in the picker for this line (BPD 6.5). */
export function onVendorShortlisted(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.VENDOR_SHORTLISTED, actor);
}

/** An RFQ for the line was dispatched. */
export function onRfqSent(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.RFQ_SENT, actor);
}

/** The first quotation for the line arrived. */
export function onQuotesReceived(lineId: string, actor: TrailActor | null) {
  return advanceLine(lineId, EnquiryLineTrailStatus.QUOTES_RECEIVED, actor);
}

/** A CR user marked the first quotation in comparison (P2/P3). */
export function onUnderEvaluation(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.UNDER_EVALUATION, actor);
}

/** Selection confirmed (P3): chosen source finalised. */
export function onVendorFinalised(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.VENDOR_FINALISED, actor);
}

/** A reservation was created for the line. */
export function onBooked(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.BOOKED, actor);
}

export function onClosed(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.CLOSED, actor);
}

export function onFulfilledInternally(
  lineId: string,
  actor: TrailActor,
  notes: string | null,
) {
  return advanceLine(
    lineId,
    EnquiryLineTrailStatus.FULFILLED_INTERNALLY,
    actor,
    { notes },
  );
}

export function onAvailabilityCheck(lineId: string, actor: TrailActor) {
  return advanceLine(lineId, EnquiryLineTrailStatus.AVAILABILITY_CHECK, actor);
}

export function onCancelledLine(
  lineId: string,
  actor: TrailActor,
  reason: string,
) {
  return advanceLine(lineId, EnquiryLineTrailStatus.CANCELLED, actor, {
    reason,
  });
}

import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { Actor } from "./crane.service";

/**
 * Communication history (BPD 6.21): the chronological messages behind an
 * enquiry, a line, an RFQ or a quotation.
 *
 * It is built on `EmailLog`, which records both outbound mail and the inbound
 * email/WhatsApp replies P6 captures. Each entry says whether it carried a
 * business event (dispatch, award, not-award, reminder) so the screen reads as
 * a trail rather than a mailbox.
 */

export interface CommunicationActor {
  id: string;
  email: string;
  role: Actor["role"];
  vendorId: string | null;
}

export interface CommunicationScope {
  enquiryId?: string;
  lineId?: string;
  rfqId?: string;
  quotationId?: string;
}

export interface CommunicationMessage {
  id: string;
  channel: "EMAIL" | "WHATSAPP";
  direction: "OUTBOUND" | "INBOUND";
  template: string;
  templateLabel: string;
  subject: string;
  fromAddress: string | null;
  toEmail: string;
  ccEmail: string | null;
  status: string;
  sentAt: string;
  entity: string | null;
  entityId: string | null;
  /** The business event this message carried, or null for a plain notice. */
  businessEvent: string | null;
}

export interface CommunicationHistory {
  scope: CommunicationScope;
  messages: CommunicationMessage[];
  /** Inbound replies are captured from P6 on. Kept for older clients. */
  inboundCaptured: true;
}

const TEMPLATE_LABELS: Record<string, string> = {
  vendor_invitation: "Registration invitation",
  onboarding_submitted: "Registration submitted",
  onboarding_approved: "Vendor approved",
  onboarding_rejected: "Vendor rejected",
  password_reset: "Password reset",
  login_otp: "Login code",
  fleet_update_reminder: "Fleet update reminder",
  rfq_invitation: "RFQ invitation",
  rfq_reminder: "RFQ reminder",
  quotation_receipt: "Quotation receipt",
  quotation_received: "Quotation received",
  quotation_awarded: "Award notice",
  quotation_not_awarded: "Not-awarded notice",
  rfq_deadline_changed: "Deadline changed",
  reservation_released: "Reservation released",
  internal_user_created: "Internal user created",
  inbound_email: "Inbound email reply",
  inbound_whatsapp: "Inbound WhatsApp reply",
};

/** Which templates carry a business event, as opposed to a plain notice. */
const BUSINESS_EVENTS: Record<string, string> = {
  rfq_invitation: "RFQ dispatched",
  rfq_reminder: "RFQ reminder sent",
  quotation_receipt: "Quotation receipted",
  quotation_received: "Quotation received",
  quotation_awarded: "Award finalised",
  quotation_not_awarded: "Marked not awarded",
  rfq_deadline_changed: "Deadline extended",
  inbound_email: "Vendor reply received",
  inbound_whatsapp: "Vendor reply received",
};

function assertInternal(actor: CommunicationActor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Communication history is available to SML staff only");
  }
}

/** Expands the chosen scope to every id a message could be logged against. */
async function resolveScope(scope: CommunicationScope): Promise<{
  enquiryIds: string[];
  lineIds: string[];
  rfqIds: string[];
  quotationIds: string[];
}> {
  const lineIds = new Set<string>();
  const enquiryIds = new Set<string>();
  const rfqIds = new Set<string>();
  const quotationIds = new Set<string>();

  if (scope.enquiryId) {
    enquiryIds.add(scope.enquiryId);
    const lines = await prisma.enquiryLineItem.findMany({
      where: { enquiryId: scope.enquiryId },
      select: { id: true },
    });
    lines.forEach((line) => lineIds.add(line.id));
  }
  if (scope.lineId) {
    lineIds.add(scope.lineId);
    const line = await prisma.enquiryLineItem.findUnique({
      where: { id: scope.lineId },
      select: { enquiryId: true },
    });
    if (line) enquiryIds.add(line.enquiryId);
  }
  if (scope.rfqId) rfqIds.add(scope.rfqId);
  if (scope.quotationId) {
    quotationIds.add(scope.quotationId);
    const quotation = await prisma.quotation.findUnique({
      where: { id: scope.quotationId },
      select: { rfqId: true },
    });
    if (quotation) rfqIds.add(quotation.rfqId);
  }

  if (lineIds.size > 0) {
    const rfqs = await prisma.rfq.findMany({
      where: { enquiryLineId: { in: [...lineIds] } },
      select: { id: true },
    });
    rfqs.forEach((rfq) => rfqIds.add(rfq.id));
  }

  if (rfqIds.size > 0) {
    const quotations = await prisma.quotation.findMany({
      where: { rfqId: { in: [...rfqIds] } },
      select: { id: true },
    });
    quotations.forEach((quotation) => quotationIds.add(quotation.id));
  }

  return {
    enquiryIds: [...enquiryIds],
    lineIds: [...lineIds],
    rfqIds: [...rfqIds],
    quotationIds: [...quotationIds],
  };
}

export async function messagesFor(
  scope: CommunicationScope,
  actor: CommunicationActor,
): Promise<CommunicationHistory> {
  assertInternal(actor);

  if (!scope.enquiryId && !scope.lineId && !scope.rfqId && !scope.quotationId) {
    throw AppError.badRequest("Give an enquiry, line, RFQ or quotation to read messages for");
  }

  const resolved = await resolveScope(scope);

  const filters: Array<{ entity: string; entityId: { in: string[] } }> = [];
  if (resolved.enquiryIds.length > 0)
    filters.push({ entity: "enquiry", entityId: { in: resolved.enquiryIds } });
  if (resolved.lineIds.length > 0)
    filters.push({ entity: "enquiry_line", entityId: { in: resolved.lineIds } });
  if (resolved.rfqIds.length > 0)
    filters.push({ entity: "rfq", entityId: { in: resolved.rfqIds } });
  if (resolved.quotationIds.length > 0)
    filters.push({ entity: "quotation", entityId: { in: resolved.quotationIds } });

  const rows = filters.length
    ? await prisma.emailLog.findMany({
        where: { OR: filters },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          toEmail: true,
          ccEmail: true,
          template: true,
          subject: true,
          status: true,
          channel: true,
          direction: true,
          fromAddress: true,
          entity: true,
          entityId: true,
          createdAt: true,
          inboundReply: { select: { receivedAt: true } },
        },
      })
    : [];

  return {
    scope,
    inboundCaptured: true,
    messages: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      direction: row.direction,
      template: row.template,
      templateLabel: TEMPLATE_LABELS[row.template] ?? row.template.replaceAll("_", " "),
      subject: row.subject,
      fromAddress: row.fromAddress,
      toEmail: row.toEmail,
      ccEmail: row.ccEmail,
      status: row.status,
      sentAt: (row.inboundReply?.receivedAt ?? row.createdAt).toISOString(),
      entity: row.entity,
      entityId: row.entityId,
      businessEvent: BUSINESS_EVENTS[row.template] ?? null,
    })),
  };
}

import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { Actor } from "./crane.service";

/**
 * Audit trail viewer (BPD 5.14): the sourcing history of an enquiry.
 *
 * Every status move, internal check, RFQ action, quotation mark and award is
 * written to `AuditLog` by the service that performed it. This assembles those
 * rows — for the enquiry, its lines, its RFQs and its quotations — in the order
 * they happened, so the journey can be reconstructed rather than inferred from
 * the current state alone.
 *
 * It reads; it never writes. Bank details are already absent from the table
 * (audit.service scrubs them centrally), so nothing here needs to filter them.
 */

export interface HistoryActor {
  id: string;
  email: string;
  role: Actor["role"];
  vendorId: string | null;
}

export interface HistoryChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEntry {
  id: string;
  at: string;
  entity: string;
  entityId: string;
  action: string;
  actor: { id: string | null; name: string | null; role: string | null } | null;
  onBehalfOfVendor: boolean;
  craneId: string | null;
  changes: HistoryChange[];
  oldValue: unknown;
  newValue: unknown;
}

export interface EnquiryHistory {
  enquiryId: string;
  entries: HistoryEntry[];
}

function assertInternal(actor: HistoryActor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("The audit trail is available to SML staff only");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changesBetween(oldValue: unknown, newValue: unknown): HistoryChange[] {
  if (!isPlainObject(oldValue) || !isPlainObject(newValue)) return [];
  const fields = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  return [...fields].map((field) => ({
    field,
    from: oldValue[field] ?? null,
    to: newValue[field] ?? null,
  }));
}

export async function enquiryHistory(
  enquiryId: string,
  actor: HistoryActor,
): Promise<EnquiryHistory> {
  assertInternal(actor);

  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: { id: true },
  });
  if (!enquiry) throw AppError.notFound("Enquiry not found");

  const lines = await prisma.enquiryLineItem.findMany({
    where: { enquiryId },
    select: { id: true },
  });
  const lineIds = lines.map((line) => line.id);

  const rfqs = lineIds.length
    ? await prisma.rfq.findMany({
        where: { enquiryLineId: { in: lineIds } },
        select: { id: true },
      })
    : [];
  const rfqIds = rfqs.map((rfq) => rfq.id);

  const quotations = rfqIds.length
    ? await prisma.quotation.findMany({
        where: { rfqId: { in: rfqIds } },
        select: { id: true },
      })
    : [];
  const quotationIds = quotations.map((quotation) => quotation.id);

  const or: Array<{ entity: string; entityId: { in: string[] } }> = [
    { entity: "enquiry", entityId: { in: [enquiryId] } },
  ];
  if (lineIds.length) or.push({ entity: "enquiry_line", entityId: { in: lineIds } });
  if (rfqIds.length) or.push({ entity: "rfq", entityId: { in: rfqIds } });
  if (quotationIds.length)
    or.push({ entity: "quotation", entityId: { in: quotationIds } });

  const rows = await prisma.auditLog.findMany({
    where: { OR: or },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      entity: true,
      entityId: true,
      action: true,
      oldValue: true,
      newValue: true,
      actorId: true,
      actorName: true,
      actorRole: true,
      onBehalfOfVendor: true,
      craneId: true,
      createdAt: true,
    },
  });

  return {
    enquiryId,
    entries: rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      entity: row.entity,
      entityId: row.entityId,
      action: row.action,
      actor: row.actorId
        ? { id: row.actorId, name: row.actorName, role: row.actorRole }
        : null,
      onBehalfOfVendor: row.onBehalfOfVendor,
      craneId: row.craneId,
      changes: changesBetween(row.oldValue, row.newValue),
      oldValue: row.oldValue,
      newValue: row.newValue,
    })),
  };
}

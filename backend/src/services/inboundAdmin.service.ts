import { InboundReplyStatus } from "../generated/prisma/client";
import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { Actor } from "./quotation.service";
import { editAndConvertReply, tryConvertReply } from "./inbound.service";
import type { InboundReplyPatch } from "../validation/inboundFields";

/**
 * P6 validation queue for admins.
 *
 * The queue is a view over `inbound_replies`, not a second copy: an admin edit
 * writes the same row the auto-converter reads, and conversion updates that row
 * in place. Any reply that failed auto-conversion stays visible with the reason
 * in `parseNote`, so nothing disappears because the parser guessed wrong.
 */

export interface ReplyListRow {
  id: string;
  status: InboundReplyStatus;
  channel: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  receivedAt: Date;
  vendor: { id: string; name: string | null } | null;
  rfq: { id: string; rfqNumber: string } | null;
  crane: { id: string; serialRegistrationNo: string } | null;
  parsedRentalRate: number | null;
  parsedRateBasis: string | null;
  parsedValidityDate: Date | null;
  parseNote: string | null;
  convertedQuotationId: string | null;
  createdAt: Date;
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin_user") {
    throw AppError.forbidden("The validation queue is available to admins only");
  }
}

function assertRfqReplyReviewer(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Reply review is available to sales and admins only");
  }
}

function assertReplyAccess(
  actor: Actor,
  replyRfqId: string | null,
  scopedRfqId?: string,
): void {
  assertRfqReplyReviewer(actor);
  if (scopedRfqId !== undefined) {
    if (replyRfqId !== scopedRfqId) throw AppError.notFound("Reply not found");
    return;
  }
  if (actor.role === "sales_user" && !replyRfqId) {
    throw AppError.forbidden("Only admins can review replies that are not matched to an RFQ");
  }
}

async function replyForScope(id: string, actor: Actor, scopedRfqId?: string) {
  const reply = await prisma.inboundReply.findUnique({
    where: { id },
    select: { id: true, rfqId: true },
  });
  if (!reply) throw AppError.notFound("Reply not found");
  assertReplyAccess(actor, reply.rfqId, scopedRfqId);
  return reply;
}

function assertScopedRfqUnchanged(
  patch: InboundReplyPatch,
  scopedRfqId: string | undefined,
): void {
  if (scopedRfqId === undefined) return;
  if (patch.rfqId !== undefined && patch.rfqId !== scopedRfqId) {
    throw AppError.forbidden("A reply cannot be moved to another RFQ from this screen");
  }
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapRow(row: {
  id: string;
  status: InboundReplyStatus;
  channel: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  receivedAt: Date;
  parseNote: string | null;
  convertedQuotationId: string | null;
  createdAt: Date;
  parsedRentalRate: unknown;
  parsedRateBasis: string | null;
  parsedValidityDate: Date | null;
  vendor: { id: string; name: string | null } | null;
  rfq: { id: string; rfqNumber: string } | null;
  crane: { id: string; serialRegistrationNo: string } | null;
}): ReplyListRow {
  return {
    id: row.id,
    status: row.status,
    channel: row.channel,
    fromAddress: row.fromAddress,
    subject: row.subject,
    bodyText: row.bodyText,
    receivedAt: row.receivedAt,
    vendor: row.vendor,
    rfq: row.rfq,
    crane: row.crane,
    parsedRentalRate: toNumber(row.parsedRentalRate),
    parsedRateBasis: row.parsedRateBasis,
    parsedValidityDate: row.parsedValidityDate,
    parseNote: row.parseNote,
    convertedQuotationId: row.convertedQuotationId,
    createdAt: row.createdAt,
  };
}

const LIST_SELECT = {
  id: true,
  status: true,
  channel: true,
  fromAddress: true,
  subject: true,
  bodyText: true,
  receivedAt: true,
  parseNote: true,
  convertedQuotationId: true,
  createdAt: true,
  parsedRentalRate: true,
  parsedRateBasis: true,
  parsedValidityDate: true,
  vendor: { select: { id: true, name: true } },
  rfq: { select: { id: true, rfqNumber: true } },
  crane: { select: { id: true, serialRegistrationNo: true } },
} as const;

export async function listInboundReplies(
  status: "PENDING" | "CONVERTED" | "DISMISSED" | "ALL",
  actor: Actor,
): Promise<{ replies: ReplyListRow[]; pendingCount: number }> {
  assertAdmin(actor);
  const where = status === "ALL" ? {} : { status: status as InboundReplyStatus };
  const [rows, pendingCount] = await Promise.all([
    prisma.inboundReply.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: LIST_SELECT,
    }),
    prisma.inboundReply.count({ where: { status: InboundReplyStatus.PENDING } }),
  ]);
  return { replies: rows.map(mapRow), pendingCount };
}

export async function listRfqInboundReplies(
  rfqId: string,
  status: "PENDING" | "CONVERTED" | "DISMISSED" | "ALL",
  actor: Actor,
): Promise<{ replies: ReplyListRow[]; pendingCount: number }> {
  assertRfqReplyReviewer(actor);
  const where =
    status === "ALL"
      ? { rfqId }
      : { rfqId, status: status as InboundReplyStatus };
  const [rows, pendingCount] = await Promise.all([
    prisma.inboundReply.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: LIST_SELECT,
    }),
    prisma.inboundReply.count({
      where: { rfqId, status: InboundReplyStatus.PENDING },
    }),
  ]);
  return { replies: rows.map(mapRow), pendingCount };
}

export async function getInboundReply(
  id: string,
  actor: Actor,
  scope: { rfqId?: string } = {},
) {
  const row = await prisma.inboundReply.findUnique({
    where: { id },
    select: {
      ...LIST_SELECT,
      bodyText: true,
      matchedBy: true,
      parsedMobilisation: true,
      parsedDemobilisation: true,
      parsedAvailability: true,
      parsedAvailableFrom: true,
      parsedCraneRef: true,
      parsedRemarks: true,
      parsedAcceptsTerms: true,
      attachments: true,
      reviewedAt: true,
      reviewNote: true,
      messageLog: {
        select: { id: true, subject: true, bodyText: true, bodyHtml: true, channel: true },
      },
      convertedQuotation: {
        select: {
          id: true,
          version: true,
          totalQuotedValue: true,
          source: true,
          status: true,
          submittedAt: true,
        },
      },
      reviewedBy: { select: { id: true, email: true } },
      enquiryLine: { select: { id: true, lineNo: true } },
    },
  });
  if (!row) throw AppError.notFound("Reply not found");
  assertReplyAccess(actor, row.rfq?.id ?? null, scope.rfqId);

  // Matching options. A reply that arrived before its vendor was known still
  // needs a way to be completed, so the detail carries the shortest list that
  // can resolve it: approved vendors, that vendor's RFQs and that vendor's
  // active cranes. Empty until a vendor is chosen; the screen says so.
  const [vendorOptions, rfqOptions, craneOptions] = await Promise.all([
    prisma.vendor.findMany({
      where: { onboardingStatus: "APPROVED", suspendedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    row.vendor?.id
      ? prisma.rfqVendorRecipient
          .findMany({
            where: { vendorId: row.vendor.id },
            select: { rfq: { select: { id: true, rfqNumber: true, status: true } } },
            orderBy: { createdAt: "desc" },
            take: 100,
          })
          .then((rows) => rows.map((entry) => entry.rfq))
      : prisma.rfq.findMany({
          where: { status: { in: ["SENT", "CLOSED"] } },
          select: { id: true, rfqNumber: true, status: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
    row.vendor?.id
      ? prisma.crane.findMany({
          where: { vendorId: row.vendor.id, isActive: true },
          select: {
            id: true,
            serialRegistrationNo: true,
            make: true,
            model: true,
            typeOfCrane: { select: { name: true } },
          },
          orderBy: { serialRegistrationNo: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
  ]);

  return {
    ...row,
    parsedRentalRate: toNumber(row.parsedRentalRate),
    parsedMobilisation: toNumber(row.parsedMobilisation),
    parsedDemobilisation: toNumber(row.parsedDemobilisation),
    convertedQuotation: row.convertedQuotation
      ? {
          ...row.convertedQuotation,
          totalQuotedValue: toNumber(row.convertedQuotation.totalQuotedValue),
        }
      : null,
    options: {
      vendors: vendorOptions,
      rfqs: rfqOptions,
      cranes: craneOptions.map((crane) => ({
        id: crane.id,
        serialRegistrationNo: crane.serialRegistrationNo,
        label: `${crane.typeOfCrane.name} ${crane.make} ${crane.model} — ${crane.serialRegistrationNo}`,
      })),
    },
  };
}

export async function patchInboundReply(
  id: string,
  patch: InboundReplyPatch,
  actor: Actor,
  scope: { rfqId?: string } = {},
) {
  await replyForScope(id, actor, scope.rfqId);
  assertScopedRfqUnchanged(patch, scope.rfqId);
  const result = await editAndConvertReply(id, patch, actor, false);
  return getInboundReply(result.replyId, actor, scope);
}

export async function convertInboundReply(
  id: string,
  patch: InboundReplyPatch,
  actor: Actor,
  scope: { rfqId?: string } = {},
) {
  await replyForScope(id, actor, scope.rfqId);
  assertScopedRfqUnchanged(patch, scope.rfqId);
  const result = await editAndConvertReply(id, patch, actor, true);
  if (!result.converted) {
    throw AppError.badRequest(result.reason ?? "The reply cannot be converted yet");
  }
  return {
    reply: await getInboundReply(id, actor, scope),
    quotationId: result.quotationId,
  };
}

export async function dismissInboundReply(
  id: string,
  note: string | null,
  actor: Actor,
  scope: { rfqId?: string } = {},
) {
  await replyForScope(id, actor, scope.rfqId);

  await prisma.inboundReply.update({
    where: { id },
    data: {
      status: InboundReplyStatus.DISMISSED,
      reviewedById: actor.id,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  });
  return getInboundReply(id, actor, scope);
}

export async function retryAutoConversion(id: string, actor: Actor) {
  assertAdmin(actor);
  const result = await tryConvertReply(id, actor);
  if (!result.converted) {
    throw AppError.badRequest(result.reason ?? "The reply cannot be converted yet");
  }
  return { reply: await getInboundReply(id, actor), quotationId: result.quotationId };
}

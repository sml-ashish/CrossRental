import { api } from "@/lib/api";

/**
 * P6 validation queue client.
 *
 * A reply can be edited before conversion because the parser is deliberately
 * conservative. The backend keeps the queue row and the resulting quotation
 * linked, so this screen never re-implements matching or pricing.
 */
export type InboundReplyStatus = "PENDING" | "CONVERTED" | "DISMISSED";
export type ReplyChannel = "EMAIL" | "WHATSAPP";
export type ReplyRateBasis = "PER_DAY" | "PER_MONTH" | "LUMP_SUM";

export interface InboundReplySummary {
  id: string;
  status: InboundReplyStatus;
  channel: ReplyChannel;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  receivedAt: string;
  vendor: { id: string; name: string | null } | null;
  rfq: { id: string; rfqNumber: string } | null;
  crane: { id: string; serialRegistrationNo: string } | null;
  parsedRentalRate: number | null;
  parsedRateBasis: string | null;
  parsedValidityDate: string | null;
  parseNote: string | null;
  convertedQuotationId: string | null;
  createdAt: string;
}

export interface InboundReplyDetail extends InboundReplySummary {
  bodyText: string;
  matchedBy: string | null;
  parsedMobilisation: number | null;
  parsedDemobilisation: number | null;
  parsedAvailability: boolean | null;
  parsedAvailableFrom: string | null;
  parsedCraneRef: string | null;
  parsedRemarks: string | null;
  parsedAcceptsTerms: boolean | null;
  attachments: Array<{
    fileRef: string;
    fileName: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }> | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  enquiryLine: { id: string; lineNo: string } | null;
  convertedQuotation: {
    id: string;
    version: number;
    totalQuotedValue: number;
    source: string;
    status: string;
    submittedAt: string;
  } | null;
  options: {
    vendors: Array<{ id: string; name: string | null }>;
    rfqs: Array<{ id: string; rfqNumber: string; status: string }>;
    cranes: Array<{ id: string; serialRegistrationNo: string; label: string }>;
  };
}

export interface ReplyPatch {
  vendorId?: string | null;
  rfqId?: string | null;
  craneId?: string | null;
  parsedRentalRate?: number | null;
  parsedRateBasis?: ReplyRateBasis | null;
  parsedMobilisation?: number | null;
  parsedDemobilisation?: number | null;
  parsedAvailability?: boolean | null;
  parsedAvailableFrom?: string | null;
  parsedValidityDate?: string | null;
  parsedCraneRef?: string | null;
  parsedRemarks?: string | null;
  parsedAcceptsTerms?: boolean | null;
}

export async function loadReplies(
  status: InboundReplyStatus | "ALL" = "PENDING",
): Promise<{ replies: InboundReplySummary[]; pendingCount: number }> {
  return api(`/admin/replies?status=${status}`);
}

export async function loadRfqReplies(
  rfqId: string,
  status: InboundReplyStatus | "ALL" = "ALL",
): Promise<{ replies: InboundReplySummary[]; pendingCount: number }> {
  return api(`/rfqs/${rfqId}/replies?status=${status}`);
}

function replyPath(id: string, rfqId?: string): string {
  return rfqId ? `/rfqs/${rfqId}/replies/${id}` : `/admin/replies/${id}`;
}

export async function loadReply(
  id: string,
  rfqId?: string,
): Promise<InboundReplyDetail> {
  const res = await api<{ reply: InboundReplyDetail }>(replyPath(id, rfqId));
  return res.reply;
}

export async function updateReply(
  id: string,
  patch: ReplyPatch,
  rfqId?: string,
): Promise<InboundReplyDetail> {
  const res = await api<{ reply: InboundReplyDetail }>(replyPath(id, rfqId), {
    method: "PATCH",
    body: patch,
  });
  return res.reply;
}

export async function convertReply(
  id: string,
  patch: ReplyPatch,
  rfqId?: string,
): Promise<{ reply: InboundReplyDetail; quotationId: string }> {
  return api(`${replyPath(id, rfqId)}/convert`, { method: "POST", body: patch });
}

export async function dismissReply(
  id: string,
  note: string | null,
  rfqId?: string,
): Promise<InboundReplyDetail> {
  const res = await api<{ reply: InboundReplyDetail }>(`${replyPath(id, rfqId)}/dismiss`, {
    method: "POST",
    body: { note },
  });
  return res.reply;
}

export async function retryReply(id: string): Promise<{ quotationId: string }> {
  return api(`/admin/replies/${id}/retry`, { method: "POST", body: {} });
}

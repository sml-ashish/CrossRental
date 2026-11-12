import { createHash } from "crypto";
import type { Prisma } from "../generated/prisma/client";
import {
  InboundReplyStatus,
  MessageChannel,
  QuoteSource,
  RateBasis,
} from "../generated/prisma/client";
import { prisma } from "../lib/database";
import type { Actor } from "./quotation.service";
import { createQuotationFromReply } from "./quotation.service";
import { parseReply, type ParsedReplyFields } from "./replyParser.service";

/**
 * P6 inbound reply ingestion.
 *
 * Email and WhatsApp take different routes into the server but meet here: one
 * normalised message, one matcher, one validation queue. The matcher is allowed
 * to be unsure. A reply with no vendor, no RFQ or no crane reference is still
 * valuable — it goes to an admin with everything that *was* read pre-filled.
 * Only a reply with every field needed for a valid quotation converts itself.
 */
export interface InboundAttachmentRef {
  fileRef: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface InboundMessageInput {
  channel: MessageChannel;
  fromAddress: string;
  subject: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  receivedAt: Date;
  providerMessageId: string;
  attachments?: InboundAttachmentRef[];
}

export interface IngestResult {
  replyId: string | null;
  duplicate: boolean;
  status: InboundReplyStatus | null;
  quotationId?: string | null;
  queuedBecause?: string;
}

interface RecipientCandidate {
  rfqId: string;
  vendorId: string;
  vendorName: string | null;
  rfqNumber: string;
  enquiryLineId: string | null;
  emails: string[];
  whatsappPhones: string[];
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function lastTen(value: string): string {
  return digits(value).slice(-10);
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function inboundTemplate(channel: MessageChannel): string {
  return channel === MessageChannel.WHATSAPP ? "inbound_whatsapp" : "inbound_email";
}

function messageHash(input: InboundMessageInput): string {
  return `inbound-${createHash("sha256")
    .update(`${input.channel}|${input.fromAddress}|${input.receivedAt.toISOString()}|${input.bodyText}`)
    .digest("hex")}`;
}

function rfqReference(text: string): string | null {
  const match = text.match(/\bRFQ[-_/ ]?[A-Z0-9]{2,}(?:[-_/ ][A-Z0-9]{2,})*\b/i);
  return match?.[0]?.replace(/[_\s/]+/g, "-").toUpperCase() ?? null;
}

async function recipientCandidates(from: string, channel: MessageChannel): Promise<RecipientCandidate[]> {
  const base = {
    select: {
      rfqId: true,
      vendorId: true,
      emails: true,
      whatsappPhones: true,
      vendor: { select: { name: true } },
      rfq: { select: { rfqNumber: true, enquiryLineId: true } },
    },
  } as const;

  if (channel === MessageChannel.EMAIL) {
    const email = normaliseEmail(from);
    const direct = await prisma.rfqVendorRecipient.findMany({
      where: { emails: { has: email } },
      ...base,
    });
    if (direct.length > 0) {
      return direct.map((row) => ({
        rfqId: row.rfqId,
        vendorId: row.vendorId,
        vendorName: row.vendor.name,
        rfqNumber: row.rfq.rfqNumber,
        enquiryLineId: row.rfq.enquiryLineId,
        emails: row.emails,
        whatsappPhones: row.whatsappPhones,
      }));
    }

    const vendor = await prisma.vendor.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (!vendor) return [];
    const rows = await prisma.rfqVendorRecipient.findMany({ where: { vendorId: vendor.id }, ...base });
    return rows.map((row) => ({
      rfqId: row.rfqId,
      vendorId: row.vendorId,
      vendorName: row.vendor.name,
      rfqNumber: row.rfq.rfqNumber,
      enquiryLineId: row.rfq.enquiryLineId,
      emails: row.emails,
      whatsappPhones: row.whatsappPhones,
    }));
  }

  const phone = digits(from);
  const direct = await prisma.rfqVendorRecipient.findMany({
    where: { whatsappPhones: { has: phone } },
    ...base,
  });
  if (direct.length > 0) {
    return direct.map((row) => ({
      rfqId: row.rfqId,
      vendorId: row.vendorId,
      vendorName: row.vendor.name,
      rfqNumber: row.rfq.rfqNumber,
      enquiryLineId: row.rfq.enquiryLineId,
      emails: row.emails,
      whatsappPhones: row.whatsappPhones,
    }));
  }

  const possible = await prisma.vendor.findMany({
    where: { telephone: { not: null } },
    select: { id: true, telephone: true },
  });
  const vendor = possible.find((row) => lastTen(row.telephone ?? "") === lastTen(phone));
  if (!vendor) return [];
  const rows = await prisma.rfqVendorRecipient.findMany({ where: { vendorId: vendor.id }, ...base });
  return rows.map((row) => ({
    rfqId: row.rfqId,
    vendorId: row.vendorId,
    vendorName: row.vendor.name,
    rfqNumber: row.rfq.rfqNumber,
    enquiryLineId: row.rfq.enquiryLineId,
    emails: row.emails,
    whatsappPhones: row.whatsappPhones,
  }));
}

async function matchRfq(
  candidates: RecipientCandidate[],
  reference: string | null,
): Promise<{ rfqId: string | null; vendorId: string | null; enquiryLineId: string | null; matchedBy: string | null }> {
  if (reference) {
    const byNumber = candidates.filter((candidate) =>
      candidate.rfqNumber.toUpperCase().replace(/[_\s/]+/g, "-").includes(reference),
    );
    if (byNumber.length === 1) {
      return {
        rfqId: byNumber[0]!.rfqId,
        vendorId: byNumber[0]!.vendorId,
        enquiryLineId: byNumber[0]!.enquiryLineId,
        matchedBy: "RFQ reference",
      };
    }

    const direct = await prisma.rfq.findMany({
      where: { rfqNumber: { contains: reference, mode: "insensitive" } },
      select: { id: true, enquiryLineId: true },
      take: 2,
    });
    if (direct.length === 1) {
      const rfq = direct[0]!;
      const vendor = candidates.find((candidate) => candidate.rfqId === rfq.id);
      return {
        rfqId: rfq.id,
        vendorId: vendor?.vendorId ?? null,
        enquiryLineId: rfq.enquiryLineId,
        matchedBy: "RFQ reference",
      };
    }
  }

  const rfqIds = unique(candidates.map((candidate) => candidate.rfqId));
  if (rfqIds.length === 1) {
    const candidate = candidates[0]!;
    return {
      rfqId: candidate.rfqId,
      vendorId: candidate.vendorId,
      enquiryLineId: candidate.enquiryLineId,
      matchedBy: reference ? null : "Only open RFQ for this address",
    };
  }

  if (candidates.length > 0) {
    const vendorIds = unique(candidates.map((candidate) => candidate.vendorId));
    if (vendorIds.length === 1) {
      return { rfqId: null, vendorId: vendorIds[0]!, enquiryLineId: null, matchedBy: "Sender" };
    }
  }

  return { rfqId: null, vendorId: null, enquiryLineId: null, matchedBy: null };
}

async function matchCrane(
  vendorId: string | null,
  craneRef: string | null,
): Promise<string | null> {
  if (!vendorId) return null;

  const cranes = await prisma.crane.findMany({
    where: { vendorId, isActive: true },
    select: {
      id: true,
      serialRegistrationNo: true,
      make: true,
      model: true,
      typeOfCrane: { select: { name: true } },
    },
  });

  if (!craneRef) return cranes.length === 1 ? cranes[0]!.id : null;

  const needle = craneRef.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return cranes.length === 1 ? cranes[0]!.id : null;

  const scored = cranes
    .map((crane) => {
      const serial = crane.serialRegistrationNo.toLowerCase().replace(/[^a-z0-9]/g, "");
      const description = `${crane.make} ${crane.model} ${crane.typeOfCrane.name}`
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const score =
        serial === needle ? 4 : serial.includes(needle) || needle.includes(serial) ? 3 : 0;
      const descriptionScore =
        description.includes(needle) || needle.includes(description) ? 2 : 0;
      return { id: crane.id, score: score + descriptionScore };
    })
    .filter((crane) => crane.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) return scored[0]!.id;
  if (scored.length > 1 && scored[0]!.score > scored[1]!.score) return scored[0]!.id;
  return cranes.length === 1 ? cranes[0]!.id : null;
}

function missingForAutoConversion(
  parsed: ParsedReplyFields,
  matches: {
    vendorId: string | null;
    rfqId: string | null;
    craneId: string | null;
  },
): string[] {
  const missing: string[] = [];
  if (!matches.vendorId) missing.push("vendor");
  if (!matches.rfqId) missing.push("RFQ");
  if (!matches.craneId) missing.push("crane");
  if (parsed.rentalRate === null) missing.push("rental rate");
  if (parsed.rateBasis === null) missing.push("rate basis (per day / per month / lump sum)");
  if (parsed.availabilityConfirmed !== true) missing.push("availability confirmation");
  if (parsed.validityDate === null) missing.push("validity date");
  if (parsed.acceptsCommercialTerms !== true) missing.push("commercial terms acceptance");
  return missing;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Stores a message and its parsed reply, then tries to convert it.
 *
 * Idempotency is by `providerMessageId`, so Meta retries and an IMAP re-poll of
 * the same message do not create a second queue row.
 */
export async function ingestInboundMessage(input: InboundMessageInput): Promise<IngestResult> {
  const providerMessageId = input.providerMessageId || messageHash(input);
  const existing = await prisma.emailLog.findUnique({
    where: { providerMessageId },
    select: { id: true, inboundReply: { select: { id: true, status: true, convertedQuotationId: true } } },
  });
  if (existing) {
    return {
      replyId: existing.inboundReply?.id ?? null,
      duplicate: true,
      status: existing.inboundReply?.status ?? null,
      quotationId: existing.inboundReply?.convertedQuotationId ?? null,
    };
  }

  const fromAddress =
    input.channel === MessageChannel.EMAIL
      ? normaliseEmail(input.fromAddress)
      : digits(input.fromAddress);
  const parsed = parseReply(input.bodyText);
  const candidates = await recipientCandidates(fromAddress, input.channel);
  const matches = await matchRfq(candidates, rfqReference(`${input.subject ?? ""}\n${input.bodyText}`));
  const craneId = await matchCrane(matches.vendorId, parsed.craneRef);
  const finalMatches = { ...matches, craneId };

  const attachments = input.attachments ?? [];
  const missing = missingForAutoConversion(parsed, finalMatches);
  const parseNote =
    missing.length === 0
      ? null
      : `Needs review: ${missing.join(", ")}.`;

  let replyId: string;
  try {
    replyId = await prisma.$transaction(async (tx) => {
      const log = await tx.emailLog.create({
        data: {
          toEmail: fromAddress,
          template: inboundTemplate(input.channel),
          subject: input.subject ?? (input.channel === MessageChannel.WHATSAPP ? "WhatsApp reply" : "(no subject)"),
          status: "SENT",
          channel: input.channel,
          direction: "INBOUND",
          fromAddress,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml ?? null,
          providerMessageId,
          entity: matches.rfqId ? "rfq" : null,
          entityId: matches.rfqId,
        },
        select: { id: true },
      });

      const reply = await tx.inboundReply.create({
        data: {
          messageLogId: log.id,
          channel: input.channel,
          fromAddress,
          subject: input.subject ?? null,
          bodyText: input.bodyText,
          receivedAt: input.receivedAt,
          vendorId: matches.vendorId,
          rfqId: matches.rfqId,
          enquiryLineId: matches.enquiryLineId,
          craneId,
          matchedBy: matches.matchedBy,
          parseNote,
          parsedRentalRate: parsed.rentalRate,
          parsedRateBasis: parsed.rateBasis,
          parsedMobilisation: parsed.mobilisationCharges,
          parsedDemobilisation: parsed.demobilisationCharges,
          parsedAvailability: parsed.availabilityConfirmed,
          parsedAvailableFrom: parsed.availableFrom,
          parsedValidityDate: parsed.validityDate,
          parsedCraneRef: parsed.craneRef,
          parsedRemarks: parsed.remarks,
          parsedAcceptsTerms: parsed.acceptsCommercialTerms,
          attachments: attachments.length > 0 ? asJson(attachments) : undefined,
        },
        select: { id: true },
      });
      return reply.id;
    });
  } catch (error) {
    // A concurrent Meta retry can hit the unique provider id between the check
    // and the create. Returning the winner is the correct idempotent answer.
    const raced = await prisma.emailLog.findUnique({
      where: { providerMessageId },
      select: { inboundReply: { select: { id: true, status: true, convertedQuotationId: true } } },
    });
    if (raced?.inboundReply) {
      return {
        replyId: raced.inboundReply.id,
        duplicate: true,
        status: raced.inboundReply.status,
        quotationId: raced.inboundReply.convertedQuotationId ?? null,
      };
    }
    throw error;
  }

  if (missing.length > 0) {
    return { replyId, duplicate: false, status: InboundReplyStatus.PENDING, queuedBecause: parseNote ?? undefined };
  }

  const conversion = await tryConvertReply(replyId, null, input.channel);
  if (conversion.converted) {
    return {
      replyId,
      duplicate: false,
      status: InboundReplyStatus.CONVERTED,
      quotationId: conversion.quotationId,
    };
  }

  return {
    replyId,
    duplicate: false,
    status: InboundReplyStatus.PENDING,
    queuedBecause: conversion.reason,
  };
}

export interface ConvertResult {
  converted: boolean;
  quotationId?: string;
  reason?: string;
}

/**
 * The one conversion path used by auto-matching and by the admin queue.
 *
 * The admin's edits have already been saved to the reply row before this runs,
 * so this reads the row rather than taking a second copy of the fields. That
 * keeps the queue and the quotation from disagreeing about what was approved.
 */
export async function tryConvertReply(
  replyId: string,
  actor: Actor | null,
  channelOverride?: MessageChannel,
): Promise<ConvertResult> {
  const reply = await prisma.inboundReply.findUnique({
    where: { id: replyId },
    select: {
      id: true,
      channel: true,
      status: true,
      vendorId: true,
      rfqId: true,
      craneId: true,
      parsedRentalRate: true,
      parsedRateBasis: true,
      parsedMobilisation: true,
      parsedDemobilisation: true,
      parsedAvailability: true,
      parsedAvailableFrom: true,
      parsedValidityDate: true,
      parsedCraneRef: true,
      parsedRemarks: true,
      parsedAcceptsTerms: true,
      attachments: true,
    },
  });
  if (!reply) throw new Error("Reply not found");
  if (reply.status !== InboundReplyStatus.PENDING) {
    return { converted: false, reason: `Reply is already ${reply.status.toLowerCase()}` };
  }

  if (!reply.vendorId || !reply.rfqId || !reply.craneId) {
    return { converted: false, reason: "Vendor, RFQ or crane is still unmatched" };
  }
  if (reply.parsedRentalRate === null || reply.parsedRateBasis === null) {
    return { converted: false, reason: "Rental rate and rate basis are required" };
  }
  if (reply.parsedAvailability !== true) {
    return { converted: false, reason: "Confirm the crane is available before converting" };
  }
  if (reply.parsedValidityDate === null) {
    return { converted: false, reason: "Validity date is required" };
  }
  if (reply.parsedAcceptsTerms !== true) {
    return { converted: false, reason: "Commercial terms must be accepted before converting" };
  }

  const rawAttachments = Array.isArray(reply.attachments) ? reply.attachments : [];
  const attachments = rawAttachments
    .map((item) => item as Partial<InboundAttachmentRef>)
    .filter((item): item is InboundAttachmentRef => Boolean(item.fileRef && item.fileName))
    .map((item) => ({
      fileRef: item.fileRef,
      fileName: item.fileName,
      mimeType: item.mimeType ?? null,
      sizeBytes: item.sizeBytes ?? null,
    }));

  const channel = channelOverride ?? reply.channel;
  try {
    const quotation = await createQuotationFromReply(
      {
        rfqId: reply.rfqId,
        vendorId: reply.vendorId,
        craneId: reply.craneId,
        rentalRate: Number(reply.parsedRentalRate),
        rateBasis: reply.parsedRateBasis,
        mobilisationCharges: reply.parsedMobilisation === null ? 0 : Number(reply.parsedMobilisation),
        demobilisationCharges:
          reply.parsedDemobilisation === null ? 0 : Number(reply.parsedDemobilisation),
        availabilityConfirmed: reply.parsedAvailability,
        availableFrom: reply.parsedAvailableFrom,
        validityDate: reply.parsedValidityDate,
        acceptsCommercialTerms: reply.parsedAcceptsTerms,
        remarks: reply.parsedRemarks,
        source: channel === MessageChannel.WHATSAPP ? QuoteSource.WHATSAPP : QuoteSource.EMAIL,
        attachments,
      },
      actor,
    );

    await prisma.inboundReply.update({
      where: { id: reply.id },
      data: {
        status: InboundReplyStatus.CONVERTED,
        convertedQuotationId: quotation.quotationId,
        reviewedById: actor?.id ?? null,
        reviewedAt: new Date(),
        reviewNote: actor ? "Converted after review" : "Converted automatically",
        parseNote: null,
      },
    });

    return { converted: true, quotationId: quotation.quotationId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Conversion failed";
    await prisma.inboundReply.update({
      where: { id: reply.id },
      data: { parseNote: `Needs review: ${reason}` },
    });
    return { converted: false, reason };
  }
}

/** Applies an admin edit, then optionally re-tries conversion. */
export async function editAndConvertReply(
  replyId: string,
  data: Prisma.InboundReplyUncheckedUpdateInput,
  actor: Actor,
  convert: boolean,
): Promise<ConvertResult & { replyId: string }> {
  const reply = await prisma.inboundReply.findUnique({ where: { id: replyId } });
  if (!reply) throw new Error("Reply not found");

  const updated = await prisma.inboundReply.update({
    where: { id: replyId },
    data: {
      ...data,
      reviewedById: actor.id,
      reviewedAt: new Date(),
    },
  });

  if (updated.rfqId && updated.rfqId !== reply.rfqId) {
    await prisma.emailLog.updateMany({
      where: { inboundReply: { is: { id: replyId } } },
      data: { entity: "rfq", entityId: updated.rfqId },
    });
  }

  if (!convert) return { converted: false, replyId };
  const result = await tryConvertReply(replyId, actor);
  return { ...result, replyId };
}

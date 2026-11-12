import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env";
import { storage } from "../lib/storage";

/**
 * P6 WhatsApp Cloud API adapter.
 *
 * Outbound is a single approved template because WhatsApp does not allow free
 * text outside a customer service window. The template body is expected to take
 * five parameters in this order:
 *   vendor name, RFQ number, site location, submission deadline, portal link.
 *
 * Inbound arrives as Meta's webhook envelope. The controller verifies the
 * signature against the raw body before this module sees it; the parser here is
 * pure so it can be tested without a network.
 */

export interface WhatsAppSendInput {
  to: string;
  vendorName: string;
  rfqNumber: string;
  siteLocation: string;
  submissionDeadline: string;
  portalUrl: string;
}

export interface WhatsAppSendResult {
  sent: boolean;
  messageId?: string;
  error?: string;
}

export function isWhatsAppConfigured(): boolean {
  return (
    env.whatsapp.provider === "meta" &&
    Boolean(env.whatsapp.phoneNumberId) &&
    Boolean(env.whatsapp.accessToken) &&
    Boolean(env.whatsapp.verifyToken) &&
    Boolean(env.whatsapp.appSecret) &&
    Boolean(env.whatsapp.templateName)
  );
}

export function whatsappStatus(): {
  enabled: boolean;
  provider: "meta" | null;
} {
  return {
    enabled: isWhatsAppConfigured(),
    provider: isWhatsAppConfigured() ? "meta" : null,
  };
}

/** Meta wants country code + digits, with no punctuation. */
export function normaliseWhatsAppNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `91${digits.slice(1)}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

export async function sendWhatsAppTemplate(
  input: WhatsAppSendInput,
): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) {
    return { sent: false, error: "WhatsApp is not configured on this deployment" };
  }

  const to = normaliseWhatsAppNumber(input.to);
  if (!to) return { sent: false, error: "That vendor has no valid WhatsApp number" };

  const url = `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: env.whatsapp.templateName,
      language: { code: env.whatsapp.templateLanguage },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: input.vendorName },
            { type: "text", text: input.rfqNumber },
            { type: "text", text: input.siteLocation },
            { type: "text", text: input.submissionDeadline },
            { type: "text", text: input.portalUrl },
          ],
        },
      ],
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string } }
      | null;

    if (!response.ok) {
      return {
        sent: false,
        error: payload?.error?.message ?? `WhatsApp rejected the message (${response.status})`,
      };
    }
    return { sent: true, messageId: payload?.messages?.[0]?.id };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : "WhatsApp could not be reached",
    };
  }
}

/** Constant-time check of Meta's `X-Hub-Signature-256` header. */
export function verifyMetaSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.whatsapp.appSecret) return false;
  const expected = `sha256=${createHmac("sha256", env.whatsapp.appSecret)
    .update(rawBody)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<{ fileRef: string; fileName: string; mimeType: string; sizeBytes: number } | null> {
  if (!isWhatsAppConfigured()) return null;
  try {
    const meta = await fetch(
      `https://graph.facebook.com/${env.whatsapp.apiVersion}/${mediaId}`,
      { headers: { Authorization: `Bearer ${env.whatsapp.accessToken}` } },
    );
    if (!meta.ok) return null;
    const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) return null;

    const file = await fetch(info.url, {
      headers: { Authorization: `Bearer ${env.whatsapp.accessToken}` },
    });
    if (!file.ok) return null;
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = info.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream";

    if (!["application/pdf", "image/jpeg", "image/png"].includes(mimeType)) return null;
    const stored = await storage().save(buffer, {
      fileName: `whatsapp-${mediaId}`,
      mimeType,
      scope: "inbound",
    });
    return stored;
  } catch {
    return null;
  }
}

export interface WhatsAppMediaRef {
  id: string;
  mimeType: string | null;
  caption: string | null;
  fileName: string | null;
}

export interface ParsedWhatsAppMessage {
  providerMessageId: string;
  from: string;
  timestamp: Date;
  text: string;
  media: WhatsAppMediaRef[];
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          image?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
        }>;
      };
    }>;
  }>;
}

/** Flattens Meta's nested envelope into one item per inbound message. */
export function parseMetaWebhook(payload: unknown): ParsedWhatsAppMessage[] {
  const body = payload as MetaWebhookBody;
  if (body?.object !== "whatsapp_business_account") return [];

  const messages: ParsedWhatsAppMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        const timestamp = Number(message.timestamp);
        const receivedAt = Number.isFinite(timestamp)
          ? new Date(timestamp * 1000)
          : new Date();

        const media: WhatsAppMediaRef[] = [];
        if (message.image?.id) {
          media.push({
            id: message.image.id,
            mimeType: message.image.mime_type ?? null,
            caption: message.image.caption ?? null,
            fileName: null,
          });
        }
        if (message.document?.id) {
          media.push({
            id: message.document.id,
            mimeType: message.document.mime_type ?? null,
            caption: message.document.caption ?? null,
            fileName: message.document.filename ?? null,
          });
        }

        const text = message.text?.body ?? media.map((item) => item.caption ?? "").join("\\n");
        messages.push({
          providerMessageId: message.id,
          from: message.from,
          timestamp: receivedAt,
          text,
          media,
        });
      }
    }
  }
  return messages;
}

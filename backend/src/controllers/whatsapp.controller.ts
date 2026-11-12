import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  downloadWhatsAppMedia,
  isWhatsAppConfigured,
  parseMetaWebhook,
  verifyMetaSignature,
} from "../services/whatsapp.service";
import { ingestInboundMessage, type InboundAttachmentRef } from "../services/inbound.service";
import { MessageChannel } from "../generated/prisma/client";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 * Verification is a GET echo of `hub.challenge`; delivery is a POST signed over
 * the exact bytes Meta sent. The route is mounted before `express.json()` so the
 * raw body is available, and a bad signature is rejected before anything is
 * written.
 */
export const verify = asyncHandler(async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    isWhatsAppConfigured() &&
    mode === "subscribe" &&
    typeof token === "string" &&
    token === process.env["WHATSAPP_VERIFY_TOKEN"]
  ) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send("Forbidden");
});

export const receive = asyncHandler(async (req: Request, res: Response) => {
  if (!isWhatsAppConfigured()) {
    res.status(503).json({ error: "WhatsApp is not configured" });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  for (const message of parseMetaWebhook(payload)) {
    try {
      const attachments: InboundAttachmentRef[] = [];
      for (const media of message.media) {
        const stored = await downloadWhatsAppMedia(media.id);
        if (stored) {
          attachments.push({
            fileRef: stored.fileRef,
            fileName: media.fileName ?? stored.fileName,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
          });
        }
      }

      await ingestInboundMessage({
        channel: MessageChannel.WHATSAPP,
        fromAddress: message.from,
        subject: "WhatsApp reply",
        bodyText: message.text || "[attachment]",
        bodyHtml: null,
        receivedAt: message.timestamp,
        providerMessageId: message.providerMessageId,
        attachments,
      });
    } catch (error) {
      // Meta retries any non-2xx, which would replay the whole batch. Log the
      // one bad message and acknowledge the batch; the database keeps whatever
      // succeeded, and a failed row can be replayed by the admin if needed.
      console.error("[whatsapp] inbound message failed", message.providerMessageId, error);
    }
  }

  res.status(200).json({ received: true });
});

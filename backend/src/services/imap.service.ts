import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { env } from "../config/env";
import { storage } from "../lib/storage";
import { MessageChannel } from "../generated/prisma/client";
import { ingestInboundMessage, type InboundAttachmentRef } from "./inbound.service";

/**
 * P6 IMAP polling for the shared vendor-reply mailbox.
 *
 * Polling rather than a provider webhook because that was the owner's choice
 * (open item 9): it works with the existing mailbox and needs no inbound domain
 * or MX change. Messages are marked Seen only after ingestion succeeds, so a
 * database outage leaves the mail for the next tick instead of losing it.
 */
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_PER_POLL = 50;

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function storeAttachments(parsed: ParsedMail): Promise<InboundAttachmentRef[]> {
  const stored: InboundAttachmentRef[] = [];
  for (const attachment of parsed.attachments ?? []) {
    const mimeType = attachment.contentType ?? "application/octet-stream";
    if (!ALLOWED_MIME.has(mimeType) || !Buffer.isBuffer(attachment.content)) continue;
    try {
      const file = await storage().save(attachment.content, {
        fileName: attachment.filename ?? "reply-attachment",
        mimeType,
        scope: "inbound",
      });
      stored.push({
        fileRef: file.fileRef,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
    } catch (error) {
      console.error("[imap] attachment could not be stored", error);
    }
  }
  return stored;
}

export function isImapConfigured(): boolean {
  return Boolean(
    env.imap.enabled &&
      env.imap.host &&
      env.imap.user &&
      env.imap.pass,
  );
}

export async function pollInboundMailbox(): Promise<{ processed: number; failed: number }> {
  if (!isImapConfigured()) return { processed: 0, failed: 0 };

  const client = new ImapFlow({
    host: env.imap.host!,
    port: env.imap.port,
    secure: env.imap.secure,
    auth: { user: env.imap.user!, pass: env.imap.pass! },
    logger: false,
  });

  let processed = 0;
  let failed = 0;

  try {
    await client.connect();
    await client.mailboxOpen(env.imap.mailbox);

    // A bounded window keeps a first run on a large mailbox from ingesting years
    // of unrelated mail. Older replies can still be handled manually.
    const since = new Date(Date.now() - 14 * 86_400_000);
    const messages = client.fetch({ seen: false, since }, { source: true, uid: true }, { uid: true });

    for await (const message of messages) {
      if (processed + failed >= MAX_PER_POLL) break;
      if (!message.source) continue;

      try {
        const parsed = await simpleParser(message.source);
        const from = parsed.from?.value?.[0]?.address?.trim().toLowerCase();
        if (!from) {
          failed += 1;
          continue;
        }

        const bodyText =
          parsed.text?.trim() ||
          (parsed.html ? htmlToText(String(parsed.html)) : "") ||
          "[no message body]";

        const attachments = await storeAttachments(parsed);

        await ingestInboundMessage({
          channel: MessageChannel.EMAIL,
          fromAddress: from,
          subject: parsed.subject ?? null,
          bodyText,
          bodyHtml: parsed.html ? String(parsed.html) : null,
          receivedAt: parsed.date ?? new Date(),
          providerMessageId: parsed.messageId ?? "",
          attachments,
        });

        await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
        processed += 1;
      } catch (error) {
        // Leave the message unseen so the next poll retries it. A permanently
        // bad message repeats in the log but never silently disappears.
        failed += 1;
        console.error("[imap] message could not be ingested", error);
      }
    }
  } catch (error) {
    console.error("[imap] poll failed", error);
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }

  return { processed, failed };
}

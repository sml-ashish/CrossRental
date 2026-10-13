import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

/**
 * Transactional mail through the Microsoft 365 shared mailbox over SMTP.
 *
 * Brief section 3 allows either Microsoft Graph or an SMTP relay from a shared
 * mailbox; SMTP is chosen because it matches the existing CustomerPulse
 * mailer and needs no Entra app-permission consent for a send-only mailbox.
 * Credentials come from configuration only.
 *
 * In development, with SMTP_HOST unset to `console`, messages are written to
 * stdout instead of being sent, so the pilot can be exercised without a
 * mailbox. `MAIL_TRANSPORT=console` forces that.
 */

let transporter: Transporter | null = null;

function useConsole(): boolean {
  if (process.env["MAIL_TRANSPORT"] === "console") return true;
  if (process.env["MAIL_TRANSPORT"] === "smtp") return false;
  return env.mail.host === "console";
}

export function getTransporter(): Transporter | null {
  if (useConsole()) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: { user: env.mail.user, pass: env.mail.pass },
      pool: true,
      maxConnections: 3,
      // Office 365 needs STARTTLS on 587.
      ...(env.mail.port === 587 ? { requireTLS: true } : {}),
    });
  }
  return transporter;
}

export interface OutgoingMail {
  to: string;
  cc?: string[];
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

/**
 * Sends a message and never throws. Callers get a result they record against
 * the recipient row, because a failed dispatch sets the recipient to Failed
 * and surfaces on the admin dashboard (brief 6.7) — it must not abort the
 * surrounding request.
 */
export async function sendMail(mail: OutgoingMail): Promise<SendResult> {
  const transport = getTransporter();

  if (!transport) {
    console.info(
      `\n[email:console] to=${mail.to}${mail.cc?.length ? ` cc=${mail.cc.join(",")}` : ""}\n` +
        `  subject: ${mail.subject}\n${indent(mail.text)}\n`,
    );
    return { sent: true };
  }

  try {
    await transport.sendMail({
      from: env.mail.from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mailer] send failed", mail.to, mail.subject, message);
    return { sent: false, error: message };
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  | ${line}`)
    .join("\n");
}
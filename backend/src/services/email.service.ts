import { prisma } from "../lib/database";
import { sendMail } from "../lib/mailer";
import { htmlToPlainText } from "../lib/plainText";

/**
 * Renders a template from the `email_templates` table, sends it through the
 * Microsoft 365 shared mailbox, and records the attempt in `email_logs`
 * (brief section 8: "Log every email in EmailLog").
 *
 * Sending never throws. A failure is logged and returned so a dispatch loop
 * can mark the recipient Failed and carry on.
 */

export type TemplateKey =
  | "vendor_invitation"
  | "onboarding_submitted"
  | "onboarding_approved"
  | "onboarding_rejected"
  | "password_reset"
  | "login_otp"
  | "fleet_update_reminder"
  | "fleet_updated_on_behalf"
  | "rfq_invitation"
  | "rfq_reminder"
  | "quotation_receipt"
  | "quotation_received"
  | "quotation_awarded"
  | "quotation_not_awarded"
  | "rfq_deadline_changed"
  | "reservation_released"
  | "internal_user_created"
  | "internal_alert_digest"
  // Counter-quote / negotiation (phase 1 + 2)
  | "negotiation_counter_received"
  | "negotiation_vendor_countered"
  | "negotiation_accepted"
  | "negotiation_declined"
  | "negotiation_reminder";

export type TemplateVars = Record<string, string | number | null | undefined | Raw>;

/**
 * Marks a value as pre-rendered plain text. Everything else passed to a
 * template is HTML-escaped, so a vendor-supplied name or remark cannot inject
 * markup into an outbound email. The message itself is sent as text, so a Raw
 * value is text too — never markup.
 */
export class Raw {
  constructor(readonly text: string) {}
}

/** Renders a reason block, or nothing when there is no content. */
export function optionalBlock(reason: string | null | undefined, label = "Reason"): Raw {
  if (!reason || reason.trim() === "") return new Raw("");
  return new Raw(`${label}: ${reason}`);
}

export function warningsBlock(warnings: string[]): Raw {
  if (warnings.length === 0) return new Raw("");
  return new Raw(`Advisories (not blocking)\n${warnings.map((w) => `- ${w}`).join("\n")}`);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function render(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in vars)) return match;
    const value = vars[key];
    if (value === null || value === undefined) return "";
    return value instanceof Raw ? value.text : escapeHtml(String(value));
  });
}

export interface SendTemplateInput {
  to: string;
  cc?: string[];
  template: TemplateKey;
  vars: TemplateVars;
  entity?: string;
  entityId?: string;
}

export interface SendTemplateResult {
  sent: boolean;
  error?: string;
  subject: string;
  logId: string;
}

export async function sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
  const row = await prisma.emailTemplate.findUnique({
    where: { key: input.template },
  });

  if (!row) {
    throw new Error(`Email template "${input.template}" is missing. Run the seed script.`);
  }

  const subject = render(row.subject, input.vars);
  // Text only. Older templates in the database may still contain HTML; the
  // converter strips it so every outgoing message has the same clean format.
  const storedIsHtml = /<\/?[a-z][^>]*>/i.test(row.bodyHtml);
  const text = htmlToPlainText(render(row.bodyHtml, input.vars), storedIsHtml);

  const log = await prisma.emailLog.create({
    data: {
      toEmail: input.to,
      ccEmail: input.cc?.join(",") ?? null,
      template: input.template,
      subject,
      status: "QUEUED",
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
    },
  });

  const result = await sendMail({ to: input.to, cc: input.cc, subject, text });

  await prisma.emailLog.update({
    where: { id: log.id },
    data: { status: result.sent ? "SENT" : "FAILED", error: result.error ?? null },
  });

  return { ...result, subject, logId: log.id };
}
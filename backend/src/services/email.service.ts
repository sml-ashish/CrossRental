import { prisma } from "../lib/database";
import { sendMail } from "../lib/mailer";

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
  | "rfq_invitation"
  | "rfq_reminder"
  | "quotation_receipt"
  | "quotation_received"
  | "quotation_awarded"
  | "quotation_not_awarded"
  | "rfq_deadline_changed"
  | "reservation_released"
  | "internal_user_created"
  | "internal_alert_digest";

export type TemplateVars = Record<string, string | number | null | undefined | Raw>;

/**
 * Marks a value as trusted markup. Everything else passed to a template is
 * HTML-escaped, so a vendor-supplied name or remark can never inject markup
 * into an outbound email.
 */
export class Raw {
  constructor(readonly html: string) {}
}

/** Renders a reason block, or nothing when there is no content. */
export function optionalBlock(reason: string | null | undefined, label = "Reason"): Raw {
  if (!reason || reason.trim() === "") return new Raw("");
  return new Raw(
    `<div style="margin:0 0 16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#334155"><strong>${escapeHtml(label)}</strong><br/>${escapeHtml(reason)}</div>`,
  );
}

export function warningsBlock(warnings: string[]): Raw {
  if (warnings.length === 0) return new Raw("");
  const items = warnings
    .map((w) => `<li style="margin:0 0 4px">${escapeHtml(w)}</li>`)
    .join("");
  return new Raw(
    `<div style="margin:0 0 16px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
      <strong style="display:block;margin-bottom:6px;font-size:13px;color:#92400e">Advisories (not blocking)</strong>
      <ul style="margin:0;padding-left:18px;font-size:12px;color:#78350f">${items}</ul>
    </div>`,
  );
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
    return value instanceof Raw ? value.html : escapeHtml(String(value));
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h1)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const html = render(row.bodyHtml, input.vars);
  const text = stripHtml(html);

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

  const result = await sendMail({ to: input.to, cc: input.cc, subject, html, text });

  await prisma.emailLog.update({
    where: { id: log.id },
    data: { status: result.sent ? "SENT" : "FAILED", error: result.error ?? null },
  });

  return { ...result, subject, logId: log.id };
}
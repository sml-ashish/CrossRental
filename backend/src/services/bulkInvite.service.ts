import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { can } from "../utils/rbac";
import { parseInviteSheet, INVITE_SHEET_COLUMNS } from "../lib/vendorInviteSheet";
import { buildInviteTemplate } from "../lib/vendorInviteTemplate";
import { inviteVendorSchema } from "../validation/inviteFields";
import { assertInvitable, inviteVendor } from "./onboarding.service";
import { recordAudit } from "./audit.service";

/**
 * Bulk vendor invitations (admin and sales).
 *
 * This is deliberately **not a second way to invite a vendor**: each row is fed
 * through `inviteVendorSchema` and then `inviteVendor`, the same schema and
 * service the single form uses, so the email/contact rules and the duplicate
 * guards cannot drift between the two entry points.
 *
 * The bulk-specific behaviour is:
 *
 * - **A bad row does not stop the import.** Valid rows are invited and the
 *   report names the Excel row and the column that failed.
 * - **Duplicates are skipped, never re-sent.** An email with an account, an
 *   outstanding invitation, or an earlier row in the same file is reported and
 *   left alone.
 * - **`dryRun` writes nothing.** It returns the same report so the screen can
 *   preview exactly what an import would do.
 * - **One mail failure is not fatal.** A row whose invitation was created but
 *   whose email bounced is reported as imported with a warning; the rest of the
 *   sheet still runs.
 */

export interface InviteRowResult {
  /** Excel row number, so the report points at the line to fix. */
  row: number;
  name: string | null;
  email: string | null;
  /** `valid` is the dry-run equivalent of `imported`. */
  status: "imported" | "valid" | "skipped" | "failed";
  message: string | null;
  warnings: string[];
}

export interface InviteImportResult {
  dryRun: boolean;
  summary: {
    total: number;
    imported: number;
    /** Rows that would import in a dry run; 0 once the import has run. */
    valid: number;
    skipped: number;
    failed: number;
    /** Imported rows whose invitation email did not go out. */
    emailFailed: number;
  };
  rows: InviteRowResult[];
}

type Actor = AuthedRequest["user"];

const FIELD_LABELS = new Map(
  INVITE_SHEET_COLUMNS.map((column) => [column.key, column.label] as const),
);

function assertCanInvite(actor: Actor): void {
  if (actor.role === "vendor_user" || !can(actor.role, "vendor:invite")) {
    throw AppError.forbidden("Only SML sales and admin users can invite vendors");
  }
}

/** Turns zod issues into a sentence a sales user can map back to a column. */
function describeIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const field = String(issue.path[0] ?? "");
      return `${FIELD_LABELS.get(field) ?? field}: ${issue.message}`;
    })
    .join(" · ");
}

export async function inviteImportTemplate(actor: Actor): Promise<Buffer> {
  assertCanInvite(actor);
  return buildInviteTemplate();
}

export async function importInvitations(input: {
  actor: Actor;
  buffer: Buffer;
  dryRun: boolean;
}): Promise<InviteImportResult> {
  const { actor, buffer, dryRun } = input;
  assertCanInvite(actor);

  const rows = await parseInviteSheet(buffer);

  const results: InviteRowResult[] = [];
  let imported = 0;
  let valid = 0;
  let skipped = 0;
  let failed = 0;
  let emailFailed = 0;

  // Emails already handled in this file. Checked after validation, so the
  // comparison uses the normalised (lower-cased) address the service will use.
  const seen = new Set<string>();

  for (const row of rows) {
    const name = (row.values["name"] ?? "").trim() || null;
    const email = (row.values["email"] ?? "").trim() || null;
    const warnings: string[] = [];

    const push = (
      status: InviteRowResult["status"],
      message: string | null,
    ): void => {
      results.push({ row: row.rowNumber, name, email, status, message, warnings });
    };

    const parsed = inviteVendorSchema.safeParse({
      name: row.values["name"] ?? "",
      email: row.values["email"] ?? "",
      contactNumber: row.values["contactNumber"] ?? "",
    });

    if (!parsed.success) {
      failed += 1;
      push("failed", describeIssues(parsed.error.issues));
      continue;
    }

    const normalisedEmail = parsed.data.email;

    if (seen.has(normalisedEmail)) {
      skipped += 1;
      push("skipped", "This email appears earlier in the file; only the first row is used.");
      continue;
    }
    seen.add(normalisedEmail);

    // Same duplicate guards as the single invite: an existing account, or a
    // live invitation, must not get a second link.
    try {
      await assertInvitable(normalisedEmail);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        skipped += 1;
        push("skipped", error.message);
        continue;
      }
      throw error;
    }

    if (dryRun) {
      valid += 1;
      push("valid", "Ready to invite.");
      continue;
    }

    // A mail failure is reported per row rather than thrown, so one bad address
    // does not abort the rest of the sheet.
    const result = await inviteVendor(parsed.data, actor);
    imported += 1;
    if (!result.emailSent) {
      emailFailed += 1;
      warnings.push("The invitation was created but the email could not be sent.");
    }
    push("imported", "Invitation sent.");
  }

  if (!dryRun && imported > 0) {
    await recordAudit({
      entity: "vendor_invitation",
      entityId: "bulk",
      action: "bulk_invite",
      newValue: { imported, skipped, failed, emailFailed, total: rows.length },
      actor,
    });
  }

  return {
    dryRun,
    summary: {
      total: rows.length,
      imported,
      valid,
      skipped,
      failed,
      emailFailed,
    },
    rows: results,
  };
}

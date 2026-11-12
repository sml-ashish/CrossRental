import ExcelJS from "exceljs";
import { AppError } from "../middleware/errorHandler";
import { cellText } from "./craneSheet";

/**
 * Reading the vendor-invitation upload workbook.
 *
 * The sheet carries the same three fields as the single invite form — vendor
 * name, email and contact number — so the bulk path can validate each row with
 * `inviteVendorSchema` and get exactly the single form's rules. Headers are
 * matched tolerantly (case, spaces and punctuation ignored) because admins
 * paste these lists out of their own spreadsheets.
 *
 * As with the crane sheet, two limits are enforced here rather than downstream:
 * the file must be a readable `.xlsx`, and it may carry at most
 * {@link MAX_INVITE_ROWS} data rows.
 */

export const MAX_INVITE_ROWS = 250;
export const INVITE_SHEET_NAME = "Invitations";

export interface InviteSheetColumn {
  key: string;
  label: string;
  /** Normalised header aliases; the label is added automatically. */
  aliases: string[];
  required: boolean;
  help: string;
}

export const INVITE_SHEET_COLUMNS: InviteSheetColumn[] = [
  {
    key: "name",
    label: "Vendor name",
    aliases: ["vendorname", "companyname", "company", "name", "vendornamecompany"],
    required: true,
    help: "The vendor's registered company name. Prefills their onboarding form.",
  },
  {
    key: "email",
    label: "Email",
    aliases: ["email", "emailaddress", "vendoremail", "contactemail"],
    required: true,
    help: "The address the invitation link is sent to. Must not already have an account or a live invitation.",
  },
  {
    key: "contactNumber",
    label: "Contact number",
    aliases: [
      "contactnumber",
      "contactno",
      "mobile",
      "mobilenumber",
      "mobileno",
      "phone",
      "phonenumber",
      "contact",
    ],
    required: true,
    help: "10-digit Indian mobile number. A +91 or leading 0 prefix is removed automatically.",
  },
];

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** label → key, and every alias → key. */
const HEADER_INDEX = new Map<string, string>();
for (const column of INVITE_SHEET_COLUMNS) {
  HEADER_INDEX.set(normaliseHeader(column.label), column.key);
  for (const alias of column.aliases) {
    HEADER_INDEX.set(normaliseHeader(alias), column.key);
  }
}

export interface ParsedInviteRow {
  /** Excel row number, so a report can point at the actual line. */
  rowNumber: number;
  values: Record<string, string>;
}

/**
 * Parses the workbook into rows of raw text keyed by field name.
 *
 * A missing mandatory header is refused up front — importing half a sheet
 * because a column was renamed is worse than asking for the template again.
 */
export async function parseInviteSheet(buffer: Buffer): Promise<ParsedInviteRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS's own `Buffer` type is an ArrayBuffer alias, which does not match
    // Node's Buffer under @types/node; the bytes are identical.
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw AppError.badRequest(
      "That file could not be read as an .xlsx workbook. Download the template and try again.",
    );
  }

  const sheet =
    workbook.getWorksheet(INVITE_SHEET_NAME) ?? workbook.worksheets[0] ?? null;
  if (!sheet) {
    throw AppError.badRequest("The workbook has no sheet to import");
  }

  const headerRow = sheet.getRow(1);
  const columns = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const key = HEADER_INDEX.get(normaliseHeader(cellText(cell)));
    if (key && !columns.has(key)) columns.set(key, columnNumber);
  });

  const missing = INVITE_SHEET_COLUMNS.filter(
    (column) => column.required && !columns.has(column.key),
  );
  if (missing.length > 0) {
    throw AppError.badRequest(
      `These columns are missing from row 1: ${missing
        .map((column) => `“${column.label}”`)
        .join(", ")}. Download the template to get the exact headers.`,
    );
  }

  const rows: ParsedInviteRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: Record<string, string> = {};
    let hasValue = false;
    for (const [key, columnNumber] of columns) {
      const text = cellText(row.getCell(columnNumber));
      if (text !== "") {
        values[key] = text;
        hasValue = true;
      }
    }
    if (!hasValue) continue;
    rows.push({ rowNumber, values });
    if (rows.length > MAX_INVITE_ROWS) {
      throw AppError.badRequest(
        `This file has more than ${MAX_INVITE_ROWS} invitations. Split it into smaller uploads.`,
      );
    }
  }

  if (rows.length === 0) {
    throw AppError.badRequest(
      "The sheet has no invitation rows. Add at least one row under the header and try again.",
    );
  }

  return rows;
}

import ExcelJS from "exceljs";
import { AppError } from "../middleware/errorHandler";

/**
 * Reading the crane upload workbook.
 *
 * The sheet is the vendor's own list, exported from their spreadsheet or typed
 * into the template — so headers are matched tolerantly (case, spaces and
 * punctuation ignored) and every cell is read as text. Nothing here validates a
 * crane; that is `createCraneSchema`'s job, applied per row by the bulk service,
 * so a crane added through this file obeys exactly the rules of the single-crane
 * form.
 *
 * Two limits are enforced here rather than downstream: the file must be an
 * `.xlsx` with a readable sheet, and it may carry at most {@link MAX_ROWS} data
 * rows. Both are reported as 400s a sales user can act on, not as a crash.
 */

export const MAX_BULK_ROWS = 250;
export const CRANE_SHEET_NAME = "Cranes";

export interface SheetColumn {
  key: string;
  label: string;
  /** Normalised header aliases; the label is added automatically. */
  aliases: string[];
  required: boolean;
  help: string;
}

export const SHEET_COLUMNS: SheetColumn[] = [
  {
    key: "serialRegistrationNo",
    label: "Serial / registration no",
    aliases: [
      "serialregistrationno",
      "serialnumber",
      "serialno",
      "serial",
      "registrationno",
      "registrationnumber",
      "craneserialno",
    ],
    required: true,
    help: "At least 4 characters, unique among this vendor's active cranes. “NA” is not accepted.",
  },
  {
    key: "typeOfCraneCode",
    label: "Crane type",
    aliases: ["typeofcranecode", "typeofcrane", "cranetype", "cranetypecode", "type"],
    required: true,
    help: "One of the types on the Lists sheet (code or exact name).",
  },
  {
    key: "capacityT",
    label: "Capacity (t)",
    aliases: ["capacityt", "capacity", "capacitytonnes", "capacityton", "tonnage"],
    required: true,
    help: "Safe working load in tonnes, greater than zero.",
  },
  {
    key: "currentLocation",
    label: "Current location",
    aliases: ["currentlocation", "location", "sitelocation", "presentlocation"],
    required: true,
    help: "Where the crane is now — city or site. At least 3 characters.",
  },
  {
    key: "stateCode",
    label: "State",
    aliases: ["statecode", "state"],
    required: true,
    help: "Indian state, code or exact name.",
  },
  {
    key: "pincode",
    label: "Pincode",
    aliases: ["pincode", "pin", "pincode6", "postalcode"],
    required: true,
    help: "Six digits. Used to locate the crane when the Google Maps cell is empty.",
  },
  {
    key: "make",
    label: "Make",
    aliases: ["make", "manufacturer", "cranemake"],
    required: true,
    help: "Manufacturer, for example Demag or Liebherr.",
  },
  {
    key: "model",
    label: "Model",
    aliases: ["model", "cranemodel"],
    required: true,
    help: "Model name as it appears on the load chart.",
  },
  {
    key: "yom",
    label: "Year of manufacture",
    aliases: ["yom", "year", "yearofmanufacture", "mfgyear"],
    required: true,
    help: "Four digits, 1950 or later and not in the future.",
  },
  {
    key: "mainBoomM",
    label: "Main boom (m)",
    aliases: ["mainboomm", "mainboom", "boomm", "boomlength"],
    required: true,
    help: "Main boom length in metres.",
  },
  {
    key: "fixedJibM",
    label: "Fixed jib (m)",
    aliases: ["fixedjibm", "fixedjib", "fixedjiblength"],
    required: false,
    help: "Optional. Leave blank or write NA when the crane has none.",
  },
  {
    key: "luffingJibM",
    label: "Luffing jib (m)",
    aliases: ["luffingjibm", "luffingjib", "luffingjiblength"],
    required: false,
    help: "Optional. Leave blank or write NA when the crane has none.",
  },
  {
    key: "windJibM",
    label: "Wind jib (m)",
    aliases: ["windjibm", "windjib", "windjiblength"],
    required: false,
    help: "Optional. Leave blank or write NA when the crane has none.",
  },
  {
    key: "currentStatus",
    label: "Status",
    aliases: ["currentstatus", "status", "cranestatus"],
    required: false,
    help: "Available (default), Engaged or Under Maintenance. Booked and Hired are set by the portal, not here.",
  },
  {
    key: "availableFrom",
    label: "Available from",
    aliases: ["availablefrom", "availablefromdate", "availabilitydate", "availableon"],
    required: false,
    help: "Required when Status is Engaged. Today or later.",
  },
  {
    key: "expectedReadyDate",
    label: "Expected ready date",
    aliases: ["expectedreadydate", "expectedready", "readydate"],
    required: false,
    help: "Optional; meaningful while the crane is Under Maintenance.",
  },
  {
    key: "googleMapsLocation",
    label: "Google Maps location",
    aliases: [
      "googlemapslocation",
      "googlemaps",
      "googlemaplocation",
      "googlemapslink",
      "mapslink",
      "locationlink",
      "maplink",
    ],
    required: false,
    help: "Optional. Paste the Google Maps share link (or the place name). When empty, the pincode is used.",
  },
  {
    key: "remarks",
    label: "Remarks",
    aliases: ["remarks", "notes", "comment", "comments"],
    required: false,
    help: "Optional free text, up to 1000 characters.",
  },
];

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** label → key, and every alias → key. */
const HEADER_INDEX = new Map<string, string>();
for (const column of SHEET_COLUMNS) {
  HEADER_INDEX.set(normaliseHeader(column.label), column.key);
  for (const alias of column.aliases) {
    HEADER_INDEX.set(normaliseHeader(alias), column.key);
  }
}

/** Reads a cell as text without evaluating formulas or trusting its type. */
export function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as unknown as Record<string, unknown>;
    if (typeof record["text"] === "string") return record["text"].trim();
    if (Array.isArray(record["richText"])) {
      return (record["richText"] as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    }
    if (record["result"] !== undefined && record["result"] !== null) {
      return String(record["result"]).trim();
    }
  }
  return "";
}

export interface ParsedSheetRow {
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
export async function parseCraneSheet(buffer: Buffer): Promise<ParsedSheetRow[]> {
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
    workbook.getWorksheet(CRANE_SHEET_NAME) ?? workbook.worksheets[0] ?? null;
  if (!sheet) {
    throw AppError.badRequest("The workbook has no sheet to import");
  }

  const headerRow = sheet.getRow(1);
  const columns = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const key = HEADER_INDEX.get(normaliseHeader(cellText(cell)));
    if (key && !columns.has(key)) columns.set(key, columnNumber);
  });

  const missing = SHEET_COLUMNS.filter((column) => column.required && !columns.has(column.key));
  if (missing.length > 0) {
    throw AppError.badRequest(
      `These columns are missing from row 1: ${missing
        .map((column) => `“${column.label}”`)
        .join(", ")}. Download the template to get the exact headers.`,
    );
  }

  const rows: ParsedSheetRow[] = [];
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
    if (rows.length > MAX_BULK_ROWS) {
      throw AppError.badRequest(
        `This file has more than ${MAX_BULK_ROWS} cranes. Split it into smaller uploads.`,
      );
    }
  }

  if (rows.length === 0) {
    throw AppError.badRequest(
      "The sheet has no crane rows. Add at least one row under the header and try again.",
    );
  }

  return rows;
}

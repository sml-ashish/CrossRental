import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { can } from "../utils/rbac";
import {
  ENQUIRY_SHEET_COLUMNS,
  parseEnquirySheet,
  parseSheetDate,
} from "../lib/enquirySheet";
import { buildEnquiryTemplate } from "../lib/enquiryTemplate";
import { createEnquirySchema, addLineSchema } from "../validation/enquiryFields";
import { addLine, createEnquiry } from "./enquiry.service";
import type { Actor } from "./rfq.service";
import { CapacityRule, DurationUnit } from "../generated/prisma/client";

/**
 * Bulk enquiry upload for the CR team (sales and admin).
 *
 * Like the crane import, this is **not a second way to create an enquiry**.
 * Every group of rows is turned into the payload the enquiry form would send and
 * handed to `createEnquiry`, so numbering, audit, the status trail's first
 * recompute, and the state / crane-type checks cannot drift between the two
 * entry points.
 *
 * What is specific to the bulk path:
 *
 * - **`Enquiry ref` groups rows into one enquiry.** The grouping is explicit and
 *   comes from the sheet, never inferred from matching customer text.
 * - **A bad row does not stop the import.** The valid rows land, and the report
 *   names the row number and the field that failed; `dryRun` returns the same
 *   report without writing anything.
 * - **Each row is validated on its own.** The header columns are repeated on
 *   every row, so a row is only accepted when it could stand alone. Rows sharing
 *   a ref then merge, and a header that disagrees with the group's first row is
 *   reported rather than silently applied.
 *
 * There is no duplicate skip: an enquiry has no natural key, and refusing a
 * second legitimate job for the same customer would be worse than a duplicate.
 * A likely duplicate is reported as a warning instead.
 */

const FIELD_LABELS = new Map(
  ENQUIRY_SHEET_COLUMNS.map((column) => [column.key, column.label] as const),
);

export interface BulkEnquiryRowResult {
  /** Excel row number, so the report points at the line to fix. */
  row: number;
  ref: string | null;
  customerName: string | null;
  /** `valid` is the dry-run equivalent of `imported`. */
  status: "imported" | "valid" | "failed";
  message: string | null;
  warnings: string[];
}

export interface BulkEnquiryResult {
  dryRun: boolean;
  summary: {
    /** Rows read from the sheet. */
    total: number;
    /** Rows that would import in a dry run; 0 once the import has run. */
    valid: number;
    /** Rows written (one per enquiry line). */
    imported: number;
    failed: number;
    /** Enquiries created, or that would be created in a dry run. */
    enquiries: number;
  };
  rows: BulkEnquiryRowResult[];
}

function assertCanImport(actor: Actor): void {
  if (actor.role === "vendor_user" || !can(actor.role, "enquiry:create")) {
    throw AppError.forbidden(
      "Only SML sales and admin users can upload enquiries",
    );
  }
}

function assertCanAppendLines(actor: Actor): void {
  if (actor.role === "vendor_user" || !can(actor.role, "enquiry:manage")) {
    throw AppError.forbidden(
      "Only SML sales and admin users can add lines to an enquiry",
    );
  }
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps a typed label or code onto the stored code for a reference list. */
function resolveReference(
  raw: string | undefined,
  entries: Array<{ code: string; name: string }>,
): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const wanted = normalise(text);
  const match = entries.find(
    (entry) =>
      normalise(entry.code) === wanted || normalise(entry.name) === wanted,
  );
  return match?.code ?? null;
}

const CAPACITY_RULE_LABELS = new Map<string, CapacityRule>([
  ["atleast", CapacityRule.AT_LEAST],
  ["minimum", CapacityRule.AT_LEAST],
  ["min", CapacityRule.AT_LEAST],
  ["orhigher", CapacityRule.AT_LEAST],
  ["higher", CapacityRule.AT_LEAST],
  ["exact", CapacityRule.EXACT],
  ["exactly", CapacityRule.EXACT],
]);

const DURATION_UNIT_LABELS = new Map<string, DurationUnit>([
  ["day", DurationUnit.DAYS],
  ["days", DurationUnit.DAYS],
  ["d", DurationUnit.DAYS],
  ["month", DurationUnit.MONTHS],
  ["months", DurationUnit.MONTHS],
  ["m", DurationUnit.MONTHS],
]);

/**
 * `createEnquirySchema` reports issues per field; the report needs a sentence a
 * sales user can map back to a column.
 */
function describeIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      // Paths look like ["lines", 0, "capacityT"]; the leaf is the column.
      const field = String(issue.path[issue.path.length - 1] ?? "");
      return `${FIELD_LABELS.get(field) ?? field}: ${issue.message}`;
    })
    .join(" · ");
}

/** Blank stays blank; anything else is handed to zod to coerce or refuse. */
function numberOrUndefined(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim();
  return text === "" ? undefined : text;
}

/**
 * Blank means "not stated"; an unparseable value is passed through as text so
 * the schema produces the "Enter a valid date" message against that column.
 */
function dateOrRaw(raw: string | undefined): Date | string | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  return parseSheetDate(text) ?? text;
}

function textOrUndefined(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim();
  return text === "" ? undefined : text;
}

type LineBuild =
  | { ok: true; craneTypeCode: string; line: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Turns one sheet row into the line payload the line form would send.
 *
 * Shared by both import paths — creating enquiries and appending lines to an
 * existing one — so a column cannot mean one thing on the Enquiries page and
 * another on an enquiry. The header columns are read separately, which is what
 * lets the append path ignore them.
 */
function buildLine(
  values: Record<string, string>,
  craneTypes: Array<{ code: string; name: string }>,
): LineBuild {
  const craneTypeCode = resolveReference(values["craneTypeCode"], craneTypes);
  if (!craneTypeCode) {
    return {
      ok: false,
      message: `Crane type: “${values["craneTypeCode"] ?? ""}” is not one of the types on the Lists sheet`,
    };
  }

  let capacityRule: CapacityRule | undefined;
  const ruleText = (values["capacityRule"] ?? "").trim();
  if (ruleText) {
    capacityRule = CAPACITY_RULE_LABELS.get(normalise(ruleText));
    if (!capacityRule) {
      return {
        ok: false,
        message: `Capacity rule: “${ruleText}” is not At least or Exact`,
      };
    }
  }

  let durationUnit: DurationUnit | undefined;
  const unitText = (values["durationUnit"] ?? "").trim();
  if (unitText) {
    durationUnit = DURATION_UNIT_LABELS.get(normalise(unitText));
    if (!durationUnit) {
      return {
        ok: false,
        message: `Duration unit: “${unitText}” is not Days or Months`,
      };
    }
  }

  const hours = textOrUndefined(values["workingHoursPerDay"]);
  const shift = textOrUndefined(values["shift"]);
  const workingHoursShift = [hours, shift].filter(Boolean).join(" · ");

  const line: Record<string, unknown> = {
    craneTypeCode,
    capacityT: numberOrUndefined(values["capacityT"]),
    capacityRule,
    capacityNote: textOrUndefined(values["capacityNote"]),
    quantity: numberOrUndefined(values["quantity"]),
    applicationDescription: textOrUndefined(values["applicationDescription"]),
    loadDescription: textOrUndefined(values["loadDescription"]),
    liftLoadT: numberOrUndefined(values["liftLoadT"]),
    workingRadiusM: numberOrUndefined(values["workingRadiusM"]),
    requiredMainBoomM: numberOrUndefined(values["requiredMainBoomM"]),
    requiredFixedJibM: numberOrUndefined(values["requiredFixedJibM"]),
    requiredLuffingJibM: numberOrUndefined(values["requiredLuffingJibM"]),
    requiredWindJibM: numberOrUndefined(values["requiredWindJibM"]),
    configurationNotes: textOrUndefined(values["configurationNotes"]),
    requiredStartDate: dateOrRaw(values["requiredStartDate"]),
    durationValue: numberOrUndefined(values["durationValue"]),
    durationUnit,
    workingDaysPerMonth: numberOrUndefined(values["workingDaysPerMonth"]),
    mobilisationTerms: textOrUndefined(values["mobilisationTerms"]),
    demobilisationTerms: textOrUndefined(values["demobilisationTerms"]),
    otCharges: textOrUndefined(values["otCharges"]),
    breakdownTerms: textOrUndefined(values["breakdownTerms"]),
    dieselScope: textOrUndefined(values["dieselScope"]),
    workingHoursShift: workingHoursShift || undefined,
    accommodationConveyance: textOrUndefined(values["accommodationConveyance"]),
    paymentTerms: textOrUndefined(values["paymentTerms"]),
    supportCraneScope: textOrUndefined(values["supportCraneScope"]),
    steelMatsGroundPrepScope: textOrUndefined(values["steelMatsGroundPrepScope"]),
    ehsHrCompliance: textOrUndefined(values["ehsHrCompliance"]),
    insuranceTerms: textOrUndefined(values["insuranceTerms"]),
    extensionClause: textOrUndefined(values["extensionClause"]),
    craneAgeCriteriaYears: numberOrUndefined(values["craneAgeCriteriaYears"]),
    otherTerms: textOrUndefined(values["otherTerms"]),
    additionalManpowerScope: textOrUndefined(values["additionalManpowerScope"]),
    intraSiteMovementScope: textOrUndefined(values["intraSiteMovementScope"]),
    prereleaseTerms: textOrUndefined(values["prereleaseTerms"]),
    ppeScope: textOrUndefined(values["ppeScope"]),
    rowScope: textOrUndefined(values["rowScope"]),
    rentalBudget: textOrUndefined(values["rentalBudget"]),
  };

  return { ok: true, craneTypeCode, line };
}

/** The header columns, read only by the create path. */
function buildHeader(values: Record<string, string>, stateCode: string): HeaderPayload {
  const header: HeaderPayload = {
    customerName: values["customerName"] ?? "",
    customerAddress: values["customerAddress"] ?? "",
    siteLocation: values["siteLocation"] ?? "",
    siteStateCode: stateCode,
    sitePincode: textOrUndefined(values["sitePincode"]) ?? null,
    region: textOrUndefined(values["region"]) ?? null,
  };
  // Only set when a date was given: `z.coerce.date(null)` is the epoch, and a
  // blank enquiry date must mean "today", not 1970.
  const enquiryDate = dateOrRaw(values["enquiryDate"]);
  if (enquiryDate !== null) header.enquiryDate = enquiryDate;
  return header;
}

interface HeaderPayload {
  enquiryDate?: Date | string;
  customerName: string;
  customerAddress: string;
  siteLocation: string;
  siteStateCode: string;
  sitePincode?: string | null;
  region?: string | null;
}

type LinePayload = Record<string, unknown>;

interface GroupLine {
  row: number;
  line: LinePayload;
  warnings: string[];
}

interface Group {
  ref: string | null;
  header: HeaderPayload;
  /** Compared against later rows so a drifting header is reported. */
  headerKey: string;
  lines: GroupLine[];
}

function headerSignature(header: HeaderPayload): string {
  return [
    header.customerName,
    header.customerAddress,
    header.siteLocation,
    header.siteStateCode,
    header.sitePincode ?? "",
    header.region ?? "",
    header.enquiryDate instanceof Date
      ? header.enquiryDate.toISOString()
      : (header.enquiryDate ?? ""),
  ]
    .map((part) => normalise(String(part)))
    .join("|");
}

/** The duplicate warning key: customer, site, state, crane type and tonnage. */
function duplicateKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => {
      const text = String(part ?? "").trim();
      if (text === "") return "";
      const asNumber = Number(text);
      return normalise(
        Number.isFinite(asNumber) && /^[\d.\s]+$/.test(text)
          ? String(asNumber)
          : text,
      );
    })
    .join("|");
}

export async function enquiryImportTemplate(actor: Actor): Promise<Buffer> {
  assertCanImport(actor);
  const [craneTypes, states] = await Promise.all([
    prisma.craneType.findMany({
      select: { code: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.state.findMany({
      select: { code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return buildEnquiryTemplate({ craneTypes, states });
}

export async function importEnquiries(input: {
  actor: Actor;
  buffer: Buffer;
  dryRun: boolean;
}): Promise<BulkEnquiryResult> {
  const { actor, buffer, dryRun } = input;
  assertCanImport(actor);

  const rows = await parseEnquirySheet(buffer);

  const [craneTypes, states, recentEnquiries] = await Promise.all([
    prisma.craneType.findMany({ select: { code: true, name: true } }),
    prisma.state.findMany({ select: { code: true, name: true } }),
    prisma.enquiry.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      select: {
        enquiryNo: true,
        customerName: true,
        siteLocation: true,
        siteStateCode: true,
        lines: { select: { craneTypeCode: true, capacityT: true } },
      },
    }),
  ]);

  // Likely duplicates: the same customer, site and crane within the last 90
  // days. A warning, never a skip — an enquiry has no natural key.
  const seen = new Map<string, string>();
  for (const enquiry of recentEnquiries) {
    for (const line of enquiry.lines) {
      const key = duplicateKey([
        enquiry.customerName,
        enquiry.siteLocation,
        enquiry.siteStateCode,
        line.craneTypeCode,
        line.capacityT?.toString(),
      ]);
      if (!seen.has(key)) seen.set(key, enquiry.enquiryNo);
    }
  }

  const results: BulkEnquiryRowResult[] = [];
  const groups = new Map<string, Group>();
  let validRows = 0;
  let failed = 0;

  const fail = (
    row: number,
    ref: string | null,
    customerName: string | null,
    message: string,
    warnings: string[] = [],
  ): void => {
    failed += 1;
    results.push({ row, ref, customerName, status: "failed", message, warnings });
  };

  for (const row of rows) {
    const values = row.values;
    const ref = textOrUndefined(values["enquiryRef"]) ?? null;
    const customerName = textOrUndefined(values["customerName"]) ?? null;
    const warnings: string[] = [];

    const stateCode = resolveReference(values["siteStateCode"], states);
    if (!stateCode) {
      fail(
        row.rowNumber,
        ref,
        customerName,
        `State: “${values["siteStateCode"] ?? ""}” is not an Indian state on the Lists sheet`,
      );
      continue;
    }

    const built = buildLine(values, craneTypes);
    if (!built.ok) {
      fail(row.rowNumber, ref, customerName, built.message);
      continue;
    }

    const header = buildHeader(values, stateCode);
    const line = built.line;

    // Validate the row as if it were the whole enquiry. That keeps each row
    // self-contained: a row missing the customer name fails on its own row
    // rather than silently borrowing the group's first row.
    const parsed = createEnquirySchema.safeParse({ ...header, lines: [line] });
    if (!parsed.success) {
      fail(
        row.rowNumber,
        ref,
        customerName,
        describeIssues(parsed.error.issues),
        warnings,
      );
      continue;
    }

    const likely = seen.get(
      duplicateKey([
        header.customerName,
        header.siteLocation,
        header.siteStateCode,
        built.craneTypeCode,
        values["capacityT"],
      ]),
    );
    if (likely) {
      warnings.push(
        `Looks like ${likely} already covers this customer, site and crane`,
      );
    }

    validRows += 1;

    const groupKey = ref ?? `__row_${row.rowNumber}`;
    const existingGroup = groups.get(groupKey);
    if (!existingGroup) {
      groups.set(groupKey, {
        ref,
        header,
        headerKey: headerSignature(header),
        lines: [{ row: row.rowNumber, line, warnings }],
      });
    } else {
      if (headerSignature(header) !== existingGroup.headerKey) {
        warnings.push(
          ref
            ? `The customer/site in this row differs from the first row of “${ref}”, so the first row's header was used`
            : "The customer/site in this row was not used",
        );
      }
      existingGroup.lines.push({ row: row.rowNumber, line, warnings });
    }
  }

  let imported = 0;
  let enquiries = 0;

  for (const group of groups.values()) {
    const lineCount = group.lines.length;

    if (dryRun) {
      enquiries += 1;
      for (const entry of group.lines) {
        results.push({
          row: entry.row,
          ref: group.ref,
          customerName: group.header.customerName,
          status: "valid",
          message:
            lineCount === 1
              ? "Will create a new enquiry"
              : `Will create one enquiry with ${lineCount} lines`,
          warnings: entry.warnings,
        });
      }
      continue;
    }

    try {
      const created = await createEnquiry(
        { ...group.header, lines: group.lines.map((entry) => entry.line) },
        actor,
      );
      imported += lineCount;
      enquiries += 1;
      const label = created.enquiryNo ?? "a new enquiry";
      for (const entry of group.lines) {
        results.push({
          row: entry.row,
          ref: group.ref,
          customerName: group.header.customerName,
          status: "imported",
          message:
            lineCount === 1
              ? `Created ${label}`
              : `Created ${label} with ${lineCount} lines`,
          warnings: entry.warnings,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The enquiry could not be saved";
      for (const entry of group.lines) {
        failed += 1;
        results.push({
          row: entry.row,
          ref: group.ref,
          customerName: group.header.customerName,
          status: "failed",
          message,
          warnings: entry.warnings,
        });
      }
    }
  }

  results.sort((a, b) => a.row - b.row);

  return {
    dryRun,
    summary: {
      total: rows.length,
      valid: dryRun ? validRows : 0,
      imported,
      failed,
      enquiries,
    },
    rows: results,
  };
}

// ---------------------------------------------------------------------------
// Adding lines to an enquiry that already exists
// ---------------------------------------------------------------------------

export interface BulkLineRowResult {
  /** Excel row number, so the report points at the line to fix. */
  row: number;
  /** The line number the row got, or would get in a dry run. */
  lineNo: number | null;
  /** `valid` is the dry-run equivalent of `imported`. */
  status: "imported" | "valid" | "failed";
  message: string | null;
  warnings: string[];
}

export interface BulkLineResult {
  dryRun: boolean;
  /** The enquiry the lines were (or would be) added to. */
  enquiryNo: string;
  summary: {
    total: number;
    /** Rows that would import in a dry run; 0 once the import has run. */
    valid: number;
    imported: number;
    failed: number;
  };
  rows: BulkLineRowResult[];
}

/** A line is "the same" as an existing one on crane type and tonnage. */
function lineKey(craneTypeCode: string | null, capacityT: unknown): string {
  return duplicateKey([craneTypeCode, capacityT?.toString()]);
}

/**
 * Appends the rows of a sheet to one existing enquiry.
 *
 * The target is fixed by the caller, never by the sheet: there is no
 * `Enquiry no` column to mistype, and a row cannot be sent to a different
 * enquiry than the screen it was uploaded from. Because the enquiry already has
 * its customer, site, state and date, the header columns are ignored here — a
 * row only has to carry its line fields.
 *
 * Every row goes through the same `addLine` the single-line form uses, so line
 * numbering (`lineNo` = last + 1), audit and the status-trail recompute stay
 * shared. A bad row never costs the good rows.
 */
export async function importLines(input: {
  actor: Actor;
  enquiryId: string;
  buffer: Buffer;
  dryRun: boolean;
}): Promise<BulkLineResult> {
  const { actor, enquiryId, buffer, dryRun } = input;
  assertCanAppendLines(actor);

  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    select: {
      id: true,
      enquiryNo: true,
      lines: { select: { lineNo: true, craneTypeCode: true, capacityT: true } },
    },
  });
  if (!enquiry) throw AppError.notFound("That enquiry does not exist");

  const [rows, craneTypes] = await Promise.all([
    parseEnquirySheet(buffer),
    prisma.craneType.findMany({ select: { code: true, name: true } }),
  ]);

  const existing = enquiry.lines.map((line) => ({
    lineNo: line.lineNo,
    key: lineKey(line.craneTypeCode, line.capacityT),
  }));
  const lastLineNo = existing.reduce(
    (max, line) => Math.max(max, line.lineNo),
    0,
  );

  const results: BulkLineRowResult[] = [];
  let validRows = 0;
  let imported = 0;
  let failed = 0;

  // Line numbers are handed out in sheet order, so a dry run can promise the
  // same numbers the import will use.
  let nextLineNo = lastLineNo + 1;

  for (const row of rows) {
    const built = buildLine(row.values, craneTypes);
    if (!built.ok) {
      failed += 1;
      results.push({
        row: row.rowNumber,
        lineNo: null,
        status: "failed",
        message: built.message,
        warnings: [],
      });
      continue;
    }

    const parsed = addLineSchema.safeParse(built.line);
    if (!parsed.success) {
      failed += 1;
      results.push({
        row: row.rowNumber,
        lineNo: null,
        status: "failed",
        message: describeIssues(parsed.error.issues),
        warnings: [],
      });
      continue;
    }

    const warnings: string[] = [];
    const key = lineKey(
      built.craneTypeCode,
      (built.line as { capacityT?: unknown }).capacityT,
    );
    const duplicate = existing.find((line) => line.key === key);
    if (duplicate) {
      warnings.push(
        `This enquiry already has line ${duplicate.lineNo} for the same crane type and capacity`,
      );
    }

    if (dryRun) {
      validRows += 1;
      results.push({
        row: row.rowNumber,
        lineNo: nextLineNo,
        status: "valid",
        message: `Will be added as line ${nextLineNo} of ${enquiry.enquiryNo}`,
        warnings,
      });
      existing.push({ lineNo: nextLineNo, key });
      nextLineNo += 1;
      continue;
    }

    try {
      const created = (await addLine(enquiryId, built.line, actor)) as {
        lineNo?: number;
      };
      imported += 1;
      const lineNo = created.lineNo ?? nextLineNo;
      results.push({
        row: row.rowNumber,
        lineNo,
        status: "imported",
        message: `Added as line ${lineNo} of ${enquiry.enquiryNo}`,
        warnings,
      });
      existing.push({ lineNo, key });
      nextLineNo = lineNo + 1;
    } catch (error) {
      failed += 1;
      results.push({
        row: row.rowNumber,
        lineNo: null,
        status: "failed",
        message:
          error instanceof Error ? error.message : "The line could not be saved",
        warnings,
      });
    }
  }

  results.sort((a, b) => a.row - b.row);

  return {
    dryRun,
    enquiryNo: enquiry.enquiryNo,
    summary: {
      total: rows.length,
      valid: dryRun ? validRows : 0,
      imported,
      failed,
    },
    rows: results,
  };
}

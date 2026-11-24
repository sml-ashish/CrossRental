import { api, apiUpload, getStoredToken } from "@/lib/api";
import type { RfqRollupStatus } from "@/lib/rfqs";

/**
 * Client for the native enquiry endpoints (P1).
 *
 * An enquiry holds the ship-to city, the state and the crane requirement.
 * Customer details, the site pin and the terms a vendor is asked to price live
 * on the RFQ, where they can be chosen per invitation. `createRfqFromLine` takes
 * a deadline plus the optional line fields the user ticked, and the backend
 * copies only that subset.
 */

export type EnquiryOverallStatus =
  | "RECEIVED_PENDING_SOURCING"
  | "PARTIALLY_QUOTED"
  | "PARTIALLY_FINALISED"
  | "FULLY_FINALISED"
  | "CLOSED";

export type EnquiryLineTrailStatus =
  | "NEW"
  | "AVAILABILITY_CHECK"
  | "VENDOR_SHORTLISTED"
  | "RFQ_SENT"
  | "AWAITING_QUOTES"
  | "QUOTES_RECEIVED"
  | "UNDER_EVALUATION"
  | "VENDOR_FINALISED"
  | "BOOKED"
  | "CLOSED"
  | "FULFILLED_INTERNALLY"
  | "CANCELLED";

/** Kept for the RFQ match helpers; the enquiry no longer stores a rule. */
export type CapacityRule = "AT_LEAST" | "EXACT";
export type DurationUnit = "DAYS" | "MONTHS";

export const ENQUIRY_STATUS_LABELS: Record<EnquiryOverallStatus, string> = {
  RECEIVED_PENDING_SOURCING: "Received — Pending Sourcing",
  PARTIALLY_QUOTED: "Partially Quoted",
  PARTIALLY_FINALISED: "Partially Finalised",
  FULLY_FINALISED: "Fully Finalised",
  CLOSED: "Closed",
};

/**
 * The only line statuses a user ever sees.
 *
 * The database keeps the finer trail for audit, but no screen prints it. Every
 * trail value folds into one of these five words; `Booked` is the last step in
 * the progression and `Cancelled` is a terminal outcome off that progression.
 */
export type EnquiryLineStatus =
  | "Sourcing pending"
  | "RFQ sent"
  | "Quotes received"
  | "Booked"
  | "Cancelled";

/** The four progress steps, in order. Cancelled is not a step on this track. */
export const LINE_STEPS: readonly EnquiryLineStatus[] = [
  "Sourcing pending",
  "RFQ sent",
  "Quotes received",
  "Booked",
];

/** All visible statuses, in display order (reports, filters, charts). */
export const LINE_STATUS_ORDER: readonly EnquiryLineStatus[] = [...LINE_STEPS, "Cancelled"];

export type LineStatusTone = "neutral" | "blue" | "amber" | "emerald" | "muted";

export const LINE_STATUS_TONES: Record<EnquiryLineStatus, LineStatusTone> = {
  "Sourcing pending": "neutral",
  "RFQ sent": "blue",
  "Quotes received": "amber",
  Booked: "emerald",
  Cancelled: "muted",
};

const LINE_STATUS_DOT_CLASSES: Record<EnquiryLineStatus, string> = {
  "Sourcing pending": "bg-slate-400",
  "RFQ sent": "bg-blue-500",
  "Quotes received": "bg-amber-500",
  Booked: "bg-emerald-500",
  Cancelled: "bg-slate-500",
};

export function lineStatusDot(status: EnquiryLineStatus): string {
  return LINE_STATUS_DOT_CLASSES[status];
}

/** Enough of a line to decide its status; RFQ picker rows have no quote count. */
export interface LineStatusInput {
  trailStatus: EnquiryLineTrailStatus;
  quoteCount?: number | null;
}

/**
 * Fold one internal trail value into the public vocabulary.
 *
 * `CLOSED` and `FULFILLED_INTERNALLY` are completed work, so they read Booked.
 * A quote can arrive before the trail catches up, so any quoted line that is
 * still in sourcing reads Quotes received — the label and the action agree.
 */
export function lineStatusFromTrail(
  status: EnquiryLineTrailStatus,
  quoteCount = 0,
): EnquiryLineStatus {
  switch (status) {
    case "CANCELLED":
      return "Cancelled";
    case "CLOSED":
    case "FULFILLED_INTERNALLY":
    case "VENDOR_FINALISED":
    case "BOOKED":
      return "Booked";
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "Quotes received";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
      return "RFQ sent";
    default:
      return quoteCount > 0 ? "Quotes received" : "Sourcing pending";
  }
}

/** The same fold for report rows, whose status arrives as a plain string. */
export function lineStatusFromValue(value: string, quoteCount = 0): EnquiryLineStatus | null {
  if (!value) return null;
  if ((LINE_STATUS_ORDER as readonly string[]).includes(value)) {
    return value as EnquiryLineStatus;
  }
  return lineStatusFromTrail(value as EnquiryLineTrailStatus, quoteCount);
}

export function lineStatusOf(line: LineStatusInput): EnquiryLineStatus {
  return lineStatusFromTrail(line.trailStatus, line.quoteCount ?? 0);
}

export const CAPACITY_RULE_LABELS: Record<CapacityRule, string> = {
  AT_LEAST: "At least",
  EXACT: "Exactly",
};

export interface EnquiryLine {
  id: string;
  enquiryId: string;
  lineNo: number;
  craneTypeCode: string | null;
  craneTypeName: string | null;
  craneModel: string | null;
  yom: number | null;
  capacityT: number | null;
  applicationDescription: string | null;
  liftLoadT: number | null;
  liftHeightM: number | null;
  craneConfiguration: string | null;
  requiredStartDate: string | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  workingDaysPerMonth: number | null;
  otCharges: string | null;
  breakdownTerms: string | null;
  dieselScope: string | null;
  workingHoursPerDay: string | null;
  shift: string | null;
  workingHoursShift: string | null;
  supportCraneScope: string | null;
  steelMatsGroundPrepScope: string | null;
  ehsHrCompliance: string | null;
  insuranceTerms: string | null;
  craneAgeCriteriaYears: number | null;
  additionalManpowerScope: string | null;
  rowScope: string | null;
  trailStatus: EnquiryLineTrailStatus;
  closureStatus: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The latest RFQ raised from this line, if any. */
  rfqId?: string | null;
  rfqNumber?: string | null;
  /** Quotes received across this line's RFQs. */
  quoteCount?: number;
}

export interface EnquirySummary {
  total: number;
  byStage: Partial<Record<EnquiryLineTrailStatus, number>>;
  pendingSourcing: number;
  rfqSent: number;
  quotesReceived: number;
  finalised: number;
  closed: number;
}

export interface Enquiry {
  id: string;
  enquiryNo: string;
  enquiryDate: string;
  shipToCity: string;
  siteStateCode: string;
  siteStateName: string | null;
  overallStatus: EnquiryOverallStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EnquiryDetail extends Enquiry {
  lines: EnquiryLine[];
  summary: EnquirySummary;
}

/**
 * The enquiry screen's KPI buckets. They are mutually exclusive and computed by
 * the server, so the cards and the rows can never disagree.
 */
export type EnquiryBucket = "pending" | "awaiting" | "quotes" | "finalised" | "closed";

export interface EnquiryListRow extends Enquiry {
  lineCount: number;
  /** One line is one crane to source. */
  craneCount: number;
  sourcedCranes: number;
  sourcedLineCount: number;
  sourcedPercent: number;
  rfqCount: number;
  quoteCount: number;
  /** The soonest start among lines that are not sourced yet. */
  nextUnsourcedStart: string | null;
  bucket: EnquiryBucket;
  /**
   * The enquiry has no project column; this is the first line's application
   * description, which is the closest honest stand-in.
   */
  project: string | null;
  summary: EnquirySummary;
}

/** The KPI numbers. Unfiltered: a KPI that moves with a filter is a filter. */
export interface EnquirySummaryCounts {
  total: number;
  active: number;
  pendingSourcing: number;
  awaitingQuotes: number;
  quotesIn: number;
  finalised: number;
  closed: number;
  raisedToday: number;
  /** Per-card delta: how many of each bucket arrived today. */
  raisedTodayByBucket: Record<EnquiryBucket, number>;
}

// --- line detail -----------------------------------------------------------

/**
 * One line on its own. This is what the line editor and the comparison screen
 * need; it replaced the old sourcing-workspace payload, which bundled
 * recommendations and quote history the rest of the app never asked for.
 */
export interface LineDetail {
  line: EnquiryLine;
}

/** The RFQ status a raised RFQ reports back on its own detail screen. */
export type { RfqRollupStatus };

// --- form shapes -----------------------------------------------------------

/** Header strings while editing. */
export interface EnquiryForm {
  enquiryDate: string;
  shipToCity: string;
  siteStateCode: string;
}

export interface EnquiryLineForm {
  craneTypeCode: string;
  craneModel: string;
  yom: string;
  capacityT: string;
  applicationDescription: string;
  liftLoadT: string;
  liftHeightM: string;
  craneConfiguration: string;
  requiredStartDate: string;
  durationValue: string;
  durationUnit: DurationUnit;
  workingDaysPerMonth: string;
  otCharges: string;
  breakdownTerms: string;
  dieselScope: string;
  workingHoursPerDay: string;
  shift: string;
  workingHoursShift: string;
  supportCraneScope: string;
  steelMatsGroundPrepScope: string;
  ehsHrCompliance: string;
  insuranceTerms: string;
  craneAgeCriteriaYears: string;
  additionalManpowerScope: string;
  rowScope: string;
}

export const EMPTY_ENQUIRY_FORM: EnquiryForm = {
  enquiryDate: "",
  shipToCity: "",
  siteStateCode: "",
};

export function emptyLine(): EnquiryLineForm {
  return {
    craneTypeCode: "",
    craneModel: "",
    yom: "",
    capacityT: "",
    applicationDescription: "",
    liftLoadT: "",
    liftHeightM: "",
    craneConfiguration: "",
    requiredStartDate: "",
    durationValue: "",
    durationUnit: "DAYS",
    workingDaysPerMonth: "",
    otCharges: "",
    breakdownTerms: "",
    dieselScope: "",
    workingHoursPerDay: "",
    shift: "",
    workingHoursShift: "",
    supportCraneScope: "",
    steelMatsGroundPrepScope: "",
    ehsHrCompliance: "",
    insuranceTerms: "",
    craneAgeCriteriaYears: "",
    additionalManpowerScope: "",
    rowScope: "",
  };
}

export function lineToForm(line: EnquiryLine): EnquiryLineForm {
  const text = (v: string | null) => v ?? "";
  const numberish = (v: number | null) => (v === null ? "" : String(v));
  return {
    craneTypeCode: text(line.craneTypeCode),
    craneModel: text(line.craneModel),
    yom: numberish(line.yom),
    capacityT: numberish(line.capacityT),
    applicationDescription: text(line.applicationDescription),
    liftLoadT: numberish(line.liftLoadT),
    liftHeightM: numberish(line.liftHeightM),
    craneConfiguration: text(line.craneConfiguration),
    requiredStartDate: line.requiredStartDate ? line.requiredStartDate.slice(0, 10) : "",
    durationValue: numberish(line.durationValue),
    durationUnit: line.durationUnit ?? "DAYS",
    workingDaysPerMonth: numberish(line.workingDaysPerMonth),
    otCharges: text(line.otCharges),
    breakdownTerms: text(line.breakdownTerms),
    dieselScope: text(line.dieselScope),
    workingHoursPerDay: text(line.workingHoursPerDay),
    shift: text(line.shift),
    workingHoursShift: text(line.workingHoursShift),
    supportCraneScope: text(line.supportCraneScope),
    steelMatsGroundPrepScope: text(line.steelMatsGroundPrepScope),
    ehsHrCompliance: text(line.ehsHrCompliance),
    insuranceTerms: text(line.insuranceTerms),
    craneAgeCriteriaYears: numberish(line.craneAgeCriteriaYears),
    additionalManpowerScope: text(line.additionalManpowerScope),
    rowScope: text(line.rowScope),
  };
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());
const numberOrNull = (value: string) =>
  value.trim() === "" ? null : Number(value);

function calendarDate(value: string): string | null {
  if (value.trim() === "") return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return new Date(value).toISOString();
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function toLinePayload(form: EnquiryLineForm) {
  return {
    craneTypeCode: form.craneTypeCode,
    craneModel: blankToNull(form.craneModel),
    yom: numberOrNull(form.yom),
    capacityT: Number(form.capacityT),
    applicationDescription: blankToNull(form.applicationDescription),
    liftLoadT: numberOrNull(form.liftLoadT),
    liftHeightM: numberOrNull(form.liftHeightM),
    craneConfiguration: blankToNull(form.craneConfiguration),
    requiredStartDate: calendarDate(form.requiredStartDate),
    durationValue: numberOrNull(form.durationValue),
    durationUnit: form.durationValue.trim() === "" ? null : form.durationUnit,
    workingDaysPerMonth: numberOrNull(form.workingDaysPerMonth),
    otCharges: blankToNull(form.otCharges),
    breakdownTerms: blankToNull(form.breakdownTerms),
    dieselScope: blankToNull(form.dieselScope),
    workingHoursPerDay: blankToNull(form.workingHoursPerDay),
    shift: blankToNull(form.shift),
    workingHoursShift: blankToNull(form.workingHoursShift),
    supportCraneScope: blankToNull(form.supportCraneScope),
    steelMatsGroundPrepScope: blankToNull(form.steelMatsGroundPrepScope),
    ehsHrCompliance: blankToNull(form.ehsHrCompliance),
    insuranceTerms: blankToNull(form.insuranceTerms),
    craneAgeCriteriaYears: numberOrNull(form.craneAgeCriteriaYears),
    additionalManpowerScope: blankToNull(form.additionalManpowerScope),
    rowScope: blankToNull(form.rowScope),
  };
}

function toHeaderPayload(form: EnquiryForm) {
  return {
    enquiryDate: form.enquiryDate ? calendarDate(form.enquiryDate) : undefined,
    shipToCity: form.shipToCity.trim(),
    siteStateCode: form.siteStateCode,
  };
}

export function enquiryToForm(enquiry: Enquiry): EnquiryForm {
  return {
    enquiryDate: enquiry.enquiryDate ? enquiry.enquiryDate.slice(0, 10) : "",
    shipToCity: enquiry.shipToCity,
    siteStateCode: enquiry.siteStateCode,
  };
}

// --- calls -----------------------------------------------------------------

export interface ListEnquiriesFilters {
  status?: EnquiryOverallStatus;
  search?: string;
  stateCode?: string;
  /** Inclusive logged-date range, sent as YYYY-MM-DD. */
  from?: string;
  to?: string;
  sort?: EnquirySort;
}

/** Newest first, soonest unsourced start, or least progress first. */
export type EnquirySort = "newest" | "startDate" | "progress";

export function listEnquiries(
  filters: ListEnquiriesFilters = {},
): Promise<{ enquiries: EnquiryListRow[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  if (filters.stateCode) params.set("stateCode", filters.stateCode);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort && filters.sort !== "newest") params.set("sort", filters.sort);
  const query = params.toString();
  return api(`/enquiries${query ? `?${query}` : ""}`);
}

export function getEnquirySummary(): Promise<{ summary: EnquirySummaryCounts }> {
  return api("/enquiries/summary");
}

/**
 * A line an RFQ can be raised against. The RFQ creation screen is line-driven,
 * so this is the picker's row rather than the full line.
 */
export interface RaisableLine {
  id: string;
  enquiryId: string;
  enquiryNo: string;
  lineNo: number;
  craneTypeCode: string | null;
  craneTypeName: string | null;
  capacityT: number | null;
  requiredStartDate: string | null;
  startDateTbc: boolean;
  /** Hire length, for the requirement summary. */
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  shipToCity: string;
  siteStateName: string | null;
  trailStatus: EnquiryLineTrailStatus;
  /** How many RFQs this line already carries, so a re-tender is visible. */
  rfqCount: number;
}

export function listRaisableLines(search = ""): Promise<{ lines: RaisableLine[] }> {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  return api(`/enquiries/lines${query}`);
}

export function getEnquiry(enquiryId: string): Promise<{ enquiry: EnquiryDetail }> {
  return api(`/enquiries/${enquiryId}`);
}

export function createEnquiry(
  form: EnquiryForm,
  lines: EnquiryLineForm[],
): Promise<{ enquiry: EnquiryDetail }> {
  return api("/enquiries", {
    method: "POST",
    body: { ...toHeaderPayload(form), lines: lines.map(toLinePayload) },
  });
}

export function updateEnquiry(
  enquiryId: string,
  form: EnquiryForm,
): Promise<{ enquiry: EnquiryDetail }> {
  return api(`/enquiries/${enquiryId}`, { method: "PUT", body: toHeaderPayload(form) });
}

export function addLine(
  enquiryId: string,
  form: EnquiryLineForm,
): Promise<{ line: EnquiryLine }> {
  return api(`/enquiries/${enquiryId}/lines`, {
    method: "POST",
    body: toLinePayload(form),
  });
}

export function updateLine(
  lineId: string,
  form: EnquiryLineForm,
): Promise<{ line: EnquiryLine }> {
  return api(`/enquiries/lines/${lineId}`, {
    method: "PUT",
    body: toLinePayload(form),
  });
}

export function cancelLine(lineId: string, reason: string): Promise<{ line: EnquiryLine }> {
  return api(`/enquiries/lines/${lineId}/cancel`, { method: "POST", body: { reason } });
}

/**
 * Raise an RFQ from a line. The deadline is always sent; `includeFields` is the
 * sales user's field picker. Every raise screen now passes it. Omitting it keeps
 * the server's original copy-everything behaviour for older integrations.
 */
export function createRfqFromLine(
  lineId: string,
  submissionDeadline: string,
  includeFields?: readonly string[],
  remark?: string,
): Promise<{ rfq: { id: string; rfqNumber: string; enquiryLineId: string } }> {
  return api(`/enquiries/lines/${lineId}/rfq`, {
    method: "POST",
    body: {
      submissionDeadline: new Date(submissionDeadline).toISOString(),
      ...(includeFields ? { includeFields: [...includeFields] } : {}),
      ...(remark?.trim() ? { remark: remark.trim() } : {}),
    },
  });
}

export function getLine(lineId: string): Promise<LineDetail> {
  return api(`/enquiries/lines/${lineId}`);
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// --- bulk upload (sales and admin) ----------------------------------------

/**
 * The `.xlsx` import for enquiries.
 *
 * Preview and import run the same server-side parse and validation, so the
 * preview cannot promise an enquiry the import will refuse. `Enquiry ref` groups
 * rows into one enquiry with several lines; a blank ref makes each row its own.
 */
export interface BulkEnquiryRowResult {
  /** Excel row number, so the report can point at the line to fix. */
  row: number;
  ref: string | null;
  shipToCity: string | null;
  /** `valid` is what `imported` would become — the dry-run wording. */
  status: "imported" | "valid" | "failed";
  message: string | null;
  warnings: string[];
}

export interface BulkEnquiryResult {
  dryRun: boolean;
  summary: {
    total: number;
    /** Rows that would import in a dry run; 0 once the import has run. */
    valid: number;
    /** Rows written, one per enquiry line. */
    imported: number;
    failed: number;
    /** Enquiries created, or that would be created in a dry run. */
    enquiries: number;
  };
  rows: BulkEnquiryRowResult[];
}

/** Validates the sheet and returns the per-row report without writing anything. */
export function previewBulkEnquiries(file: File): Promise<BulkEnquiryResult> {
  return apiUpload(`/enquiries/bulk?dryRun=true`, file, { method: "POST" });
}

/** Writes the valid rows, creating one enquiry per group. */
export function importBulkEnquiries(file: File): Promise<BulkEnquiryResult> {
  return apiUpload(`/enquiries/bulk?dryRun=false`, file, { method: "POST" });
}

/**
 * Downloads the import template through the authenticated API.
 *
 * Same object-URL dance as the crane template: a plain link would arrive without
 * the bearer token.
 */
export async function downloadBulkEnquiryTemplate(): Promise<void> {
  const base = import.meta.env.VITE_API_BASE_URL ?? "/api";
  const response = await fetch(`${base}/enquiries/bulk/template`, {
    headers: { Authorization: `Bearer ${getStoredToken() ?? ""}` },
  });
  if (!response.ok) throw new Error("The template could not be downloaded.");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "crossrentel-enquiry-upload.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// --- bulk add lines to one enquiry ----------------------------------------

/**
 * Appending lines to an enquiry that already exists.
 *
 * The target is the enquiry in the URL, not a column in the sheet, so a row
 * cannot land on a different enquiry than the screen it was uploaded from. The
 * header columns are ignored on this path: customer, site, state and date come
 * from the enquiry.
 */
export interface BulkLineRowResult {
  /** Excel row number, so the report can point at the line to fix. */
  row: number;
  /** The line number the row got, or would get in a dry run. */
  lineNo: number | null;
  /** `valid` is what `imported` would become — the dry-run wording. */
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

/** Validates the sheet and returns the per-row report without writing anything. */
export function previewBulkLines(
  enquiryId: string,
  file: File,
): Promise<BulkLineResult> {
  return apiUpload(`/enquiries/${enquiryId}/lines/bulk?dryRun=true`, file, {
    method: "POST",
  });
}

/** Appends the valid rows to the enquiry, one line per row. */
export function importBulkLines(
  enquiryId: string,
  file: File,
): Promise<BulkLineResult> {
  return apiUpload(`/enquiries/${enquiryId}/lines/bulk?dryRun=false`, file, {
    method: "POST",
  });
}

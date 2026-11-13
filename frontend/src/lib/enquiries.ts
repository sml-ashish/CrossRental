import { api, apiUpload, getStoredToken } from "@/lib/api";
import type { RfqRollupStatus } from "@/lib/rfqs";

/**
 * Client for the native enquiry endpoints (P1).
 *
 * The customer block — customer name/address and the rental budget — is shown
 * on the internal screens but never leaves the server when an RFQ is raised:
 * `createRfqFromLine` takes only a deadline and the backend prefills the RFQ
 * from the vendor-safe subset. There is deliberately no way to send those
 * fields from here.
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

export type CapacityRule = "AT_LEAST" | "EXACT";
export type DurationUnit = "DAYS" | "MONTHS";

export const ENQUIRY_STATUS_LABELS: Record<EnquiryOverallStatus, string> = {
  RECEIVED_PENDING_SOURCING: "Received — Pending Sourcing",
  PARTIALLY_QUOTED: "Partially Quoted",
  PARTIALLY_FINALISED: "Partially Finalised",
  FULLY_FINALISED: "Fully Finalised",
  CLOSED: "Closed",
};

export const TRAIL_LABELS: Record<EnquiryLineTrailStatus, string> = {
  NEW: "New",
  AVAILABILITY_CHECK: "Availability Check",
  VENDOR_SHORTLISTED: "Vendor Shortlisted",
  RFQ_SENT: "RFQ Sent",
  AWAITING_QUOTES: "Awaiting Quotes",
  QUOTES_RECEIVED: "Quotes Received",
  UNDER_EVALUATION: "Under Evaluation",
  VENDOR_FINALISED: "Vendor Finalised",
  BOOKED: "Booked",
  CLOSED: "Closed",
  FULFILLED_INTERNALLY: "Fulfilled Internally",
  CANCELLED: "Cancelled",
};

/** The trail rendered as a fixed sequence, so a reader sees the whole journey. */
export const TRAIL_SEQUENCE: EnquiryLineTrailStatus[] = [
  "NEW",
  "AVAILABILITY_CHECK",
  "VENDOR_SHORTLISTED",
  "RFQ_SENT",
  "QUOTES_RECEIVED",
  "UNDER_EVALUATION",
  "VENDOR_FINALISED",
  "BOOKED",
];

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
  capacityT: number | null;
  capacityRule: CapacityRule;
  capacityNote: string | null;
  quantity: number;
  applicationDescription: string | null;
  loadDescription: string | null;
  liftLoadT: number | null;
  workingRadiusM: number | null;
  requiredMainBoomM: number | null;
  requiredFixedJibM: number | null;
  requiredLuffingJibM: number | null;
  requiredWindJibM: number | null;
  configurationNotes: string | null;
  requiredStartDate: string | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  workingDaysPerMonth: number | null;
  mobilisationTerms: string | null;
  demobilisationTerms: string | null;
  otCharges: string | null;
  breakdownTerms: string | null;
  dieselScope: string | null;
  workingHoursShift: string | null;
  accommodationConveyance: string | null;
  paymentTerms: string | null;
  supportCraneScope: string | null;
  steelMatsGroundPrepScope: string | null;
  ehsHrCompliance: string | null;
  insuranceTerms: string | null;
  extensionClause: string | null;
  craneAgeCriteriaYears: number | null;
  otherTerms: string | null;
  additionalManpowerScope: string | null;
  intraSiteMovementScope: string | null;
  prereleaseTerms: string | null;
  ppeScope: string | null;
  rowScope: string | null;
  rentalBudget: string | null;
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
  customerName: string;
  customerAddress: string;
  siteLocation: string;
  siteStateCode: string;
  siteStateName: string | null;
  sitePincode: string | null;
  region: string | null;
  /** The site pin, resolved once by the server's geocoder. */
  siteLatitude: number | null;
  siteLongitude: number | null;
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
  /** Cranes required, counted by quantity rather than by line. */
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

/**
 * Header strings while editing. The customer block is here because this is the
 * internal form; it is dropped by the backend when an RFQ is raised, not by the
 * client.
 */
export interface EnquiryForm {
  enquiryDate: string;
  customerName: string;
  customerAddress: string;
  siteLocation: string;
  siteStateCode: string;
  sitePincode: string;
  region: string;
}

export interface EnquiryLineForm {
  craneTypeCode: string;
  capacityT: string;
  capacityRule: CapacityRule;
  capacityNote: string;
  quantity: string;
  applicationDescription: string;
  loadDescription: string;
  liftLoadT: string;
  workingRadiusM: string;
  requiredMainBoomM: string;
  requiredFixedJibM: string;
  requiredLuffingJibM: string;
  requiredWindJibM: string;
  configurationNotes: string;
  requiredStartDate: string;
  durationValue: string;
  durationUnit: DurationUnit;
  workingDaysPerMonth: string;
  mobilisationTerms: string;
  demobilisationTerms: string;
  otCharges: string;
  breakdownTerms: string;
  dieselScope: string;
  workingHoursShift: string;
  accommodationConveyance: string;
  paymentTerms: string;
  supportCraneScope: string;
  steelMatsGroundPrepScope: string;
  ehsHrCompliance: string;
  insuranceTerms: string;
  extensionClause: string;
  craneAgeCriteriaYears: string;
  otherTerms: string;
  additionalManpowerScope: string;
  intraSiteMovementScope: string;
  prereleaseTerms: string;
  ppeScope: string;
  rowScope: string;
  rentalBudget: string;
}

export const EMPTY_ENQUIRY_FORM: EnquiryForm = {
  enquiryDate: "",
  customerName: "",
  customerAddress: "",
  siteLocation: "",
  siteStateCode: "",
  sitePincode: "",
  region: "",
};

export function emptyLine(): EnquiryLineForm {
  return {
    craneTypeCode: "",
    capacityT: "",
    capacityRule: "AT_LEAST",
    capacityNote: "",
    quantity: "1",
    applicationDescription: "",
    loadDescription: "",
    liftLoadT: "",
    workingRadiusM: "",
    requiredMainBoomM: "",
    requiredFixedJibM: "",
    requiredLuffingJibM: "",
    requiredWindJibM: "",
    configurationNotes: "",
    requiredStartDate: "",
    durationValue: "",
    durationUnit: "DAYS",
    workingDaysPerMonth: "",
    mobilisationTerms: "",
    demobilisationTerms: "",
    otCharges: "",
    breakdownTerms: "",
    dieselScope: "",
    workingHoursShift: "",
    accommodationConveyance: "",
    paymentTerms: "",
    supportCraneScope: "",
    steelMatsGroundPrepScope: "",
    ehsHrCompliance: "",
    insuranceTerms: "",
    extensionClause: "",
    craneAgeCriteriaYears: "",
    otherTerms: "",
    additionalManpowerScope: "",
    intraSiteMovementScope: "",
    prereleaseTerms: "",
    ppeScope: "",
    rowScope: "",
    rentalBudget: "",
  };
}

export function lineToForm(line: EnquiryLine): EnquiryLineForm {
  const text = (v: string | null) => v ?? "";
  const numberish = (v: number | null) => (v === null ? "" : String(v));
  return {
    craneTypeCode: text(line.craneTypeCode),
    capacityT: numberish(line.capacityT),
    capacityRule: line.capacityRule,
    capacityNote: text(line.capacityNote),
    quantity: String(line.quantity),
    applicationDescription: text(line.applicationDescription),
    loadDescription: text(line.loadDescription),
    liftLoadT: numberish(line.liftLoadT),
    workingRadiusM: numberish(line.workingRadiusM),
    requiredMainBoomM: numberish(line.requiredMainBoomM),
    requiredFixedJibM: numberish(line.requiredFixedJibM),
    requiredLuffingJibM: numberish(line.requiredLuffingJibM),
    requiredWindJibM: numberish(line.requiredWindJibM),
    configurationNotes: text(line.configurationNotes),
    requiredStartDate: line.requiredStartDate ? line.requiredStartDate.slice(0, 10) : "",
    durationValue: numberish(line.durationValue),
    durationUnit: line.durationUnit ?? "DAYS",
    workingDaysPerMonth: numberish(line.workingDaysPerMonth),
    mobilisationTerms: text(line.mobilisationTerms),
    demobilisationTerms: text(line.demobilisationTerms),
    otCharges: text(line.otCharges),
    breakdownTerms: text(line.breakdownTerms),
    dieselScope: text(line.dieselScope),
    workingHoursShift: text(line.workingHoursShift),
    accommodationConveyance: text(line.accommodationConveyance),
    paymentTerms: text(line.paymentTerms),
    supportCraneScope: text(line.supportCraneScope),
    steelMatsGroundPrepScope: text(line.steelMatsGroundPrepScope),
    ehsHrCompliance: text(line.ehsHrCompliance),
    insuranceTerms: text(line.insuranceTerms),
    extensionClause: text(line.extensionClause),
    craneAgeCriteriaYears: numberish(line.craneAgeCriteriaYears),
    otherTerms: text(line.otherTerms),
    additionalManpowerScope: text(line.additionalManpowerScope),
    intraSiteMovementScope: text(line.intraSiteMovementScope),
    prereleaseTerms: text(line.prereleaseTerms),
    ppeScope: text(line.ppeScope),
    rowScope: text(line.rowScope),
    rentalBudget: text(line.rentalBudget),
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
    capacityT: Number(form.capacityT),
    capacityRule: form.capacityRule,
    capacityNote: blankToNull(form.capacityNote),
    quantity: Number(form.quantity),
    applicationDescription: blankToNull(form.applicationDescription),
    loadDescription: blankToNull(form.loadDescription),
    liftLoadT: numberOrNull(form.liftLoadT),
    workingRadiusM: numberOrNull(form.workingRadiusM),
    requiredMainBoomM: numberOrNull(form.requiredMainBoomM),
    requiredFixedJibM: numberOrNull(form.requiredFixedJibM),
    requiredLuffingJibM: numberOrNull(form.requiredLuffingJibM),
    requiredWindJibM: numberOrNull(form.requiredWindJibM),
    configurationNotes: blankToNull(form.configurationNotes),
    requiredStartDate: calendarDate(form.requiredStartDate),
    durationValue: numberOrNull(form.durationValue),
    durationUnit: form.durationValue.trim() === "" ? null : form.durationUnit,
    workingDaysPerMonth: numberOrNull(form.workingDaysPerMonth),
    mobilisationTerms: blankToNull(form.mobilisationTerms),
    demobilisationTerms: blankToNull(form.demobilisationTerms),
    otCharges: blankToNull(form.otCharges),
    breakdownTerms: blankToNull(form.breakdownTerms),
    dieselScope: blankToNull(form.dieselScope),
    workingHoursShift: blankToNull(form.workingHoursShift),
    accommodationConveyance: blankToNull(form.accommodationConveyance),
    paymentTerms: blankToNull(form.paymentTerms),
    supportCraneScope: blankToNull(form.supportCraneScope),
    steelMatsGroundPrepScope: blankToNull(form.steelMatsGroundPrepScope),
    ehsHrCompliance: blankToNull(form.ehsHrCompliance),
    insuranceTerms: blankToNull(form.insuranceTerms),
    extensionClause: blankToNull(form.extensionClause),
    craneAgeCriteriaYears: numberOrNull(form.craneAgeCriteriaYears),
    otherTerms: blankToNull(form.otherTerms),
    additionalManpowerScope: blankToNull(form.additionalManpowerScope),
    intraSiteMovementScope: blankToNull(form.intraSiteMovementScope),
    prereleaseTerms: blankToNull(form.prereleaseTerms),
    ppeScope: blankToNull(form.ppeScope),
    rowScope: blankToNull(form.rowScope),
    rentalBudget: blankToNull(form.rentalBudget),
  };
}

function toHeaderPayload(form: EnquiryForm) {
  return {
    enquiryDate: form.enquiryDate ? calendarDate(form.enquiryDate) : undefined,
    customerName: form.customerName.trim(),
    customerAddress: form.customerAddress.trim(),
    siteLocation: form.siteLocation.trim(),
    siteStateCode: form.siteStateCode,
    sitePincode: blankToNull(form.sitePincode),
    region: blankToNull(form.region),
  };
}

export function enquiryToForm(enquiry: Enquiry): EnquiryForm {
  return {
    enquiryDate: enquiry.enquiryDate ? enquiry.enquiryDate.slice(0, 10) : "",
    customerName: enquiry.customerName,
    customerAddress: enquiry.customerAddress,
    siteLocation: enquiry.siteLocation,
    siteStateCode: enquiry.siteStateCode,
    sitePincode: enquiry.sitePincode ?? "",
    region: enquiry.region ?? "",
  };
}

// --- calls -----------------------------------------------------------------

export interface ListEnquiriesFilters {
  status?: EnquiryOverallStatus;
  search?: string;
  stateCode?: string;
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
  capacityRule: CapacityRule;
  quantity: number;
  requiredStartDate: string | null;
  startDateTbc: boolean;
  siteLocation: string;
  siteStateName: string | null;
  sitePincode: string | null;
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

/** Raise an RFQ from a line. Only the deadline is sent; the rest is prefilled. */
export function createRfqFromLine(
  lineId: string,
  submissionDeadline: string,
): Promise<{ rfq: { id: string; rfqNumber: string; enquiryLineId: string } }> {
  return api(`/enquiries/lines/${lineId}/rfq`, {
    method: "POST",
    body: { submissionDeadline: new Date(submissionDeadline).toISOString() },
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
  customerName: string | null;
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

import { api } from "@/lib/api";

/**
 * Client for the internal RFQ endpoints (brief 7.9, M4).
 *
 * Nothing here decides who may see an RFQ or resolve an email address — the
 * backend owns both (brief 6.6, 6.7). Notably `sendRfq` takes vendor *ids*, never
 * addresses: the server looks up each vendor's own active user and ignores
 * anything the client tried to add, because the mail carries the customer's
 * requirement and must not be deliverable to an arbitrary address.
 *
 * Distances arrive with their method attached. `distanceApproximate` is the
 * flag the UI must render: brief 6.9 requires a straight-line fallback to be
 * labelled as an approximation rather than presented as a road distance.
 */

export type RfqStatus = "DRAFT" | "SENT" | "CLOSED" | "CANCELLED";
export type RfqRollupStatus = "SENT" | "AWAITING_QUOTES" | "QUOTES_RECEIVED";
export type EmailDeliveryStatus = "QUEUED" | "SENT" | "FAILED";
export type ResponseStatus = "PENDING" | "QUOTED" | "DECLINED" | "EXPIRED";
export type MessageChannel = "EMAIL" | "WHATSAPP";
export type QuoteSource = "PORTAL" | "EMAIL" | "WHATSAPP" | "MANUAL";
export type DurationUnit = "DAYS" | "MONTHS";
export type DistanceMethod = "road" | "straight_line" | null;

export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  // Brief decision 8: the BPD's spelling is "Finalised".
  CLOSED: "Finalised",
  CANCELLED: "Cancelled",
};

export const ROLLUPE_STATUS_LABELS: Record<RfqRollupStatus, string> = {
  SENT: "Sent",
  AWAITING_QUOTES: "Awaiting quotes",
  QUOTES_RECEIVED: "Quotes received",
};

export const DELIVERY_LABELS: Record<EmailDeliveryStatus, string> = {
  QUEUED: "Queued",
  SENT: "Delivered",
  FAILED: "Failed",
};

export const RESPONSE_LABELS: Record<ResponseStatus, string> = {
  PENDING: "Pending",
  QUOTED: "Quoted",
  DECLINED: "Declined",
  EXPIRED: "Expired",
};

export interface RfqSiteState {
  code: string;
  name: string;
}

export interface Rfq {
  id: string;
  rfqNumber: string;
  enquiryNo: string;
  lineNo: string;
  /** The native enquiry line this RFQ was raised against, when it has one. */
  enquiryLineId: string | null;
  craneType: string;
  craneTypeRef: { name: string } | null;
  capacityT: number;
  capacityRule: "AT_LEAST" | "EXACT";
  capacityNote: string | null;
  applicationDescription: string | null;
  loadDescription: string | null;
  mainBoomM: number | null;
  jibLengthM: number | null;
  startDateTbc: boolean;
  workingDaysPerMonth: number | null;
  quantity: number;
  siteLocation: string;
  siteStateCode: string;
  siteState: RfqSiteState | null;
  sitePincode: string | null;
  siteLatitude: number | null;
  siteLongitude: number | null;
  siteCoordinateSource: "auto" | "manual" | null;
  /** True until a pin exists, which is what suppresses every distance (brief 6.9). */
  siteLocationUnverified: boolean;
  requiredStartDate: string;
  durationValue: number;
  durationUnit: DurationUnit;
  configuration: string | null;
  otCharges: string | null;
  breakdownTerms: string | null;
  dieselScope: string | null;
  workingHoursShift: string | null;
  craneAgeCriteriaYears: number | null;
  accommodationConveyance: string | null;
  paymentTerms: string | null;
  mobilisationTerms: string | null;
  supportCrane: string | null;
  steelMatsGroundPrep: string | null;
  ehsHrRequirements: string | null;
  insuranceTerms: string | null;
  extensionClause: string | null;
  notes: string | null;
  smlContactName: string | null;
  smlContactMobile: string | null;
  smlContactEmail: string | null;
  submissionDeadline: string;
  status: RfqStatus;
  rollupStatus: RfqRollupStatus | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** P6: the channels the RFQ was last dispatched through. */
  channels: MessageChannel[];
  createdBy: { id: string; email: string; fullName: string | null } | null;
}

/** The per-vendor summary the tracking list shows inline. */
export interface RfqListRecipient {
  recipientId: string;
  vendorName: string;
  emailDeliveryStatus: EmailDeliveryStatus;
  whatsappDeliveryStatus: EmailDeliveryStatus | null;
  responseStatus: ResponseStatus;
}

export interface RfqListRow extends Rfq {
  recipientCount: number;
  quotedCount: number;
  failedCount: number;
  pendingCount: number;
  recipients: RfqListRecipient[];
}

export interface RfqRecipient {
  recipientId: string;
  vendorId: string;
  vendorName: string;
  vendorOnboardingStatus: string;
  emails: string[];
  emailDeliveryStatus: EmailDeliveryStatus;
  emailDeliveryError: string | null;
  whatsappPhones: string[];
  whatsappDeliveryStatus: EmailDeliveryStatus | null;
  whatsappDeliveryError: string | null;
  firstViewedAt: string | null;
  responseStatus: ResponseStatus;
  respondedAt: string | null;
  declineReason: string | null;
  declineNote: string | null;
  reminderCount: number;
  lastReminderAt: string | null;
  candidateSnapshot: unknown;
}

export interface ReceivedQuotation {
  quotationId: string;
  vendorId: string;
  vendorName: string;
  version: number;
  isLatest: boolean;
  craneId: string;
  craneDescription: string;
  rentalRate: number;
  rateBasis: string;
  mobilisationCharges: number;
  demobilisationCharges: number;
  taxBasis: string;
  totalQuotedValue: number;
  validityDate: string;
  distanceToSiteKm: number | null;
  distanceMethod: DistanceMethod;
  /** Brief 6.9: a straight-line figure must be labelled, not presented as road. */
  distanceApproximate: boolean;
  /**
   * Brief 6.8 advisories, as `{ code, message }` — the same shape the vendor
   * preview and the detail screen return. Not plain strings: `code` is what a
   * caller would branch on.
   */
  warnings: Array<{ code: string; message: string }>;
  /** P6: how this quotation was captured. */
  source: QuoteSource;
  status: string;
  submittedAt: string;
}

export interface RfqDetail extends Rfq {
  recipients: RfqRecipient[];
  attachments: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number | null }>;
  quotations: ReceivedQuotation[];
}

// --- candidate picker (brief 6.9) ----------------------------------------

/**
 * The two recommendation views on an RFQ.
 *
 * `technical` matches crane type and capacity, nearest first. `distance` keeps
 * the type but drops the tonnage filter, so the nearest cranes show even when
 * they are short on capacity.
 */
export type CandidateMode = "technical" | "distance";

export interface CandidateCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  /** Lighter than the RFQ asks for — only reachable in distance mode. */
  belowRequiredCapacity: boolean;
  make: string;
  model: string;
  yom: number | null;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  loadChartFileName: string | null;
  /** Engaged, but released on or before the required start date. */
  availableInTime: boolean;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  /** When the crane's details were last edited (ISO). */
  lastUpdatedAt: string;
  distanceKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
}

export interface CandidateGroup {
  vendorId: string;
  vendorName: string;
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  cranes: CandidateCrane[];
}

export interface CandidateList {
  /** Which ranking produced this list. */
  mode: CandidateMode;
  site: {
    siteLocation: string;
    stateCode: string;
    stateName: string;
    latitude: number | null;
    longitude: number | null;
    locationUnverified: boolean;
  };
  /** False when the job site has no pin, so no distance can be produced at all. */
  distancesAvailable: boolean;
  located: CandidateGroup[];
  unverified: CandidateCrane[];
  capacityRule: string;
  startDateTbc: boolean;
  notice: string | null;
}

export interface ApprovedVendor {
  id: string;
  name: string;
  email: string;
  operatingRegions: Array<{ stateCode: string; state: { name: string } }>;
  users: Array<{ id: string; email: string; fullName: string | null }>;
}

// --- form ------------------------------------------------------------------

/** Strings while editing; `rfqToForm` and `toRfqPayload` are the only conversions. */
export interface RfqForm {
  craneType: string;
  capacityT: string;
  capacityRule: "AT_LEAST" | "EXACT";
  capacityNote: string;
  applicationDescription: string;
  loadDescription: string;
  mainBoomM: string;
  jibLengthM: string;
  startDateTbc: boolean;
  workingDaysPerMonth: string;
  quantity: string;
  siteLocation: string;
  siteStateCode: string;
  sitePincode: string;
  siteLatitude: string;
  siteLongitude: string;
  requiredStartDate: string;
  durationValue: string;
  durationUnit: DurationUnit;
  configuration: string;
  submissionDeadline: string;
  otCharges: string;
  breakdownTerms: string;
  dieselScope: string;
  workingHoursShift: string;
  craneAgeCriteriaYears: string;
  accommodationConveyance: string;
  paymentTerms: string;
  mobilisationTerms: string;
  supportCrane: string;
  steelMatsGroundPrep: string;
  ehsHrRequirements: string;
  insuranceTerms: string;
  extensionClause: string;
  notes: string;
  smlContactName: string;
  smlContactMobile: string;
  smlContactEmail: string;
}

export const EMPTY_RFQ_FORM: RfqForm = {
  craneType: "",
  capacityT: "",
  capacityRule: "AT_LEAST",
  capacityNote: "",
  applicationDescription: "",
  loadDescription: "",
  mainBoomM: "",
  jibLengthM: "",
  startDateTbc: false,
  workingDaysPerMonth: "",
  quantity: "1",
  siteLocation: "",
  siteStateCode: "",
  sitePincode: "",
  siteLatitude: "",
  siteLongitude: "",
  requiredStartDate: "",
  durationValue: "",
  durationUnit: "DAYS",
  configuration: "",
  submissionDeadline: "",
  otCharges: "",
  breakdownTerms: "",
  dieselScope: "",
  workingHoursShift: "",
  craneAgeCriteriaYears: "",
  accommodationConveyance: "",
  paymentTerms: "",
  mobilisationTerms: "",
  supportCrane: "",
  steelMatsGroundPrep: "",
  ehsHrRequirements: "",
  insuranceTerms: "",
  extensionClause: "",
  notes: "",
  smlContactName: "",
  smlContactMobile: "",
  smlContactEmail: "",
};

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`; the API returns a full ISO string. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `date` wants `YYYY-MM-DD`, read in UTC to match the anchor it was stored on. */
function toCalendarDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  // UTC getters, not local: the stored value is a calendar date, so reading it
  // back in local time would show the previous day west of UTC.
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function rfqToForm(rfq: Rfq): RfqForm {
  return {
    craneType: rfq.craneType,
    capacityT: String(rfq.capacityT),
    capacityRule: rfq.capacityRule,
    capacityNote: rfq.capacityNote ?? "",
    applicationDescription: rfq.applicationDescription ?? "",
    loadDescription: rfq.loadDescription ?? "",
    mainBoomM: rfq.mainBoomM === null ? "" : String(rfq.mainBoomM),
    jibLengthM: rfq.jibLengthM === null ? "" : String(rfq.jibLengthM),
    startDateTbc: rfq.startDateTbc,
    workingDaysPerMonth:
      rfq.workingDaysPerMonth === null ? "" : String(rfq.workingDaysPerMonth),
    quantity: String(rfq.quantity),
    siteLocation: rfq.siteLocation,
    siteStateCode: rfq.siteStateCode,
    sitePincode: rfq.sitePincode ?? "",
    siteLatitude: rfq.siteLatitude === null ? "" : String(rfq.siteLatitude),
    siteLongitude: rfq.siteLongitude === null ? "" : String(rfq.siteLongitude),
    requiredStartDate: toCalendarDate(rfq.requiredStartDate),
    durationValue: String(rfq.durationValue),
    durationUnit: rfq.durationUnit,
    configuration: rfq.configuration ?? "",
    submissionDeadline: toLocalInput(rfq.submissionDeadline),
    otCharges: rfq.otCharges ?? "",
    breakdownTerms: rfq.breakdownTerms ?? "",
    dieselScope: rfq.dieselScope ?? "",
    workingHoursShift: rfq.workingHoursShift ?? "",
    craneAgeCriteriaYears:
      rfq.craneAgeCriteriaYears === null ? "" : String(rfq.craneAgeCriteriaYears),
    accommodationConveyance: rfq.accommodationConveyance ?? "",
    paymentTerms: rfq.paymentTerms ?? "",
    mobilisationTerms: rfq.mobilisationTerms ?? "",
    supportCrane: rfq.supportCrane ?? "",
    steelMatsGroundPrep: rfq.steelMatsGroundPrep ?? "",
    ehsHrRequirements: rfq.ehsHrRequirements ?? "",
    insuranceTerms: rfq.insuranceTerms ?? "",
    extensionClause: rfq.extensionClause ?? "",
    notes: rfq.notes ?? "",
    smlContactName: rfq.smlContactName ?? "",
    smlContactMobile: rfq.smlContactMobile ?? "",
    smlContactEmail: rfq.smlContactEmail ?? "",
  };
}

/** Blank optional text is sent as null rather than "", matching the M3 crane form. */
const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

function coordinate(value: string): number | null {
  const text = value.trim();
  return text === "" ? null : Number(text);
}

/**
 * `type="date"` yields `YYYY-MM-DD`, a calendar day rather than an instant.
 *
 * It goes out as UTC midnight, which is the anchor the backend stores calendar
 * dates on, because the two are compared against each other: a crane that frees
 * up on the 5th has to satisfy a required start date of the 5th. Sending local
 * midnight instead would put the required date *before* the release date
 * everywhere east of UTC, and the picker would drop a crane that is actually
 * free in time.
 *
 * `new Date("2026-10-05")` already parses as UTC midnight, but that is a quirk of
 * the language spec rather than something the code says, so it is spelled out.
 */
function calendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return new Date(value);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * One serialisation for create and edit.
 *
 * Dates go out as ISO strings: `datetime-local` produces a local time with no
 * zone, and sending it raw would have the server read it as UTC. A vendor in
 * Gujarat picking 18:00 must mean 18:00 in Gujarat.
 */
function toRfqPayload(form: RfqForm) {
  return {
    craneType: form.craneType,
    capacityT: Number(form.capacityT),
    capacityRule: form.capacityRule,
    capacityNote: blankToNull(form.capacityNote),
    applicationDescription: blankToNull(form.applicationDescription),
    loadDescription: blankToNull(form.loadDescription),
    mainBoomM: form.mainBoomM.trim() === "" ? null : Number(form.mainBoomM),
    jibLengthM: form.jibLengthM.trim() === "" ? null : Number(form.jibLengthM),
    startDateTbc: form.startDateTbc,
    workingDaysPerMonth:
      form.workingDaysPerMonth.trim() === "" ? null : Number(form.workingDaysPerMonth),
    quantity: Number(form.quantity),
    siteLocation: form.siteLocation.trim(),
    siteStateCode: form.siteStateCode,
    sitePincode: blankToNull(form.sitePincode),
    siteLatitude: coordinate(form.siteLatitude),
    siteLongitude: coordinate(form.siteLongitude),
    requiredStartDate: calendarDate(form.requiredStartDate).toISOString(),
    durationValue: Number(form.durationValue),
    durationUnit: form.durationUnit,
    configuration: blankToNull(form.configuration),
    submissionDeadline: new Date(form.submissionDeadline).toISOString(),
    otCharges: blankToNull(form.otCharges),
    breakdownTerms: blankToNull(form.breakdownTerms),
    dieselScope: blankToNull(form.dieselScope),
    workingHoursShift: blankToNull(form.workingHoursShift),
    craneAgeCriteriaYears:
      form.craneAgeCriteriaYears.trim() === "" ? null : Number(form.craneAgeCriteriaYears),
    accommodationConveyance: blankToNull(form.accommodationConveyance),
    paymentTerms: blankToNull(form.paymentTerms),
    mobilisationTerms: blankToNull(form.mobilisationTerms),
    supportCrane: blankToNull(form.supportCrane),
    steelMatsGroundPrep: blankToNull(form.steelMatsGroundPrep),
    ehsHrRequirements: blankToNull(form.ehsHrRequirements),
    insuranceTerms: blankToNull(form.insuranceTerms),
    extensionClause: blankToNull(form.extensionClause),
    notes: blankToNull(form.notes),
    smlContactName: blankToNull(form.smlContactName),
    smlContactMobile: blankToNull(form.smlContactMobile),
    smlContactEmail: blankToNull(form.smlContactEmail),
  };
}

// --- calls -----------------------------------------------------------------

export interface ListRfqsFilters {
  status?: RfqStatus;
  search?: string;
  awaitingResponse?: boolean;
}

export function listRfqs(filters: ListRfqsFilters = {}): Promise<{ rfqs: RfqListRow[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  if (filters.awaitingResponse) params.set("awaitingResponse", "true");
  const query = params.toString();
  return api(`/rfqs${query ? `?${query}` : ""}`);
}

export function getRfq(rfqId: string): Promise<{ rfq: RfqDetail }> {
  return api(`/rfqs/${rfqId}`);
}

export function updateRfq(rfqId: string, form: RfqForm): Promise<{ rfq: Rfq }> {
  return api(`/rfqs/${rfqId}`, { method: "PUT", body: toRfqPayload(form) });
}

export function getCandidates(
  rfqId: string,
  mode: CandidateMode = "technical",
): Promise<{ candidates: CandidateList }> {
  return api(`/rfqs/${rfqId}/candidates?mode=${mode}`);
}

export function listApprovedVendors(search = ""): Promise<{ vendors: ApprovedVendor[] }> {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  return api(`/rfqs/approved-vendors${query}`);
}

export interface SendResult {
  sent: number;
  failed: number;
  results: Array<{
    vendorId: string;
    status: EmailDeliveryStatus;
    emailStatus: EmailDeliveryStatus | null;
    whatsappStatus: EmailDeliveryStatus | null;
    error?: string;
  }>;
}

export function sendRfq(
  rfqId: string,
  vendorIds: string[],
  channels: MessageChannel[] = ["EMAIL"],
): Promise<{ result: SendResult }> {
  return api(`/rfqs/${rfqId}/send`, { method: "POST", body: { vendorIds, channels } });
}

export function confirmSitePin(
  rfqId: string,
  siteLatitude: number,
  siteLongitude: number,
): Promise<{ rfq: Rfq }> {
  return api(`/rfqs/${rfqId}/site-pin`, {
    method: "PATCH",
    body: { siteLatitude, siteLongitude },
  });
}

export function extendDeadline(
  rfqId: string,
  submissionDeadline: string,
  reason?: string,
): Promise<{ result: { submissionDeadline: string; notified: number } }> {
  return api(`/rfqs/${rfqId}/deadline`, {
    method: "PATCH",
    body: { submissionDeadline: new Date(submissionDeadline).toISOString(), reason: reason || null },
  });
}

export function cancelRfq(rfqId: string, reason: string): Promise<{ result: { notified: number } }> {
  return api(`/rfqs/${rfqId}/cancel`, { method: "POST", body: { reason } });
}

/**
 * Award (brief 6.7 as revised, M7 + phase B2). Admin only on the backend
 * (`quotation:award`). The award creates the reservation for the crane; while
 * the RFQ's quantity is not reached it is **partial** and the other quotations
 * stay open. The optional reason is broad remarks for the email, not a channel
 * to negotiate. Dates are only needed when the RFQ's start date is TBC.
 */
export function awardQuotation(
  rfqId: string,
  quotationId: string,
  options: { reason?: string; reasonCode?: string; dates?: { startDate?: string; endDate?: string } } = {},
): Promise<{
  result: {
    awarded: true;
    quotationId: string;
    craneId: string;
    reservationId: string;
    reservationStart: string;
    reservationEnd: string;
    rfqNumber: string;
    partial: boolean;
    quantity: number;
    awardedCount: number;
    rfqClosed: boolean;
    notAwardedCount: number;
    notifiedAwarded: number;
    notifiedNotAwarded: number;
  };
}> {
  const body: Record<string, unknown> = {};
  if (options.reason?.trim()) body.reason = options.reason.trim();
  if (options.reasonCode?.trim()) body.reasonCode = options.reasonCode.trim();
  if (options.dates?.startDate) body.startDate = options.dates.startDate;
  if (options.dates?.endDate) body.endDate = options.dates.endDate;
  return api(`/rfqs/${rfqId}/quotations/${quotationId}/award`, {
    method: "POST",
    body,
  });
}

export function remindRfq(
  rfqId: string,
  recipientIds?: string[],
): Promise<{ result: { reminded: number; sent: number } }> {
  return api(`/rfqs/${rfqId}/remind`, {
    method: "POST",
    body: recipientIds?.length ? { recipientIds } : {},
  });
}

/**
 * Formats a distance the way brief 6.9 requires it to be read.
 *
 * An approximation is labelled inline rather than left for the reader to infer
 * from a smaller number, because a straight-line figure and a road figure for
 * the same pair are not comparable and look like they are.
 */
export function formatDistance(
  km: number | null,
  approximate: boolean,
): string {
  if (km === null) return "—";
  const rounded = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
  return approximate ? `${rounded} km (straight-line approx.)` : `${rounded} km`;
}

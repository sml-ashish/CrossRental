import { api, apiUpload } from "@/lib/api";

/**
 * Client for the vendor's own RFQs and quotations (brief 7.8, M5).
 *
 * A different surface from `lib/rfqs.ts`, and the difference is not cosmetic.
 * That module talks to `/api/rfqs`, which is internal and refuses vendors; this
 * one talks to `/api/vendor/rfqs`, which is gated on `rfq:respond` — a capability
 * no internal role holds. Nothing here decides what a vendor may see: every query
 * is scoped server-side by the token's vendor id, and another vendor's id comes
 * back as a 404 rather than an empty result.
 *
 * **Warnings are data, not errors.** `warnings` comes back on the preview and is
 * stored on the quotation. The brief is explicit that a crane of the wrong type
 * or one that frees up late is an advisory for sales, not a refusal — so the UI
 * shows them and still lets the vendor submit.
 */

export type RateBasis = "PER_DAY" | "PER_MONTH" | "LUMP_SUM";
export type DurationUnit = "DAYS" | "MONTHS";
export type QuotationStatus =
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "SHORTLISTED"
  | "AWARDED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED";
export type VendorResponseStatus = "PENDING" | "QUOTED" | "DECLINED" | "EXPIRED";
export type DistanceMethod = "road" | "straight_line";

export const RATE_BASIS_LABELS: Record<RateBasis, string> = {
  PER_DAY: "Per day",
  PER_MONTH: "Per month",
  LUMP_SUM: "Lump sum",
};

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  SHORTLISTED: "Shortlisted",
  AWARDED: "Awarded",
  REJECTED: "Not selected",
  WITHDRAWN: "Withdrawn",
  EXPIRED: "Expired",
};

export const VENDOR_RESPONSE_LABELS: Record<VendorResponseStatus, string> = {
  PENDING: "Awaiting your quote",
  QUOTED: "Quoted",
  DECLINED: "Declined",
  EXPIRED: "Expired",
};

export interface VendorWarning {
  code: string;
  message: string;
}

export interface VendorInboxRow {
  recipientId: string;
  rfqId: string;
  rfqNumber: string;
  craneType: string;
  craneTypeName: string;
  capacityT: number;
  quantity: number;
  siteLocation: string;
  siteStateCode: string;
  siteStateName: string;
  requiredStartDate: string;
  durationValue: number;
  durationUnit: DurationUnit;
  submissionDeadline: string;
  responseStatus: VendorResponseStatus;
  respondedAt: string | null;
  firstViewedAt: string | null;
  reminderCount: number;
  unread: boolean;
  overdue: boolean;
  canRespond: boolean;
  quotationCount: number;
  latestQuotationTotal: number | null;
}

export interface VendorRfqDetail {
  rfq: {
    rfqId: string;
    rfqNumber: string;
    enquiryNo: string;
    lineNo: string;
    craneType: string;
    craneTypeName: string;
    capacityT: number;
    quantity: number;
    siteLocation: string;
    siteStateCode: string;
    siteStateName: string;
    sitePincode: string | null;
    requiredStartDate: string;
    durationValue: number;
    durationUnit: DurationUnit;
    configuration: string | null;
    commercialTerms: {
      otCharges: string | null;
      breakdownTerms: string | null;
      dieselScope: string | null;
      workingHoursShift: string | null;
      accommodationConveyance: string | null;
      paymentTerms: string | null;
      extra: string | null;
    };
    smlContact: { name: string | null; mobile: string | null; email: string | null };
    submissionDeadline: string;
    locked: boolean;
    notes: string | null;
  };
  response: {
    responseStatus: VendorResponseStatus;
    declineReason: string | null;
    declineNote: string | null;
    respondedAt: string | null;
    reminderCount: number;
    canRespond: boolean;
  };
  quotations: VendorQuotation[];
}

export interface VendorQuotation {
  quotationId: string;
  craneId: string;
  craneLabel: string;
  version: number;
  isLatest: boolean;
  rentalRate: number;
  rateBasis: RateBasis;
  mobilisationCharges: number;
  totalQuotedValue: number;
  calculationNote: string | null;
  availabilityConfirmed: boolean;
  availableFrom: string | null;
  validityDate: string;
  acceptsCommercialTerms: boolean;
  deviationText: string | null;
  remarks: string | null;
  warnings: VendorWarning[];
  submittedAt: string;
  status: QuotationStatus;
  distanceToSiteKm: number | null;
  distanceMethod: DistanceMethod | null;
  /**
   * The server's own verdict on whether this version can still be acted on:
   * latest version, still SUBMITTED, and the RFQ not yet locked. Deliberately not
   * re-derived here — a non-latest version and an expired RFQ look the same from
   * the client but are refused for different reasons.
   */
  editable: boolean;
}

export interface QuotationPreview {
  rentalCharge: number;
  mobilisationCharges: number;
  totalQuotedValue: number;
  calculationNote: string;
  warnings: VendorWarning[];
  loadChartOnFile: boolean;
  /** False means a quote still needs a chart attached to be accepted. */
  loadChartSatisfied: boolean;
  distanceKm: number | null;
  distanceMethod: DistanceMethod | null;
  distanceApproximate: boolean;
  /** False with a reason when the RFQ or crane will not accept a quote right now. */
  canSubmit: boolean;
  blockedReason: string | null;
}

/** One crane's version series, newest first — the shape history is grouped into. */
export interface QuotationSeries {
  craneId: string;
  craneLabel: string;
  versions: Array<{
    quotationId: string;
    version: number;
    isLatest: boolean;
    status: QuotationStatus;
    rentalRate: number;
    rateBasis: RateBasis;
    mobilisationCharges: number;
    totalQuotedValue: number;
    calculationNote: string | null;
    validityDate: string;
    submittedAt: string;
    warnings: VendorWarning[];
  }>;
}

export interface QuoteInput {
  /** Omitted on a revision: a version series belongs to the crane already quoted. */
  craneId?: string;
  rentalRate: number | string;
  rateBasis: RateBasis;
  mobilisationCharges: number | string;
  availabilityConfirmed: boolean;
  availableFrom?: string | null;
  validityDate: string;
  acceptsCommercialTerms: boolean;
  deviationText?: string | null;
  remarks?: string | null;
}

export function listVendorRfqs(query: { responseStatus?: string; search?: string } = {}) {
  const params = new URLSearchParams();
  if (query.responseStatus) params.set("responseStatus", query.responseStatus);
  if (query.search) params.set("search", query.search);
  const suffix = params.toString();
  return api<{ rfqs: VendorInboxRow[] }>(`/vendor/rfqs${suffix ? `?${suffix}` : ""}`);
}

export function getVendorRfq(rfqId: string) {
  return api<VendorRfqDetail>(`/vendor/rfqs/${rfqId}`);
}

export function previewQuotation(rfqId: string, input: QuoteInput) {
  return api<{ preview: QuotationPreview }>(`/vendor/rfqs/${rfqId}/quotations/preview`, {
    method: "POST",
    body: input,
  });
}

/**
 * Submits a quotation, optionally with a load chart.
 *
 * Multipart even when there is no file, so one code path covers both and the
 * browser sets the boundary itself. The chart is only needed when the crane has
 * none on file, so the form asks for it conditionally rather than demanding a
 * file the vendor has already uploaded once.
 */
export function submitQuotation(
  rfqId: string,
  input: QuoteInput,
  loadChart: File | null = null,
) {
  return apiUpload<{
    quotation: {
      quotationId: string;
      version: number;
      totalQuotedValue: number;
      rentalCharge: number;
      calculationNote: string;
      warnings: VendorWarning[];
      distanceKm: number | null;
      distanceMethod: DistanceMethod | null;
      distanceApproximate: boolean;
    };
  }>(`/vendor/rfqs/${rfqId}/quotations`, loadChart, {
    method: "POST",
    fields: { ...input },
  });
}

export function reviseQuotation(
  quotationId: string,
  input: QuoteInput,
  loadChart: File | null = null,
) {
  return apiUpload<{
    quotation: {
      quotationId: string;
      version: number;
      totalQuotedValue: number;
      rentalCharge: number;
      calculationNote: string;
      warnings: VendorWarning[];
    };
  }>(`/vendor/rfqs/quotations/${quotationId}/revisions`, loadChart, {
    method: "POST",
    fields: { ...input },
  });
}

export function withdrawQuotation(quotationId: string, reason?: string) {
  return api<{ withdrawn: boolean; quotationId: string; version: number }>(
    `/vendor/rfqs/quotations/${quotationId}/withdraw`,
    { method: "POST", body: reason ? { reason } : {} },
  );
}

export function declineRfq(rfqId: string, body: { reason?: string; note?: string }) {
  return api<{
    declined: boolean;
    responseStatus: VendorResponseStatus;
    respondedAt: string | null;
  }>(`/vendor/rfqs/${rfqId}/decline`, {
    method: "POST",
    body,
  });
}

export function listQuotationHistory(rfqId: string) {
  return api<{ rfqId: string; rfqNumber: string; series: QuotationSeries[] }>(
    `/vendor/rfqs/${rfqId}/quotations`,
  );
}

/** Indian rupees, matching how the figure appears in the emails. */
export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
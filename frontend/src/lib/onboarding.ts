import { api, apiUpload, getStoredToken } from "@/lib/api";

/**
 * Client for the M2 onboarding endpoints (brief 7.2, 7.3).
 *
 * Two entry points exist for the same form: an invitation token from the
 * emailed link, and a signed-in vendor revisiting their own registration. The
 * paths are chosen here so the screens never build a URL themselves, and so the
 * token — which is a bearer credential — is only ever passed as a path
 * segment, never logged or stored.
 */

export type DocType =
  | "CANCELLED_CHEQUE"
  | "GST_CERTIFICATE"
  | "PAN_COPY"
  | "DECLARATION_SCAN"
  | "TDS_CERTIFICATE"
  | "MSME_CERTIFICATE"
  | "OTHER";

export interface OnboardingContact {
  name: string;
  mobile: string;
  telephone: string;
  email: string;
  isPrimary: boolean;
  receivesRfqs: boolean;
}

/** The editable form. Every field is optional until submit. */
export interface OnboardingForm {
  name: string;
  natureOfCompany: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  district: string;
  stateCode: string;
  pincode: string;
  telephone: string;
  fax: string;
  email: string;
  weeklyOffDays: string;
  companySize: string;
  pan: string;
  tan: string;
  gstRegistered: boolean;
  gstn: string;
  gstRegistrationType: string;
  gstr1FilingFrequency: string;
  cin: string;
  govtRegistrationType: string;
  govtRegistrationNo: string;
  msmeRegistered: boolean;
  msmeCategory: string;
  msmeRegNo: string;
  msmeExemptionDate: string;
  tdsLowerDeduction: boolean;
  tdsCertificateNo: string;
  tdsSection: string;
  tdsRatePercent: string;
  tdsValidFrom: string;
  tdsValidTo: string;
  operatingRegions: string[];
  contacts: OnboardingContact[];
  bankAccountHolderName: string;
  bankName: string;
  bankBranch: string;
  bankAccountType: string;
  /** Left blank when the vendor is not changing the stored value. */
  bankAccountNo: string;
  bankIfsc: string;
  bankMicr: string;
  bankIban: string;
  bankSwift: string;
  fleetSummary: string;
  codeOfConductAccepted: boolean;
  declarationName: string;
  declarationDesignation: string;
  declarationDate: string;
  communicationNotes: string;
}

export interface OnboardingDocument {
  docType: string;
  fileName: string;
  uploadedAt: string;
  sizeBytes?: number | null;
  label?: string;
}

export interface OnboardingState {
  vendorId: string | null;
  status: string;
  rejectionRemarks: string | null;
  canEdit: boolean;
  draft: Partial<OnboardingForm> | null;
  documents: OnboardingDocument[];
  missingDocuments: string[];
}

/** The token-scoped view also carries what the invite knew about the vendor. */
export interface OnboardingInviteState extends OnboardingState {
  token: string;
  prefill: {
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    expiresAt: string;
  };
}

export interface SaveResult {
  vendorId: string;
  status: string;
  warnings: string[];
}

const EMPTY_FORM: OnboardingForm = {
  name: "",
  natureOfCompany: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  district: "",
  stateCode: "",
  pincode: "",
  telephone: "",
  fax: "",
  email: "",
  weeklyOffDays: "",
  companySize: "",
  pan: "",
  tan: "",
  gstRegistered: false,
  gstn: "",
  gstRegistrationType: "",
  gstr1FilingFrequency: "",
  cin: "",
  govtRegistrationType: "",
  govtRegistrationNo: "",
  msmeRegistered: false,
  msmeCategory: "",
  msmeRegNo: "",
  msmeExemptionDate: "",
  tdsLowerDeduction: false,
  tdsCertificateNo: "",
  tdsSection: "",
  tdsRatePercent: "",
  tdsValidFrom: "",
  tdsValidTo: "",
  operatingRegions: [],
  contacts: [],
  bankAccountHolderName: "",
  bankName: "",
  bankBranch: "",
  bankAccountType: "",
  bankAccountNo: "",
  bankIfsc: "",
  bankMicr: "",
  bankIban: "",
  bankSwift: "",
  fleetSummary: "",
  codeOfConductAccepted: false,
  declarationName: "",
  declarationDesignation: "",
  declarationDate: "",
  communicationNotes: "",
};

/**
 * Merges a saved draft over the invitation prefill.
 *
 * The draft wins per field, but an invitee who has typed nothing yet should
 * still see their company name and email in the boxes — that is the whole point
 * of the SML user typing them into the invitation.
 */
export function initialForm(
  draft: Partial<OnboardingForm> | null,
  prefill?: { companyName: string | null; contactName: string | null; email: string | null },
): OnboardingForm {
  const merged: OnboardingForm = { ...EMPTY_FORM, ...(draft ?? {}) };

  // A stored draft carries every field, with undefined for "not answered yet" —
  // those must not wipe the defaults above.
  merged.gstRegistered = merged.gstRegistered === true;
  merged.msmeRegistered = merged.msmeRegistered === true;
  merged.tdsLowerDeduction = merged.tdsLowerDeduction === true;
  merged.contacts = (merged.contacts ?? []).map((c) => ({ ...c, receivesRfqs: c.receivesRfqs === true }));

  if (prefill) {
    if (!merged.name && prefill.companyName) merged.name = prefill.companyName;
    if (!merged.email && prefill.email) merged.email = prefill.email;
    if (merged.contacts.length === 0 && prefill.contactName) {
      merged.contacts = [
        {
          name: prefill.contactName,
          mobile: "",
          telephone: "",
          email: prefill.email ?? "",
          isPrimary: true,
          receivesRfqs: false,
        },
      ];
    }
  }

  return merged;
}

export function loadInvite(token: string) {
  return api<OnboardingInviteState>(
    `/onboarding/invitation/${encodeURIComponent(token)}`,
    { anonymous: true },
  );
}

export function loadOwnOnboarding() {
  return api<OnboardingState>("/onboarding");
}

/**
 * Saves the form.
 *
 * Only fields the vendor actually touched are sent, so a section-by-section
 * save never blanks the sections they have not reached yet.
 */
export function saveForm(
  token: string | null,
  form: OnboardingForm,
  touched: ReadonlySet<keyof OnboardingForm>,
) {
  const body: Record<string, unknown> = {};
  for (const key of touched) {
    if (key === "contacts" || key === "operatingRegions") {
      body[key] = form[key];
      continue;
    }
    body[key] = form[key];
  }

  // Never send an unchanged bank number: the field is blank by design after the
  // first save, and sending "" would be read as clearing the stored value.
  if (!touched.has("bankAccountNo")) delete body["bankAccountNo"];
  if (!touched.has("bankIfsc")) delete body["bankIfsc"];

  // Booleans always travel, even untouched, so a draft save records an
  // explicit answer rather than leaving the master flags null.
  for (const key of ["gstRegistered", "msmeRegistered", "tdsLowerDeduction"] as const) {
    body[key] ??= form[key];
  }
  // Numeric input arrives as a string from the form; the API expects a number.
  if (typeof body["tdsRatePercent"] === "string") {
    const n = Number(body["tdsRatePercent"]);
    body["tdsRatePercent"] = body["tdsRatePercent"] === "" ? undefined : Number.isFinite(n) ? n : undefined;
  }

  return token
    ? api<SaveResult>(`/onboarding/invitation/${encodeURIComponent(token)}`, {
        method: "PUT",
        body,
        anonymous: true,
      })
    : api<SaveResult>("/onboarding", { method: "PUT", body });
}

export function submitForm(token: string | null, form: OnboardingForm) {
  return token
    ? api<SaveResult>(`/onboarding/invitation/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        body: form,
        anonymous: true,
      })
    : api<SaveResult>("/onboarding/submit", { method: "POST", body: form });
}

export function uploadDocument(token: string | null, docType: DocType, file: File) {
  const path = token
    ? `/onboarding/invitation/${encodeURIComponent(token)}/documents/${docType}`
    : `/onboarding/documents/${docType}`;
  return apiUpload<{ document: OnboardingDocument }>(path, file, {
    anonymous: Boolean(token),
  });
}

/** Streams a stored document back. Fetched rather than linked so it is authenticated. */
export async function downloadDocument(
  path: string,
  token?: string | null,
): Promise<{ blob: Blob; fileName: string }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? "/api"}${path}`, { headers });
  if (!response.ok) {
    throw new Error("That file could not be downloaded.");
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await response.blob(),
    fileName: match?.[1] ?? "document",
  };
}

// ---------------------------------------------------------------------------
// SAP vendor creation sheet (brief D3, admin only)
// ---------------------------------------------------------------------------

export interface SapSheetRow {
  label: string;
  value: string;
}

export interface SapSheetSection {
  title: string;
  rows: SapSheetRow[];
}

export interface SapSheet {
  vendorId: string;
  vendorName: string;
  sapVendorCode: string | null;
  generatedAt: string;
  sections: SapSheetSection[];
}

export function loadSapSheet(vendorId: string) {
  return api<{ sheet: SapSheet }>(`/vendors/${encodeURIComponent(vendorId)}/sap-sheet`);
}

/** Streams the SpreadsheetML export back. Fetched rather than linked so it is authenticated. */
export async function downloadSapSheet(
  vendorId: string,
): Promise<{ blob: Blob; fileName: string }> {
  const token = getStoredToken();
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? "/api"}/vendors/${encodeURIComponent(vendorId)}/sap-sheet.xls`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "The SAP creation sheet is restricted to administrators."
        : "That sheet could not be downloaded.",
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), fileName: match?.[1] ?? "SAP-vendor-sheet.xls" };
}

// ---------------------------------------------------------------------------
// Admin / sales side
// ---------------------------------------------------------------------------

export interface QueueVendor {
  id: string;
  name: string | null;
  email: string | null;
  pan: string | null;
  gstn: string | null;
  sapVendorCode: string | null;
  onboardingStatus: string;
  adminRemarks: string | null;
  approvedAt: string | null;
  totalFleetSize: number;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  stateCode: string | null;
  pincode: string | null;
  operatingRegions: string[];
  updatedAt: string;
  contacts: { name: string; email: string | null; mobile: string | null }[];
  documents: { docType: string }[];
  bankVisible: boolean;
}

export interface VendorQueue {
  vendors: QueueVendor[];
  counts: Record<string, number>;
}

export interface VendorDecision {
  id: string;
  outcome: string;
  remarks: string | null;
  createdAt: string;
  decidedBy: { fullName: string | null; email: string } | null;
}

export interface VendorDetail {
  id: string;
  sapVendorCode: string | null;
  name: string | null;
  natureOfCompany: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  stateCode: string | null;
  /** The related State row, as sent by the detail endpoint. */
  addressState: { name: string } | null;
  pincode: string | null;
  telephone: string | null;
  fax: string | null;
  email: string | null;
  weeklyOffDays: string | null;
  companySize: string | null;
  pan: string | null;
  tan: string | null;
  gstRegistered: boolean | null;
  gstn: string | null;
  gstRegistrationType: string | null;
  gstr1FilingFrequency: string | null;
  cin: string | null;
  govtRegistrationType: string | null;
  govtRegistrationNo: string | null;
  msmeRegistered: boolean | null;
  msmeCategory: string | null;
  msmeRegNo: string | null;
  msmeExemptionDate: string | null;
  tdsLowerDeduction: boolean | null;
  tdsCertificateNo: string | null;
  tdsSection: string | null;
  tdsRatePercent: number | null;
  tdsValidFrom: string | null;
  tdsValidTo: string | null;
  fleetSummary: string | null;
  codeOfConductAccepted: boolean | null;
  declarationName: string | null;
  declarationDesignation: string | null;
  declarationDate: string | null;
  bankMicr: string | null;
  bankIban: string | null;
  bankSwift: string | null;
  communicationNotes: string | null;
  onboardingStatus: string;
  adminRemarks: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  facilityStatus: string | null;
  manpowerStatus: string | null;
  improvementRequirement: string | null;
  improvementPeriod: string | null;
  totalFleetSize: number;
  createdAt: string;
  updatedAt: string;
  operatingRegions: string[];
  contacts: OnboardingContact[];
  documents: OnboardingDocument[];
  decisions: VendorDecision[];
  users: { id: string; email: string; fullName: string | null; activatedAt: string | null }[];
  approvedBy: { id: string; fullName: string | null; email: string } | null;
  /** Present only for an admin. Absent entirely for sales. */
  bankVisible: boolean;
  bankAccountHolderName?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankAccountType?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
}

export interface VendorDetailResponse {
  vendor: VendorDetail;
  missingDocuments: string[];
  canApprove: boolean;
}

export function listVendors(status: string, search: string) {
  const params = new URLSearchParams({ status });
  if (search.trim()) params.set("search", search.trim());
  return api<VendorQueue>(`/vendors?${params.toString()}`);
}

export function loadVendorDetail(vendorId: string) {
  return api<VendorDetailResponse>(`/vendors/${encodeURIComponent(vendorId)}`);
}

export function approveVendor(
  vendorId: string,
  body: {
    sapVendorCode?: string;
    adminRemarks?: string;
    officeUse?: {
      facilityStatus?: string;
      manpowerStatus?: string;
      improvementRequirement?: string;
      improvementPeriod?: string;
    };
  },
) {
  return api<{ vendorId: string; userId: string; activationEmailSent: boolean }>(
    `/vendors/${encodeURIComponent(vendorId)}/approve`,
    { method: "POST", body },
  );
}

export function rejectVendor(vendorId: string, body: { remarks: string }) {
  return api<{ vendorId: string; rejectionEmailSent: boolean }>(
    `/vendors/${encodeURIComponent(vendorId)}/reject`,
    { method: "POST", body },
  );
}

export function resendActivation(vendorId: string) {
  return api<{ sent: boolean }>(`/vendors/${encodeURIComponent(vendorId)}/resend-activation`, {
    method: "POST",
  });
}

export function inviteVendor(body: { email: string; companyName?: string; contactName?: string }) {
  return api<{ invitationId: string; token: string; expiresAt: string }>("/vendors/invitations", {
    method: "POST",
    body,
  });
}

export const DOCUMENT_LABELS: Record<string, string> = {
  CANCELLED_CHEQUE: "Cancelled cheque",
  GST_CERTIFICATE: "GST certificate",
  PAN_COPY: "PAN card copy",
  DECLARATION_SCAN: "Signed declaration page",
  TDS_CERTIFICATE: "TDS exemption certificate",
  MSME_CERTIFICATE: "MSME registration certificate",
  OTHER: "Other supporting document",
};

/** Documents every vendor uploads; the GST certificate joins only when registered. */
export const REQUIRED_DOC_TYPES: DocType[] = ["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN"];
import { api, apiUpload } from "@/lib/api";

/**
 * Client for the M2 onboarding endpoints (brief 7.2, 7.3).
 *
 * Two entry points exist for the same form: an invitation token from the
 * emailed link, and a signed-in vendor revisiting their own registration. The
 * paths are chosen here so the screens never build a URL themselves, and so the
 * token — which is a bearer credential — is only ever passed as a path
 * segment, never logged or stored.
 */

export type DocType = "CANCELLED_CHEQUE" | "GST_CERTIFICATE" | "PAN_COPY" | "OTHER";

export interface OnboardingContact {
  name: string;
  mobile: string;
  telephone: string;
  email: string;
  isPrimary: boolean;
}

/** The editable form. Every field is optional until submit. */
export interface OnboardingForm {
  name: string;
  natureOfCompany: string;
  registeredAddress: string;
  telephone: string;
  fax: string;
  email: string;
  weeklyOffDays: string;
  companySize: string;
  pan: string;
  tan: string;
  gstn: string;
  gstCompositionOpted: boolean;
  gstr1FilingFrequency: string;
  cin: string;
  govtRegistrationType: string;
  govtRegistrationNo: string;
  msmeCategory: string;
  operatingRegions: string[];
  contacts: OnboardingContact[];
  bankAccountHolderName: string;
  bankName: string;
  bankBranch: string;
  bankAccountType: string;
  /** Left blank when the vendor is not changing the stored value. */
  bankAccountNo: string;
  bankIfsc: string;
  fleetSummary: string;
  codeOfConductAccepted: boolean;
  declarationName: string;
  declarationDesignation: string;
  declarationDate: string;
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
  registeredAddress: "",
  telephone: "",
  fax: "",
  email: "",
  weeklyOffDays: "",
  companySize: "",
  pan: "",
  tan: "",
  gstn: "",
  gstCompositionOpted: false,
  gstr1FilingFrequency: "",
  cin: "",
  govtRegistrationType: "",
  govtRegistrationNo: "",
  msmeCategory: "",
  operatingRegions: [],
  contacts: [],
  bankAccountHolderName: "",
  bankName: "",
  bankBranch: "",
  bankAccountType: "",
  bankAccountNo: "",
  bankIfsc: "",
  fleetSummary: "",
  codeOfConductAccepted: false,
  declarationName: "",
  declarationDesignation: "",
  declarationDate: "",
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

  if (prefill) {
    if (!merged.name && prefill.companyName) merged.name = prefill.companyName;
    if (!merged.email && prefill.email) merged.email = prefill.email;
    if (merged.contacts.length === 0 && prefill.contactName) {
      merged.contacts = [
        { name: prefill.contactName, mobile: "", telephone: "", email: prefill.email ?? "", isPrimary: true },
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
  registeredAddress: string | null;
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
  registeredAddress: string | null;
  telephone: string | null;
  fax: string | null;
  email: string | null;
  weeklyOffDays: string | null;
  companySize: string | null;
  pan: string | null;
  tan: string | null;
  gstn: string | null;
  gstCompositionOpted: boolean | null;
  gstr1FilingFrequency: string | null;
  cin: string | null;
  govtRegistrationType: string | null;
  govtRegistrationNo: string | null;
  msmeCategory: string | null;
  fleetSummary: string | null;
  codeOfConductAccepted: boolean | null;
  declarationName: string | null;
  declarationDesignation: string | null;
  declarationDate: string | null;
  onboardingStatus: string;
  adminRemarks: string | null;
  approvedAt: string | null;
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
  OTHER: "Other supporting document",
};

export const REQUIRED_DOC_TYPES: DocType[] = ["CANCELLED_CHEQUE", "GST_CERTIFICATE", "PAN_COPY"];
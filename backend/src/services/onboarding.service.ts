import { createHash } from "crypto";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { portalUrl } from "../utils/jwt";
import { encryptField, last4, randomToken, safeEquals } from "../utils/crypto";
import { recordAudit } from "./audit.service";
import { sendTemplate } from "./email.service";
import {
  accountNoField,
  cinField,
  emailField,
  gstnField,
  gstinPanMismatch,
  ifscField,
  longText,
  micrField,
  mobileField,
  panCompanyTypeMismatch,
  panField,
  pastOrTodayField,
  phoneField,
  pincodeField,
  shortText,
  stateCodeList,
} from "../validation/vendorFields";
import type { AuthedRequest } from "../middleware/auth";

/**
 * Vendor onboarding: invitation, draft, submission (brief 7.2 and 7.3).
 *
 * Flow
 * ----
 *   inviteVendor()          admin/sales sends a link  (brief 8)
 *   loadByToken()           vendor opens the link, sees a prefilled draft
 *   saveDraft()             partial save, no validation beyond shape
 *   submit()                full validation, status -> SUBMITTED, admin emailed
 *   approveVendor()         (approval.service.ts) creates the login
 *   rejectVendor()          (approval.service.ts) emails the remarks
 *
 * Onboarding is invite-gated. Brief 8 replaces the paper registration mail
 * with a portal link, so a new vendor arrives holding a token rather than
 * reaching a public sign-up endpoint. Only the SHA-256 of that token is
 * stored.
 *
 * A draft is allowed to be incomplete — that is the point of it — so "mandatory"
 * in brief 5.1 is enforced on submit, not by the database. `submit()` re-runs
 * the same `onboardingSchema` that `approveVendor()` uses, so an incomplete
 * form can never reach APPROVED.
 */

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

/**
 * An optional choice, where a blank means "not answered".
 *
 * A `<select>` with a placeholder submits `""` when nothing is picked, which a
 * bare `z.enum(...).optional()` rejects with "Invalid option" — an error the
 * vendor cannot act on, for a field they deliberately left alone. This mirrors
 * `optionalTrimmed` above so a blank is uniformly "not provided" across the
 * form. Required choices are left strict, since there a blank *is* a mistake.
 */
const optionalChoice = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .optional()
    .or(z.literal("").transform(() => undefined));

/**
 * An email that may be left blank.
 *
 * A form posts "" for an untouched input, so "" has to mean "no email" rather
 * than "invalid email" — otherwise a secondary contact with no address, which
 * the schema explicitly allows, cannot be saved at all.
 */
const optionalEmail = z
  .union([emailField, z.literal("").transform(() => undefined)])
  .optional();

/**
 * The draft shape. Everything the vendor types on the onboarding form.
 *
 * Bank account number and IFSC arrive in clear text over the wire and are
 * encrypted before they touch the database — they are never stored in clear,
 * and never logged (the request logger deliberately records no body).
 */
export const onboardingSchema = z.object({
  // Company
  name: shortText.min(2, "Company name is required"),
  natureOfCompany: z.enum(["PUBLIC_LTD", "PRIVATE_LTD", "PARTNERSHIP", "PROPRIETORSHIP"], {
    message: "Select the nature of the company",
  }),
  // Structured address (brief 5.1). Line 1, city, district, state and pincode
  // are mandatory; line 2 is the optional second line.
  addressLine1: shortText.min(5, "Address line 1 is required"),
  addressLine2: optionalTrimmed(200),
  city: shortText.min(2, "City is required"),
  district: shortText.min(2, "District is required"),
  stateCode: z.string().trim().toUpperCase().length(2, "Select the state"),
  pincode: pincodeField,
  telephone: phoneField,
  fax: optionalTrimmed(50),
  email: emailField,
  weeklyOffDays: optionalTrimmed(100),
  companySize: optionalTrimmed(50),

  // Registration
  pan: panField,
  tan: optionalTrimmed(10),

  // GST block. Whether the vendor is registered drives the rest, so the
  // choice itself is a required field (brief 5.1: "Mandatory choice"); the
  // consequences are enforced at submit, not here, so a draft can be parked
  // half-way through the block.
  gstRegistered: z.boolean(),
  gstn: gstnField.optional(),
  gstRegistrationType: optionalChoice(["REGULAR", "COMPOSITE", "SEZ", "EOU"]),
  gstr1FilingFrequency: optionalChoice(["MONTHLY", "QUARTERLY", "COMPOSITE"]),
  cin: optionalTrimmed(21),
  govtRegistrationType: optionalTrimmed(100),
  govtRegistrationNo: optionalTrimmed(100),

  // MSME block
  msmeRegistered: z.boolean(),
  msmeCategory: optionalChoice(["MICRO", "SMALL", "MEDIUM"]),
  msmeRegNo: optionalTrimmed(50),
  msmeExemptionDate: pastOrTodayField.optional(),

  // TDS block
  tdsLowerDeduction: z.boolean(),
  tdsCertificateNo: optionalTrimmed(100),
  tdsSection: optionalTrimmed(20),
  tdsRatePercent: z.number().int().min(0).max(100).optional(),
  tdsValidFrom: pastOrTodayField.optional(),
  tdsValidTo: pastOrTodayField.optional(),

  operatingRegions: stateCodeList(1, "state"),

  // Contact persons. Brief 7.2 has a repeatable section; exactly one must be
  // primary, and the primary contact's email becomes the login. receivesRfqs
  // (brief 5.3) marks the contacts who get the RFQ emails.
  contacts: z
    .array(
      z.object({
        name: shortText.min(2, "Contact name is required"),
        mobile: mobileField,
        telephone: optionalTrimmed(50),
        email: optionalEmail,
        isPrimary: z.boolean().default(false),
        receivesRfqs: z.boolean().default(false),
      }),
    )
    .min(1, "Add at least one contact person")
    .max(10, "A maximum of 10 contacts is allowed")
    .refine((c) => c.some((x) => x.isPrimary), "Mark one contact as primary")
    .refine((c) => c.filter((x) => x.isPrimary).length === 1, "Only one contact can be primary")
    .refine(
      (c) => {
        const primary = c.find((x) => x.isPrimary);
        return primary?.email ? true : "The primary contact needs an email — it becomes the portal login";
      },
      { message: "The primary contact needs an email — it becomes the portal login" },
    ),

  // Bank
  bankAccountHolderName: shortText.min(2, "Account holder name is required"),
  bankName: shortText.min(2, "Bank name is required"),
  bankBranch: shortText.min(2, "Branch is required"),
  bankAccountType: z.enum(["SAVING", "CURRENT", "OTHER"], { message: "Select the account type" }),
  // Optional in the schema: the edit form is only ever given the mask, never
  // the clear value back, so a resubmission cannot be required to retype it.
  // Submit checks these against the stored values instead.
  bankAccountNo: accountNoField.optional(),
  bankIfsc: ifscField.optional(),
  bankMicr: micrField.optional(),
  // Foreign-bank fields (brief 5.1): optional, only meaningful for accounts
  // outside India.
  bankIban: optionalTrimmed(34),
  bankSwift: optionalTrimmed(11),

  // Fleet summary + declaration
  fleetSummary: longText.min(5, "Describe the crane categories and approximate fleet size"),
  codeOfConductAccepted: z.literal(true, {
    message: "You must accept the code of conduct",
  }),
  declarationName: shortText.min(2, "Your name is required"),
  declarationDesignation: shortText.min(2, "Your designation is required"),
  declarationDate: pastOrTodayField,

  // Communication preferences: email is the only channel for now, so this is
  // the vendor's notes on how they want to be reached.
  communicationNotes: optionalTrimmed(500),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

/**
 * Cross-field and conditional rules that a single field cannot carry (brief
 * 5.1). Returns a list rather than throwing so `submit` can report every
 * problem at once — a vendor filling a long form should not fix one field per
 * round trip. Draft saves deliberately skip these: parking a half-finished GST
 * block must not require having decided `gstRegistered` first.
 */
export function onboardingSubmitProblems(input: OnboardingInput): string[] {
  const problems: string[] = [];

  // GST: registered means a GSTN and a registration type; unregistered means
  // neither (the GSTN column is stored as null, brief 5.1).
  if (input.gstRegistered) {
    if (!input.gstn) problems.push("GSTIN is required for a GST-registered vendor");
    if (!input.gstRegistrationType) problems.push("GST registration type is required for a GST-registered vendor");
  } else if (input.gstn || input.gstRegistrationType) {
    problems.push("GSTIN and registration type only apply to a GST-registered vendor");
  }

  // The PAN embedded in the GSTIN must match the PAN entered (brief 5.1).
  if (input.gstn && input.pan && gstinPanMismatch(input.gstn, input.pan)) {
    problems.push("The PAN embedded in the GSTIN does not match the PAN you entered");
  }

  // The PAN's 4th letter must match the nature of the company (brief 5.1).
  if (input.pan && panCompanyTypeMismatch(input.pan, input.natureOfCompany)) {
    problems.push("The 4th letter of the PAN does not match the nature of the company (C for a company, F for a partnership, P for a proprietorship)");
  }

  // MSME: category and registration number are required when registered
  // (brief 5.1); the exemption date stays optional.
  if (input.msmeRegistered) {
    if (!input.msmeCategory) problems.push("MSME category is required for an MSME-registered vendor");
    if (!input.msmeRegNo) problems.push("MSME registration number is required for an MSME-registered vendor");
  }

  // TDS: certificate number, section, rate and the validity window are
  // required when a lower deduction is claimed (brief 5.1).
  if (input.tdsLowerDeduction) {
    if (!input.tdsCertificateNo) problems.push("TDS certificate number is required for a lower-deduction claim");
    if (!input.tdsSection) problems.push("TDS section is required for a lower-deduction claim");
    if (input.tdsRatePercent === undefined) problems.push("TDS rate is required for a lower-deduction claim");
    if (!input.tdsValidFrom) problems.push("TDS valid-from date is required for a lower-deduction claim");
    if (!input.tdsValidTo) problems.push("TDS valid-to date is required for a lower-deduction claim");
  }

  return problems;
}

/**
 * Advisory checks reported on submit but never blocking (brief 7.2). A CIN on
 * a proprietorship is odd but harmless; the submit endpoint returns these so
 * the UI can show them without failing the submission.
 */
export function onboardingWarnings(input: OnboardingInput): string[] {
  const warnings: string[] = [];
  if (input.cin && input.natureOfCompany !== "PUBLIC_LTD" && input.natureOfCompany !== "PRIVATE_LTD") {
    warnings.push("A CIN applies to a company. You have selected a different nature of company.");
  }
  const emails = input.contacts.map((c) => c.email?.toLowerCase()).filter(Boolean) as string[];
  if (new Set(emails).size !== emails.length) {
    warnings.push("Two contacts share the same email address.");
  }
  if (input.email.toLowerCase() !== input.contacts.find((c) => c.isPrimary)?.email?.toLowerCase()) {
    warnings.push("The company email differs from the primary contact's email.");
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------

export interface InviteInput {
  email?: string | null;
  companyName?: string | null;
  contactName?: string | null;
}

export async function inviteVendor(
  input: InviteInput,
  actor: AuthedRequest["user"],
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const email = input.email?.trim().toLowerCase() || null;

  if (email) {
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      throw AppError.conflict("An account already exists for that email address.");
    }

    // Do not stack invitations on one address; the vendor would then have two
    // live links and no way to tell which is current.
    const live = await prisma.vendorInvitation.findFirst({
      where: { email, revokedAt: null, submittedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (live) {
      throw AppError.conflict("An invitation for that email address is already outstanding.");
    }
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.onboarding.invitationTtlDays * 24 * 60 * 60 * 1000);

  const invitation = await prisma.vendorInvitation.create({
    data: {
      tokenHash: hashToken(token),
      email,
      companyName: input.companyName?.trim() || null,
      contactName: input.contactName?.trim() || null,
      createdById: actor.id,
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });

  if (!email) {
    // Nothing to send to. The admin can copy the link out of the queue instead.
    return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
  }

  const result = await sendTemplate({
    to: email,
    template: "vendor_invitation",
    // Placeholder names must match services/emailTemplates.ts exactly; an
    // unmatched name is left in the body as literal {{...}}.
    vars: {
      onboardingUrl: portalUrl(`/onboarding/start?token=${encodeURIComponent(token)}`),
    },
    entity: "vendor_invitation",
    entityId: invitation.id,
  });

  if (!result.sent) {
    // The invitation row is kept so the admin can resend or copy the link, but
    // they need to know the mail did not go out.
    throw new AppError(
      "The invitation was created but the email could not be sent. Copy the link from the queue instead.",
      502,
      "INVITATION_EMAIL_FAILED",
    );
  }

  await recordAudit({
    entity: "vendor_invitation",
    entityId: invitation.id,
    action: "invite_sent",
    newValue: { email, companyName: input.companyName ?? null },
    actor,
  });

  return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
}

// ---------------------------------------------------------------------------
// Reading the form by token
// ---------------------------------------------------------------------------

export interface OnboardingView {
  token: string;
  vendorId: string | null;
  status: string;
  /** Populated only when the form was rejected, so the vendor can see why. */
  rejectionRemarks: string | null;
  canEdit: boolean;
  prefill: {
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    expiresAt: string;
  };
  draft: Record<string, unknown> | null;
  documents: { docType: string; fileName: string; uploadedAt: string }[];
  missingDocuments: string[];
}

/** Throws unless the token resolves to a usable invitation. */
async function resolveInvitation(token: string) {
  if (!token || token.length < 20) {
    throw AppError.badRequest("This registration link is not valid.");
  }

  const invitation = await prisma.vendorInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { vendor: { select: { id: true, onboardingStatus: true } } },
  });

  // Compare against a hash of the same length regardless of whether a match
  // exists, so a missing invitation and a wrong token cost the same.
  const matches = invitation !== null && safeEquals(invitation.tokenHash, hashToken(token));
  if (!matches || !invitation) {
    throw AppError.badRequest("This registration link is not valid.");
  }
  if (invitation.revokedAt) {
    throw AppError.badRequest("This registration link has been withdrawn. Please contact your SML contact.");
  }
  if (invitation.expiresAt < new Date()) {
    throw AppError.badRequest("This registration link has expired. Please ask your SML contact to resend it.");
  }

  return invitation;
}

/**
 * Resolves an invitation token to its vendor, for the document endpoints that
 * need a vendorId but not the whole form. Throws unless the token is valid,
 * unrevoked and unexpired — the same rules as the form itself, so a withdrawn
 * link cannot still be used to upload a PAN copy.
 */
export async function resolveVendorByToken(
  token: string,
): Promise<{ vendorId: string | null; invitationId: string }> {
  const invitation = await resolveInvitation(token);
  return { vendorId: invitation.vendor?.id ?? null, invitationId: invitation.id };
}

/**
 * Whether a registration may still be edited.
 *
 * DRAFT is always editable. REJECTED is editable again because brief 7.3 lets a
 * vendor correct a rejected registration and resubmit it within the window. Once
 * SUBMITTED the form is frozen for review; APPROVED is frozen permanently.
 */
export function isEditableStatus(status: string): boolean {
  return status === "DRAFT" || status === "REJECTED";
}

/**
 * Documents every submit needs (brief 7.2): the cancelled cheque and PAN copy
 * for everyone, plus the signed declaration page (open item 4 — the checkbox
 * stands, and the scan of the signed page is uploaded beside it).
 */
export const REQUIRED_DOCUMENTS = ["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN"] as const;

export const REQUIRED_DOCUMENT_LABELS: Record<string, string> = {
  CANCELLED_CHEQUE: "Cancelled cheque",
  GST_CERTIFICATE: "GST certificate",
  PAN_COPY: "PAN copy",
  DECLARATION_SCAN: "Signed declaration page",
  TDS_CERTIFICATE: "TDS exemption certificate",
  MSME_CERTIFICATE: "MSME registration certificate",
  OTHER: "Other supporting document",
};

/**
 * The full list for a given form state: a GST-registered vendor also owes the
 * GST certificate (brief 7.2's "if applicable"), and an unregistered vendor
 * does not.
 */
export function requiredDocumentsFor(gstRegistered: boolean): string[] {
  return gstRegistered ? [...REQUIRED_DOCUMENTS, "GST_CERTIFICATE"] : [...REQUIRED_DOCUMENTS];
}

export async function loadByToken(token: string): Promise<OnboardingView> {
  const invitation = await resolveInvitation(token);

  const canEdit = isEditableStatus(invitation.vendor?.onboardingStatus ?? "DRAFT");

  // Reuse the same read as the authenticated path so the two can never drift.
  const vendor = invitation.vendorId ? await loadVendorDraft(invitation.vendorId) : null;

  const uploaded = new Set((vendor?.documents ?? []).map((d) => d.docType));

  return {
    token,
    vendorId: vendor?.id ?? null,
    status: vendor?.onboardingStatus ?? "DRAFT",
    rejectionRemarks:
      vendor && vendor.onboardingStatus === "REJECTED" ? (vendor.decisions[0]?.remarks ?? vendor.adminRemarks) : null,
    canEdit,
    prefill: {
      companyName: invitation.companyName,
      contactName: invitation.contactName,
      email: invitation.email,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    draft: vendor ? shapeDraft(vendor) : null,
    documents: (vendor?.documents ?? []).map((d) => ({
      docType: d.docType,
      fileName: d.fileName,
      uploadedAt: d.uploadedAt.toISOString(),
    })),
    missingDocuments: requiredDocumentsFor(vendor?.gstRegistered === true).filter((d) => !uploaded.has(d)),
  };
}

/** Maps a vendor row back onto the form's field names for the edit screen. */
function shapeDraft(vendor: VendorDraftRow) {
  return {
    name: vendor.name ?? "",
    natureOfCompany: vendor.natureOfCompany ?? undefined,
    addressLine1: vendor.addressLine1 ?? "",
    addressLine2: vendor.addressLine2 ?? "",
    city: vendor.city ?? "",
    district: vendor.district ?? "",
    stateCode: vendor.stateCode ?? "",
    pincode: vendor.pincode ?? "",
    telephone: vendor.telephone ?? "",
    fax: vendor.fax ?? "",
    email: vendor.email ?? "",
    weeklyOffDays: vendor.weeklyOffDays ?? "",
    companySize: vendor.companySize ?? "",
    pan: vendor.pan ?? "",
    tan: vendor.tan ?? "",
    gstRegistered: vendor.gstRegistered ?? undefined,
    gstn: vendor.gstn ?? "",
    gstRegistrationType: vendor.gstRegistrationType ?? undefined,
    gstr1FilingFrequency: vendor.gstr1FilingFrequency ?? undefined,
    cin: vendor.cin ?? "",
    govtRegistrationType: vendor.govtRegistrationType ?? "",
    govtRegistrationNo: vendor.govtRegistrationNo ?? "",
    msmeRegistered: vendor.msmeRegistered ?? undefined,
    msmeCategory: vendor.msmeCategory ?? undefined,
    msmeRegNo: vendor.msmeRegNo ?? "",
    msmeExemptionDate: vendor.msmeExemptionDate?.toISOString().slice(0, 10) ?? "",
    tdsLowerDeduction: vendor.tdsLowerDeduction ?? undefined,
    tdsCertificateNo: vendor.tdsCertificateNo ?? "",
    tdsSection: vendor.tdsSection ?? "",
    tdsRatePercent: vendor.tdsRatePercent ?? undefined,
    tdsValidFrom: vendor.tdsValidFrom?.toISOString().slice(0, 10) ?? "",
    tdsValidTo: vendor.tdsValidTo?.toISOString().slice(0, 10) ?? "",
    operatingRegions: vendor.operatingRegions.map((r) => r.stateCode),
    contacts: vendor.contacts.map((c) => ({
      name: c.name,
      mobile: c.mobile,
      telephone: c.telephone ?? "",
      email: c.email ?? "",
      isPrimary: c.isPrimary,
      receivesRfqs: c.receivesRfqs,
    })),
    bankAccountHolderName: vendor.bankAccountHolderName ?? "",
    bankName: vendor.bankName ?? "",
    bankBranch: vendor.bankBranch ?? "",
    bankAccountType: vendor.bankAccountType ?? undefined,
    // Only the mask ever leaves the server on a read. The clear number is never
    // echoed back, so an edit form cannot leak it into the DOM or a log.
    bankAccountNo: "",
    bankAccountNoMasked: vendor.bankAccountNoLast4
      ? `XXXXXXXX${vendor.bankAccountNoLast4}`
      : null,
    bankIfsc: "",
    bankIfscMasked: vendor.bankIfscEnc ? "hidden" : null,
    bankMicr: vendor.bankMicr ?? "",
    bankIban: vendor.bankIban ?? "",
    bankSwift: vendor.bankSwift ?? "",
    fleetSummary: vendor.fleetSummary ?? "",
    codeOfConductAccepted: vendor.codeOfConductAccepted ?? false,
    declarationName: vendor.declarationName ?? "",
    declarationDesignation: vendor.declarationDesignation ?? "",
    declarationDate: vendor.declarationDate?.toISOString().slice(0, 10) ?? "",
    communicationNotes: vendor.communicationNotes ?? "",
  };
}

type VendorDraftRow = {
  id: string;
  onboardingStatus: string;
  adminRemarks: string | null;
  name: string | null;
  natureOfCompany: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  stateCode: string | null;
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
  msmeExemptionDate: Date | null;
  tdsLowerDeduction: boolean | null;
  tdsCertificateNo: string | null;
  tdsSection: string | null;
  tdsRatePercent: number | null;
  tdsValidFrom: Date | null;
  tdsValidTo: Date | null;
  fleetSummary: string | null;
  codeOfConductAccepted: boolean | null;
  declarationName: string | null;
  declarationDesignation: string | null;
  declarationDate: Date | null;
  bankAccountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountType: string | null;
  bankAccountNoLast4: string | null;
  bankIfscEnc: string | null;
  bankMicr: string | null;
  bankIban: string | null;
  bankSwift: string | null;
  communicationNotes: string | null;
  operatingRegions: { stateCode: string }[];
  contacts: {
    id: string;
    name: string;
    mobile: string;
    telephone: string | null;
    email: string | null;
    isPrimary: boolean;
    receivesRfqs: boolean;
  }[];
  documents: { docType: string; fileName: string; uploadedAt: Date }[];
  decisions: { remarks: string | null; createdAt: Date }[];
};

/** Reads a vendor's onboarding row for the authenticated edit path. */
async function loadVendorDraft(vendorId: string): Promise<VendorDraftRow | null> {
  return prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      onboardingStatus: true,
      adminRemarks: true,
      name: true,
      natureOfCompany: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      district: true,
      stateCode: true,
      pincode: true,
      telephone: true,
      fax: true,
      email: true,
      weeklyOffDays: true,
      companySize: true,
      pan: true,
      tan: true,
      gstRegistered: true,
      gstn: true,
      gstRegistrationType: true,
      gstr1FilingFrequency: true,
      cin: true,
      govtRegistrationType: true,
      govtRegistrationNo: true,
      msmeRegistered: true,
      msmeCategory: true,
      msmeRegNo: true,
      msmeExemptionDate: true,
      tdsLowerDeduction: true,
      tdsCertificateNo: true,
      tdsSection: true,
      tdsRatePercent: true,
      tdsValidFrom: true,
      tdsValidTo: true,
      fleetSummary: true,
      codeOfConductAccepted: true,
      declarationName: true,
      declarationDesignation: true,
      declarationDate: true,
      bankAccountHolderName: true,
      bankName: true,
      bankBranch: true,
      bankAccountType: true,
      bankAccountNoLast4: true,
      bankIfscEnc: true,
      bankMicr: true,
      bankIban: true,
      bankSwift: true,
      communicationNotes: true,
      operatingRegions: { select: { stateCode: true } },
      contacts: {
        select: {
          id: true,
          name: true,
          mobile: true,
          telephone: true,
          email: true,
          isPrimary: true,
          receivesRfqs: true,
        },
        orderBy: { isPrimary: "desc" },
      },
      documents: { select: { docType: true, fileName: true, uploadedAt: true } },
      decisions: {
        where: { outcome: "REJECTED" },
        select: { remarks: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
}

export { loadVendorDraft, shapeDraft };
export type { VendorDraftRow };

// ---------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------

/**
 * Field -> column map for everything the vendor types, minus the bank block.
 *
 * Presence-based on purpose. A draft save is partial, so the mapper may only
 * touch fields the client actually sent: emitting a column for every field would
 * write `null` over the values saved by an earlier section and quietly destroy
 * them.
 *
 * "Sent" is tested as `!== undefined` rather than with `Object.hasOwn`, because
 * Zod's `.partial()` output always carries every key, using `undefined` for the
 * ones the client omitted. An explicit `""` is still honoured as "cleared" —
 * that is a deliberate act, whereas `undefined` means "untouched".
 */
function vendorDataFrom(input: Partial<OnboardingInput>) {
  const data: Record<string, unknown> = {};

  const setText = (key: keyof OnboardingInput, column: string, value?: string | null) => {
    if (value === undefined) return;
    data[column] = value === "" ? null : value;
  };
  const setEnum = <K extends keyof OnboardingInput>(key: K, column: string) => {
    const value = input[key];
    if (value === undefined) return;
    data[column] = value ?? null;
  };

  setText("name", "name", input.name);
  setEnum("natureOfCompany", "natureOfCompany");
  setText("addressLine1", "addressLine1", input.addressLine1);
  setText("addressLine2", "addressLine2", input.addressLine2);
  setText("city", "city", input.city);
  setText("district", "district", input.district);
  setText("stateCode", "stateCode", input.stateCode);
  setText("pincode", "pincode", input.pincode);
  setText("telephone", "telephone", input.telephone);
  setText("fax", "fax", input.fax);
  setText("email", "email", input.email);
  setText("weeklyOffDays", "weeklyOffDays", input.weeklyOffDays);
  setText("companySize", "companySize", input.companySize);
  setText("pan", "pan", input.pan);
  setText("tan", "tan", input.tan);
  setEnum("gstRegistered", "gstRegistered");
  setText("gstn", "gstn", input.gstn);
  setEnum("gstRegistrationType", "gstRegistrationType");
  setEnum("gstr1FilingFrequency", "gstr1FilingFrequency");
  setText("cin", "cin", input.cin);
  setText("govtRegistrationType", "govtRegistrationType", input.govtRegistrationType);
  setText("govtRegistrationNo", "govtRegistrationNo", input.govtRegistrationNo);
  setEnum("msmeRegistered", "msmeRegistered");
  setEnum("msmeCategory", "msmeCategory");
  setText("msmeRegNo", "msmeRegNo", input.msmeRegNo);
  setEnum("tdsLowerDeduction", "tdsLowerDeduction");
  setText("tdsCertificateNo", "tdsCertificateNo", input.tdsCertificateNo);
  setText("tdsSection", "tdsSection", input.tdsSection);
  setText("fleetSummary", "fleetSummary", input.fleetSummary);
  setEnum("codeOfConductAccepted", "codeOfConductAccepted");
  setText("declarationName", "declarationName", input.declarationName);
  setText("declarationDesignation", "declarationDesignation", input.declarationDesignation);

  // Guarded rather than `new Date(undefined)`, which would hand Prisma an
  // Invalid Date and fail the whole save.
  if (input.declarationDate !== undefined) {
    data["declarationDate"] = input.declarationDate ? new Date(input.declarationDate) : null;
  }
  if (input.msmeExemptionDate !== undefined) {
    data["msmeExemptionDate"] = input.msmeExemptionDate ? new Date(input.msmeExemptionDate) : null;
  }
  if (input.tdsRatePercent !== undefined) {
    data["tdsRatePercent"] = input.tdsRatePercent ?? null;
  }
  if (input.tdsValidFrom !== undefined) {
    data["tdsValidFrom"] = input.tdsValidFrom ? new Date(input.tdsValidFrom) : null;
  }
  if (input.tdsValidTo !== undefined) {
    data["tdsValidTo"] = input.tdsValidTo ? new Date(input.tdsValidTo) : null;
  }

  setText("bankAccountHolderName", "bankAccountHolderName", input.bankAccountHolderName);
  setText("bankName", "bankName", input.bankName);
  setText("bankBranch", "bankBranch", input.bankBranch);
  setEnum("bankAccountType", "bankAccountType");
  setText("bankMicr", "bankMicr", input.bankMicr);
  setText("bankIban", "bankIban", input.bankIban);
  setText("bankSwift", "bankSwift", input.bankSwift);
  setText("communicationNotes", "communicationNotes", input.communicationNotes);

  return data;
}

/**
 * Writes the form. `bankAccountNo`/`bankIfsc` are omitted when the client sends
 * them blank, which is how the edit form avoids having to send back the clear
 * value it was never given.
 */
function bankDataFrom(input: Partial<OnboardingInput>, previous?: { last4: string | null; hasIfsc: boolean }) {
  const data: Record<string, string> = {};
  if (input.bankAccountNo) {
    data["bankAccountNoEnc"] = encryptField(input.bankAccountNo);
    data["bankAccountNoLast4"] = last4(input.bankAccountNo);
  } else if (previous?.last4) {
    data["bankAccountNoLast4"] = previous.last4;
  }
  if (input.bankIfsc) {
    data["bankIfscEnc"] = encryptField(input.bankIfsc);
  }
  return data;
}

/**
 * Validates and persists, creating the draft vendor row on first save.
 *
 * `mode: "draft"` accepts a partial form — only the field shapes are checked.
 * `mode: "submit"` requires everything and moves the record to SUBMITTED.
 */
export async function saveDraft(params: {
  token?: string;
  vendorId?: string;
  input: unknown;
  mode: "draft" | "submit";
  actor?: AuthedRequest["user"] | null;
  ipAddress?: string;
}): Promise<{ vendorId: string; status: string; warnings: string[] }> {
  const { input, mode, actor } = params;

  let vendorId = params.vendorId;
  let previous: { last4: string | null; hasIfsc: boolean } | undefined;

  if (params.token) {
    const invitation = await resolveInvitation(params.token);
    if (invitation.submittedAt && invitation.vendor?.onboardingStatus !== "REJECTED") {
      throw AppError.conflict("This registration has already been submitted and is under review.");
    }
    vendorId = invitation.vendorId ?? undefined;

    // First save. The invitation exists but no vendor row does yet, so this is
    // where the draft is created and linked to the invitation. Doing it here
    // rather than at invite time keeps an invited-but-never-started vendor out
    // of the admin queue until they have actually begun.
    if (!vendorId) {
      const created = await prisma.vendor.create({
        data: { onboardingStatus: "DRAFT", name: invitation.companyName },
        select: { id: true },
      });
      vendorId = created.id;

      await prisma.vendorInvitation.update({
        where: { id: invitation.id },
        data: { vendorId: created.id },
      });

      await recordAudit({
        entity: "vendor",
        entityId: created.id,
        action: "onboarding_started",
        actor: actor ?? null,
        ipAddress: params.ipAddress,
      });
    }
  }

  if (!vendorId) {
    throw AppError.badRequest("No onboarding record to save.");
  }

  const existing = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { onboardingStatus: true, bankAccountNoLast4: true, bankIfscEnc: true },
  });
  if (!existing) throw AppError.notFound("Onboarding record not found");

  if (!isEditableStatus(existing.onboardingStatus)) {
    throw AppError.conflict(
      existing.onboardingStatus === "SUBMITTED"
        ? "This registration has already been submitted and is under review."
        : "An approved registration can no longer be edited here.",
    );
  }
  previous = { last4: existing.bankAccountNoLast4, hasIfsc: Boolean(existing.bankIfscEnc) };

  if (mode === "draft") {
    // Partial save. Reject only what is structurally impossible, so a vendor
    // can park a half-typed form without fighting the validator.
    //
    // Blank inputs are dropped first. An untouched dropdown or text box submits
    // "", but in a partial save that means "not answered yet" rather than
    // "invalid" — without this, saving a draft while the account type was still
    // unset failed on a field the vendor had not reached. Submitting still
    // requires the mandatory fields, because that path never drops blanks.
    const answered = typeof input === "object" && input !== null ? input : {};
    const withoutBlanks = Object.fromEntries(
      Object.entries(answered as Record<string, unknown>).filter(([, value]) => value !== ""),
    );
    const parsed = onboardingSchema.partial().safeParse(withoutBlanks);
    if (!parsed.success) throw parsed.error;
    const partial = parsed.data as Partial<OnboardingInput>;

    await prisma.$transaction(async (tx) => {
      await tx.vendor.update({
        where: { id: vendorId },
        data: {
          ...vendorDataFrom(partial),
          ...bankDataFrom(partial as OnboardingInput, previous),
        },
      });
      if (partial.operatingRegions) {
        await replaceRegions(tx, vendorId, partial.operatingRegions);
      }
      if (partial.contacts) {
        await replaceContacts(tx, vendorId, partial.contacts);
      }
    });

    return { vendorId, status: existing.onboardingStatus, warnings: [] };
  }

// --- submit -------------------------------------------------------------

  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  const full = parsed.data;

  // Bank account number and IFSC are optional in the schema because the edit
  // form never receives the clear values back — it only ever had the mask. So
  // "required" here means "a value was typed, or one is already stored".
  const problems: string[] = [];
  if (!full.bankAccountNo && !previous?.last4) problems.push("Bank account number is required");
  if (!full.bankIfsc && !previous?.hasIfsc) problems.push("IFSC is required");

  // Cross-field and conditional rules from brief 5.1: GST consequences, the
  // PAN inside the GSTIN, the PAN's company-type letter, and the MSME/TDS
  // blocks. Hard blocks, unlike the advisory warnings below.
  problems.push(...onboardingSubmitProblems(full));

  // P0 A8: PAN and GSTN are unique across vendors. The columns are @unique, so
  // a duplicate would be refused anyway — but as a raw 409 "value already in
  // use". Naming the field here tells the vendor which number collided.
  const duplicate = await prisma.vendor.findFirst({
    where: {
      NOT: { id: vendorId },
      OR: [{ pan: full.pan }, ...(full.gstn ? [{ gstn: full.gstn }] : [])],
    },
    select: { pan: true, gstn: true },
  });
  if (duplicate) {
    if (duplicate.pan === full.pan) {
      problems.push("A vendor is already registered with this PAN");
    }
    if (full.gstn && duplicate.gstn === full.gstn) {
      problems.push("A vendor is already registered with this GSTIN");
    }
  }

  // Brief 7.2 makes the cheque, PAN copy and signed declaration part of the
  // registration — plus the GST certificate when the vendor is registered —
  // so a submit without them is incomplete. Checked before anything is
  // written: a vendor must not reach SUBMITTED — and therefore an admin's
  // queue — with documents still outstanding.
  const uploaded = new Set<string>(
    (
      await prisma.vendorDocument.findMany({
        where: { vendorId },
        select: { docType: true },
      })
    ).map((d) => d.docType),
  );
  for (const docType of requiredDocumentsFor(full.gstRegistered)) {
    if (!uploaded.has(docType)) {
      problems.push(`${REQUIRED_DOCUMENT_LABELS[docType] ?? docType} has not been uploaded`);
    }
  }

  if (problems.length > 0) {
    throw new AppError(
      problems.join(". "),
      400,
      "VALIDATION_ERROR",
      problems.map((message) => ({ path: "", message })),
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.vendor.update({
      where: { id: vendorId },
      data: {
        ...vendorDataFrom(full),
        ...bankDataFrom(full, previous),
      },
    });
    await replaceRegions(tx, vendorId, full.operatingRegions);
    await replaceContacts(tx, vendorId, full.contacts);
    await tx.vendor.update({
      where: { id: vendorId },
      data: { onboardingStatus: "SUBMITTED" },
    });
    if (params.token) {
      await tx.vendorInvitation.updateMany({
        where: { tokenHash: hashToken(params.token) },
        data: { submittedAt: new Date() },
      });
    }
  });

  // Brief 7.2: "On submit, status is Submitted, and the admin is notified."
  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: {
      name: true,
      email: true,
      pan: true,
      gstn: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      district: true,
      addressState: { select: { name: true } },
      pincode: true,
    },
  });

  await sendTemplate({
    to: env.mail.internalNotifyEmail,
    template: "onboarding_submitted",
    vars: {
      vendorName: vendor.name ?? "(name not given)",
      vendorEmail: vendor.email ?? "",
      pan: vendor.pan ?? "",
      gstn: vendor.gstn ?? "",
      registeredAddress: [
        vendor.addressLine1,
        vendor.addressLine2,
        [vendor.city, vendor.district, vendor.addressState?.name, vendor.pincode].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(", "),
      reviewUrl: portalUrl(`/app/vendors/${vendorId}`),
    },
    entity: "vendor",
    entityId: vendorId,
  });

  await recordAudit({
    entity: "vendor",
    entityId: vendorId,
    action: "onboarding_submitted",
    newValue: { onboardingStatus: "SUBMITTED" },
    actor,
    ipAddress: params.ipAddress,
  });

  return { vendorId, status: "SUBMITTED", warnings: onboardingWarnings(full) };
}

async function replaceRegions(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  vendorId: string,
  codes: string[],
) {
  await tx.stateVendorRegion.deleteMany({ where: { vendorId } });
  const known = await tx.state.findMany({ where: { code: { in: codes } }, select: { code: true } });
  const knownCodes = known.map((s) => s.code);
  const unknown = codes.filter((c) => !knownCodes.includes(c));
  if (unknown.length > 0) {
    throw AppError.badRequest(`Unknown state code${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }
  await tx.stateVendorRegion.createMany({
    data: knownCodes.map((code) => ({ vendorId, stateCode: code })),
  });
}

async function replaceContacts(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  vendorId: string,
  contacts: OnboardingInput["contacts"],
) {
  // Contacts are replaced wholesale rather than diffed: the section is small,
  // and a diff would need to decide what a removed contact means for an
  // already-created login.
  await tx.vendorContact.deleteMany({ where: { vendorId } });
  for (const contact of contacts) {
    await tx.vendorContact.create({
      data: {
        vendorId,
        name: contact.name,
        mobile: contact.mobile,
        telephone: contact.telephone || null,
        email: contact.email?.toLowerCase() ?? null,
        isPrimary: contact.isPrimary,
        receivesRfqs: contact.receivesRfqs,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Authenticated read/edit (vendor already has an account)
// ---------------------------------------------------------------------------

/**
 * Re-opens a rejected registration for the signed-in vendor. Used by the
 * "correct and resubmit" screen, which is reached with a session rather than
 * the original invitation token.
 */
export async function saveOwnOnboarding(params: {
  vendorId: string;
  input: unknown;
  mode: "draft" | "submit";
  actor?: AuthedRequest["user"] | null;
  ipAddress?: string;
}): Promise<{ vendorId: string; status: string; warnings: string[] }> {
  const { vendorId, ...rest } = params;
  return saveDraft({ ...rest, vendorId });
}

/**
 * Re-checks a submitted form against the full schema without changing it.
 * `approveVendor` calls this so an APPROVED vendor is always complete even if a
 * future change lets something through a partial save.
 */
export async function assertSubmittable(vendorId: string): Promise<void> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      name: true,
      natureOfCompany: true,
      addressLine1: true,
      city: true,
      district: true,
      stateCode: true,
      pincode: true,
      telephone: true,
      email: true,
      pan: true,
      gstRegistered: true,
      gstn: true,
      gstRegistrationType: true,
      msmeRegistered: true,
      msmeCategory: true,
      msmeRegNo: true,
      tdsLowerDeduction: true,
      tdsCertificateNo: true,
      tdsSection: true,
      tdsRatePercent: true,
      tdsValidFrom: true,
      tdsValidTo: true,
      bankName: true,
      bankBranch: true,
      bankAccountType: true,
      bankAccountNoEnc: true,
      bankIfscEnc: true,
      codeOfConductAccepted: true,
      declarationName: true,
      declarationDesignation: true,
      declarationDate: true,
      fleetSummary: true,
      operatingRegions: { select: { stateCode: true } },
      contacts: { select: { name: true, mobile: true, email: true, isPrimary: true, receivesRfqs: true } },
      documents: { select: { docType: true } },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");

  const problems: string[] = [];
  const need = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === "") problems.push(label);
  };

  need("Company name", vendor.name);
  need("Nature of company", vendor.natureOfCompany);
  need("Address line 1", vendor.addressLine1);
  need("City", vendor.city);
  need("District", vendor.district);
  need("State", vendor.stateCode);
  need("Pincode", vendor.pincode);
  need("Telephone", vendor.telephone);
  need("Email", vendor.email);
  need("PAN", vendor.pan);

  // Same conditional rules as the submit path (brief 5.1): an approved vendor
  // must be complete whichever blocks were filled in.
  if (vendor.gstRegistered) {
    need("GSTIN", vendor.gstn);
    need("GST registration type", vendor.gstRegistrationType);
  }
  if (vendor.msmeRegistered) {
    need("MSME category", vendor.msmeCategory);
    need("MSME registration number", vendor.msmeRegNo);
  }
  if (vendor.tdsLowerDeduction) {
    need("TDS certificate number", vendor.tdsCertificateNo);
    need("TDS section", vendor.tdsSection);
    need("TDS rate", vendor.tdsRatePercent);
    need("TDS valid-from date", vendor.tdsValidFrom);
    need("TDS valid-to date", vendor.tdsValidTo);
  }

  need("Bank name", vendor.bankName);
  need("Bank branch", vendor.bankBranch);
  need("Bank account type", vendor.bankAccountType);
  need("Bank account number", vendor.bankAccountNoEnc);
  need("IFSC", vendor.bankIfscEnc);
  need("Code of conduct acceptance", vendor.codeOfConductAccepted === true ? "yes" : null);
  need("Declaration name", vendor.declarationName);
  need("Declaration designation", vendor.declarationDesignation);
  need("Declaration date", vendor.declarationDate);
  need("Fleet summary", vendor.fleetSummary);

  if (vendor.operatingRegions.length === 0) problems.push("Operating regions");
  if (vendor.contacts.length === 0) problems.push("Contact person");
  else {
    const primary = vendor.contacts.find((c) => c.isPrimary);
    if (!primary) problems.push("Primary contact");
    else need("Primary contact email", primary.email);
  }

  const uploaded = new Set<string>(vendor.documents.map((d) => d.docType));
  for (const doc of requiredDocumentsFor(vendor.gstRegistered === true)) {
    if (!uploaded.has(doc)) problems.push(REQUIRED_DOCUMENT_LABELS[doc]);
  }

  if (problems.length > 0) {
    throw AppError.badRequest(
      `This registration is incomplete: ${problems.join(", ")}.`,
      "INCOMPLETE_ONBOARDING",
    );
  }
}

export { hashToken };
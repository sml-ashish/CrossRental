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
  panField,
  pastOrTodayField,
  phoneField,
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
  registeredAddress: longText.min(5, "Registered address is required"),
  telephone: phoneField,
  fax: optionalTrimmed(50),
  email: emailField,
  weeklyOffDays: optionalTrimmed(100),
  companySize: optionalTrimmed(50),

  // Registration
  pan: panField,
  tan: optionalTrimmed(10),
  gstn: gstnField,
  gstCompositionOpted: z.boolean().optional(),
  gstr1FilingFrequency: optionalChoice(["MONTHLY", "QUARTERLY", "COMPOSITE"]),
  cin: optionalTrimmed(21),
  govtRegistrationType: optionalTrimmed(100),
  govtRegistrationNo: optionalTrimmed(100),
  msmeCategory: optionalChoice(["MICRO", "SMALL", "MEDIUM"]),

  operatingRegions: stateCodeList(1, "state"),

  // Contact persons. Brief 7.2 has a repeatable section; exactly one must be
  // primary, and the primary contact's email becomes the login.
  contacts: z
    .array(
      z.object({
        name: shortText.min(2, "Contact name is required"),
        mobile: phoneField,
        telephone: optionalTrimmed(50),
        email: optionalEmail,
        isPrimary: z.boolean().default(false),
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

  // Fleet summary + declaration
  fleetSummary: longText.min(5, "Describe the crane categories and approximate fleet size"),
  codeOfConductAccepted: z.literal(true, {
    message: "You must accept the code of conduct",
  }),
  declarationName: shortText.min(2, "Your name is required"),
  declarationDesignation: shortText.min(2, "Your designation is required"),
  declarationDate: pastOrTodayField,
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

/**
 * Cross-field rules that Zod cannot express on a single field. Returns a list
 * rather than throwing so `submit` can report every problem at once — a vendor
 * filling a long form should not fix one field per round trip.
 */
export function onboardingWarnings(input: OnboardingInput): string[] {
  const warnings: string[] = [];
  if (gstinPanMismatch(input.gstn, input.pan)) {
    warnings.push("The PAN embedded in the GSTIN does not match the PAN you entered.");
  }
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

/** Document types brief 7.2 requires: cancelled cheque, GST certificate, PAN copy. */
export const REQUIRED_DOCUMENTS = ["CANCELLED_CHEQUE", "GST_CERTIFICATE", "PAN_COPY"] as const;

export const REQUIRED_DOCUMENT_LABELS: Record<string, string> = {
  CANCELLED_CHEQUE: "Cancelled cheque",
  GST_CERTIFICATE: "GST certificate",
  PAN_COPY: "PAN copy",
  OTHER: "Other supporting document",
};

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
    missingDocuments: REQUIRED_DOCUMENTS.filter((d) => !uploaded.has(d)),
  };
}

/** Maps a vendor row back onto the form's field names for the edit screen. */
function shapeDraft(vendor: VendorDraftRow) {
  return {
    name: vendor.name ?? "",
    natureOfCompany: vendor.natureOfCompany ?? undefined,
    registeredAddress: vendor.registeredAddress ?? "",
    telephone: vendor.telephone ?? "",
    fax: vendor.fax ?? "",
    email: vendor.email ?? "",
    weeklyOffDays: vendor.weeklyOffDays ?? "",
    companySize: vendor.companySize ?? "",
    pan: vendor.pan ?? "",
    tan: vendor.tan ?? "",
    gstn: vendor.gstn ?? "",
    gstCompositionOpted: vendor.gstCompositionOpted ?? undefined,
    gstr1FilingFrequency: vendor.gstr1FilingFrequency ?? undefined,
    cin: vendor.cin ?? "",
    govtRegistrationType: vendor.govtRegistrationType ?? "",
    govtRegistrationNo: vendor.govtRegistrationNo ?? "",
    msmeCategory: vendor.msmeCategory ?? undefined,
    operatingRegions: vendor.operatingRegions.map((r) => r.stateCode),
    contacts: vendor.contacts.map((c) => ({
      name: c.name,
      mobile: c.mobile,
      telephone: c.telephone ?? "",
      email: c.email ?? "",
      isPrimary: c.isPrimary,
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
    fleetSummary: vendor.fleetSummary ?? "",
    codeOfConductAccepted: vendor.codeOfConductAccepted ?? false,
    declarationName: vendor.declarationName ?? "",
    declarationDesignation: vendor.declarationDesignation ?? "",
    declarationDate: vendor.declarationDate?.toISOString().slice(0, 10) ?? "",
  };
}

type VendorDraftRow = {
  id: string;
  onboardingStatus: string;
  adminRemarks: string | null;
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
  declarationDate: Date | null;
  bankAccountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountType: string | null;
  bankAccountNoLast4: string | null;
  bankIfscEnc: string | null;
  operatingRegions: { stateCode: string }[];
  contacts: {
    id: string;
    name: string;
    mobile: string;
    telephone: string | null;
    email: string | null;
    isPrimary: boolean;
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
      registeredAddress: true,
      telephone: true,
      fax: true,
      email: true,
      weeklyOffDays: true,
      companySize: true,
      pan: true,
      tan: true,
      gstn: true,
      gstCompositionOpted: true,
      gstr1FilingFrequency: true,
      cin: true,
      govtRegistrationType: true,
      govtRegistrationNo: true,
      msmeCategory: true,
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
      operatingRegions: { select: { stateCode: true } },
      contacts: {
        select: { id: true, name: true, mobile: true, telephone: true, email: true, isPrimary: true },
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
  setText("registeredAddress", "registeredAddress", input.registeredAddress);
  setText("telephone", "telephone", input.telephone);
  setText("fax", "fax", input.fax);
  setText("email", "email", input.email);
  setText("weeklyOffDays", "weeklyOffDays", input.weeklyOffDays);
  setText("companySize", "companySize", input.companySize);
  setText("pan", "pan", input.pan);
  setText("tan", "tan", input.tan);
  setText("gstn", "gstn", input.gstn);
  setEnum("gstCompositionOpted", "gstCompositionOpted");
  setEnum("gstr1FilingFrequency", "gstr1FilingFrequency");
  setText("cin", "cin", input.cin);
  setText("govtRegistrationType", "govtRegistrationType", input.govtRegistrationType);
  setText("govtRegistrationNo", "govtRegistrationNo", input.govtRegistrationNo);
  setEnum("msmeCategory", "msmeCategory");
  setText("fleetSummary", "fleetSummary", input.fleetSummary);
  setEnum("codeOfConductAccepted", "codeOfConductAccepted");
  setText("declarationName", "declarationName", input.declarationName);
  setText("declarationDesignation", "declarationDesignation", input.declarationDesignation);

  // Guarded rather than `new Date(undefined)`, which would hand Prisma an
  // Invalid Date and fail the whole save.
  if (input.declarationDate !== undefined) {
    data["declarationDate"] = input.declarationDate ? new Date(input.declarationDate) : null;
  }

  setText("bankAccountHolderName", "bankAccountHolderName", input.bankAccountHolderName);
  setText("bankName", "bankName", input.bankName);
  setText("bankBranch", "bankBranch", input.bankBranch);
  setEnum("bankAccountType", "bankAccountType");

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

  // Brief 7.2 makes the cancelled cheque, GST certificate and PAN copy part of
  // the registration, so a submit without them is incomplete. Checked before
  // anything is written: a vendor must not reach SUBMITTED — and therefore an
  // admin's queue — with documents still outstanding.
  const uploaded = new Set(
    (
      await prisma.vendorDocument.findMany({
        where: { vendorId },
        select: { docType: true },
      })
    ).map((d) => d.docType),
  );
  for (const docType of REQUIRED_DOCUMENTS) {
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
    select: { name: true, email: true, pan: true, gstn: true, registeredAddress: true },
  });

  await sendTemplate({
    to: env.mail.internalNotifyEmail,
    template: "onboarding_submitted",
    vars: {
      vendorName: vendor.name ?? "(name not given)",
      vendorEmail: vendor.email ?? "",
      pan: vendor.pan ?? "",
      gstn: vendor.gstn ?? "",
      registeredAddress: vendor.registeredAddress ?? "",
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
      registeredAddress: true,
      telephone: true,
      email: true,
      pan: true,
      gstn: true,
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
      contacts: { select: { name: true, mobile: true, email: true, isPrimary: true } },
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
  need("Registered address", vendor.registeredAddress);
  need("Telephone", vendor.telephone);
  need("Email", vendor.email);
  need("PAN", vendor.pan);
  need("GSTIN", vendor.gstn);
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

  const uploaded = new Set(vendor.documents.map((d) => d.docType));
  for (const doc of REQUIRED_DOCUMENTS) {
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
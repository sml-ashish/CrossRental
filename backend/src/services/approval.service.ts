import { env } from "../config/env";
import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { portalUrl } from "../utils/jwt";
import { randomToken } from "../utils/crypto";
import { recordAudit } from "./audit.service";
import { sendTemplate } from "./email.service";
import { assertSubmittable } from "./onboarding.service";

/**
 * Admin decisions on a submitted onboarding form (brief 7.3).
 *
 * On approval (brief 7.3): "create the vendor master record, contact records
 * and login credentials automatically, record the SAP vendor code if the admin
 * has it, and send the activation email."
 *
 * The vendor master and contact rows already exist by this point — they were
 * created as a draft when the vendor first saved the form. What approval adds
 * is the thing that cannot exist before: a login. So `approveVendor` creates
 * the User, issues the activation token, and emails the link. That is the only
 * moment a vendor_user row comes into being.
 *
 * On rejection: remarks are mandatory (brief 7.3) and are emailed to the
 * vendor, who keeps access to the original invitation link in order to correct
 * and resubmit.
 */

export interface OfficeUseReview {
  facilityStatus?: "ADEQUATE" | "NOT_ADEQUATE" | "NEEDS_IMPROVEMENT" | null;
  manpowerStatus?: "ADEQUATE" | "NOT_ADEQUATE" | null;
  improvementRequirement?: string | null;
  improvementPeriod?: string | null;
}

export interface ApproveInput {
  vendorId: string;
  sapVendorCode?: string | null;
  adminRemarks?: string | null;
  officeUse?: OfficeUseReview;
}

export interface ApproveResult {
  vendorId: string;
  userId: string;
  activationEmailSent: boolean;
  /** True when a User already existed, e.g. a resubmission after rejection. */
  reusedExistingUser: boolean;
}

export async function approveVendor(
  input: ApproveInput,
  actor: AuthedRequest["user"],
): Promise<ApproveResult> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: {
      id: true,
      name: true,
      email: true,
      onboardingStatus: true,
      sapVendorCode: true,
      contacts: {
        where: { isPrimary: true },
        select: { id: true, name: true, email: true, mobile: true },
        take: 1,
      },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");

  if (vendor.onboardingStatus === "APPROVED") {
    throw AppError.conflict("This vendor is already approved.");
  }
  if (vendor.onboardingStatus !== "SUBMITTED") {
    throw AppError.conflict(
      `Only a submitted registration can be approved. This one is ${vendor.onboardingStatus.toLowerCase()}.`,
    );
  }

  // Brief 5.1 makes the SAP code optional, but if given it must be free.
  if (input.sapVendorCode) {
    const clash = await prisma.vendor.findFirst({
      where: { sapVendorCode: input.sapVendorCode, NOT: { id: vendor.id } },
      select: { id: true },
    });
    if (clash) throw AppError.conflict("That SAP vendor code is already assigned to another vendor.");
  }

  // Belt and braces: an APPROVED vendor must be complete. This re-runs the same
  // checks the vendor's own submit did.
  await assertSubmittable(vendor.id);

  // The login address is the primary contact's email (brief 5.1: Vendor.email
  // is "also the primary login email"), falling back to the company email.
  const loginEmail = (vendor.contacts[0]?.email ?? vendor.email ?? "").toLowerCase();
  if (!loginEmail) {
    throw AppError.badRequest("This vendor has no email address to create a login with.");
  }

  const token = randomToken(32);
  const activationExpiresAt = new Date(
    Date.now() + env.auth.activationTokenTtlHours * 60 * 60 * 1000,
  );

  // A resubmission after a rejection may already have a user row (created by an
  // earlier approval that was later reversed, or seeded). Reuse it rather than
  // failing on the unique email index.
  const existingUser = await prisma.user.findUnique({
    where: { email: loginEmail },
    select: { id: true, vendorId: true, role: true },
  });

  if (existingUser && existingUser.vendorId !== vendor.id) {
    throw AppError.conflict(
      "That login email already belongs to a different vendor. Correct the contact email before approving.",
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const office = input.officeUse ?? {};

    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            vendorId: vendor.id,
            role: "vendor_user",
            fullName: vendor.contacts[0]?.name ?? vendor.name,
            isActive: true,
            // A fresh activation link each time, so a link sent before a
            // rejection cannot be replayed afterwards.
            activationToken: token,
            activationTokenExpiresAt: activationExpiresAt,
            activatedAt: null,
            resetToken: null,
            resetTokenExpiresAt: null,
          },
          select: { id: true },
        })
      : await tx.user.create({
          data: {
            email: loginEmail,
            fullName: vendor.contacts[0]?.name ?? vendor.name,
            role: "vendor_user",
            vendorId: vendor.id,
            activationToken: token,
            activationTokenExpiresAt: activationExpiresAt,
          },
          select: { id: true },
        });

    await tx.vendor.update({
      where: { id: vendor.id },
      data: {
        onboardingStatus: "APPROVED",
        approvedById: actor.id,
        approvedAt: new Date(),
        adminRemarks: input.adminRemarks || null,
        sapVendorCode: input.sapVendorCode?.trim() || vendor.sapVendorCode || null,
        facilityStatus: office.facilityStatus ?? null,
        manpowerStatus: office.manpowerStatus ?? null,
        improvementRequirement: office.improvementRequirement?.trim() || null,
        improvementPeriod: office.improvementPeriod?.trim() || null,
      },
    });

    await tx.vendorDecision.create({
      data: {
        vendorId: vendor.id,
        outcome: "APPROVED",
        remarks: input.adminRemarks?.trim() || null,
        decidedById: actor.id,
      },
    });

    return { userId: user.id };
  });

  // Brief 7.3: send the activation email.
  const mail = await sendTemplate({
    to: loginEmail,
    template: "onboarding_approved",
    vars: {
      vendorName: vendor.name ?? "",
      sapVendorCode: input.sapVendorCode || vendor.sapVendorCode || "not yet assigned",
      activationTtlHours: String(env.auth.activationTokenTtlHours),
      activationUrl: portalUrl(`/auth/activate?token=${encodeURIComponent(token)}`),
    },
    entity: "vendor",
    entityId: vendor.id,
  });

  await recordAudit({
    entity: "vendor",
    entityId: vendor.id,
    action: "onboarding_approved",
    oldValue: { onboardingStatus: "SUBMITTED" },
    newValue: {
      onboardingStatus: "APPROVED",
      sapVendorCode: input.sapVendorCode || vendor.sapVendorCode || null,
      userId: result.userId,
      activationEmailSent: mail.sent,
    },
    actor,
  });

  if (!mail.sent) {
    // The vendor is approved and can be activated, but nobody has the link.
    // This is the one failure that must not be silent.
    throw new AppError(
      "The vendor was approved but the activation email could not be sent. Resend it from the vendor detail page.",
      502,
      "ACTIVATION_EMAIL_FAILED",
    );
  }

  return {
    vendorId: vendor.id,
    userId: result.userId,
    activationEmailSent: mail.sent,
    reusedExistingUser: existingUser !== null,
  };
}

export interface RejectInput {
  vendorId: string;
  /** Mandatory on rejection (brief 7.3). */
  remarks: string;
  officeUse?: OfficeUseReview;
}

export interface RejectResult {
  vendorId: string;
  rejectionEmailSent: boolean;
  resubmitLinkExpiresAt: Date;
}

export async function rejectVendor(
  input: RejectInput,
  actor: AuthedRequest["user"],
): Promise<RejectResult> {
  const remarks = input.remarks?.trim();
  if (!remarks) {
    // Brief 7.3: "Approve or reject, with remarks required on rejection."
    throw AppError.badRequest("Remarks are required when rejecting a registration.");
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: {
      id: true,
      name: true,
      email: true,
      onboardingStatus: true,
      contacts: { where: { isPrimary: true }, select: { email: true }, take: 1 },
      invitations: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, tokenHash: true },
        take: 1,
      },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");
  if (vendor.onboardingStatus === "REJECTED") {
    throw AppError.conflict("This registration has already been rejected.");
  }
  if (vendor.onboardingStatus !== "SUBMITTED") {
    throw AppError.conflict(
      `Only a submitted registration can be rejected. This one is ${vendor.onboardingStatus.toLowerCase()}.`,
    );
  }

  const office = input.officeUse ?? {};

  await prisma.$transaction(async (tx) => {
    await tx.vendor.update({
      where: { id: vendor.id },
      data: {
        onboardingStatus: "REJECTED",
        adminRemarks: remarks,
        facilityStatus: office.facilityStatus ?? null,
        manpowerStatus: office.manpowerStatus ?? null,
        improvementRequirement: office.improvementRequirement?.trim() || null,
        improvementPeriod: office.improvementPeriod?.trim() || null,
      },
    });
    await tx.vendorDecision.create({
      data: {
        vendorId: vendor.id,
        outcome: "REJECTED",
        remarks,
        decidedById: actor.id,
      },
    });

    // Hand the original invitation link back so the vendor can correct and
    // resubmit. A rejected vendor has no account, so this link is the only way
    // back in — clearing submittedAt is what reopens it.
    const invitation = vendor.invitations[0];
    if (invitation) {
      await tx.vendorInvitation.update({
        where: { id: invitation.id },
        data: {
          submittedAt: null,
          expiresAt: new Date(Date.now() + env.onboarding.resubmitWindowDays * 24 * 60 * 60 * 1000),
        },
      });
    }
  });

  const contactEmail = vendor.contacts[0]?.email ?? vendor.email;
  let mail = { sent: false, subject: "" };
  if (contactEmail) {
    mail = await sendTemplate({
      to: contactEmail,
      template: "onboarding_rejected",
      vars: {
        vendorName: vendor.name ?? "",
        adminRemarks: remarks,
      },
      entity: "vendor",
      entityId: vendor.id,
    });
  }

  await recordAudit({
    entity: "vendor",
    entityId: vendor.id,
    action: "onboarding_rejected",
    oldValue: { onboardingStatus: "SUBMITTED" },
    newValue: { onboardingStatus: "REJECTED", remarks },
    actor,
  });

  return {
    vendorId: vendor.id,
    rejectionEmailSent: mail.sent,
    resubmitLinkExpiresAt: new Date(
      Date.now() + env.onboarding.resubmitWindowDays * 24 * 60 * 60 * 1000,
    ),
  };
}

/**
 * Re-sends the activation email for an approved vendor whose link never
 * arrived. Creates a fresh token, so it also invalidates the previous link.
 */
export async function resendActivation(
  vendorId: string,
  actor: AuthedRequest["user"],
): Promise<{ sent: boolean }> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      name: true,
      onboardingStatus: true,
      sapVendorCode: true,
      users: {
        where: { role: "vendor_user" },
        select: { id: true, email: true, activatedAt: true, fullName: true },
        take: 1,
      },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");
  if (vendor.onboardingStatus !== "APPROVED") {
    throw AppError.conflict("Only an approved vendor has an activation link to resend.");
  }

  const user = vendor.users[0];
  if (!user) throw AppError.notFound("This vendor has no login yet.");
  if (user.activatedAt) {
    throw AppError.conflict("This vendor has already activated their account. Use password reset instead.");
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.auth.activationTokenTtlHours * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { activationToken: token, activationTokenExpiresAt: expiresAt },
  });

  const mail = await sendTemplate({
    to: user.email,
    template: "onboarding_approved",
    vars: {
      vendorName: vendor.name ?? "",
      sapVendorCode: vendor.sapVendorCode ?? "not yet assigned",
      activationTtlHours: String(env.auth.activationTokenTtlHours),
      activationUrl: portalUrl(`/auth/activate?token=${encodeURIComponent(token)}`),
    },
    entity: "vendor",
    entityId: vendor.id,
  });

  await recordAudit({
    entity: "vendor",
    entityId: vendor.id,
    action: "activation_resent",
    newValue: { userId: user.id, sent: mail.sent },
    actor,
  });

  return { sent: mail.sent };
}

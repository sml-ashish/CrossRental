import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import { OtpPurpose, UserRole } from "../generated/prisma/client";
import { prisma } from "../lib/database";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { AuthTokenPayload, portalUrl, signAuthToken } from "../utils/jwt";
import { randomToken } from "../utils/crypto";
import { sendTemplate } from "./email.service";

/**
 * Authentication for both audiences in the portal:
 *
 * - vendor_user: email + password, first use via an emailed activation link
 *   where they choose a password.
 * - admin_user / sales_user: email, then a 6-digit one-time code sent by
 *   email. 10-minute expiry, single use, rate limited. These accounts never
 *   hold a password hash at all.
 *
 * Every failure path returns the same generic message so the login screen
 * cannot be used to discover which email addresses are registered.
 */

const GENERIC_LOGIN_FAILURE = "Invalid email or password";
const GENERIC_OTP_FAILURE = "That code is not valid. Please request a new one.";
const GENERIC_RESET_SENT =
  "If that email address belongs to a vendor account, a password reset link has been sent.";
const GENERIC_OTP_SENT =
  "If that email address belongs to an SML user account, a sign-in code has been sent.";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Shared password policy. Deliberately modest — this is a B2B portal where
 * the vendor's contact is often a partner on a phone — but it does reject
 * the trivial passwords that show up in a seeded/imported fleet.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < env.auth.vendorPasswordMinLength) {
    throw AppError.badRequest(
      `Password must be at least ${env.auth.vendorPasswordMinLength} characters`,
    );
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    throw AppError.badRequest("Password must contain both letters and numbers");
  }
  if (/^(password|welcome|crane|sanghvi|\d+)$/i.test(password)) {
    throw AppError.badRequest("That password is too common. Please choose another.");
  }
}

export interface AuthResult {
  token: string;
  user: {
    id: string;
    email: string;
    fullName: string | null;
    role: UserRole;
    vendorId: string | null;
    vendorName?: string;
  };
}

function toAuthResult(user: {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  vendorId: string | null;
}, vendorName?: string | null): AuthResult {
  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    vendorId: user.vendorId,
  };
  return {
    token: signAuthToken(payload),
    user: { ...user, ...(vendorName ? { vendorName } : {}) },
  };
}

async function touchLogin(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Vendor: email + password
// ---------------------------------------------------------------------------

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalised },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      vendorId: true,
      passwordHash: true,
      isActive: true,
      activationToken: true,
      vendor: { select: { name: true, onboardingStatus: true } },
    },
  });

  // Compare against a dummy hash when the user is missing so the response
  // time does not reveal whether the address is registered.
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const passwordOk = await verifyPassword(password, hash);

  if (!user || !user.passwordHash || !passwordOk || !user.isActive) {
    throw new AppError(GENERIC_LOGIN_FAILURE, 401, "INVALID_CREDENTIALS");
  }

  if (user.role !== "vendor_user") {
    // Internal users are OTP-only. Saying so here would confirm the address
    // exists, so the generic failure stands.
    throw new AppError(GENERIC_LOGIN_FAILURE, 401, "INVALID_CREDENTIALS");
  }

  if (user.activationToken) {
    throw new AppError(
      "Your account has not been activated yet. Please use the activation link we emailed you.",
      403,
      "NOT_ACTIVATED",
    );
  }

  if (user.vendor?.onboardingStatus !== "APPROVED") {
    throw new AppError(
      "Your vendor registration is not approved yet, so the portal is not available.",
      403,
      "VENDOR_NOT_APPROVED",
    );
  }

  await touchLogin(user.id);
  return toAuthResult(user, user.vendor?.name);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { email: normalised, role: "vendor_user", isActive: true },
    select: { id: true, email: true, fullName: true, vendorId: true },
  });

  if (!user) {
    // Still report success so the endpoint cannot enumerate accounts.
    return;
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.auth.passwordResetTtlHours * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken: token, resetTokenExpiresAt: expiresAt },
  });

  await sendTemplate({
    to: user.email,
    template: "password_reset",
    vars: {
      resetUrl: portalUrl(`/reset-password?token=${encodeURIComponent(token)}`),
      resetTtlHours: env.auth.passwordResetTtlHours,
    },
    entity: "User",
    entityId: user.id,
  });
}

export interface TokenValidity {
  valid: boolean;
  reason?: "NOT_FOUND" | "EXPIRED" | "WRONG_ROLE" | "ALREADY_USED";
  email?: string;
}

export async function checkActivationToken(token: string): Promise<TokenValidity> {
  const user = await prisma.user.findFirst({
    where: { activationToken: token },
    select: { id: true, email: true, role: true, activationTokenExpiresAt: true },
  });
  if (!user) return { valid: false, reason: "NOT_FOUND" };
  if (user.role !== "vendor_user") return { valid: false, reason: "WRONG_ROLE" };
  if (!user.activationTokenExpiresAt || user.activationTokenExpiresAt < new Date()) {
    return { valid: false, reason: "EXPIRED" };
  }
  return { valid: true, email: user.email };
}

export async function activateAccount(token: string, password: string): Promise<AuthResult> {
  assertPasswordStrength(password);

  const user = await prisma.user.findFirst({
    where: { activationToken: token },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      vendorId: true,
      activationTokenExpiresAt: true,
      vendor: { select: { name: true, onboardingStatus: true } },
    },
  });

  if (!user) throw new AppError("This activation link is not valid.", 400, "INVALID_TOKEN");
  if (user.role !== "vendor_user") {
    throw new AppError("This activation link is not valid.", 400, "INVALID_TOKEN");
  }
  if (!user.activationTokenExpiresAt || user.activationTokenExpiresAt < new Date()) {
    throw new AppError("This activation link has expired. Please ask us to resend it.", 400, "TOKEN_EXPIRED");
  }
  if (user.vendor?.onboardingStatus !== "APPROVED") {
    throw new AppError("Your vendor registration is not approved yet.", 403, "VENDOR_NOT_APPROVED");
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      activationToken: null,
      activationTokenExpiresAt: null,
      activatedAt: new Date(),
    },
    select: { id: true, email: true, fullName: true, role: true, vendorId: true },
  });

  await touchLogin(updated.id);
  return toAuthResult(updated, user.vendor?.name);
}

export async function resetPassword(token: string, password: string): Promise<void> {
  assertPasswordStrength(password);

  const user = await prisma.user.findFirst({
    where: { resetToken: token },
    select: {
      id: true,
      email: true,
      role: true,
      resetTokenExpiresAt: true,
    },
  });

  if (!user) throw new AppError("This reset link is not valid.", 400, "INVALID_TOKEN");
  if (user.role !== "vendor_user") {
    throw new AppError("This reset link is not valid.", 400, "INVALID_TOKEN");
  }
  if (!user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
    throw new AppError("This reset link has expired. Please request a new one.", 400, "TOKEN_EXPIRED");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      resetToken: null,
      resetTokenExpiresAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Internal users: email + one-time code
// ---------------------------------------------------------------------------

function generateOtpCode(): string {
  // randomInt is uniform; Math.random is not acceptable for a login code.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function requestLoginOtp(email: string, ipAddress?: string): Promise<void> {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { email: normalised, role: { in: ["admin_user", "sales_user"] }, isActive: true },
    select: { id: true, email: true, fullName: true, vendorId: true },
  });

  if (!user) return; // Generic response stands; nothing is emailed.

  const code = generateOtpCode();

  // Invalidate any earlier outstanding code so only the newest one works.
  await prisma.loginOtp.updateMany({
    where: { userId: user.id, purpose: OtpPurpose.LOGIN, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.loginOtp.create({
    data: {
      userId: user.id,
      purpose: OtpPurpose.LOGIN,
      codeHash: await hashPassword(code),
      expiresAt: new Date(Date.now() + env.auth.loginOtpTtlMinutes * 60 * 1000),
      ipAddress: ipAddress ?? null,
    },
  });

  await sendTemplate({
    to: user.email,
    template: "login_otp",
    vars: {
      otpCode: code,
      otpTtlMinutes: env.auth.loginOtpTtlMinutes,
      fullName: user.fullName ? ` ${user.fullName}` : "",
    },
    entity: "User",
    entityId: user.id,
  });
}

export async function verifyLoginOtp(email: string, code: string): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { email: normalised, role: { in: ["admin_user", "sales_user"] }, isActive: true },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      vendorId: true,
      otps: {
        where: { purpose: OtpPurpose.LOGIN, consumedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, codeHash: true, expiresAt: true, attempts: true },
      },
    },
  });

  const otp = user?.otps[0];
  if (!user || !otp) throw new AppError(GENERIC_OTP_FAILURE, 401, "INVALID_OTP");

  if (otp.expiresAt < new Date()) {
    throw new AppError(GENERIC_OTP_FAILURE, 401, "INVALID_OTP");
  }

  if (otp.attempts >= env.auth.loginOtpMaxAttempts) {
    throw new AppError("Too many incorrect attempts. Please request a new code.", 429, "OTP_LOCKED");
  }

  const ok = await verifyPassword(code, otp.codeHash);
  if (!ok) {
    await prisma.loginOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError(GENERIC_OTP_FAILURE, 401, "INVALID_OTP");
  }

  // Single use: consumed before the session is issued.
  await prisma.loginOtp.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() },
  });

  await touchLogin(user.id);
  return toAuthResult(user);
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

export async function describeUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      vendorId: true,
      isActive: true,
      activatedAt: true,
      vendor: { select: { id: true, name: true, onboardingStatus: true, sapVendorCode: true } },
    },
  });
  if (!user) throw AppError.unauthorized();
  return user;
}
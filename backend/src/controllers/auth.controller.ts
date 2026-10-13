import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/database";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import { AuthedRequest } from "../middleware/auth";
import {
  activateAccount,
  assertPasswordStrength,
  checkActivationToken,
  describeUser,
  hashPassword,
  loginWithPassword,
  requestLoginOtp,
  requestPasswordReset,
  resetPassword,
  verifyLoginOtp,
  verifyPassword,
} from "../services/auth.service";
import { recordAudit } from "../services/audit.service";
import { capabilitiesOf } from "../utils/rbac";

/**
 * Auth endpoints. Note that no response here reveals whether an email address
 * is registered — a wrong password, an unknown address and an inactive
 * account all produce the same 401 with the same text.
 */

const emailField = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(200, "Email is too long")
  .email("Enter a valid email address")
  .transform((value) => value.toLowerCase());

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required").max(200),
});

export const otpRequestSchema = z.object({ email: emailField });
export const otpVerifySchema = z.object({
  email: emailField,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
});
export const forgotPasswordSchema = z.object({ email: emailField });

export const activateSchema = z.object({
  token: z.string().min(10, "Activation link is not valid"),
  password: z.string().min(1, "Password is required").max(200),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10, "Reset link is not valid"),
  password: z.string().min(1, "Password is required").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(1, "New password is required").max(200),
});

function sessionResponse(
  user: { id: string; email: string; fullName: string | null; role: string; vendorId: string | null },
  token: string,
) {
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      vendorId: user.vendorId,
      capabilities: capabilitiesOf(user.role as never),
    },
  };
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);
  const result = await loginWithPassword(email, password);
  res.json(sessionResponse(result.user, result.token));
});

export const requestOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email } = otpRequestSchema.parse(req.body);
  await requestLoginOtp(email, req.ip);
  res.json({
    message:
      "If that email address belongs to an SML user account, a sign-in code has been sent.",
  });
});

export const verifyOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = otpVerifySchema.parse(req.body);
  const result = await verifyLoginOtp(email, code);
  await recordAudit({
    entity: "User",
    entityId: result.user.id,
    action: "OTP_LOGIN",
    actor: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role as never,
      vendorId: result.user.vendorId,
    },
    ipAddress: req.ip,
  });
  res.json(sessionResponse(result.user, result.token));
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  await requestPasswordReset(email);
  res.json({
    message:
      "If that email address belongs to a vendor account, a password reset link has been sent.",
  });
});

export const checkActivation = asyncHandler(async (req: Request, res: Response) => {
  const token = z.string().min(10).parse(req.body?.token ?? req.query.token);
  const result = await checkActivationToken(token);
  res.json({
    valid: result.valid,
    reason: result.reason ?? null,
    email: result.email ?? null,
  });
});

export const activate = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = activateSchema.parse(req.body);
  const result = await activateAccount(token, password);
  await recordAudit({
    entity: "User",
    entityId: result.user.id,
    action: "ACTIVATED",
    actor: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role as never,
      vendorId: result.user.vendorId,
    },
    ipAddress: req.ip,
  });
  res.json(sessionResponse(result.user, result.token));
});

export const resetPasswordHandler = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await resetPassword(token, password);
  res.json({ message: "Your password has been changed. You can now sign in." });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const detail = await describeUser(user.id);
  res.json({
    user: {
      id: detail.id,
      email: detail.email,
      fullName: detail.fullName,
      role: detail.role,
      vendorId: detail.vendorId,
      vendor: detail.vendor,
      capabilities: capabilitiesOf(detail.role),
    },
  });
});

export const changePassword = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  if (req.user.role !== "vendor_user") {
    throw AppError.badRequest(
      "Internal accounts sign in with a one-time code and do not use passwords.",
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) {
    throw AppError.badRequest("This account has no password set. Use the activation link.");
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw AppError.badRequest("Current password is incorrect");
  }
  assertPasswordStrength(newPassword);

  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  await recordAudit({
    entity: "User",
    entityId: req.user.id,
    action: "PASSWORD_CHANGED",
    actor: req.user,
    ipAddress: req.ip,
  });

  res.json({ message: "Password updated" });
});
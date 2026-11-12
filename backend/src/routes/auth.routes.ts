import { Router } from "express";
import * as auth from "../controllers/auth.controller";
import * as sso from "../controllers/sso.controller";
import { requireAuth } from "../middleware/auth";
import {
  activationLimiter,
  apiLimiter,
  loginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  resetLimiter,
} from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/auth
 *
 * Public endpoints are individually rate limited (brief 6.6). The vendor
 * password login and the internal OTP request are deliberately separate
 * routes rather than one polymorphic endpoint, so the rate limits and error
 * messages cannot be confused between the two audiences.
 */

// Vendor: email + password.
router.post("/login", loginLimiter, auth.login);

// Internal (admin / sales): email, then a 6-digit code.
router.post("/otp/request", otpRequestLimiter, auth.requestOtp);
router.post("/otp/verify", otpVerifyLimiter, auth.verifyOtp);

// SSO for internal users (P5). OTP remains the fallback.
router.get("/sso/status", apiLimiter, sso.status);
router.get("/sso/start", apiLimiter, sso.start);
router.post("/sso/callback", otpVerifyLimiter, sso.callback);

// Password reset (vendor).
router.post("/forgot-password", resetLimiter, auth.forgotPassword);
router.post("/reset-password", activationLimiter, auth.resetPasswordHandler);

// First-time activation (vendor), reached from the emailed link.
router.post("/activation/check", activationLimiter, auth.checkActivation);
router.post("/activate", activationLimiter, auth.activate);

// Authenticated.
router.get("/me", apiLimiter, requireAuth, auth.me);
router.post("/change-password", apiLimiter, requireAuth, auth.changePassword);

export default router;
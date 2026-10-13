import rateLimit, { ipKeyGenerator, RateLimitRequestHandler } from "express-rate-limit";
import { Request } from "express";
import { env } from "../config/env";

/**
 * Rate limits on the credential endpoints. Brief 6.6 requires login and
 * password reset to be rate limited; OTP request and verify are limited for
 * the same reason (an emailed code is only as strong as its send rate).
 *
 * Keyed on IP + submitted email so one attacker cannot lock out an entire
 * office by hammering one account, and a botnet cannot spread a single email
 * across many IPs to collect more attempts.
 *
 * `ipKeyGenerator` is used rather than raw `req.ip` because a client-supplied
 * IPv6 address can arrive as a /64 subnet — 2^64 addresses behind one limit
 * key would make the credential limits meaningless.
 */

const FIFTEEN_MIN = 15 * 60 * 1000;

function keyByIpAndEmail(prefix: string, emailField: string) {
  return (req: Request): string => {
    const raw = (req.body as Record<string, unknown> | undefined)?.[emailField];
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    return `${prefix}:${ipKeyGenerator(req.ip ?? "")}:${email}`;
  };
}

function tooMany(message: string): (req: Request, res: import("express").Response) => void {
  return (_req, res) => {
    res.status(429).json({ error: message, code: "RATE_LIMITED" });
  };
}

/**
 * Exported so the limiter's behaviour can be exercised at a low threshold in
 * tests instead of only being asserted through its configuration.
 */
export function credentialLimit(
  prefix: string,
  emailField: string,
  max: number,
  message: string,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: FIFTEEN_MIN,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: keyByIpAndEmail(prefix, emailField),
    handler: tooMany(message),
  });
}

export const loginLimiter = credentialLimit(
  "login",
  "email",
  env.rateLimits.loginPer15Min,
  "Too many sign-in attempts. Please try again later.",
);

export const resetLimiter = credentialLimit(
  "reset",
  "email",
  env.rateLimits.resetPer15Min,
  "Too many password reset requests. Please try again later.",
);

export const otpRequestLimiter = credentialLimit(
  "otp-request",
  "email",
  env.rateLimits.otpRequestPer15Min,
  "Too many code requests. Please try again later.",
);

export const otpVerifyLimiter = credentialLimit(
  "otp-verify",
  "email",
  env.rateLimits.otpVerifyPer15Min,
  "Too many code attempts. Please try again later.",
);

export const activationLimiter = credentialLimit(
  "activate",
  "email",
  20,
  "Too many attempts. Please try again later.",
);

export const apiLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimits.apiPerMin,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooMany("Too many requests. Please slow down."),
});
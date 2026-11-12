import { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { capabilitiesOf } from "../utils/rbac";
import { signInWithSso } from "../services/auth.service";
import {
  authorizationUrl,
  consumeState,
  createState,
  exchangeCode,
  ssoStatus,
} from "../services/sso.service";

/**
 * P5 SSO endpoints (open item 8). OTP stays available as the fallback; these
 * routes are inert until `SSO_PROVIDER=entra` is fully configured.
 */

export const status = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ sso: ssoStatus() });
});

export const start = asyncHandler(async (_req: Request, res: Response) => {
  const state = createState();
  res.json({ authorizationUrl: authorizationUrl(state), state });
});

const callbackSchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

export const callback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = callbackSchema.parse(req.body);
  // Validate the state before spending the provider round trip.
  consumeState(state);

  const identity = await exchangeCode(code, state);
  const result = await signInWithSso(identity.email);

  res.json({
    token: result.token,
    user: {
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.fullName,
      role: result.user.role,
      vendorId: result.user.vendorId,
      capabilities: capabilitiesOf(result.user.role),
    },
  });
});

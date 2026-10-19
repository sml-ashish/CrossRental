import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import type { AuthedRequest } from "../middleware/auth";
import { vendorDashboard } from "../services/vendorDashboard.service";

/**
 * HTTP shaping for the vendor dashboard (brief 7.5). No rules here: the service
 * asserts the role, the vendor scope and the thresholds it reads.
 */
export const dashboard = asyncHandler(async (_req: Request, res: Response) => {
  const actor = (_req as AuthedRequest).user;
  const data = await vendorDashboard({
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  });
  res.json(data);
});

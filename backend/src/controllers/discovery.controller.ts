import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import * as discovery from "../services/discovery.service";
import type { DiscoveryActor } from "../services/discovery.service";

/**
 * HTTP shaping for manual vendor discovery (BPD 6.8 / 5.9). The service
 * re-checks that the caller is internal, so a vendor cannot reach it even if a
 * route were mounted too loosely.
 */

function actorOf(req: Request): DiscoveryActor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

export const search = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  res.json(await discovery.searchCranes(query, actorOf(req)));
});

export const facets = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await discovery.discoveryFacets());
});

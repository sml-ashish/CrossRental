import { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import type { Actor } from "../services/rfq.service";
import { getSettings, setSetting } from "../utils/settings";
import {
  isMasterListKey,
  getMasterLists,
  setMasterList,
} from "../utils/masterLists";

function actorOf(req: Request): Actor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    vendorId: user.vendorId,
  };
}

/**
 * SML-side configuration additions (brief 6.4 and the phase A plan).
 *
 * The day basis decides how a quoted month converts into days for every
 * quotation total, so changing it is an accounting decision — admin-only, and
 * logged through the setting's `updatedBy`. Reading it guards the same way:
 * sales does not need it, and the form hints explain the behaviour instead.
 */

const updateSchema = z.object({
  rateDayBasis: z.enum(["CALENDAR_DAYS", "WORKING_DAYS_PER_MONTH"]),
});

export const show = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getSettings();
  res.json({
    settings: {
      rateDayBasis: settings.rateDayBasis,
      // P3: the comparison screen's rank rule. Read-only for now — there is a
      // single allowed value, so there is nothing to change yet.
      quoteRankRule: settings.quoteRankRule,
    },
  });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { rateDayBasis } = updateSchema.parse(req.body);
  await setSetting("RATE_DAY_BASIS", rateDayBasis, actorOf(req).id);
  res.json({ settings: { rateDayBasis } });
});

const masterListSchema = z.object({
  values: z.array(z.string()),
});

/**
 * Admin-editable master lists for the SAP office-use block (phase D3). Reading
 * is admin-only too: these lists only ever feed the office-use form and the
 * creation sheet, both of which are admin surfaces.
 */
export const showMasterLists = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ masterLists: await getMasterLists() });
});

export const updateMasterList = asyncHandler(async (req: Request, res: Response) => {
  const name = req.params.name ?? "";
  if (!isMasterListKey(name)) throw AppError.badRequest(`Unknown master list: ${name}`);
  const { values } = masterListSchema.parse(req.body);
  const saved = await setMasterList(name, values, actorOf(req).id);
  res.json({ name, values: saved });
});

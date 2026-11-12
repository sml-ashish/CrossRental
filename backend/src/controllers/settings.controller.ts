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
import {
  createMobilisationRate,
  listEmailTemplates,
  listMobilisationRates,
  listStateRegions,
  updateEmailTemplate,
  updateMobilisationRate,
  updateStateRegion,
} from "../services/configuration.service";

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

const updateSchema = z
  .object({
    rateDayBasis: z.enum(["CALENDAR_DAYS", "WORKING_DAYS_PER_MONTH"]).optional(),
    // P5 alert SLAs and retention. Open item 11 supplies the final values.
    alertRfqSlaHours: z.number().int().min(1).max(720).optional(),
    alertQuotationExpiryDays: z.number().int().min(1).max(90).optional(),
    alertBookingLeadDays: z.number().int().min(1).max(90).optional(),
    alertEmailsEnabled: z.boolean().optional(),
    reportRetentionMonths: z.number().int().min(1).max(600).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to change",
  });

/**
 * The full configurable surface. Admin-only: these values change every
 * quotation and alert the portal produces.
 */
export const show = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getSettings();
  res.json({ settings });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const body = updateSchema.parse(req.body);
  const updatedBy = actorOf(req).id;

  if (body.rateDayBasis !== undefined) {
    await setSetting("RATE_DAY_BASIS", body.rateDayBasis, updatedBy);
  }
  if (body.alertRfqSlaHours !== undefined) {
    await setSetting("ALERT_RFQ_SLA_HOURS", String(body.alertRfqSlaHours), updatedBy);
  }
  if (body.alertQuotationExpiryDays !== undefined) {
    await setSetting(
      "ALERT_QUOTATION_EXPIRY_DAYS",
      String(body.alertQuotationExpiryDays),
      updatedBy,
    );
  }
  if (body.alertBookingLeadDays !== undefined) {
    await setSetting("ALERT_BOOKING_LEAD_DAYS", String(body.alertBookingLeadDays), updatedBy);
  }
  if (body.alertEmailsEnabled !== undefined) {
    await setSetting("ALERT_EMAILS_ENABLED", String(body.alertEmailsEnabled), updatedBy);
  }
  if (body.reportRetentionMonths !== undefined) {
    await setSetting("REPORT_RETENTION_MONTHS", String(body.reportRetentionMonths), updatedBy);
  }

  res.json({ settings: await getSettings() });
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

// --- P5 configuration tables ------------------------------------------------

const rateCreateSchema = z.object({
  craneTypeCode: z.string().trim().min(1),
  capacityMinT: z.number().min(0),
  capacityMaxT: z.number().min(0).nullable(),
  ownershipType: z.enum(["VENDOR", "SML"]).nullable(),
  ratePerKm: z.number().min(0),
});

const rateUpdateSchema = z
  .object({
    capacityMinT: z.number().min(0).optional(),
    capacityMaxT: z.number().min(0).nullable().optional(),
    ownershipType: z.enum(["VENDOR", "SML"]).nullable().optional(),
    ratePerKm: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to change",
  });

export const showMobilisationRates = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ rates: await listMobilisationRates() });
});

export const createRate = asyncHandler(async (req: Request, res: Response) => {
  const body = rateCreateSchema.parse(req.body);
  const rate = await createMobilisationRate(body, actorOf(req));
  res.status(201).json({ rate });
});

export const updateRate = asyncHandler(async (req: Request, res: Response) => {
  const body = rateUpdateSchema.parse(req.body);
  const rate = await updateMobilisationRate(req.params.id ?? "", body, actorOf(req));
  res.json({ rate });
});

const templateSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().min(1),
});

export const showEmailTemplates = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ templates: await listEmailTemplates() });
});

export const updateTemplate = asyncHandler(async (req: Request, res: Response) => {
  const body = templateSchema.parse(req.body);
  const template = await updateEmailTemplate(req.params.key ?? "", body, actorOf(req));
  res.json({ template });
});

const stateRegionSchema = z.object({
  region: z.string().trim().max(120).nullable(),
});

export const showStateRegions = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ states: await listStateRegions() });
});

export const updateState = asyncHandler(async (req: Request, res: Response) => {
  const body = stateRegionSchema.parse(req.body);
  const state = await updateStateRegion(req.params.code ?? "", body.region, actorOf(req));
  res.json({ state });
});

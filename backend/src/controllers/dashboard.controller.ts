import { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { managementDashboard, salesDashboard } from "../services/dashboard.service";

/**
 * P5 dashboards. The routes are split by audience:
 * - /api/dashboard/sales — the CR team's working list (admin too).
 * - /api/management/dashboard — the read-only aggregate for management.
 *
 * The management route is capability-gated on `reports:view_all`; the
 * management role holds nothing else, so no write path can be reached.
 */

const dateField = z
  .string()
  .trim()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  });

const filterSchema = z.object({
  from: dateField,
  to: dateField,
  region: z.string().trim().min(1).max(120).optional(),
  craneCategory: z.string().trim().min(1).max(60).optional(),
});

function endOfDay(value: Date | undefined, raw: string | undefined): Date | undefined {
  if (!value) return undefined;
  // A bare `to=2026-11-03` means the whole of that day, not its first instant.
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const end = new Date(value);
    end.setHours(23, 59, 59, 999);
    return end;
  }
  return value;
}

export const sales = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ dashboard: await salesDashboard() });
});

export const management = asyncHandler(async (req: Request, res: Response) => {
  const query = filterSchema.parse(req.query ?? {});
  res.json({
    dashboard: await managementDashboard({
      from: query.from,
      to: endOfDay(query.to, req.query["to"] as string | undefined),
      region: query.region,
      craneCategory: query.craneCategory,
    }),
  });
});

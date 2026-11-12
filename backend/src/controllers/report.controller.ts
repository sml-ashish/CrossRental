import { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import type { AuthedRequest } from "../middleware/auth";
import { REPORT_VIEWS, buildReport, reportToCsv, scopeFor } from "../services/report.service";

/**
 * P5 reports and CSV export.
 *
 * `reports:view` (sales) and `reports:view_all` (admin/management) both reach
 * this route; the service is what narrows a sales user to their own enquiries.
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

const reportSchema = z.object({
  view: z.enum(REPORT_VIEWS as [string, ...string[]]).default("enquiry"),
  format: z.enum(["json", "csv"]).default("json"),
  from: dateField,
  to: dateField,
  craneCategory: z.string().trim().min(1).max(60).optional(),
});

function endOfDay(value: Date | undefined, raw: unknown): Date | undefined {
  if (!value) return undefined;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const end = new Date(value);
    end.setHours(23, 59, 59, 999);
    return end;
  }
  return value;
}

export const index = asyncHandler(async (req: Request, res: Response) => {
  const query = reportSchema.parse(req.query ?? {});
  const user = (req as AuthedRequest).user;
  if (!user) return;

  const report = await buildReport({
    view: query.view as (typeof REPORT_VIEWS)[number],
    ...scopeFor(user),
    from: query.from,
    to: endOfDay(query.to, req.query["to"]),
    craneCategory: query.craneCategory,
  });

  if (query.format === "csv") {
    const filename = `crossrental-${query.view}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(reportToCsv(report));
    return;
  }

  res.json({ report });
});

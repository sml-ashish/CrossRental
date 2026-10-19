import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import { AuthedRequest, vendorScopeOf } from "../middleware/auth";
import { validateUpload, ACCEPTED_UPLOAD_LABEL } from "../middleware/upload";
import * as cranes from "../services/crane.service";
import { craneProfile } from "../services/craneProfile.service";
import type { Actor } from "../services/crane.service";

/**
 * HTTP shaping for fleet management (brief 7.4).
 *
 * No business rules live here. In particular this file does not decide who may
 * see a crane — that is `loadScoped` inside the service, which every read goes
 * through, so there is no route that could accidentally return another vendor's
 * crane.
 */

function actorOf(req: Request): Actor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.badRequest(`Missing ${key}`);
  }
  return value.trim();
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  // vendorScopeOf pins a vendor to their own rows and lets an internal reader
  // narrow with ?vendorId=, returning null for "every approved vendor".
  const rows = await cranes.listCranes(query, actorOf(req), vendorScopeOf(req));
  res.json({ cranes: rows });
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ crane: await cranes.getCraneDetail(actorOf(req), param(req, "craneId")) });
});

/** BPD 6.11: the crane detail screen's calendar, flags and transport guess. */
export const profile = asyncHandler(async (req: Request, res: Response) => {
  res.json({ profile: await craneProfile(actorOf(req), param(req, "craneId")) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ crane: await cranes.createCrane(req.body, actorOf(req)) });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    crane: await cranes.updateCrane(param(req, "craneId"), req.body, actorOf(req)),
  });
});

/** The one-step status and location change from brief 7.4. */
export const quickUpdate = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    crane: await cranes.quickUpdateCrane(param(req, "craneId"), req.body, actorOf(req)),
  });
});

/** "Duplicate this crane" returns a prefill; the vendor still submits a form. */
export const duplicatePrefill = asyncHandler(async (req: Request, res: Response) => {
  res.json({ prefill: await cranes.duplicateCranePrefill(actorOf(req), param(req, "craneId")) });
});

/** "Confirm still accurate" — refreshes the timestamp, changes no data. */
export const confirmAccurate = asyncHandler(async (req: Request, res: Response) => {
  res.json({ crane: await cranes.confirmCraneAccurate(param(req, "craneId"), actorOf(req)) });
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  res.json({ crane: await cranes.deactivateCrane(param(req, "craneId"), actorOf(req)) });
});

export const reactivate = asyncHandler(async (req: Request, res: Response) => {
  res.json({ crane: await cranes.reactivateCrane(param(req, "craneId"), actorOf(req)) });
});

export const uploadChart = asyncHandler(async (req: Request, res: Response) => {
  const file = validateUpload(req.file ?? undefined);
  if (!file) {
    throw AppError.badRequest(`Attach a ${ACCEPTED_UPLOAD_LABEL} load chart`);
  }
  res.status(201).json({
    crane: await cranes.uploadLoadChart(param(req, "craneId"), file, actorOf(req)),
  });
});

export const downloadChart = asyncHandler(async (req: Request, res: Response) => {
  const file = await cranes.readLoadChart(actorOf(req), param(req, "craneId"));
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.buffer.length));
  res.setHeader("Content-Disposition", `attachment; filename="${file.fileName.replace(/"/g, "")}"`);
  res.send(file.buffer);
});

/** Brief 6.4's review path. No UI yet, but the endpoint exists so it is real. */
export const setApproval = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    crane: await cranes.setCraneApproval(param(req, "craneId"), req.body, actorOf(req)),
  });
});
import { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import type { Actor } from "../services/rfq.service";
import { emailField, shortText } from "../validation/vendorFields";
import {
  adminDashboard,
  createInternalUser,
  listInternalUsers,
  reinstateVendor,
  resetUserCredentials,
  suspendVendor,
  updateInternalUser,
} from "../services/admin.service";

function actorOf(req: Request): Actor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

/**
 * P0 B: the admin-only dashboard and staff management endpoints.
 *
 * Every route is gated on `vendor:approve`, which only `admin_user` holds — the
 * plan puts configuration and user management out of the sales role's reach.
 */

const internalRole = z.enum(["admin_user", "sales_user", "management_viewer"]);

const createUserSchema = z.object({
  email: emailField,
  fullName: shortText.max(120).optional(),
  role: internalRole,
});

const updateUserSchema = z
  .object({
    role: internalRole.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => body.role !== undefined || body.isActive !== undefined, {
    message: "Nothing to change",
  });

const suspendSchema = z.object({
  reason: z.string().trim().max(500).nullish(),
});

export const dashboard = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ dashboard: await adminDashboard() });
});

export const listUsers = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ users: await listInternalUsers() });
});

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const body = createUserSchema.parse(req.body);
  const user = await createInternalUser(body, actorOf(req));
  res.status(201).json({ user });
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const body = updateUserSchema.parse(req.body);
  const user = await updateInternalUser(req.params.id ?? "", body, actorOf(req));
  res.json({ user });
});

export const resetCredentials = asyncHandler(async (req: Request, res: Response) => {
  await resetUserCredentials(req.params.id ?? "", actorOf(req));
  res.json({ ok: true });
});

export const suspend = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = suspendSchema.parse(req.body ?? {});
  const vendor = await suspendVendor(req.params.id ?? "", reason ?? null, actorOf(req));
  res.json({ vendor });
});

export const reinstate = asyncHandler(async (req: Request, res: Response) => {
  const vendor = await reinstateVendor(req.params.id ?? "", actorOf(req));
  res.json({ vendor });
});

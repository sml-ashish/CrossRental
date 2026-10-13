import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { UserRole } from "../generated/prisma/client";
import { prisma } from "../lib/database";
import { AppError } from "./errorHandler";
import { AuthTokenPayload, verifyAuthToken } from "../utils/jwt";
import type { Capability } from "../utils/rbac";
import { can } from "../utils/rbac";

export interface AuthedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
    vendorId: string | null;
  };
}

/**
 * Auth + authorisation middleware.
 *
 * The vendor isolation rule from brief 6.6 is enforced here rather than in
 * each controller: a vendor_user may only ever act on rows whose vendorId
 * equals their own, and `requireVendorScope` is what proves it on every
 * request. Controllers additionally pass an explicit vendorId into their
 * Prisma `where` clauses — this middleware is the backstop, not the only
 * layer, so a forgotten filter still cannot cross a vendor boundary.
 */

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: "Not authenticated", code: "NO_TOKEN" });
    return;
  }

  let payload: AuthTokenPayload;
  try {
    payload = verifyAuthToken(token);
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    res.status(401).json({
      error: expired ? "Session expired, please sign in again" : "Invalid session",
      code: expired ? "SESSION_EXPIRED" : "INVALID_TOKEN",
    });
    return;
  }

  // The JWT is only trusted after confirming the account still exists and is
  // still active — a disabled or deleted user must lose access immediately,
  // not whenever their token happens to expire.
  void (async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, role: true, vendorId: true, isActive: true },
      });

      if (!user) {
        res.status(401).json({ error: "Session expired, please sign in again", code: "SESSION_EXPIRED" });
        return;
      }
      if (!user.isActive) {
        res.status(401).json({ error: "This account has been deactivated", code: "ACCOUNT_DEACTIVATED" });
        return;
      }

      (req as AuthedRequest).user = {
        id: user.id,
        email: user.email,
        role: user.role,
        vendorId: user.vendorId,
      };
      next();
    } catch (err) {
      next(err);
    }
  })();
}

/** Restricts a route to specific roles. Must run after requireAuth. */
export function requireRole(...allowed: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      next(AppError.unauthorized());
      return;
    }
    if (!allowed.includes(user.role)) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

export function requireCapability(...required: Capability[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      next(AppError.unauthorized());
      return;
    }
    if (!required.every((capability) => can(user.role, capability))) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

/**
 * Satisfied by holding *any* of the listed capabilities.
 *
 * `requireCapability` is an AND. This is the OR, for the read routes where two
 * different roles are each legitimate but neither implies the other — a vendor
 * reading their own fleet, and sales reading an approved vendor's fleet for the
 * candidate picker.
 */
export function requireAnyCapability(...accepted: Capability[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      next(AppError.unauthorized());
      return;
    }
    if (!accepted.some((capability) => can(user.role, capability))) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

export function requireInternalUser(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user) {
    next(AppError.unauthorized());
    return;
  }
  if (user.role === "vendor_user") {
    next(AppError.forbidden());
    return;
  }
  next();
}

/**
 * Returns the vendorId the caller is allowed to act within.
 *
 * - vendor_user: always their own vendorId, from the token.
 * - admin/sales: an explicit `?vendorId=` / body value, used by the internal
 *   screens to narrow to one vendor.
 *
 * Returns null for internal users who did not narrow, meaning "all vendors".
 */
export function vendorScopeOf(req: Request): string | null {
  const user = (req as AuthedRequest).user;
  if (user.role === "vendor_user") {
    if (!user.vendorId) {
      // A vendor account with no vendor record is a data-integrity problem,
      // not something to fail open on.
      throw AppError.forbidden("Your account is not linked to a vendor");
    }
    return user.vendorId;
  }

  const source = {
    ...((req.query as Record<string, unknown>) ?? {}),
    ...(typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {}),
    ...((req.params as Record<string, unknown>) ?? {}),
  };

  const requested = source["vendorId"];
  if (typeof requested === "string" && requested.trim() !== "") {
    return requested.trim();
  }
  return null;
}

/**
 * Guards a route that addresses a single vendor-owned row by id. Loads the
 * row's owner and compares it with the caller's scope, so a vendor who
 * guesses another vendor's crane id gets 404 — not 403, which would confirm
 * the row exists.
 */
export async function requireVendorOwnership(
  req: Request,
  resolve: (req: AuthedRequest) => Promise<{ vendorId: string } | null>,
): Promise<void> {
  const user = (req as AuthedRequest).user;
  if (user.role !== "vendor_user") return;

  const row = await resolve(req as AuthedRequest);
  if (!row || row.vendorId !== user.vendorId) {
    throw AppError.notFound();
  }
}
import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client";
import { env } from "../config/env";

/**
 * One error type for anything the application deliberately rejects, plus a
 * terminal handler that turns everything else into a safe JSON response.
 *
 * The important property for this portal: a message is only ever shown to the
 * caller when it was raised deliberately as an AppError. Anything else is
 * logged server-side and replaced with a generic message, so an unexpected
 * database error can never leak schema detail to a vendor.
 */

export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = "BAD_REQUEST",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(message, 400, "BAD_REQUEST", details);
  }

  static unauthorized(message = "Not authenticated"): AppError {
    return new AppError(message, 401, "UNAUTHORIZED");
  }

  static forbidden(message = "You do not have permission to perform this action"): AppError {
    return new AppError(message, 403, "FORBIDDEN");
  }

  static notFound(message = "Not found"): AppError {
    return new AppError(message, 404, "NOT_FOUND");
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(message, 409, "CONFLICT", details);
  }

  /**
   * Deliberately identical message for "no such user" and "wrong password".
   * Login screens must not reveal whether an email is registered.
   */
  static invalidCredentials(): AppError {
    return new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }
}

interface BodyParserError extends Error {
  status?: number;
  type?: string;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: "NO_ROUTE" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // The partial unique index on (vendorId, serialRegistrationNo) raises
  // P2002. Duplicate-crane detection is a normal user-facing outcome, so it
  // is translated into a clear message instead of a 500.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    const target = (err.meta?.["target"] as string[] | undefined) ?? [];
    if (target.includes("cranes_vendor_serial_active_uniq")) {
      res.status(409).json({
        error:
          "You already have an active crane with this serial / registration number.",
        code: "DUPLICATE_CRANE_SERIAL",
      });
      return;
    }
    res.status(409).json({ error: "That value is already in use", code: "DUPLICATE" });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    return;
  }

  // A CHECK constraint rejected the write. Application code validates these
  // first, so reaching here means something slipped through — report it as a
  // bad request with the constraint name, which is safe to show.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2010") {
    const message = String(err.meta?.["message"] ?? "");
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    if (constraint) {
      res.status(400).json({
        error: `That value is not allowed (${constraint})`,
        code: "CONSTRAINT_VIOLATION",
      });
      return;
    }
  }

  const parserError = err as BodyParserError;
  if (parserError?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body is too large", code: "PAYLOAD_TOO_LARGE" });
    return;
  }

  // Everything else: log it, tell the caller nothing.
  console.error("[error]", err);
  res.status(500).json({
    error: env.isProduction
      ? "Something went wrong. Please try again."
      : String((err as Error)?.message ?? err),
    code: "INTERNAL_ERROR",
  });
}
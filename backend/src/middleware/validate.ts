import { NextFunction, Request, Response } from "express";
import { ZodError, ZodType } from "zod";
import { AppError } from "./errorHandler";

/**
 * Zod validation for request bodies, query strings and params. Parsed output
 * replaces the raw value so handlers work with coerced, typed data rather
 * than `any`.
 *
 * Four Zod-internal keys (`__proto__`, `constructor`, `prototype` and a
 * catch-all) are stripped from the incoming body before parsing, because a
 * request body is attacker-controlled and prototype pollution here would
 * bypass every later ownership check.
 */

const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

function stripDangerousKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDangerousKeys);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = Object.create(null);
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) continue;
    out[key] = stripDangerousKeys(val);
  }
  return Object.assign({}, out);
}

export function validateBody<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(stripDangerousKeys(req.body ?? {}));
      next();
    } catch (err) {
      next(toAppError(err));
    }
  };
}

export function validateQuery<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(stripDangerousKeys(req.query ?? {}));
      // req.query is a getter-only property in Express 5 but assignable in 4;
      // stash the parsed value where handlers can rely on it being typed.
      (req as Request & { validatedQuery?: unknown }).validatedQuery = parsed;
      Object.defineProperty(req, "query", { value: parsed, writable: true });
      next();
    } catch (err) {
      next(toAppError(err));
    }
  };
}

export function validateParams<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      Object.defineProperty(req, "params", {
        value: schema.parse(stripDangerousKeys(req.params ?? {})),
        writable: true,
      });
      next();
    } catch (err) {
      next(toAppError(err));
    }
  };
}

function toAppError(err: unknown): AppError {
  if (err instanceof ZodError) {
    return new AppError("Validation failed", 400, "VALIDATION_ERROR", {
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return err as AppError;
}
import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

/**
 * Assigns a request id and logs one line per request. Keeps the log to a
 * single line with no body content, because request bodies on this portal
 * carry vendor bank details.
 */

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Auth endpoints are logged at a coarse level so the log stays useful
    // without recording the submitted email address of every attempt.
    const label = req.originalUrl.startsWith("/api/auth") ? req.originalUrl.split("?")[0] : req.originalUrl;
    console.log(
      `${req.method} ${label} ${res.statusCode} ${ms.toFixed(1)}ms req=${requestId}`,
    );
  });

  next();
}
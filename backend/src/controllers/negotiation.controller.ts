import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import * as negotiations from "../services/negotiation.service";
import type { Actor } from "../services/quotation.service";

/**
 * HTTP shaping for counter-quote / negotiation (phase 1 + 2).
 *
 * No rules here. Every service function re-checks the caller's role/vendor scope
 * and the thread's turn and version, so this layer only parses ids and bodies.
 * Internal handlers are mounted on `/api/rfqs`, vendor handlers on
 * `/api/vendor/rfqs`; the service is the single source of access truth.
 */

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

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.badRequest(`Missing ${key}`);
  }
  return value.trim();
}

// --- internal / SML ---------------------------------------------------------

export const listForRfq = asyncHandler(async (req: Request, res: Response) => {
  res.json(await negotiations.listRfqNegotiations(param(req, "rfqId"), actorOf(req)));
});

export const previewCounter = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await negotiations.previewSmlCounter(
      param(req, "rfqId"),
      param(req, "quotationId"),
      req.body,
      actorOf(req),
    ),
  );
});

export const counter = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(
    { result: await negotiations.counterAsSml(
      param(req, "rfqId"),
      param(req, "quotationId"),
      req.body,
      actorOf(req),
    ) },
  );
});

export const accept = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    { result: await negotiations.acceptNegotiationAsSml(param(req, "id"), req.body, actorOf(req)) },
  );
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    { result: await negotiations.rejectNegotiation(param(req, "id"), req.body, actorOf(req)) },
  );
});

export const logVendorOffer = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    { result: await negotiations.logVendorOffer(param(req, "id"), req.body, actorOf(req)) },
  );
});

// --- vendor -----------------------------------------------------------------

export const vendorListForRfq = asyncHandler(async (req: Request, res: Response) => {
  res.json(await negotiations.listVendorNegotiations(param(req, "rfqId"), actorOf(req)));
});

export const vendorGet = asyncHandler(async (req: Request, res: Response) => {
  res.json(await negotiations.getNegotiation(param(req, "id"), actorOf(req)));
});

export const vendorPreviewCounter = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await negotiations.previewVendorCounter(param(req, "id"), req.body, actorOf(req)),
  );
});

export const vendorCounter = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(
    { result: await negotiations.counterAsVendor(param(req, "id"), req.body, actorOf(req)) },
  );
});

export const vendorAccept = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    { result: await negotiations.acceptNegotiationAsVendor(param(req, "id"), req.body, actorOf(req)) },
  );
});

export const vendorDecline = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    { result: await negotiations.declineNegotiation(param(req, "id"), req.body, actorOf(req)) },
  );
});

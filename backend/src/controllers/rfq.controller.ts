import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import * as rfqs from "../services/rfq.service";
import type { Actor } from "../services/rfq.service";
import { awardQuotation } from "../services/award.service";
import { markQuotation } from "../services/quotation.service";

/**
 * HTTP shaping for internal RFQ work (brief 7.9).
 *
 * No rules here. Every function in the service is internal-only and re-checks
 * that itself, so there is no route that reaches an RFQ operation with a vendor
 * token — and no way for a future route to forget the check.
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

export const list = asyncHandler(async (req: Request, res: Response) => {
  const rows = await rfqs.listRfqs(req.query, actorOf(req));
  res.json({ rfqs: rows });
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ rfq: await rfqs.getRfqDetail(param(req, "rfqId"), actorOf(req)) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ rfq: await rfqs.createRfq(req.body, actorOf(req)) });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    rfq: await rfqs.updateRfq(param(req, "rfqId"), req.body, actorOf(req)),
  });
});

/** Candidate picker: matching vendor cranes grouped by vendor, nearest first. */
export const candidates = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    candidates: await rfqs.getCandidates(
      param(req, "rfqId"),
      req.query,
      actorOf(req),
    ),
  });
});

/** Approved vendors with an active user — the picker's "everyone else" list. */
export const approvedVendors = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({
      vendors: await rfqs.listApprovedVendors(req.query, actorOf(req)),
    });
  },
);

export const send = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    result: await rfqs.sendRfq(param(req, "rfqId"), req.body, actorOf(req)),
  });
});

export const confirmSitePin = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({
      rfq: await rfqs.confirmSitePin(
        param(req, "rfqId"),
        req.body,
        actorOf(req),
      ),
    });
  },
);

export const extendDeadline = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({
      result: await rfqs.extendDeadline(
        param(req, "rfqId"),
        req.body,
        actorOf(req),
      ),
    });
  },
);

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    result: await rfqs.cancelRfq(param(req, "rfqId"), req.body, actorOf(req)),
  });
});

export const remind = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    result: await rfqs.remindRfq(param(req, "rfqId"), req.body, actorOf(req)),
  });
});

/**
 * Run the deadline sweep by hand.
 *
 * The automatic sweep is M7. Exposing it as a route means the expiry rule can be
 * exercised against a running server now, rather than only in a unit test.
 */
export const expirePending = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({ result: await rfqs.runExpirySweep(actorOf(req)) });
  },
);

/**
 * Award (brief 6.7): select a quotation, mark the rest Not Awarded, book the
 * crane, close the RFQ and email the vendors. The business rules live in
 * `award.service.ts`, which the later sales-side comparison screens will call
 * too; this handler only parses paths and shapes the response.
 */
export const award = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    result: await awardQuotation(
      param(req, "rfqId"),
      param(req, "quotationId"),
      req.body,
      actorOf(req),
    ),
  });
});

/**
 * Mark a quotation (P3, BPD 6.15): Under Review, Shortlisted or Rejected with a
 * reason code. This is the comparison screen's working note, not the award — the
 * award outcomes stay in `award.service.ts`. The service owns the rules.
 */
export const mark = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    result: await markQuotation(
      param(req, "rfqId"),
      param(req, "quotationId"),
      req.body,
      actorOf(req),
    ),
  });
});

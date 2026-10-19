import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import * as enquiries from "../services/enquiry.service";
import { enquiryHistory } from "../services/history.service";
import type { Actor } from "../services/rfq.service";

/**
 * HTTP shaping for enquiry intake and the sourcing workspace (P1).
 *
 * No rules here, as with the RFQ controller: the service re-checks that the
 * actor is internal on every entry point, so a vendor token cannot reach an
 * enquiry operation even if a route were mounted too loosely.
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
  const rows = await enquiries.listEnquiries(req.query, actorOf(req));
  res.json({ enquiries: rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  res
    .status(201)
    .json({ enquiry: await enquiries.createEnquiry(req.body, actorOf(req)) });
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    enquiry: await enquiries.getEnquiryDetail(param(req, "enquiryId"), actorOf(req)),
  });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    enquiry: await enquiries.updateEnquiry(
      param(req, "enquiryId"),
      req.body,
      actorOf(req),
    ),
  });
});

/** The enquiry's sourcing history, reconstructed from the audit trail (5.14). */
export const history = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    history: await enquiryHistory(param(req, "enquiryId"), actorOf(req)),
  });
});

export const addLine = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({
    line: await enquiries.addLine(param(req, "enquiryId"), req.body, actorOf(req)),
  });
});

export const updateLine = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    line: await enquiries.updateLine(param(req, "lineId"), req.body, actorOf(req)),
  });
});

export const cancelLine = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    line: await enquiries.cancelLine(param(req, "lineId"), req.body, actorOf(req)),
  });
});

/** The manual internal availability check (P1 section 5). */
export const internalCheck = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    line: await enquiries.recordInternalCheck(
      param(req, "lineId"),
      req.body,
      actorOf(req),
    ),
  });
});

/** An extension point for P3's comparison screen; harmless before then. */
export const underEvaluation = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({
      line: await enquiries.markUnderEvaluation(param(req, "lineId"), actorOf(req)),
    });
  },
);

/** Raise an RFQ from a line; prefilled from the vendor-safe subset. */
export const createRfq = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({
    rfq: await enquiries.createRfqFromLine(
      param(req, "lineId"),
      req.body,
      actorOf(req),
    ),
  });
});

/** The line's sourcing workspace: recommendations, RFQ history, quotations. */
export const workspace = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    workspace: await enquiries.getLineWorkspace(param(req, "lineId"), actorOf(req)),
  });
});

/** The line's comparable quotations, ranked (P3, BPD 6.15). */
export const comparison = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    comparison: await enquiries.getLineComparison(
      param(req, "lineId"),
      actorOf(req),
    ),
  });
});

/** The line's recommendations and snapshot history (P2). */
export const recommendations = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await enquiries.getLineRecommendations(
      param(req, "lineId"),
      actorOf(req),
    );
    res.json(result);
  },
);

/** Re-run the recommendation engine, keeping earlier snapshots (P2). */
export const refreshRecommendations = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await enquiries.refreshLineRecommendations(
      param(req, "lineId"),
      actorOf(req),
    );
    res.json(result);
  },
);

import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { validateUpload } from "../middleware/upload";
import * as quotations from "../services/quotation.service";
import type { Actor } from "../services/quotation.service";

/**
 * HTTP shaping for the vendor's own quotations (brief 7.8).
 *
 * No rules here. Every function in the service re-checks vendor ownership from
 * the token, so this layer cannot accidentally widen access — the worst it could
 * do is pass an id along, and the service answers 404 for anything that is not
 * this vendor's row.
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

/**
 * The load chart is optional on these two routes: the rule is satisfied by the
 * crane's own file, and only a vendor whose crane has none needs to send one.
 * `validateUpload` still sniffs whatever arrives, so a wrong file type is
 * rejected rather than stored.
 */
function optionalLoadChart(req: Request) {
  return validateUpload(req.file ?? undefined);
}

export const inbox = asyncHandler(async (req: Request, res: Response) => {
  res.json(await quotations.listVendorRfqs(req.query, actorOf(req)));
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.getVendorRfqDetail(param(req, "rfqId"), actorOf(req)),
  );
});

export const preview = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.previewQuotation(
      param(req, "rfqId"),
      req.body,
      actorOf(req),
    ),
  );
});

export const submit = asyncHandler(async (req: Request, res: Response) => {
  res
    .status(201)
    .json(
      await quotations.submitQuotation(
        param(req, "rfqId"),
        req.body,
        actorOf(req),
        optionalLoadChart(req),
      ),
    );
});

export const revise = asyncHandler(async (req: Request, res: Response) => {
  res
    .status(201)
    .json(
      await quotations.reviseQuotation(
        param(req, "quotationId"),
        req.body,
        actorOf(req),
        optionalLoadChart(req),
      ),
    );
});

export const withdraw = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.withdrawQuotation(
      param(req, "quotationId"),
      req.body,
      actorOf(req),
    ),
  );
});

export const decline = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.declineRfq(param(req, "rfqId"), req.body, actorOf(req)),
  );
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.listQuotationHistory(param(req, "rfqId"), actorOf(req)),
  );
});

export const attachments = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await quotations.listQuotationAttachments(
      param(req, "quotationId"),
      actorOf(req),
    ),
  );
});

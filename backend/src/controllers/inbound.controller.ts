import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import type { Actor } from "../services/quotation.service";
import {
  convertInboundReply,
  dismissInboundReply,
  getInboundReply,
  listInboundReplies,
  listRfqInboundReplies,
  patchInboundReply,
  retryAutoConversion,
} from "../services/inboundAdmin.service";
import {
  dismissReplySchema,
  inboundReplyPatchSchema,
  listRepliesQuerySchema,
} from "../validation/inboundFields";

function actorOf(req: Request): Actor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = listRepliesQuerySchema.parse(req.query);
  res.json(await listInboundReplies(query.status, actorOf(req)));
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  res.json({ reply: await getInboundReply(req.params.id ?? "", actorOf(req)) });
});

export const patch = asyncHandler(async (req: Request, res: Response) => {
  const body = inboundReplyPatchSchema.parse(req.body ?? {});
  res.json({ reply: await patchInboundReply(req.params.id ?? "", body, actorOf(req)) });
});

export const convert = asyncHandler(async (req: Request, res: Response) => {
  const body = inboundReplyPatchSchema.parse(req.body ?? {});
  res.json(await convertInboundReply(req.params.id ?? "", body, actorOf(req)));
});

export const dismiss = asyncHandler(async (req: Request, res: Response) => {
  const body = dismissReplySchema.parse(req.body ?? {});
  res.json({
    reply: await dismissInboundReply(req.params.id ?? "", body.note ?? null, actorOf(req)),
  });
});

export const retry = asyncHandler(async (req: Request, res: Response) => {
  res.json(await retryAutoConversion(req.params.id ?? "", actorOf(req)));
});

export const listForRfq = asyncHandler(async (req: Request, res: Response) => {
  const query = listRepliesQuerySchema.parse(req.query);
  res.json(
    await listRfqInboundReplies(req.params.rfqId ?? "", query.status, actorOf(req)),
  );
});

import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { messagesFor } from "../services/communication.service";
import type { CommunicationScope } from "../services/communication.service";

/**
 * HTTP shaping for the communication history (BPD 6.21). The service checks the
 * caller is internal, so a vendor cannot read another party's messages even if
 * the route were mounted loosely.
 */

function actorOf(req: Request) {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

function optionalQuery(req: Request, key: keyof CommunicationScope): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const scope: CommunicationScope = {
    enquiryId: optionalQuery(req, "enquiryId"),
    lineId: optionalQuery(req, "lineId"),
    rfqId: optionalQuery(req, "rfqId"),
    quotationId: optionalQuery(req, "quotationId"),
  };
  res.json({ history: await messagesFor(scope, actorOf(req)) });
});

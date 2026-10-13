import { Router } from "express";
import * as vendorQuotations from "../controllers/vendorQuotation.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";
import { uploadSingle } from "../middleware/upload";

const router = Router();

/**
 * /api/vendor/rfqs — the vendor's own RFQ inbox and quotations (brief 7.8).
 *
 * A separate surface from `/api/rfqs`, which is internal and refuses vendors.
 * Keeping them apart means the capability is the difference: `rfq:respond` is
 * held by `vendor_user` and by no internal role, so there is no path from an SML
 * account to these handlers at all.
 *
 * Every handler also scopes by the token's vendor id inside the service, so a
 * guessed RFQ or quotation id from another vendor is a 404 rather than a 403
 * that would confirm the row exists.
 */

router.use(apiLimiter, requireAuth, requireCapability("rfq:respond"));

// --- static paths before "/:rfqId" so they are not captured as an id ---
router.get("/", vendorQuotations.inbox);

// --- one RFQ, as this vendor sees it ---
router.get("/:rfqId", vendorQuotations.detail);
router.get("/:rfqId/quotations", vendorQuotations.history);
router.post("/:rfqId/decline", vendorQuotations.decline);

/**
 * Quoting an RFQ.
 *
 * `preview` is a plain JSON POST because it is the form's live total; `submit`
 * accepts an optional `loadChart` file for vendors whose crane has none on file.
 */
router.post("/:rfqId/quotations/preview", vendorQuotations.preview);
router.post(
  "/:rfqId/quotations",
  uploadSingle("loadChart"),
  vendorQuotations.submit,
);

// --- acting on a quotation this vendor already filed ---
router.post(
  "/quotations/:quotationId/revisions",
  uploadSingle("loadChart"),
  vendorQuotations.revise,
);
router.post("/quotations/:quotationId/withdraw", vendorQuotations.withdraw);
router.get(
  "/quotations/:quotationId/attachments",
  vendorQuotations.attachments,
);

export default router;

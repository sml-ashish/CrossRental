import { Router } from "express";
import * as enquiry from "../controllers/enquiry.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/enquiries — native enquiry intake and the sourcing workspace (P1).
 *
 * Internal only, like the RFQ router: `enquiry:*` is held by admin and the CR
 * team (`sales_user`) alone. The line paths are declared before `/:enquiryId`
 * so `/lines/...` is never captured as an enquiry id.
 */

router.use(apiLimiter, requireAuth);

// --- lines (static first) ---
router.get(
  "/lines/:lineId/workspace",
  requireCapability("enquiry:view"),
  enquiry.workspace,
);
router.get(
  "/lines/:lineId/recommendations",
  requireCapability("enquiry:view"),
  enquiry.recommendations,
);
router.get(
  "/lines/:lineId/comparison",
  requireCapability("enquiry:view"),
  enquiry.comparison,
);
router.post(
  "/lines/:lineId/recommendations/refresh",
  requireCapability("enquiry:manage"),
  enquiry.refreshRecommendations,
);
router.put("/lines/:lineId", requireCapability("enquiry:manage"), enquiry.updateLine);
router.post(
  "/lines/:lineId/cancel",
  requireCapability("enquiry:manage"),
  enquiry.cancelLine,
);
router.post(
  "/lines/:lineId/internal-check",
  requireCapability("enquiry:manage"),
  enquiry.internalCheck,
);
router.post(
  "/lines/:lineId/under-evaluation",
  requireCapability("enquiry:manage"),
  enquiry.underEvaluation,
);

/** Raising an RFQ from a line is a create action on the RFQ it makes. */
router.post("/lines/:lineId/rfq", requireCapability("rfq:create"), enquiry.createRfq);

// --- list + create ---
router.get("/", requireCapability("enquiry:view"), enquiry.list);
router.post("/", requireCapability("enquiry:create"), enquiry.create);

// --- one enquiry ---
router.get("/:enquiryId", requireCapability("enquiry:view"), enquiry.detail);
/** The sourcing history for the audit viewer (BPD 5.14). */
router.get(
  "/:enquiryId/history",
  requireCapability("enquiry:view"),
  enquiry.history,
);
router.put("/:enquiryId", requireCapability("enquiry:manage"), enquiry.update);
router.post(
  "/:enquiryId/lines",
  requireCapability("enquiry:manage"),
  enquiry.addLine,
);

export default router;

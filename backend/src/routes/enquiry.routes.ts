import { Router } from "express";
import * as enquiry from "../controllers/enquiry.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";
import { uploadSpreadsheet } from "../middleware/upload";

const router = Router();

/**
 * /api/enquiries — native enquiry intake (P1).
 *
 * Internal only, like the RFQ router: `enquiry:*` is held by admin and the CR
 * team (`sales_user`) alone. The line paths are declared before `/:enquiryId`
 * so `/lines/...` is never captured as an enquiry id.
 */

router.use(apiLimiter, requireAuth);

// --- lines (static first) ---
/** Open lines for the RFQ creation picker; declared before `/lines/:lineId`. */
router.get(
  "/lines",
  requireCapability("enquiry:view"),
  enquiry.listRaisableLines,
);
router.get(
  "/lines/:lineId",
  requireCapability("enquiry:view"),
  enquiry.line,
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
/** KPI cards. Declared before `/:enquiryId` so it is not read as an id. */
router.get("/summary", requireCapability("enquiry:view"), enquiry.summary);
router.post("/", requireCapability("enquiry:create"), enquiry.create);

// --- bulk upload (static, before `/:enquiryId`) ---
/**
 * The CR team's `.xlsx` import. Declared before `/:enquiryId` so `/bulk` is
 * never captured as an enquiry id.
 */
router.get(
  "/bulk/template",
  requireCapability("enquiry:create"),
  enquiry.bulkTemplate,
);
router.post(
  "/bulk",
  requireCapability("enquiry:create"),
  uploadSpreadsheet("file"),
  enquiry.bulkImport,
);

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
/**
 * Bulk add lines to this enquiry. The target is the URL, so there is no
 * `Enquiry no` column to mistype; declared after `/:enquiryId/lines` because the
 * paths do not overlap.
 */
router.post(
  "/:enquiryId/lines/bulk",
  requireCapability("enquiry:manage"),
  uploadSpreadsheet("file"),
  enquiry.bulkLines,
);

export default router;

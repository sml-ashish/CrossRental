import { Router } from "express";
import * as rfq from "../controllers/rfq.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/rfqs — internal RFQ creation, dispatch and tracking (brief 7.9).
 *
 * Internal only. There is no `fleet:edit_own` path into this router: a vendor
 * holding only vendor capabilities cannot reach an RFQ operation at all. M5 adds
 * the vendor-facing inbox on a separate surface; the tracking screen in 7.9 is
 * sales' own list, so mixing the two here would mean one router serving two
 * audiences under one set of rules.
 *
 * Guards are per verb rather than one blanket "any rfq capability". The RBAC
 * table already separates creating from dispatching from reminding, and a blanket
 * guard would quietly hand every one of those to whoever holds the weakest of
 * them.
 */

router.use(apiLimiter, requireAuth);

// --- static paths before "/:rfqId" so they are not captured as an id ---
/**
 * Runs the deadline sweep by hand. The automatic sweep is M7 (brief 7.9); the
 * route exists so the expiry rule can be exercised against a running server now
 * instead of only in a unit test.
 */
router.post(
  "/expire-pending",
  requireCapability("rfq:track"),
  rfq.expirePending,
);

/**
 * Approved vendors with an active user — the picker's "everyone else" list.
 * A query about vendors rather than about one RFQ, hence a static path.
 */
router.get(
  "/approved-vendors",
  requireCapability("rfq:track"),
  rfq.approvedVendors,
);

// --- list + create ---
router.get("/", requireCapability("rfq:track"), rfq.list);
router.post("/", requireCapability("rfq:create"), rfq.create);

// --- one RFQ ---
router.get("/:rfqId", requireCapability("rfq:track"), rfq.detail);

/** Editing draft content, including a corrected site pin, is part of creating. */
router.put("/:rfqId", requireCapability("rfq:create"), rfq.update);
router.patch(
  "/:rfqId/site-pin",
  requireCapability("rfq:create"),
  rfq.confirmSitePin,
);

/**
 * Candidate picker (brief 6.9): matching vendor cranes grouped by vendor,
 * nearest first, with located and un-located candidates in separate groups so an
 * un-geocoded crane is never silently dropped.
 */
router.get(
  "/:rfqId/candidates",
  requireCapability("rfq:track"),
  rfq.candidates,
);

// --- actions that change state and/or send mail ---
router.post("/:rfqId/send", requireCapability("rfq:dispatch"), rfq.send);
router.patch(
  "/:rfqId/deadline",
  requireCapability("rfq:extend_deadline"),
  rfq.extendDeadline,
);
router.post("/:rfqId/cancel", requireCapability("rfq:cancel"), rfq.cancel);

/** Manual reminder. The scheduled nudges are M7. */
router.post("/:rfqId/remind", requireCapability("rfq:remind"), rfq.remind);

export default router;

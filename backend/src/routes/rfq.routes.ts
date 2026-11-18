import { Router } from "express";
import * as inbound from "../controllers/inbound.controller";
import * as rfq from "../controllers/rfq.controller";
import * as negotiation from "../controllers/negotiation.controller";
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

/** Everything that has happened to this RFQ, shown inline as its audit trail. */
router.get("/:rfqId/audit", requireCapability("rfq:track"), rfq.audit);

/**
 * Replies belonging to this RFQ, shown where the conversation lives. Validation
 * stays in the admin reply queue so sales can read the conversation without a
 * second conversion surface.
 */
router.get(
  "/:rfqId/replies",
  requireCapability("rfq:track"),
  inbound.listForRfq,
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

/**
 * Award (brief 6.7, M7; P3 makes it the CR path from comparison).
 *
 * `quotation:award` is held by admin and — since P3 — `sales_user`, so the
 * capability check here admits the CR team; vendors are still refused. The
 * service re-checks the role, because a route mounted too loosely later must
 * not widen this: award books a crane and emails every vendor on the RFQ, so it
 * is the one action worth gating twice.
 */
router.post(
  "/:rfqId/quotations/:quotationId/award",
  requireCapability("quotation:award"),
  rfq.award,
);

/**
 * Mark a quotation Under Review / Shortlisted / Rejected (P3, BPD 6.15).
 *
 * `quotation:review` is held by both internal roles; a vendor cannot reach it.
 * The award is a separate route on purpose — a mark is a working note, the award
 * is the commitment, and only the award path may reach Selected/Not Awarded.
 */
router.post(
  "/:rfqId/quotations/:quotationId/mark",
  requireCapability("quotation:review"),
  rfq.mark,
);

// --- counter-quote / negotiation (phase 1 + 2) ------------------------------
// Guarded by `quotation:counter` (held by sales and admin). The service
// re-checks the role and, for vendor-scoped reads, the ownership.

router.get(
  "/:rfqId/negotiations",
  requireCapability("quotation:counter"),
  negotiation.listForRfq,
);
router.post(
  "/:rfqId/quotations/:quotationId/counter/preview",
  requireCapability("quotation:counter"),
  negotiation.previewCounter,
);
router.post(
  "/:rfqId/quotations/:quotationId/counter",
  requireCapability("quotation:counter"),
  negotiation.counter,
);
router.post(
  "/:rfqId/negotiations/:id/accept",
  requireCapability("quotation:counter"),
  negotiation.accept,
);
router.post(
  "/:rfqId/negotiations/:id/reject",
  requireCapability("quotation:counter"),
  negotiation.reject,
);
router.post(
  "/:rfqId/negotiations/:id/log-vendor-offer",
  requireCapability("quotation:counter"),
  negotiation.logVendorOffer,
);

export default router;

import { Router } from "express";
import * as negotiation from "../controllers/negotiation.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/vendor/negotiations — a vendor acting on a counter-offer thread.
 *
 * Kept on a surface of its own (rather than under /api/vendor/rfqs) so the
 * thread-id routes are not ambiguous with an RFQ id, and so the vendor capability
 * guard is the only gate: ownership is re-checked inside the service for every
 * id, making another vendor's thread a 404 rather than a 403.
 */
router.use(apiLimiter, requireAuth, requireCapability("rfq:respond"));

router.get("/:id", negotiation.vendorGet);
router.post("/:id/preview", negotiation.vendorPreviewCounter);
router.post("/:id/counter", negotiation.vendorCounter);
router.post("/:id/accept", negotiation.vendorAccept);
router.post("/:id/decline", negotiation.vendorDecline);

export default router;

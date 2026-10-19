import { Router } from "express";
import * as vendor from "../controllers/vendorDashboard.controller";
import { requireAuth } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/vendor/dashboard — the vendor's own dashboard (brief 7.5, M7).
 *
 * A vendor-only surface that hangs off the same `/api/vendor` prefix as the
 * quotation inbox, for the same reason as M5's split: internal users have no
 * dashboard here and no route that accidentally reads one, and every handler
 * re-checks the role inside the service so a route mounted loosely later still
 * cannot serve the count of somebody else's fleet.
 */
router.use(apiLimiter, requireAuth);

router.get("/", vendor.dashboard);

export default router;

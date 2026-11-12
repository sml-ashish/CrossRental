import { Router } from "express";
import * as discovery from "../controllers/discovery.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/discovery — manual vendor discovery (BPD 6.8 / 5.9).
 *
 * Internal only: `fleet:view_all` is held by admin and the CR team, and the
 * service re-checks the role on every call. A vendor already reads their own
 * fleet through /api/cranes; discovery is SML's view across every vendor.
 */

router.use(apiLimiter, requireAuth);

router.get("/cranes", requireCapability("fleet:view_all"), discovery.search);
router.get("/calendar", requireCapability("fleet:view_all"), discovery.calendar);
router.get("/facets", requireCapability("fleet:view_all"), discovery.facets);

export default router;

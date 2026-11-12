import { Router } from "express";
import * as dashboard from "../controllers/dashboard.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/management — the read-only Management Viewer surface (P5).
 *
 * The role holds `reports:view_all` and nothing else, so this is the only
 * dashboard it can reach. Admin also holds the capability and may read it.
 */
router.use(apiLimiter, requireAuth, requireCapability("reports:view_all"));

router.get("/dashboard", dashboard.management);

export default router;

import { Router } from "express";
import * as report from "../controllers/report.controller";
import { requireAnyCapability, requireAuth } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/reports — P5 management reports (BPD 5.15 / 6.23).
 *
 * Reads only. Sales hold `reports:view` and are narrowed to their own
 * enquiries; admin and management hold `reports:view_all`.
 */
router.use(apiLimiter, requireAuth);

router.get(
  "/",
  requireAnyCapability("reports:view", "reports:view_all"),
  report.index,
);

export default router;

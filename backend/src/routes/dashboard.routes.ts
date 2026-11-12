import { Router } from "express";
import * as dashboard from "../controllers/dashboard.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

router.use(apiLimiter, requireAuth);

/** The CR team's operational dashboard. Admin holds `enquiry:view` too. */
router.get("/sales", requireCapability("enquiry:view"), dashboard.sales);

export default router;

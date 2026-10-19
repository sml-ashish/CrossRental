import { Router } from "express";
import * as communication from "../controllers/communication.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/communications — communication history (BPD 6.21).
 *
 * Internal only. `enquiry:view` is held by admin and the CR team; the service
 * re-checks the role, and vendors hold neither capability nor any route here.
 */

router.use(apiLimiter, requireAuth);

router.get("/", requireCapability("enquiry:view"), communication.list);

export default router;

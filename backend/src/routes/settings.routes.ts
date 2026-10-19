import { Router } from "express";
import * as settings from "../controllers/settings.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/settings — SML-side configuration (brief 6.4 / phase A).
 *
 * Admin-only on both ends: changing the day basis changes how every
 * quotation total is worked out thereafter, and reading it is a
 * sales question the RFQ form answers with hints instead.
 */
router.use(apiLimiter, requireAuth);

router.get("/", requireCapability("vendor:approve"), settings.show);
router.patch("/", requireCapability("vendor:approve"), settings.update);

// SAP office-use master lists (phase D3): admin-editable, admin-readable.
router.get("/master-lists", requireCapability("vendor:approve"), settings.showMasterLists);
router.put("/master-lists/:name", requireCapability("vendor:approve"), settings.updateMasterList);

export default router;

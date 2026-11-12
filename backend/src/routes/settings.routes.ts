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

// P5 admin configuration: per-km assumptions, email wording and region mapping.
router.get(
  "/mobilisation-rates",
  requireCapability("vendor:approve"),
  settings.showMobilisationRates,
);
router.post(
  "/mobilisation-rates",
  requireCapability("vendor:approve"),
  settings.createRate,
);
router.patch(
  "/mobilisation-rates/:id",
  requireCapability("vendor:approve"),
  settings.updateRate,
);

router.get(
  "/email-templates",
  requireCapability("vendor:approve"),
  settings.showEmailTemplates,
);
router.put(
  "/email-templates/:key",
  requireCapability("vendor:approve"),
  settings.updateTemplate,
);

router.get("/states", requireCapability("vendor:approve"), settings.showStateRegions);
router.patch("/states/:code", requireCapability("vendor:approve"), settings.updateState);

export default router;

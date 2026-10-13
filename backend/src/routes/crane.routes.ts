import { Router } from "express";
import * as crane from "../controllers/crane.controller";
import { requireAuth, requireAnyCapability, requireCapability } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/cranes — fleet management (brief 7.4).
 *
 * Requires authentication on every route. Beyond that the split is by
 * capability, not by role:
 *
 * - fleet:edit_own  vendor — CRUD on their own cranes.
 * - fleet:view_all  admin + sales — read any approved vendor's fleet, which is
 *   what M4's candidate picker and M6's location views will read. They cannot
 *   write: sales creates RFQs, it does not maintain fleets.
 *
 * The `fleet:view_all` routes are the only ones not scoped to the caller's own
 * vendor, and `loadScoped` in the service still refuses a row belonging to a
 * vendor who is not Approved.
 */

router.use(apiLimiter, requireAuth);

/**
 * Reads accept either capability: a vendor reading their own fleet, or an
 * internal user reading an approved vendor's (fleet:view_all). Everything that
 * writes is fleet:edit_own only — sales builds RFQs, it does not maintain
 * fleets.
 */
const canReadFleet = requireAnyCapability("fleet:edit_own", "fleet:view_all");

// --- reads ---
router.get("/", canReadFleet, crane.list);
router.get("/:craneId", canReadFleet, crane.detail);

// --- the vendor's own fleet: writes ---
router.post("/", requireCapability("fleet:edit_own"), crane.create);
router.put("/:craneId", requireCapability("fleet:edit_own"), crane.update);

/** Quick actions from brief 7.4. */
router.patch("/:craneId/status-location", requireCapability("fleet:edit_own"), crane.quickUpdate);
router.get("/:craneId/duplicate", requireCapability("fleet:edit_own"), crane.duplicatePrefill);
router.post("/:craneId/confirm-accurate", requireCapability("fleet:edit_own"), crane.confirmAccurate);

// Soft delete, never a hard delete (brief 7.4).
router.post("/:craneId/deactivate", requireCapability("fleet:edit_own"), crane.deactivate);
router.post("/:craneId/reactivate", requireCapability("fleet:edit_own"), crane.reactivate);

// Load chart (brief 5.2).
router.post(
  "/:craneId/load-chart",
  requireCapability("fleet:edit_own"),
  uploadSingle("file"),
  crane.uploadChart,
);
router.get("/:craneId/load-chart", requireCapability("fleet:edit_own"), crane.downloadChart);

// --- internal read + fleet approval (brief 6.4) ---
router.patch("/:craneId/approval", requireCapability("vendor:approve"), crane.setApproval);

export default router;
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

/**
 * Brief D1: a vendor writes their own fleet (`fleet:edit_own`); an SML user
 * writes any approved vendor's (`fleet:edit_all`). The service marks the latter
 * "on behalf of" and emails the vendor.
 */
const canWriteFleet = requireAnyCapability("fleet:edit_own", "fleet:edit_all");

// --- reads ---
router.get("/", canReadFleet, crane.list);
router.get("/:craneId", canReadFleet, crane.detail);
/** BPD 6.11 crane detail: calendar, maintenance flags and transport cost. */
router.get("/:craneId/profile", requireCapability("fleet:view_all"), crane.profile);

// --- the vendor's own fleet, or any vendor's on their behalf ---
router.post("/", canWriteFleet, crane.create);
router.put("/:craneId", canWriteFleet, crane.update);

/** Quick actions from brief 7.4. */
router.patch("/:craneId/status-location", canWriteFleet, crane.quickUpdate);
router.get("/:craneId/duplicate", canReadFleet, crane.duplicatePrefill);
router.post("/:craneId/confirm-accurate", canWriteFleet, crane.confirmAccurate);

// Soft delete, never a hard delete (brief 7.4).
router.post("/:craneId/deactivate", canWriteFleet, crane.deactivate);
router.post("/:craneId/reactivate", canWriteFleet, crane.reactivate);

// Load chart (brief 5.2).
router.post(
  "/:craneId/load-chart",
  canWriteFleet,
  uploadSingle("file"),
  crane.uploadChart,
);
router.get("/:craneId/load-chart", canReadFleet, crane.downloadChart);

// --- internal read + fleet approval (brief 6.4) ---
router.patch("/:craneId/approval", requireCapability("vendor:approve"), crane.setApproval);

export default router;
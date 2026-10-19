import { Router } from "express";
import * as admin from "../controllers/admin.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/admin — the internal administration surface (P0 B).
 *
 * `vendor:approve` is the admin gate used across the SML-only screens (settings,
 * reservations, SAP sheet); it is held by `admin_user` and not by `sales_user`,
 * so configuration and staff management stay with admins.
 */
router.use(apiLimiter, requireAuth, requireCapability("vendor:approve"));

router.get("/dashboard", admin.dashboard);

router.get("/users", admin.listUsers);
router.post("/users", admin.createUser);
router.patch("/users/:id", admin.updateUser);
router.post("/users/:id/reset-credentials", admin.resetCredentials);

router.post("/vendors/:id/suspend", admin.suspend);
router.post("/vendors/:id/reinstate", admin.reinstate);

export default router;

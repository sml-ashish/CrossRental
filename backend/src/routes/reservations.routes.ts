import { Router } from "express";
import * as reservations from "../controllers/reservations.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/reservations — the dated commitments a crane carries (brief 5.3 / 6.1).
 *
 * SML-side only, and there is deliberately no vendor route: vendors see the
 * Booked/Hired badge a reservation implies on their own crane list, but the
 * reservation itself is SML's record of who has the crane when. Reading is
 * `rfq:track` (sales and admin both track commitments); blocking and releasing
 * are `vendor:approve` (admin-only), because releasing a crane frees it for
 * another contract.
 */
router.use(apiLimiter, requireAuth);

router.get("/", requireCapability("rfq:track"), reservations.index);
router.get("/calendar", requireCapability("rfq:track"), reservations.calendar);
router.post("/", requireCapability("vendor:approve"), reservations.create);
router.post(
  "/:reservationId/release",
  requireCapability("vendor:approve"),
  reservations.release,
);
router.post(
  "/complete-overdue",
  requireCapability("vendor:approve"),
  reservations.completeOverdue,
);

export default router;

import { Router } from "express";
import * as onboarding from "../controllers/onboarding.controller";
import { requireAuth, requireCapability } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";
import { apiLimiter } from "../middleware/rateLimiter";

const router = Router();

/**
 * /api/onboarding
 *
 * Two audiences share one set of handlers:
 *
 * - `/invitation/:token/*` is reached from the emailed link with no account.
 *   The token is the credential and is re-checked on every call. These routes
 *   deliberately sit behind no auth middleware.
 * - The bare routes are for an activated vendor using their login, resolved
 *   from the JWT.
 *
 * Everything here is rate limited: `apiLimiter` is already applied to all of
 * `/api` in index.ts, and the write paths get it again explicitly so that
 * adding this router elsewhere cannot accidentally leave them unmetered.
 */

// --- token scope (no account) ---
router.get("/document-types", apiLimiter, onboarding.getDocumentTypes);
router.get("/reference-data", apiLimiter, onboarding.getReferenceData);
router.get("/invitation/:token", apiLimiter, onboarding.getOnboarding);
router.put("/invitation/:token", apiLimiter, onboarding.saveOnboardingDraft);
router.post("/invitation/:token/submit", apiLimiter, onboarding.submitOnboarding);
router.post(
  "/invitation/:token/documents/:docType",
  apiLimiter,
  uploadSingle("file"),
  onboarding.uploadDocument,
);
router.get("/invitation/:token/documents/:docType", apiLimiter, onboarding.downloadDocument);

// --- account scope (activated vendor) ---
router.get("/", apiLimiter, requireAuth, requireCapability("fleet:edit_own"), onboarding.getOnboarding);
router.put("/", apiLimiter, requireAuth, requireCapability("fleet:edit_own"), onboarding.saveOnboardingDraft);
router.post("/submit", apiLimiter, requireAuth, requireCapability("fleet:edit_own"), onboarding.submitOnboarding);
router.post(
  "/documents/:docType",
  apiLimiter,
  requireAuth,
  requireCapability("fleet:edit_own"),
  uploadSingle("file"),
  onboarding.uploadDocument,
);
router.get(
  "/documents/:docType",
  apiLimiter,
  requireAuth,
  requireCapability("fleet:edit_own"),
  onboarding.downloadDocument,
);

export default router;
import { Router } from "express";
import * as vendor from "../controllers/vendor.controller";
import * as approval from "../controllers/approval.controller";
import * as reservations from "../controllers/reservations.controller";
import { requireAuth, requireCapability, requireRole } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";
import { uploadSpreadsheet } from "../middleware/upload";

const router = Router();

/**
 * /api/vendors
 *
 * M1 shipped only the caller's own record. M2 adds the internal onboarding
 * screens: the approval queue, the detail view behind a decision, the decision
 * endpoints themselves, and invitations.
 *
 * Authorisation is per route rather than blanket `requireInternalUser`, because
 * the capabilities differ:
 *
 * - vendor:invite    admin + sales — may send a registration link.
 * - vendor:view_all  admin + sales — may list and read registrations.
 * - vendor:view_bank admin only       — the detail endpoint's decrypted bank
 *   block and the document downloads, since these files include cancelled
 *   cheques. `vendorDetail` re-checks this internally so the rule holds even if
 *   a route is mounted too loosely later.
 * - vendor:approve   admin only       — approve and reject.
 *
 * Every route also requires auth, so these are unreachable with only a
 * capability name.
 */

// --- the vendor's own record ---
router.get("/me", apiLimiter, requireAuth, vendor.getMyVendor);
/**
 * The vendor's own booking calendar (BPD 6.17). Scoped by the token inside the
 * service, so `?vendorId=` cannot widen it. Declared before "/:vendorId".
 */
router.get(
  "/me/booking-calendar",
  apiLimiter,
  requireAuth,
  requireRole("vendor_user"),
  reservations.vendorCalendar,
);
router.get("/reference-data", apiLimiter, requireAuth, vendor.getReferenceData);

// --- invitations (admin + sales) ---
// Declared before "/:vendorId" so "invitations" is never read as an id.
router.post(
  "/invitations",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:invite"),
  approval.createInvitation,
);
router.get(
  "/invitations",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:view_all"),
  approval.listInvitations,
);

// Bulk invitations: the template, then the preview/import of an .xlsx sheet.
// Same capability as inviting one vendor, so a sales user cannot gain reach
// through the file that they do not have through the form.
router.get(
  "/invitations/bulk/template",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:invite"),
  approval.bulkInviteTemplate,
);
router.post(
  "/invitations/bulk",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:invite"),
  uploadSpreadsheet("file"),
  approval.bulkImportInvitations,
);

// --- queue and detail (admin + sales; bank fields admin-only) ---
router.get("/", apiLimiter, requireAuth, requireCapability("vendor:view_all"), approval.listVendors);
router.get(
  "/:vendorId",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:view_all"),
  approval.vendorDetail,
);
/** BPD 6.10 discovery view: fleet, categories and participation (no bank). */
router.get(
  "/:vendorId/profile",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:view_all"),
  vendor.insight,
);
router.get(
  "/:vendorId/documents/:docType",
  apiLimiter,
  requireAuth,
  approval.downloadDocument,
);

// --- SAP vendor creation sheet (admin only; brief D3) ---
// Declared before "/:vendorId/approve" purely for readability; the paths do not
// overlap. Both are gated admin-only because the sheet includes bank details.
router.get(
  "/:vendorId/sap-sheet",
  apiLimiter,
  requireAuth,
  approval.sapSheet,
);
router.get(
  "/:vendorId/sap-sheet.xls",
  apiLimiter,
  requireAuth,
  approval.exportSapSheet,
);

// --- decisions (admin only) ---
router.post(
  "/:vendorId/approve",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:approve"),
  approval.approve,
);
router.post(
  "/:vendorId/reject",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:approve"),
  approval.reject,
);
router.post(
  "/:vendorId/resend-activation",
  apiLimiter,
  requireAuth,
  requireCapability("vendor:approve"),
  approval.resendActivationEmail,
);

export default router;
import { Request, Response } from "express";
import { prisma } from "../lib/database";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { maskAccountNumber } from "../utils/crypto";
import { vendorInsights } from "../services/vendorInsights.service";
import type { Actor } from "../services/crane.service";

function actorOf(req: Request): Actor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return { id: user.id, email: user.email, role: user.role, vendorId: user.vendorId };
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.badRequest(`Missing ${key}`);
  }
  return value.trim();
}

/**
 * Vendor-facing read of the caller's own vendor record.
 *
 * This is the only vendor endpoint in M1. It exists because access isolation
 * has to be provable from M1 onwards, and it is also where the bank-detail
 * masking rule (brief 6.6) is enforced: `bankAccountNoEnc` and `bankIfscEnc`
 * are never selected at all, and a vendor receives a mask built from the
 * clear-text last4. Admin users receive the decrypted values and nobody else
 * does.
 */

export const getMyVendor = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  if (user.role !== "vendor_user" || !user.vendorId) {
    throw AppError.forbidden("This endpoint is for vendor users");
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id: user.vendorId },
    select: {
      id: true,
      sapVendorCode: true,
      name: true,
      natureOfCompany: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      district: true,
      stateCode: true,
      pincode: true,
      telephone: true,
      fax: true,
      email: true,
      weeklyOffDays: true,
      pan: true,
      tan: true,
      gstRegistered: true,
      gstn: true,
      gstRegistrationType: true,
      gstr1FilingFrequency: true,
      cin: true,
      govtRegistrationType: true,
      govtRegistrationNo: true,
      msmeRegistered: true,
      msmeCategory: true,
      msmeRegNo: true,
      msmeExemptionDate: true,
      tdsLowerDeduction: true,
      tdsCertificateNo: true,
      tdsSection: true,
      tdsRatePercent: true,
      tdsValidFrom: true,
      tdsValidTo: true,
      fleetSummary: true,
      onboardingStatus: true,
      adminRemarks: true,
      approvedAt: true,
      totalFleetSize: true,
      // Encrypted columns are deliberately absent from this select.
      bankName: true,
      bankBranch: true,
      bankAccountType: true,
      bankAccountHolderName: true,
      bankAccountNoLast4: true,
      bankMicr: true,
      bankIban: true,
      bankSwift: true,
      communicationNotes: true,
      operatingRegions: { select: { stateCode: true } },
      contacts: {
        select: {
          id: true,
          name: true,
          mobile: true,
          telephone: true,
          email: true,
          isPrimary: true,
          receivesRfqs: true,
        },
        orderBy: { isPrimary: "desc" },
      },
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!vendor) throw AppError.notFound("Vendor record not found");

  res.json({
    vendor: {
      ...vendor,
      operatingRegions: vendor.operatingRegions.map((r) => r.stateCode),
      // Never the real number for a vendor. Brief 6.6: masked in the UI,
      // full only to admins.
      bankAccountNo: vendor.bankAccountNoLast4
        ? maskAccountNumber(vendor.bankAccountNoLast4)
        : null,
      bankIfsc: "hidden",
      bankMasked: true,
    },
  });
});

/**
 * BPD 6.10 discovery view of a vendor: fleet, categories and participation.
 * Additive to the approval detail, which keeps the registration form and the
 * admin-only bank block; this endpoint never selects bank columns.
 */
export const insight = asyncHandler(async (req: Request, res: Response) => {
  res.json({ profile: await vendorInsights(actorOf(req), param(req, "vendorId")) });
});

/** Reference data the onboarding and fleet forms need. */
export const getReferenceData = asyncHandler(async (_req: Request, res: Response) => {
  const [states, craneTypes] = await Promise.all([
    prisma.state.findMany({ orderBy: { name: "asc" }, select: { code: true, name: true } }),
    prisma.craneType.findMany({ orderBy: { sortOrder: "asc" }, select: { code: true, name: true } }),
  ]);
  res.json({ states, craneTypes });
});
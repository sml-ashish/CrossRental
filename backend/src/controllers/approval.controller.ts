import { Request, Response } from "express";
import { prisma } from "../lib/database";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import { AuthedRequest } from "../middleware/auth";
import { can } from "../utils/rbac";
import { decryptField } from "../utils/crypto";
import {
  inviteVendor,
  REQUIRED_DOCUMENT_LABELS,
  requiredDocumentsFor,
} from "../services/onboarding.service";
import { approveVendor, rejectVendor, resendActivation } from "../services/approval.service";
import { buildSapSheet, renderSapSheetXls } from "../services/sapSheet.service";
import { readOnboardingDocument } from "../services/documents.service";
import type { OfficeUseReview } from "../services/approval.service";

/**
 * Admin and sales onboarding screens (brief 7.3).
 *
 * The rule that shapes this file is brief 6.6: bank details are admin-only.
 * `vendor:view_bank` is checked in exactly one place — `vendorDetail` — which
 * is also the only place the encrypted bank columns are decrypted. Sales users
 * get the same page with the bank block omitted rather than masked, so the
 * value is never loaded into the response at all.
 */

function actorOf(req: Request): AuthedRequest["user"] {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return user;
}

/**
 * Reads the office-use review block off the request body, ignoring blanks.
 *
 * Accepts it either nested under `officeUse` (how the admin screen groups the
 * fields, matching brief 7.3's "office-use review" block) or flat on the body,
 * so a caller does not silently lose the review by getting the nesting wrong.
 */
function officeUseFrom(body: unknown): OfficeUseReview {
  const outer = (body ?? {}) as Record<string, unknown>;
  const source = (
    typeof outer["officeUse"] === "object" && outer["officeUse"] !== null
      ? (outer["officeUse"] as Record<string, unknown>)
      : outer
  );
  const pick = (key: string): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  return {
    facilityStatus: pick("facilityStatus") as OfficeUseReview["facilityStatus"],
    manpowerStatus: pick("manpowerStatus") as OfficeUseReview["manpowerStatus"],
    improvementRequirement: pick("improvementRequirement"),
    improvementPeriod: pick("improvementPeriod"),
    vendorOrigin: pick("vendorOrigin"),
    vendorType: pick("vendorType"),
    purchaseOrg: pick("purchaseOrg"),
    paymentTerm: pick("paymentTerm"),
    withholdingTaxType: pick("withholdingTaxType"),
    legalForm: pick("legalForm"),
  };
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.badRequest(`Missing ${key}`);
  }
  return value.trim();
}

// --- invitations ------------------------------------------------------------

export const createInvitation = asyncHandler(async (req: Request, res: Response) => {
  const result = await inviteVendor(req.body, actorOf(req));
  res.status(201).json(result);
});

/**
 * Invitation list for the queue screen.
 *
 * The raw token is never returned — only its hash is stored, so the link cannot
 * be re-shown later. An admin who needs a fresh link sends a new invitation.
 */
export const listInvitations = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const vendorId = typeof query.vendorId === "string" ? query.vendorId : undefined;

  const invitations = await prisma.vendorInvitation.findMany({
    where: {
      ...(vendorId ? { vendorId } : {}),
      ...(query.status === "ACTIVE" ? { revokedAt: null, submittedAt: null } : {}),
      ...(query.status === "SUBMITTED" ? { submittedAt: { not: null } } : {}),
      ...(query.status === "REVOKED" ? { revokedAt: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      email: true,
      companyName: true,
      contactName: true,
      expiresAt: true,
      submittedAt: true,
      revokedAt: true,
      createdAt: true,
      vendor: { select: { id: true, name: true, onboardingStatus: true } },
    },
  });

  res.json({ invitations });
});

// --- queue and detail -------------------------------------------------------

/**
 * The approval queue (brief 7.3: "a list of submitted vendors with filters").
 *
 * Defaults to SUBMITTED because that is the queue an admin opens to work
 * through. Search matches company name, email, PAN or SAP code.
 */
export const listVendors = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  const query = req.query as Record<string, string | undefined>;

  const status = typeof query.status === "string" && query.status !== "" ? query.status : "SUBMITTED";
  const search = typeof query.search === "string" ? query.search.trim() : "";

  const vendors = await prisma.vendor.findMany({
    where: {
      ...(status !== "ALL" ? { onboardingStatus: status as never } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { pan: { contains: search.toUpperCase(), mode: "insensitive" } },
              { sapVendorCode: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ onboardingStatus: "asc" }, { updatedAt: "desc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      email: true,
      pan: true,
      gstn: true,
      sapVendorCode: true,
      onboardingStatus: true,
      adminRemarks: true,
      approvedAt: true,
      totalFleetSize: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      district: true,
      stateCode: true,
      pincode: true,
      operatingRegions: { select: { stateCode: true } },
      updatedAt: true,
      // Bank columns are deliberately absent: this list is readable by sales.
      contacts: {
        where: { isPrimary: true },
        select: { name: true, email: true, mobile: true },
        take: 1,
      },
      documents: { select: { docType: true } },
    },
  });

  const canSeeBank = can(user.role, "vendor:view_bank");

  res.json({
    vendors: vendors.map((v) => ({
      ...v,
      operatingRegions: v.operatingRegions.map((r) => r.stateCode),
      // Sales gets a flag instead of the values; admins get them in the detail
      // endpoint, never in this list.
      bankVisible: canSeeBank,
    })),
    counts: await statusCounts(),
  });
});

async function statusCounts() {
  const grouped = await prisma.vendor.groupBy({
    by: ["onboardingStatus"],
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    DRAFT: 0,
    SUBMITTED: 0,
    APPROVED: 0,
    REJECTED: 0,
  };
  for (const row of grouped) counts[row.onboardingStatus] = row._count._all;
  return counts;
}

/**
 * The detail screen behind an approval decision: the whole submitted form, the
 * uploaded documents, the decision history, and — for admins only — the
 * decrypted bank block.
 */
export const vendorDetail = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  const vendorId = param(req, "vendorId");
  const canSeeBank = can(user.role, "vendor:view_bank");

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
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
      addressState: { select: { name: true } },
      pincode: true,
      telephone: true,
      fax: true,
      email: true,
      weeklyOffDays: true,
      companySize: true,
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
      codeOfConductAccepted: true,
      declarationName: true,
      declarationDesignation: true,
      declarationDate: true,
      bankMicr: true,
      bankIban: true,
      bankSwift: true,
      communicationNotes: true,
      onboardingStatus: true,
      adminRemarks: true,
      approvedAt: true,
      facilityStatus: true,
      manpowerStatus: true,
      improvementRequirement: true,
      improvementPeriod: true,
      vendorOrigin: true,
      vendorType: true,
      purchaseOrg: true,
      paymentTerm: true,
      withholdingTaxType: true,
      legalForm: true,
      totalFleetSize: true,
      // P0 B2: the detail screen shows suspension state and its reason.
      suspendedAt: true,
      suspendReason: true,
      createdAt: true,
      updatedAt: true,
      // Encrypted bank columns. Prisma cannot narrow a select on a runtime
      // condition, so they are always selected here and stripped from the
      // response below unless the caller has vendor:view_bank. They never
      // reach a sales user's payload.
      bankAccountNoEnc: true,
      bankIfscEnc: true,
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
      documents: {
        select: { id: true, docType: true, fileName: true, sizeBytes: true, uploadedAt: true },
        orderBy: { uploadedAt: "desc" },
      },
      decisions: {
        select: {
          id: true,
          outcome: true,
          remarks: true,
          createdAt: true,
          decidedBy: { select: { fullName: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      users: {
        select: { id: true, email: true, fullName: true, activatedAt: true },
      },
      approvedBy: { select: { id: true, fullName: true, email: true } },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");

  const uploaded = new Set<string>(vendor.documents.map((d) => d.docType));
  const { bankAccountNoEnc, bankIfscEnc, ...rest } = vendor;

  res.json({
    vendor: {
      ...rest,
      operatingRegions: vendor.operatingRegions.map((r) => r.stateCode),
      documents: vendor.documents.map((d) => ({
        ...d,
        label: REQUIRED_DOCUMENT_LABELS[d.docType] ?? d.docType,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      decisions: vendor.decisions.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
      // Decrypted here and nowhere else. For a sales user the encrypted columns
      // above are dropped by the destructure and `bankVisible` is false, so the
      // account number never leaves the server.
      ...(canSeeBank
        ? {
            bankAccountNo: bankAccountNoEnc ? decryptField(bankAccountNoEnc) : null,
            bankIfsc: bankIfscEnc ? decryptField(bankIfscEnc) : null,
            bankVisible: true,
          }
        : { bankVisible: false }),
    },
    missingDocuments: requiredDocumentsFor(vendor.gstRegistered === true).filter((d) => !uploaded.has(d)),
    canApprove: can(user.role, "vendor:approve"),
  });
});

// --- decisions --------------------------------------------------------------

export const approve = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const result = await approveVendor(
    {
      vendorId: param(req, "vendorId"),
      sapVendorCode: typeof body.sapVendorCode === "string" ? body.sapVendorCode : null,
      adminRemarks: typeof body.adminRemarks === "string" ? body.adminRemarks : null,
      officeUse: officeUseFrom(body),
    },
    user,
  );

  res.json(result);
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const result = await rejectVendor(
    {
      vendorId: param(req, "vendorId"),
      remarks: typeof body.remarks === "string" ? body.remarks : "",
      officeUse: officeUseFrom(body),
    },
    user,
  );

  res.json(result);
});

export const resendActivationEmail = asyncHandler(async (req: Request, res: Response) => {
  const result = await resendActivation(param(req, "vendorId"), actorOf(req));
  res.json(result);
});

/**
 * The SAP vendor creation sheet (brief D3), admin only. It includes the
 * decrypted bank block, so it is gated exactly like the detail screen's bank
 * section rather than merely by "internal".
 */
export const sapSheet = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  if (!can(user.role, "vendor:view_bank")) {
    throw AppError.forbidden("The SAP creation sheet is restricted to administrators");
  }
  res.json({ sheet: await buildSapSheet(param(req, "vendorId")) });
});

export const exportSapSheet = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  if (!can(user.role, "vendor:view_bank")) {
    throw AppError.forbidden("The SAP creation sheet is restricted to administrators");
  }
  const file = await renderSapSheetXls(param(req, "vendorId"));
  res.setHeader("Content-Type", "application/vnd.ms-excel");
  res.setHeader("Content-Length", String(Buffer.byteLength(file.body)));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.fileName.replace(/"/g, "")}"`,
  );
  // The brief is explicit: this export is not logged. No audit row, no email.
  res.send(file.body);
});

/**
 * Downloads an uploaded registration document. Restricted to
 * `vendor:view_bank` because these files include cancelled cheques and bank
 * letters.
 */
export const downloadDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = actorOf(req);
  if (!can(user.role, "vendor:view_bank")) {
    throw AppError.forbidden("Registration documents are restricted to administrators");
  }

  const file = await readOnboardingDocument({
    vendorId: param(req, "vendorId"),
    docType: param(req, "docType"),
  });

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.buffer.length));
  res.setHeader("Content-Disposition", `attachment; filename="${file.fileName.replace(/"/g, "")}"`);
  res.send(file.buffer);
});
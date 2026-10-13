import { prisma } from "../lib/database";
import { storage } from "../lib/storage";
import { AppError } from "../middleware/errorHandler";
import { REQUIRED_DOCUMENT_LABELS } from "./onboarding.service";
import type { DocumentType } from "../generated/prisma/client";

/**
 * Onboarding document uploads (brief 7.2: cancelled cheque, GST certificate,
 * PAN copy).
 *
 * Two invariants matter here:
 *
 * 1. Only the three document types the form defines can be stored. `docType`
 *    comes from the URL, so it is validated against an allow-list before it
 *    reaches a Prisma enum cast.
 *
 * 2. A replaced document deletes its predecessor. `vendor_documents` has no
 *    unique constraint on (vendorId, docType), so without this the required-
 *    document check would still pass but an admin reviewing the file list would
 *    see three superseded PAN copies and no way to tell which is current.
 */

const UPLOADABLE = new Set<string>(["CANCELLED_CHEQUE", "GST_CERTIFICATE", "PAN_COPY", "OTHER"]);

function assertDocType(value: string): DocumentType {
  if (!UPLOADABLE.has(value)) {
    throw AppError.badRequest("That document type is not part of the registration form.");
  }
  return value as DocumentType;
}

export interface UploadedDocument {
  docType: string;
  fileName: string;
  uploadedAt: string;
}

/**
 * Stores one onboarding document for a vendor, replacing any earlier file of
 * the same type. Returns the new row's details.
 */
export async function uploadOnboardingDocument(params: {
  vendorId: string;
  docType: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  uploadedBy?: string | null;
}): Promise<UploadedDocument> {
  const docType = assertDocType(params.docType);

  // Uploading before the first save would create a document row with no vendor
  // to hang off, so the controller resolves the vendor first and refuses.
  const vendor = await prisma.vendor.findUnique({
    where: { id: params.vendorId },
    select: { id: true, onboardingStatus: true },
  });
  if (!vendor) throw AppError.notFound("Vendor not found");

  if (vendor.onboardingStatus === "APPROVED") {
    throw AppError.conflict(
      "This registration is approved and can no longer be edited. Contact your SML contact to correct a document.",
    );
  }

  const stored = await storage().save(params.buffer, {
    fileName: params.fileName,
    mimeType: params.mimeType,
    scope: `vendors/${params.vendorId}/onboarding`,
  });

  const previous = await prisma.vendorDocument.findMany({
    where: { vendorId: params.vendorId, docType },
    select: { id: true, fileRef: true },
  });

  const row = await prisma.vendorDocument.create({
    data: {
      vendorId: params.vendorId,
      docType,
      fileRef: stored.fileRef,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      uploadedBy: params.uploadedBy ?? null,
    },
    select: { docType: true, fileName: true, uploadedAt: true },
  });

  // Only after the new row exists do the old ones go, so a failed replace
  // leaves the vendor with the document they last uploaded.
  for (const old of previous) {
    await prisma.vendorDocument.delete({ where: { id: old.id } }).catch(() => undefined);
    await storage().remove(old.fileRef);
  }

  return {
    docType: row.docType,
    fileName: row.fileName,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

/**
 * Reads a stored document for download. `fileRef` never comes from the
 * request, so this cannot be pointed at another vendor's file; ownership was
 * already proven by the caller scoping `vendorId`.
 */
export async function readOnboardingDocument(params: {
  vendorId: string;
  docType: string;
}): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
  const docType = assertDocType(params.docType);

  const doc = await prisma.vendorDocument.findFirst({
    where: { vendorId: params.vendorId, docType },
    orderBy: { uploadedAt: "desc" },
    select: { fileRef: true, fileName: true, mimeType: true },
  });

  if (!doc) {
    throw AppError.notFound(
      `No ${REQUIRED_DOCUMENT_LABELS[docType] ?? docType} has been uploaded yet.`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await storage().read(doc.fileRef);
  } catch {
    // The row says a file exists but the storage driver cannot find it. Report
    // it as missing rather than as a server error, since that is what it means
    // for the user.
    throw AppError.notFound("That file is no longer available. Please upload it again.");
  }

  return {
    fileName: doc.fileName,
    mimeType: doc.mimeType ?? "application/octet-stream",
    buffer,
  };
}

/** Current documents for a vendor, for the form's checklist and the admin view. */
export async function listOnboardingDocuments(
  vendorId: string,
): Promise<(UploadedDocument & { sizeBytes: number | null })[]> {
  const docs = await prisma.vendorDocument.findMany({
    where: { vendorId },
    orderBy: { uploadedAt: "desc" },
    select: { docType: true, fileName: true, uploadedAt: true, sizeBytes: true },
  });
  return docs.map((d) => ({
    docType: d.docType,
    fileName: d.fileName,
    uploadedAt: d.uploadedAt.toISOString(),
    sizeBytes: d.sizeBytes,
  }));
}
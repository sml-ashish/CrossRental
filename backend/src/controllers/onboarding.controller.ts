import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import { prisma } from "../lib/database";
import { AuthedRequest } from "../middleware/auth";
import { uploadedFile, validateUpload } from "../middleware/upload";
import {
  isEditableStatus,
  loadByToken,
  loadVendorDraft,
  REQUIRED_DOCUMENTS,
  REQUIRED_DOCUMENT_LABELS,
  resolveVendorByToken,
  saveDraft,
} from "../services/onboarding.service";
import {
  listOnboardingDocuments,
  readOnboardingDocument,
  uploadOnboardingDocument,
} from "../services/documents.service";

/**
 * Onboarding endpoints (brief 7.2).
 *
 * Every handler works in one of two scopes:
 *
 * - Token scope: `/api/onboarding/invitation/:token/...`, reached from the
 *   emailed link with no account. The token is the credential, so it is
 *   validated on every request rather than trusted from a previous one.
 * - Account scope: `/api/onboarding/...`, reached by an activated vendor using
 *   their login, and resolved from the JWT's vendorId.
 *
 * Both are served by the same handlers so the two paths cannot drift apart.
 * The scope is taken from the route shape, never from the request body, so a
 * vendor cannot ask for another vendor's draft by passing a vendorId.
 */

interface Scope {
  vendorId: string | null;
  token?: string;
  actor?: AuthedRequest["user"];
  ipAddress?: string;
}

/**
 * Works out which vendor the caller is acting as.
 *
 * A token in the URL wins when present; otherwise the caller's own vendorId is
 * used and a vendor account with no vendor record is refused.
 */
function scopeOf(req: Request): Scope {
  const token = typeof req.params.token === "string" ? req.params.token : undefined;
  if (token) {
    return { vendorId: null, token, ipAddress: req.ip };
  }

  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  if (user.role === "vendor_user") {
    if (!user.vendorId) throw AppError.forbidden("Your account is not linked to a vendor");
    return { vendorId: user.vendorId, actor: user, ipAddress: req.ip };
  }

  // Internal users have no implicit onboarding draft of their own.
  throw AppError.forbidden("Use the vendor detail page to edit a registration");
}

/**
 * Resolves the vendor id for a write. In token scope the vendor row may not
 * exist yet, because the vendor has never saved the form — in that case the
 * document cannot be stored, since it would have no vendor to belong to.
 */
async function requireVendorId(scope: Scope): Promise<string> {
  if (scope.vendorId) return scope.vendorId;

  const { vendorId } = await resolveVendorByToken(scope.token!);
  if (!vendorId) {
    throw AppError.badRequest(
      "Please complete and save the company details section before uploading documents.",
    );
  }
  return vendorId;
}

// --- reads ------------------------------------------------------------------

export const getOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeOf(req);

  if (scope.token) {
    const view = await loadByToken(scope.token);
    return res.json(view);
  }

  const vendorId = await requireVendorId(scope);
  const [draft, documents] = await Promise.all([
    loadVendorDraft(vendorId),
    listOnboardingDocuments(vendorId),
  ]);
  if (!draft) throw AppError.notFound("Onboarding record not found");

  return res.json({
    vendorId,
    status: draft.onboardingStatus,
    rejectionRemarks:
      draft.onboardingStatus === "REJECTED" ? (draft.decisions[0]?.remarks ?? draft.adminRemarks) : null,
    canEdit: isEditableStatus(draft.onboardingStatus),
    draft,
    documents,
    missingDocuments: requiredMissing(documents.map((d) => d.docType)),
  });
});

/**
 * The state list, for an invitee who has no account.
 *
 * The authenticated `/vendors/reference-data` also returns crane types, which
 * are not needed to register and are not worth exposing on a public route.
 * States are public reference data — the same rows the fleet filters use — so
 * they are safe to serve without a session.
 */
export const getReferenceData = asyncHandler(async (_req: Request, res: Response) => {
  const states = await prisma.state.findMany({
    orderBy: { name: "asc" },
    select: { code: true, name: true },
  });
  res.json({ states });
});

/** The form's document checklist, for rendering before anything is uploaded. */
export const getDocumentTypes = asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    required: REQUIRED_DOCUMENTS.map((docType) => ({
      docType,
      label: REQUIRED_DOCUMENT_LABELS[docType],
      required: true,
    })),
    optional: [{ docType: "OTHER", label: REQUIRED_DOCUMENT_LABELS.OTHER ?? "Other document", required: false }],
  });
});

// --- writes -----------------------------------------------------------------

export const saveOnboardingDraft = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeOf(req);

  // Deliberately not requireVendorId: in token scope the vendor row does not
  // exist yet, and creating that draft is part of this call. saveDraft resolves
  // the token and creates the row on first save.
  const result = await saveDraft({
    vendorId: scope.vendorId ?? undefined,
    token: scope.token,
    input: req.body,
    mode: "draft",
    actor: scope.actor ?? null,
    ipAddress: scope.ipAddress,
  });

  res.json(result);
});

export const submitOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeOf(req);

  const result = await saveDraft({
    vendorId: scope.vendorId ?? undefined,
    token: scope.token,
    input: req.body,
    mode: "submit",
    actor: scope.actor ?? null,
    ipAddress: scope.ipAddress,
  });

  res.json(result);
});

// --- documents --------------------------------------------------------------

export const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const vendorId = await requireVendorId(scope);

  const docType = typeof req.params.docType === "string" ? req.params.docType : "";
  const file = uploadedFile(req);
  const validated = validateUpload(file);
  if (!validated) throw AppError.badRequest("No file was uploaded");

  const document = await uploadOnboardingDocument({
    vendorId,
    docType,
    buffer: validated.buffer,
    fileName: validated.fileName,
    mimeType: validated.mimeType,
    uploadedBy: scope.actor?.id ?? null,
  });

  res.status(201).json({ document });
});

export const downloadDocument = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const vendorId = await requireVendorId(scope);

  const docType = typeof req.params.docType === "string" ? req.params.docType : "";
  const file = await readOnboardingDocument({ vendorId, docType });

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.buffer.length));
  // Force a download rather than rendering the file inline in a browser tab,
  // so an uploaded document cannot execute in the portal's origin.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.fileName.replace(/"/g, "")}"`,
  );
  res.send(file.buffer);
});

function requiredMissing(uploaded: string[]): string[] {
  const have = new Set(uploaded);
  return REQUIRED_DOCUMENTS.filter((docType) => !have.has(docType));
}
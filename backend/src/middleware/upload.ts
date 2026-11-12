import multer from "multer";
import { Request, RequestHandler } from "express";
import { AppError } from "./errorHandler";
import { env } from "../config/env";

/**
 * Upload handling for load charts, onboarding documents, RFQ attachments and
 * quotation attachments. Brief 6.6 requires file type and size validation.
 *
 * Validation is allow-list only: the declared MIME type must be one of
 * PDF/JPEG/PNG *and* the magic bytes must agree *and* the extension must
 * match. A shell script renamed to .pdf is rejected. Files are held in memory
 * and handed to the storage provider, so nothing unvalidated reaches disk.
 */

const ALLOWED = new Map<string, string>([
  ["application/pdf", "PDF"],
  ["image/jpeg", "JPG"],
  ["image/png", "PNG"],
]);

const EXTENSION_ALLOWED = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

export const ACCEPTED_UPLOAD_LABEL = "PDF, JPG or PNG";

/** Identifies the file type from its leading bytes, ignoring the filename. */
function sniff(buffer: Buffer): string | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.storage.uploadMaxBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(AppError.badRequest(`Only ${ACCEPTED_UPLOAD_LABEL} files are accepted`));
      return;
    }
    cb(null, true);
  },
});

/** Wraps a multer middleware so its errors become AppErrors with usable codes. */
function handle(
  middleware: RequestHandler,
  maxBytes: number = env.storage.uploadMaxBytes,
): RequestHandler {
  return (req, res, next) => {
    middleware(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(
            new AppError(
              `File is too large. Maximum size is ${Math.round(
                maxBytes / (1024 * 1024),
              )} MB.`,
              413,
              "FILE_TOO_LARGE",
            ),
          );
          return;
        }
        next(AppError.badRequest(`Upload failed: ${err.message}`));
        return;
      }
      next(err);
    });
  };
}

export const uploadSingle = (field: string): RequestHandler => handle(upload.single(field));export const uploadOptional = (field: string): RequestHandler =>
  handle(upload.fields([{ name: field, maxCount: 1 }]) as RequestHandler);

/**
 * Pulls the single uploaded file off a multipart request. multer's
 * `.fields()` populates `req.files` as an object rather than `req.file`, so
 * both shapes are checked.
 */
export function uploadedFile(req: Request): Express.Multer.File | undefined {
  if (req.file) return req.file;
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  if (files) {
    for (const group of Object.values(files)) {
      if (group?.[0]) return group[0];
    }
  }
  return undefined;
}

export interface ValidatedUpload {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Confirms the bytes match the declared type and the extension, then returns
 * the upload ready for the storage provider. Returns null when nothing was
 * attached, which is allowed for optional uploads.
 */
export function validateUpload(file: Express.Multer.File | undefined): ValidatedUpload | null {
  if (!file) return null;

  const sniffed = sniff(file.buffer);
  if (!sniffed || sniffed !== file.mimetype) {
    throw AppError.badRequest(
      `That file is not a valid ${ALLOWED.get(file.mimetype) ?? "supported"} file`,
    );
  }

  const dot = file.originalname.lastIndexOf(".");
  const ext = dot >= 0 ? file.originalname.slice(dot).toLowerCase() : "";
  if (EXTENSION_ALLOWED.get(ext) !== sniffed) {
    throw AppError.badRequest("File extension does not match the file contents");
  }

  return {
    buffer: file.buffer,
    fileName: safeFileName(file.originalname),
    mimeType: sniffed,
    sizeBytes: file.size,
  };
}

/** Strips any path component a browser may have included in the filename. */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/^.*[\\/]/, "")
      .replace(/[^\w.\- ]+/g, "_")
      .slice(0, 200) || "upload"
  );
}

/**
 * Spreadsheet uploads for the bulk crane import.
 *
 * Deliberately separate from the document uploader: an `.xlsx` is a ZIP
 * container, so the PDF/JPEG/PNG magic-byte allow-list cannot describe it. The
 * checks here are the extension, the declared MIME type, and the ZIP signature —
 * enough to refuse a renamed `.csv` or a random file before a parser sees it.
 * The size cap is lower than the document cap because a 250-row crane sheet is
 * small, and a large upload is far more likely to be a mistake than a fleet.
 */
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLSX_MAX_BYTES = 5 * 1024 * 1024;

const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: XLSX_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const dot = file.originalname.toLowerCase().lastIndexOf(".");
    const ext = dot >= 0 ? file.originalname.slice(dot).toLowerCase() : "";
    // Browsers disagree about the MIME type of an .xlsx; the extension and the
    // bytes below are the real checks, so octet-stream is tolerated here.
    const mimeOk =
      file.mimetype === XLSX_MIME || file.mimetype === "application/octet-stream";
    if (ext !== ".xlsx" || !mimeOk) {
      cb(AppError.badRequest("Only .xlsx spreadsheets are accepted"));
      return;
    }
    cb(null, true);
  },
});

export const uploadSpreadsheet = (field: string): RequestHandler =>
  handle(spreadsheetUpload.single(field), XLSX_MAX_BYTES);

export interface ValidatedSpreadsheet {
  buffer: Buffer;
  fileName: string;
  sizeBytes: number;
}

/** Confirms the bytes really are a ZIP-based workbook before parsing. */
export function validateSpreadsheet(
  file: Express.Multer.File | undefined,
): ValidatedSpreadsheet {
  if (!file) {
    throw AppError.badRequest("Attach the .xlsx file to upload");
  }
  const isZipArchive =
    file.buffer.length >= 4 &&
    file.buffer[0] === 0x50 &&
    file.buffer[1] === 0x4b &&
    file.buffer[2] === 0x03 &&
    file.buffer[3] === 0x04;
  if (!isZipArchive) {
    throw AppError.badRequest("That file is not a valid .xlsx workbook");
  }
  return {
    buffer: file.buffer,
    fileName: safeFileName(file.originalname),
    sizeBytes: file.size,
  };
}
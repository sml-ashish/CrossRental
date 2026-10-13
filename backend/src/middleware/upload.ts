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
function handle(middleware: RequestHandler): RequestHandler {
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
                env.storage.uploadMaxBytes / (1024 * 1024),
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

export const uploadSingle = (field: string): RequestHandler => handle(upload.single(field));

export const uploadOptional = (field: string): RequestHandler =>
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
import { z } from "zod";

/**
 * Field formats for the vendor onboarding form (brief 5.1).
 *
 * These are collected here rather than inline in the route schema because the
 * same rules are needed in three places: validating a draft save, validating a
 * submit, and re-validating at approval time so an admin cannot approve a form
 * that never passed through submit. One definition, three call sites.
 *
 * Everything is upper-cased and stripped of spaces before matching, because
 * these are transcribed from paper forms by hand and vendors routinely type
 * "aa p r t 1234 e".
 */

// --- Individual formats ----------------------------------------------------

/** PAN: 5 letters, 4 digits, 1 letter (brief 5.1). */
export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;

/**
 * Brief 5.1: the PAN's 4th letter is the company-type letter — C for a
 * (Public or Private) company, F for a partnership, P for a proprietorship.
 * A mismatch usually means the PAN belongs to a different entity than the
 * one the form is about, which is exactly the transcription error this rule
 * exists to catch.
 */
const COMPANY_TYPE_LETTER: Record<string, string> = {
  PUBLIC_LTD: "C",
  PRIVATE_LTD: "C",
  PARTNERSHIP: "F",
  PROPRIETORSHIP: "P",
};

export function panCompanyTypeMismatch(pan: string, natureOfCompany: string): boolean {
  const letter = COMPANY_TYPE_LETTER[natureOfCompany];
  return letter !== undefined ? pan[3] !== letter : false;
}

/**
 * GSTIN: 15 characters — 2-digit state code, 10-character PAN, 1 entity code,
 * 'Z', 1 checksum character (brief 5.1 says "15 characters"; the structure is
 * what makes a typo detectable).
 */
export const GSTN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/** IFSC: 4 letters, '0', 6 alphanumerics (brief 5.1). */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** CIN: 21 characters, `U` + 20 alphanumerics for an unlisted company. */
export const CIN_PATTERN = /^[LUu]\d{5}[A-Z\d]{2}\d{4}[A-Z\d]{3}[A-Z\d]{6}$/;

/**
 * Indian mobile/landline. Permissive on purpose: brief 5.1 only says the
 * telephone is mandatory, and over-stricting a field vendors use for landlines
 * with an STD code pushes them to invent something that passes.
 */
export const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;

/**
 * A contact's mobile (P0 A8): 10 digits with no leading zero. A "+91"/"0"
 * prefix is stripped first, because vendors type their number in every one of
 * those shapes, and refusing a correct number over its punctuation helps no
 * one. This is stricter than {@link PHONE_PATTERN}, which still governs a
 * landline's telephone field.
 */
export const MOBILE_PATTERN = /^[1-9]\d{9}$/;

export function normaliseMobile(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function normalise(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

// --- Zod field schemas -----------------------------------------------------

const trimmed = (max: number) => z.string().trim().max(max, `Must be ${max} characters or fewer`);

export const panField = z
  .string()
  .trim()
  .transform(normalise)
  .refine((v) => PAN_PATTERN.test(v), "PAN must be 5 letters, 4 digits, then 1 letter (e.g. ABCDE1234F)");

export const gstnField = z
  .string()
  .trim()
  .transform(normalise)
  .refine((v) => v.length === 15, "GSTIN must be exactly 15 characters")
  .refine((v) => GSTN_PATTERN.test(v), "That is not a valid GSTIN");

/**
 * GSTIN and PAN must agree — a very common transcription error, and one that is
 * invisible until someone tries to validate the vendor against the GST portal.
 */
export function gstinPanMismatch(gstn: string, pan: string): boolean {
  return gstn.length >= 12 && pan.length >= 10 ? gstn.slice(2, 12) !== pan : false;
}

export const ifscField = z
  .string()
  .trim()
  .transform(normalise)
  .refine((v) => IFSC_PATTERN.test(v), "IFSC must be 4 letters, then 0, then 6 characters (e.g. HDFC0001234)");

export const cinField = z
  .string()
  .trim()
  .transform(normalise)
  .refine((v) => CIN_PATTERN.test(v), "That is not a valid CIN");

export const phoneField = z
  .string()
  .trim()
  .refine((v) => PHONE_PATTERN.test(v), "Enter a valid phone number");

export const mobileField = z
  .string()
  .trim()
  .transform(normaliseMobile)
  .refine((v) => MOBILE_PATTERN.test(v), "Enter a 10-digit mobile number without a leading zero");

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address");

/** Bank account numbers: digits, and long enough to be a real one. */
export const accountNoField = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ""))
  .refine((v) => /^\d{9,18}$/.test(v), "Enter the account number as 9 to 18 digits");

/** MICR: exactly 9 digits (brief 5.1), optional. */
export const micrField = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ""))
  .refine((v) => /^\d{9}$/.test(v), "MICR must be exactly 9 digits");

/** Indian pincodes: 6 digits, and the first is never 0. */
export const pincodeField = z
  .string()
  .trim()
  .refine((v) => /^[1-9]\d{5}$/.test(v), "Enter a 6-digit pincode");

export const shortText = trimmed(200);
export const longText = trimmed(2000);

/** A date that must not be in the future, used for the declaration date. */
export const pastOrTodayField = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date")
  .refine((v) => {
    const parsed = Date.parse(v);
    // Allow today: a declaration signed this morning is legitimate.
    return parsed <= Date.now() + 24 * 60 * 60 * 1000;
  }, "Date cannot be in the future");

/** Normalises a multi-select of state codes to a clean, deduplicated list. */
export function stateCodeList(min: number, label: string) {
  return z
    .array(z.string().trim().toUpperCase().length(2, "Use a 2-letter state code"))
    .transform((codes) => [...new Set(codes)])
    .refine((codes) => codes.length >= min, `Select at least ${min} operating ${label}`);
}
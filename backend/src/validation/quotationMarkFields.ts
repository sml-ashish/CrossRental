import { z } from "zod";

/**
 * Marking a quotation in the comparison screen (P3, BPD 6.15).
 *
 * A CR user marks a comparable quotation Under Review, Shortlisted or Rejected
 * and records **why** as a reason code. The codes are admin-maintained master
 * lists (`QUOTATION_MARK_REASON_CODES`); this schema only normalises the input —
 * membership in the list is checked in the service, so a code can still be
 * recorded while the list is being filled in.
 *
 * `SELECTED` and `NOT_AWARDED` are deliberately absent: those are the award's
 * outcomes and only `awardQuotation` may set them.
 */

export const QUOTATION_MARK_STATUSES = [
  "UNDER_REVIEW",
  "SHORTLISTED",
  "REJECTED",
] as const;

export type QuotationMarkStatus = (typeof QUOTATION_MARK_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | null => {
      if (v === undefined || v === null) return null;
      const text = v.trim();
      return text === "" ? null : text;
    })
    .refine((v) => v === null || v.length <= max, {
      message: `Keep it under ${max} characters`,
    });

export const quotationMarkSchema = z.object({
  status: z.enum(QUOTATION_MARK_STATUSES),
  /** The reason code from the master list; free text is accepted until the list is set. */
  reasonCode: optionalText(120),
  /** Optional free-text note beside the code. */
  reasonText: optionalText(500),
});

export type QuotationMarkInput = z.infer<typeof quotationMarkSchema>;

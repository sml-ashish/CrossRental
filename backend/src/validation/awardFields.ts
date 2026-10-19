import { z } from "zod";
import { toUtcMidnight } from "./reservationFields";

/**
 * Award action fields (brief 6.7 as revised, phase B2).
 *
 * The brief calls for `award_quotation(quotation_id, reason_code)`. The reason
 * is free text rather than a fixed code set because no code list exists in the
 * source material; it is stored in the audit trail and echoed to the awarded
 * and not-awarded vendors so both ends of the RFQ see the same words.
 *
 * P3 adds `reasonCode` beside it: a picked award from the comparison screen
 * carries the admin-maintained `AWARD_REASON_CODES` value, kept on the winning
 * quotation so the comparison screen shows why. The free-text `reason` stays —
 * the two are not exclusive.
 *
 * Phase B2 adds the reservation window. When the RFQ's start date is not TBC the
 * window is derived from the RFQ itself, so the dates are optional; when the
 * start date is TBC the caller must supply both, because there is nothing to
 * derive them from and a reservation must be dated.
 */

const dateOnly = z.coerce
  .date({ message: "Enter a valid date" })
  .transform(toUtcMidnight);

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

export const awardQuotationSchema = z
  .object({
    reason: optionalText(1000),
    /** P3: the picked reason code from the award master list. */
    reasonCode: optionalText(120),
    startDate: dateOnly.optional(),
    endDate: dateOnly.optional(),
  })
  .refine(
    (v) => !(v.startDate && v.endDate) || v.endDate.getTime() >= v.startDate.getTime(),
    { message: "The end date cannot be before the start date", path: ["endDate"] },
  );

export type AwardQuotationInput = z.infer<typeof awardQuotationSchema>;

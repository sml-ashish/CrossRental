import { z } from "zod";
import {
  CapacityRule,
  DurationUnit,
  EnquiryOverallStatus,
} from "../generated/prisma/client";
import { submissionDeadlineField } from "./rfqFields";

/**
 * Enquiry intake fields (P1 section 2), derived from the 31-row Cross Rental
 * Enquiry Template in docs/CR Enquiry from SP.xlsx. The template wins where the
 * two disagree, which is why the five scope terms the first field-list draft
 * missed (additional manpower, intra-site movement, pre-release, PPE, ROW) are
 * first-class columns here.
 *
 * Customer name/address and the budget are internal only: the validators keep
 * them, and the RFQ prefill deliberately drops them.
 */

const trimmed = (max: number) => z.string().trim().max(max);
const dateField = z.coerce.date({ message: "Enter a valid date" });

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | null => {
      if (v === undefined || v === null) return null;
      const text = String(v).trim();
      return text === "" ? null : text;
    });

/** An optional positive decimal, absent/blank/null all meaning "not stated". */
const optionalNumber = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number` })
    .positive(`${label} must be greater than 0`)
    .optional()
    .nullable();

const optionalInt = (label: string, min: number, max: number) =>
  z.coerce
    .number({ message: `${label} must be a whole number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} cannot be below ${min}`)
    .max(max, `${label} cannot exceed ${max}`)
    .optional()
    .nullable();

const baseLineFields = {
  craneTypeCode: trimmed(50).min(1, "Choose the crane type"),
  capacityT: z.coerce
    .number({ message: "Enter the required capacity in tonnes" })
    .positive("Required capacity must be greater than 0"),
  capacityRule: z
    .enum([CapacityRule.AT_LEAST, CapacityRule.EXACT])
    .default(CapacityRule.AT_LEAST),
  capacityNote: optionalText(2000),
  quantity: z.coerce
    .number({ message: "Enter the quantity required" })
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .default(1),

  applicationDescription: optionalText(5000),
  loadDescription: optionalText(5000),
  liftLoadT: optionalNumber("Lift load"),
  workingRadiusM: optionalNumber("Working radius"),

  requiredMainBoomM: optionalNumber("Main boom length"),
  requiredFixedJibM: optionalNumber("Fixed jib length"),
  requiredLuffingJibM: optionalNumber("Luffing jib length"),
  requiredWindJibM: optionalNumber("Wind jib length"),
  configurationNotes: optionalText(2000),

  // No start date means "to be confirmed"; there is no separate flag.
  requiredStartDate: dateField.optional().nullable(),
  durationValue: optionalNumber("Duration"),
  durationUnit: z
    .enum([DurationUnit.DAYS, DurationUnit.MONTHS])
    .optional()
    .nullable(),
  workingDaysPerMonth: optionalInt("Working days per month", 1, 31),

  mobilisationTerms: optionalText(2000),
  demobilisationTerms: optionalText(2000),

  otCharges: optionalText(200),
  breakdownTerms: optionalText(200),
  dieselScope: optionalText(200),
  workingHoursShift: optionalText(120),
  accommodationConveyance: optionalText(200),
  paymentTerms: optionalText(500),
  supportCraneScope: optionalText(500),
  steelMatsGroundPrepScope: optionalText(1000),
  ehsHrCompliance: optionalText(1000),
  insuranceTerms: optionalText(1000),
  extensionClause: optionalText(1000),
  craneAgeCriteriaYears: optionalInt("Crane age criterion", 0, 80),
  otherTerms: optionalText(4000),

  // The five template rows the first field-list draft missed.
  additionalManpowerScope: optionalText(500),
  intraSiteMovementScope: optionalText(500),
  prereleaseTerms: optionalText(500),
  ppeScope: optionalText(200),
  rowScope: optionalText(500),

  // Internal only — never copied into an RFQ.
  rentalBudget: optionalText(300),
};

const headerFields = {
  enquiryDate: dateField.optional(),
  /** Defaults to the acting CR user when omitted. */
  crOwnerId: z.string().uuid("That is not a valid owner reference").optional(),
  customerName: trimmed(300).min(1, "Enter the customer name"),
  customerAddress: trimmed(2000).min(2, "Enter the customer address"),
  siteLocation: trimmed(300).min(3, "Enter the job site location"),
  siteStateCode: trimmed(10).min(1, "Choose the state"),
  sitePincode: optionalText(10),
  region: optionalText(120),
};

/**
 * Creating an enquiry and all of its lines in one call (the adapter point). A
 * future SAP feed calls the same service with `source` set differently; it does
 * not need a different schema.
 */
export const createEnquirySchema = z.object({
  ...headerFields,
  lines: z
    .array(z.object(baseLineFields))
    .min(1, "Add at least one line item"),
});

export type CreateEnquiryInput = z.infer<typeof createEnquirySchema>;

/** Editing the header. A full form save, like the crane and RFQ edits. */
export const updateEnquirySchema = z.object({ ...headerFields });

export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;

/** Adding a line to an existing enquiry. */
export const addLineSchema = z.object({ ...baseLineFields });

export type AddLineInput = z.infer<typeof addLineSchema>;

/** Editing a line in full (a partial line is a line nobody can source). */
export const updateLineSchema = z.object({ ...baseLineFields });

export type UpdateLineInput = z.infer<typeof updateLineSchema>;

export const cancelLineSchema = z.object({
  reason: trimmed(500).min(3, "Give a reason for cancelling the line"),
});

export type CancelLineInput = z.infer<typeof cancelLineSchema>;

/**
 * Recording the internal availability check. There is no SML fleet in this
 * platform, so this is a manual CR outcome: either the requirement will be met
 * outside vendor sourcing ("fulfilled internally") or internal means were
 * checked and cannot meet it.
 */
export const internalCheckSchema = z.object({
  outcome: z.enum(["CHECKED_NOT_AVAILABLE", "FULFILLED_INTERNALLY"]),
  notes: optionalText(1000),
});

export type InternalCheckInput = z.infer<typeof internalCheckSchema>;

/**
 * Raising an RFQ from a line. Everything else is prefilled from the line and
 * the enquiry header's vendor-safe subset, so only the deadline is required.
 */
export const rfqFromLineSchema = z.object({
  submissionDeadline: submissionDeadlineField,
});

export type RfqFromLineInput = z.infer<typeof rfqFromLineSchema>;

export const listEnquiriesQuerySchema = z.object({
  status: z
    .enum([
      EnquiryOverallStatus.RECEIVED_PENDING_SOURCING,
      EnquiryOverallStatus.PARTIALLY_QUOTED,
      EnquiryOverallStatus.PARTIALLY_FINALISED,
      EnquiryOverallStatus.FULLY_FINALISED,
      EnquiryOverallStatus.CLOSED,
    ])
    .optional(),
  search: trimmed(120).optional(),
  region: optionalText(120),
  stateCode: trimmed(10).optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});

export type ListEnquiriesQuery = z.infer<typeof listEnquiriesQuerySchema>;

/** The RFQ line picker: open lines that can carry a new RFQ. */
export const listRaisableLinesQuerySchema = z.object({
  search: trimmed(120).optional(),
});

export type ListRaisableLinesQuery = z.infer<typeof listRaisableLinesQuerySchema>;

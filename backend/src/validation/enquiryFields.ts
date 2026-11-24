import { z } from "zod";
import { DurationUnit, EnquiryOverallStatus } from "../generated/prisma/client";
import { submissionDeadlineField } from "./rfqFields";

/**
 * Enquiry intake fields. The enquiry captures the crane requirement, the site
 * city/state and the terms SML may choose to carry into an RFQ. Vendor terms,
 * customer details and the site pin are not stored here; they live on the RFQ.
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
  craneModel: optionalText(100),
  yom: optionalInt("Year of manufacture", 1950, 2100),
  capacityT: z.coerce
    .number({ message: "Enter the required capacity in tonnes" })
    .positive("Required capacity must be greater than 0"),

  applicationDescription: optionalText(5000),
  liftLoadT: optionalNumber("Weight to be lifted"),
  liftHeightM: optionalNumber("Height to be lifted"),

  craneConfiguration: optionalText(200),

  // No start date means "to be confirmed"; there is no separate flag.
  requiredStartDate: dateField.optional().nullable(),
  durationValue: optionalNumber("Duration"),
  durationUnit: z
    .enum([DurationUnit.DAYS, DurationUnit.MONTHS])
    .optional()
    .nullable(),
  workingDaysPerMonth: optionalInt("Working days per month", 1, 31),

  otCharges: optionalText(200),
  breakdownTerms: optionalText(200),
  dieselScope: optionalText(200),
  workingHoursPerDay: optionalText(120),
  shift: optionalText(60),
  workingHoursShift: optionalText(120),
  supportCraneScope: optionalText(500),
  steelMatsGroundPrepScope: optionalText(1000),
  ehsHrCompliance: optionalText(1000),
  insuranceTerms: optionalText(1000),
  craneAgeCriteriaYears: optionalInt("Crane age criterion", 0, 80),

  additionalManpowerScope: optionalText(500),
  rowScope: optionalText(500),
};

const headerFields = {
  enquiryDate: dateField.optional(),
  shipToCity: trimmed(100).min(2, "Enter the delivery city"),
  siteStateCode: trimmed(10).min(1, "Choose the state"),
};

/**
 * Creating an enquiry and all of its lines in one call (the adapter point). The
 * form, the bulk upload and any future SAP feed all use this one schema.
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
 * The line-item fields a sales user may choose to copy into an RFQ.
 *
 * Core facts (crane type, capacity and site) are not in this list: an RFQ
 * cannot be sourced without them, so they are always sent. The client sends the
 * keys it wants; the service uses this list as the only allow-list, so an
 * unknown key is a validation error rather than a silent way to populate an RFQ
 * column.
 */
export const RFQ_LINE_FIELD_KEYS = [
  // Job and load
  "applicationDescription",
  "liftLoadT",
  "liftHeightM",
  // Configuration
  "craneConfiguration",
  "workingDaysPerMonth",
  // Commercial terms
  "otCharges",
  "breakdownTerms",
  "dieselScope",
  "workingHoursShift",
  "craneAgeCriteriaYears",
  // Scopes and other terms
  "supportCraneScope",
  "steelMatsGroundPrepScope",
  "ehsHrCompliance",
  "insuranceTerms",
  "additionalManpowerScope",
  "rowScope",
] as const;

export type RfqLineFieldKey = (typeof RFQ_LINE_FIELD_KEYS)[number];

/**
 * Raising an RFQ from a line. Everything else is prefilled from the line and
 * the enquiry city/state, so only the deadline is required.
 *
 * `includeFields` is the sales user's field picker. When it is omitted the
 * service copies every vendor-safe line field, which keeps older callers (and
 * the enquiry-screen shortcuts) behaving exactly as before. When present, only
 * the named fields are copied; everything else stays null/absent on the RFQ.
 */
export const rfqFromLineSchema = z.object({
  submissionDeadline: submissionDeadlineField,
  includeFields: z.array(z.enum(RFQ_LINE_FIELD_KEYS)).optional(),
  /** Optional sales remark. Lands in the RFQ's vendor-visible notes. */
  remark: optionalText(1000),
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
  stateCode: trimmed(10).optional(),
  from: dateField.optional(),
  to: dateField.optional(),
  /**
   * The list screen's order. `newest` is the default; `startDate` puts the
   * enquiries whose unsourced work begins soonest first; `progress` shows the
   * least-sourced first, which is where attention is needed.
   */
  sort: z.enum(["newest", "startDate", "progress"]).optional(),
});

export type ListEnquiriesQuery = z.infer<typeof listEnquiriesQuerySchema>;

/** The RFQ line picker: open lines that can carry a new RFQ. */
export const listRaisableLinesQuerySchema = z.object({
  search: trimmed(120).optional(),
});

export type ListRaisableLinesQuery = z.infer<typeof listRaisableLinesQuerySchema>;

/**
 * Which recommendation view the enquiry section asked for.
 *
 * `technical` (the default) is the stored snapshot, unchanged. `distance` is a
 * live list that drops the capacity filter, so it is never persisted.
 */
export const recommendationQuerySchema = z.object({
  mode: z.enum(["technical", "distance"]).default("technical"),
});

export type RecommendationQuery = z.infer<typeof recommendationQuerySchema>;

/** Part B: the crane whose pin ends the route from the job site. */
export const lineRouteQuerySchema = z.object({
  craneId: z.string().trim().min(1),
});

export type LineRouteQuery = z.infer<typeof lineRouteQuerySchema>;

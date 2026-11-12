import { z } from "zod";
import { INDIA_BOUNDS } from "../lib/geo";
import {
  CapacityRule,
  DurationUnit,
  RfqStatus,
} from "../generated/prisma/client";

/**
 * RFQ field rules from brief 5.4, with the constraints of brief 6.7.
 *
 * Two things are worth knowing about this file before changing it.
 *
 * **An RFQ is one enquiry line item, never the enquiry header.** Brief 6.7 is
 * emphatic about this because the alternative — one RFQ per enquiry — makes the
 * quantity, capacity and duration fields ambiguous the moment a customer asks
 * for two different cranes. `lineNo` is therefore required rather than
 * decorative: it is the key the later SAP feed will replace.
 *
 * **The database already carries some of these rules.** `rfqs` has CHECK
 * constraints for positive quantity, positive duration, and site coordinates
 * inside India. The schemas here are the friendly layer in front of them — a
 * sales user gets a sentence naming the field, not a constraint violation.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/** A real date, rejecting the `Invalid Date` that `new Date("nonsense")` gives. */
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

/**
 * The submission deadline (brief 5.4): mandatory and in the future.
 *
 * "In the future" is checked here rather than in the service because the whole
 * point is to refuse it at the form, where the user can still fix it. A past
 * deadline is not a slow failure to detect later — it is an RFQ nobody can ever
 * answer.
 */
export const submissionDeadlineField = dateField.refine(
  (d) => d.getTime() > Date.now(),
  "The submission deadline must be in the future",
);

/**
 * A pin the sales user confirmed for the job site (brief 6.9).
 *
 * Exported on its own because the same pair appears in the create schema and in
 * the draft update. Half a pin is not a location, so the pairing rule is shared
 * rather than restated.
 */
const sitePinFields = {
  siteLatitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLat, "Site latitude is outside India")
    .max(INDIA_BOUNDS.maxLat, "Site latitude is outside India")
    .optional()
    .nullable(),
  siteLongitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLng, "Site longitude is outside India")
    .max(INDIA_BOUNDS.maxLng, "Site longitude is outside India")
    .optional()
    .nullable(),
};

/**
 * Shared rule: coordinates arrive as a pair or not at all.
 *
 * "Provided" means not undefined *and* not null. Comparing against null alone
 * misses the common half-pin, where the partner field was simply left out, and
 * the invalid point reaches the database CHECK as a constraint violation instead
 * of a message naming the field.
 */
function requirePairedPin(
  value: { siteLatitude?: number | null; siteLongitude?: number | null },
  ctx: z.RefinementCtx,
): void {
  const hasLat =
    value.siteLatitude !== undefined && value.siteLatitude !== null;
  const hasLng =
    value.siteLongitude !== undefined && value.siteLongitude !== null;
  if (hasLat === hasLng) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [hasLat ? "siteLongitude" : "siteLatitude"],
    message: "Give both latitude and longitude, or neither",
  });
}

/**
 * Brief 6.7's commercial terms.
 *
 * "Template defaults, editable per RFQ" — the defaults are seeded into
 * EmailTemplate-adjacent configuration and copied in at creation time, but every
 * one of them is overridable per RFQ because a customer's payment terms are
 * frequently the thing being negotiated. Nothing here is required: a missing term
 * is a blank on the enquiry, not an invalid RFQ.
 */
const commercialTermFields = {
  otCharges: optionalText(200),
  breakdownTerms: optionalText(200),
  dieselScope: optionalText(200),
  workingHoursShift: optionalText(120),
  craneAgeCriteriaYears: z.coerce
    .number()
    .int("Enter a whole number of years")
    .min(0, "The age criterion cannot be negative")
    .max(80, "That age criterion is too high")
    .optional()
    .nullable(),
  accommodationConveyance: optionalText(200),
  paymentTerms: optionalText(200),
  // P0 A4: the remaining terms on the CR enquiry line item.
  mobilisationTerms: optionalText(2000),
  supportCrane: optionalText(500),
  steelMatsGroundPrep: optionalText(1000),
  ehsHrRequirements: optionalText(1000),
  insuranceTerms: optionalText(1000),
  extensionClause: optionalText(1000),
  notes: optionalText(2000),
  /**
   * Vendor-safe terms that have no column of their own (P1): the demobilisation
   * term and the five scope terms the template carries. A free-form bag rather
   * than five more columns, because these are shown to the vendor as text and
   * never matched on. Anything internal must not be added here — the RFQ is the
   * vendor-facing artefact.
   */
  commercialTermsExtra: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .nullable(),
};

/** The SML contact shown to vendors (brief 5.4). */
const smlContactFields = {
  smlContactName: optionalText(120),
  smlContactMobile: optionalText(40),
  smlContactEmail: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | null => {
      if (v === undefined || v === null) return null;
      const text = String(v).trim();
      return text === "" ? null : text;
    })
    .refine((v) => v === null || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address",
    }),
};

/**
 * The line an RFQ belongs to (P1).
 *
 * An RFQ is raised **against one enquiry line item**, never the enquiry header:
 * that is what makes quantity, capacity and duration unambiguous. The native
 * `enquiryLineId` is the anchor, and when it is present the service derives
 * `enquiryNo`/`lineNo` from the line so the three cannot disagree.
 *
 * `enquiryNo`/`lineNo` survive only for the parked SAP feed, which will arrive
 * with its own reference text before a native line exists. The UI has no path
 * that creates an RFQ this way; the refinement below still demands the pair so
 * that legacy callers cannot create a completely unanchored RFQ.
 */
const enquiryIdentityFields = {
  enquiryLineId: z
    .string()
    .uuid("That is not a valid enquiry line reference")
    .optional()
    .nullable(),
  /** The SAP line-item snapshot (brief 5.4): text for now, a feed later. */
  enquiryNo: trimmed(60).optional(),
  lineNo: trimmed(60).optional(),
};

const baseRfqFields = {
  craneType: trimmed(50).min(1, "Choose the crane type"),
  capacityT: z.coerce
    .number({ message: "Enter the required capacity in tonnes" })
    .positive("Required capacity must be greater than 0"),
  // Brief A3: how candidates are matched on capacity. Defaults to "at least"
  // so the M6 behaviour is preserved for RFQs that do not state a rule.
  capacityRule: z.enum([CapacityRule.AT_LEAST, CapacityRule.EXACT]).default(
    CapacityRule.AT_LEAST,
  ),
  // Context for the capacity choice, not a filter: matching keys on tonnes.
  capacityNote: optionalText(2000),
  quantity: z.coerce
    .number({ message: "Enter the quantity required" })
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1"),

  // Brief A3: what the crane is there to do and what it will lift. Both are
  // shown to the vendor verbatim, so they are long free text, not a picklist.
  applicationDescription: optionalText(5000),
  loadDescription: optionalText(5000),

  // Structured boom/jib requirements (brief A3). Optional per row because not
  // every enquiry states them; the quotation service warns when the offered
  // crane's boom falls short of what was asked.
  mainBoomM: z.coerce
    .number({ message: "Enter the required main boom length in metres" })
    .positive("Main boom length must be greater than 0")
    .max(200, "Main boom length cannot exceed 200 m")
    .optional(),
  jibLengthM: z.coerce
    .number({ message: "Enter the required jib length in metres" })
    .positive("Jib length must be greater than 0")
    .max(200, "Jib length cannot exceed 200 m")
    .optional(),

  // Brief A3: no fixed start date means the availability confirmation is not
  // demanded and the vendor is told why.
  startDateTbc: z.boolean().default(false),
  /** Used to convert months into days when RATE_DAY_BASIS is working days. */
  workingDaysPerMonth: z.coerce
    .number({ message: "Enter the working days per month" })
    .int("Working days per month must be a whole number")
    .min(1, "Working days per month must be at least 1")
    .max(31, "Working days per month cannot exceed 31")
    .optional(),

  siteLocation: trimmed(300).min(3, "Enter the job site location"),
  siteStateCode: trimmed(10).min(1, "Choose the state"),
  sitePincode: optionalText(10),

  requiredStartDate: dateField,
  durationValue: z.coerce
    .number({ message: "Enter the duration" })
    .positive("Duration must be greater than 0"),
  durationUnit: z.enum([DurationUnit.DAYS, DurationUnit.MONTHS]),

  configuration: optionalText(1000),
  ...commercialTermFields,
  ...smlContactFields,
};

/**
 * Creating an RFQ.
 *
 * The deadline is mandatory and future-dated. The site pin is optional here
 * because the site is geocoded on save; supplying one means the sales user has
 * already confirmed it, which wins over the lookup.
 *
 * `enquiryLineId` is the supported path. The legacy `enquiryNo`/`lineNo` pair is
 * only accepted when no line is given, and the service overwrites both from the
 * line whenever one is — so an RFQ can never be filed against a line it does not
 * belong to.
 */
function requireLineOrLegacyIdentity(
  value: { enquiryLineId?: string | null; enquiryNo?: string; lineNo?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.enquiryLineId) return;
  if (!value.enquiryNo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["enquiryNo"],
      message: "Choose the enquiry line this RFQ is for",
    });
  }
  if (!value.lineNo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lineNo"],
      message: "Choose the enquiry line this RFQ is for",
    });
  }
}

export const createRfqSchema = z
  .object({
    ...enquiryIdentityFields,
    ...baseRfqFields,
    submissionDeadline: submissionDeadlineField,
    ...sitePinFields,
  })
  .superRefine(requirePairedPin)
  .superRefine(requireLineOrLegacyIdentity);

export type CreateRfqInput = z.infer<typeof createRfqSchema>;

/**
 * Editing a draft.
 *
 * Every requirement field stays required — this is a full-form `PUT`, matching
 * the crane edit, because a partially-saved RFQ is an RFQ that cannot be sent
 * and the form is the only place a sales user would notice a missing field.
 * The deadline may be moved here as well as through the dedicated extend action;
 * a *later* deadline is what `extendDeadline` is for, with its notification.
 *
 * The enquiry line is deliberately absent: an RFQ does not move between lines
 * after it is created, and the stored `enquiryNo`/`lineNo` are a snapshot the
 * edit form cannot rewrite.
 */
export const updateRfqSchema = z
  .object({
    ...baseRfqFields,
    submissionDeadline: submissionDeadlineField,
    ...sitePinFields,
  })
  .superRefine(requirePairedPin);

export type UpdateRfqInput = z.infer<typeof updateRfqSchema>;

/**
 * Sending (brief 6.7).
 *
 * `vendorIds` rather than free-text emails: brief 6.7 restricts recipients to
 * approved vendors with an active user, and taking addresses from the client
 * would let a typo mail a stranger with the customer's requirement. The service
 * resolves each id to that vendor's own active user addresses and ignores
 * anything the client tried to add.
 */
export const sendRfqSchema = z.object({
  vendorIds: z
    .array(z.string().uuid("That is not a valid vendor reference"))
    .min(1, "Choose at least one vendor"),
  /** P6: email, WhatsApp, or both. Defaults to email for older clients. */
  channels: z
    .array(z.enum(["EMAIL", "WHATSAPP"]))
    .min(1, "Choose at least one channel")
    .default(["EMAIL"]),
});

export type SendRfqInput = z.infer<typeof sendRfqSchema>;

/**
 * Extending the deadline (brief 6.7).
 *
 * Required to move *later* than the current deadline. An action called "extend"
 * that quietly shortens a deadline is how a vendor loses the chance to quote, so
 * the refusal is explicit and the dedicated action is the only way to move a
 * deadline backwards — by cancelling instead.
 */
export const extendDeadlineSchema = z.object({
  submissionDeadline: submissionDeadlineField,
  reason: optionalText(500),
});

export type ExtendDeadlineInput = z.infer<typeof extendDeadlineSchema>;

/** Cancelling. The reason is required: this is the audit trail of a dead enquiry. */
export const cancelRfqSchema = z.object({
  reason: trimmed(500).min(
    3,
    "Give a reason for cancelling — this is recorded",
  ),
});

export type CancelRfqInput = z.infer<typeof cancelRfqSchema>;

/**
 * A manual reminder (brief 6.7).
 *
 * With no `recipientIds`, every still-Pending recipient is reminded. Named ids
 * let the sales user chase one vendor who opened the RFQ and did nothing, which
 * is the common case.
 */
export const remindRfqSchema = z.object({
  recipientIds: z.array(z.string().uuid()).optional(),
});

export type RemindRfqInput = z.infer<typeof remindRfqSchema>;

/** Confirming the job-site pin without editing the rest of the RFQ. */
export const confirmSitePinSchema = z
  .object({
    siteLatitude: z.coerce
      .number()
      .min(INDIA_BOUNDS.minLat, "Site latitude is outside India")
      .max(INDIA_BOUNDS.maxLat, "Site latitude is outside India"),
    siteLongitude: z.coerce
      .number()
      .min(INDIA_BOUNDS.minLng, "Site longitude is outside India")
      .max(INDIA_BOUNDS.maxLng, "Site longitude is outside India"),
  })
  .strict();

export type ConfirmSitePinInput = z.infer<typeof confirmSitePinSchema>;

export const listRfqsQuerySchema = z.object({
  status: z
    .enum([
      RfqStatus.DRAFT,
      RfqStatus.SENT,
      RfqStatus.CLOSED,
      RfqStatus.CANCELLED,
    ])
    .optional(),
  search: trimmed(120).optional(),
  /** Pending-only is the working queue a sales user actually wants. */
  awaitingResponse: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export type ListRfqsQuery = z.infer<typeof listRfqsQuerySchema>;

/**
 * Approved vendors available to receive an RFQ (brief 6.7: onboarding_status
 * Approved *and* an active user).
 *
 * Used by the picker's "all approved vendors" escape hatch, and by the service
 * to re-check a selection at send time — the list may have changed since the
 * picker was rendered.
 */
export const listApprovedVendorsQuerySchema = z.object({
  search: trimmed(120).optional(),
});

export type ListApprovedVendorsQuery = z.infer<
  typeof listApprovedVendorsQuerySchema
>;

/**
 * Which recommendation view the candidate picker asked for.
 *
 * `technical` (the default) is the brief 6.9 list: crane type and capacity
 * match, nearest first. `distance` keeps the type but drops the tonnage filter,
 * so sales can see what is physically closest when nothing matches exactly.
 */
export const candidateQuerySchema = z.object({
  mode: z.enum(["technical", "distance"]).default("technical"),
});

export type CandidateQuery = z.infer<typeof candidateQuerySchema>;

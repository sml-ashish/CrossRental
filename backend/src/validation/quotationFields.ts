import { z } from "zod";
import { RateBasis, DurationUnit } from "../generated/prisma/client";
import { parseDateInput, startOfUtcDay, todayUtcMidnight } from "../lib/dates";

/**
 * Quotation field rules from brief 6.7.
 *
 * The validations split into two kinds, and keeping them apart is the point of
 * this file.
 *
 * **Blocks** are things that make a quotation meaningless or unsafe: no rate, a
 * crane that is not the vendor's, a crane SML has booked, a quote already past
 * its validity. A vendor who trips one of these has to change the form.
 *
 * **Warnings** are things sales needs to see but the vendor is allowed to answer
 * anyway: a crane of the wrong type, one too old for the customer's criteria, one
 * that frees up after the work starts. Brief 6.7 is explicit that these are
 * advisories, not gates — refusing them would make it impossible to offer an
 * alternative crane, which is exactly what the vendor does when their best
 * machine is out on another job. They are computed in the service, not here,
 * because they need the RFQ requirement and the crane row.
 */

/** Days in a month for unit conversion. Brief 6.7 fixes this at 30. */
export const DAYS_PER_MONTH = 30;

/** Brief 6's fallback when the day basis is working days but the RFQ captured none. */
export const DEFAULT_WORKING_DAYS_PER_MONTH = 26;

/**
 * The day-basis context an RFQ contributes to the total (brief 6): the admin
 * setting decides which conversion applies, the RFQ supplies its own
 * working-days figure when the working basis is chosen.
 */
export interface DayBasisContext {
  rateDayBasis: "CALENDAR_DAYS" | "WORKING_DAYS_PER_MONTH";
  workingDaysPerMonth?: number | null;
}

/** Days a month counts as, under the configured basis. */
export function daysPerMonthFor(basis?: DayBasisContext | null): number {
  if (basis?.rateDayBasis === "WORKING_DAYS_PER_MONTH") {
    const days = basis.workingDaysPerMonth ?? DEFAULT_WORKING_DAYS_PER_MONTH;
    return days > 0 ? days : DEFAULT_WORKING_DAYS_PER_MONTH;
  }
  return DAYS_PER_MONTH;
}

/**
 * Converts the RFQ's duration into days, the unit the total is worked out in.
 *
 * A month is 30 days under the calendar basis (the brief's own instruction, not
 * any calendar reckoning: the number goes in an email to a customer and has to
 * be reproducible). Under the working-days basis the RFQ's captured figure —
 * or the 26-day fallback — is used instead. A duration that arrives as a
 * fraction is kept as a fraction here and rounded only at the point of
 * display, so the vendor can see the working.
 */
export function durationInDays(
  value: number,
  unit: DurationUnit,
  dayBasis?: DayBasisContext | null,
): number {
  return unit === DurationUnit.MONTHS ? value * daysPerMonthFor(dayBasis) : value;
}

/**
 * Works out the rental charge and the sentence explaining it.
 *
 * Brief 6.7: the total is the rental charge for the RFQ's duration plus
 * mobilisation. For Per Day or Per Month the rate is multiplied by the duration,
 * converting to days when the units differ. For Lump Sum the rate *is* the rental
 * charge — there is no duration to multiply, because the vendor has priced the
 * whole job.
 *
 * The note is stored, not just shown, so a receipt reprinted a year later
 * reproduces the same arithmetic the vendor agreed to.
 */
export function calculateTotal(input: {
  rentalRate: number;
  rateBasis: RateBasis;
  durationValue: number;
  durationUnit: DurationUnit;
  mobilisationCharges: number;
  demobilisationCharges?: number;
  /** Brief 6: month conversion basis; omitted means the calendar default. */
  dayBasis?: DayBasisContext | null;
}): { rentalCharge: number; total: number; note: string } {
  const {
    rentalRate,
    rateBasis,
    durationValue,
    durationUnit,
    mobilisationCharges,
    demobilisationCharges = 0,
    dayBasis,
  } = input;

  // The dues and returns travel together: every line of the note names both so
  // the arithmetic a receipt reproduces a year later is the one the vendor saw.
  const bothCharges =
    mobilisationCharges === 0 && demobilisationCharges === 0
      ? ""
      : mobilisationCharges === 0
        ? `plus demobilisation ${money(demobilisationCharges)} `
        : demobilisationCharges === 0
          ? `plus mobilisation ${money(mobilisationCharges)} `
          : `plus mobilisation ${money(mobilisationCharges)} and demobilisation ${money(demobilisationCharges)} `;

  if (rateBasis === RateBasis.LUMP_SUM) {
    const total = round2(rentalRate + mobilisationCharges + demobilisationCharges);
    return {
      rentalCharge: round2(rentalRate),
      total,
      note:
        `Lump sum ${money(rentalRate)} ${bothCharges}` +
        `= ${money(total)}. A lump sum is the whole job, so the ${trimNumber(durationValue)} ` +
        `${plural(durationUnit, durationValue)} rental period is not multiplied into it.`,
    };
  }

  const days = durationInDays(durationValue, durationUnit, dayBasis);

  let rentalCharge: number;
  let working: string;

  if (rateBasis === RateBasis.PER_DAY) {
    // Always multiply by days, whichever unit the duration arrived in. The
    // conversion belongs to the duration, never to the rate.
    rentalCharge = rentalRate * days;
    working =
      `${money(rentalRate)} per day × ${trimNumber(days)} ` +
      `${plural(DurationUnit.DAYS, days)} = ${money(rentalCharge)}`;
  } else if (durationUnit === DurationUnit.MONTHS) {
    rentalCharge = rentalRate * durationValue;
    working =
      `${money(rentalRate)} per month × ${trimNumber(durationValue)} ` +
      `${plural(DurationUnit.MONTHS, durationValue)} = ${money(rentalCharge)}`;
  } else {
    // A monthly rate priced against a duration given in days: turn the rate into
    // a daily one first, so the arithmetic shown matches the rate the vendor set.
    const perMonth = daysPerMonthFor(dayBasis);
    const perDay = rentalRate / perMonth;
    rentalCharge = perDay * days;
    working =
      `${money(rentalRate)} per month ÷ ${trimNumber(perMonth)} days = ` +
      `${money(perDay)} per day × ${trimNumber(days)} ` +
      `${plural(DurationUnit.DAYS, days)} = ${money(rentalCharge)}`;
  }

  const total = round2(rentalCharge + mobilisationCharges + demobilisationCharges);
  return {
    rentalCharge: round2(rentalCharge),
    total,
    note: `${working}, ${bothCharges}= ${money(total)}.`,
  };
}

const unitWord = (unit: DurationUnit) => (unit === DurationUnit.MONTHS ? "month" : "day");
const plural = (unit: DurationUnit, value: number) =>
  `${unitWord(unit)}${value === 1 ? "" : "s"}`;

/** Two decimals, avoiding float drift like 0.1 + 0.2. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Trims a trailing `.0` so a whole number does not read as "10.0". */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round2(value));
}

/** Indian-format rupees, so the working in the note matches the emails. */
function money(value: number): string {
  return `₹${round2(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const trimmed = (max: number) => z.string().trim().max(max);

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | null => {
      if (v === undefined || v === null) return null;
      const text = String(v).trim();
      return text === "" ? null : text;
    });

/** `validity_date` is a calendar date, anchored like every other one. See lib/dates. */
const calendarDateField = z
  .union([z.string(), z.date()])
  .transform((v, ctx) => {
    const parsed = parseDateInput(v);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date" });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * Quote validity: today or later.
 *
 * A quotation that expired before anyone read it is worse than useless — sales
 * would compare a dead price against a live one. Checked against the same UTC
 * anchor the rest of the calendar dates use, so this does not reject a date the
 * vendor entered this morning.
 */
export const validityDateField = calendarDateField.refine(
  (d) => startOfUtcDay(d) >= todayUtcMidnight(),
  "The validity date is today or later",
);

const commercialAnswer = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((v) => v === true || v === "true");

/**
 * Submitting a quotation (brief 6.7).
 *
 * `craneId` is the vendor's own crane and nothing else — a form field carrying a
 * crane id is a claim, not a fact, and the service re-checks ownership against
 * the token rather than trusting this.
 */
export const submitQuotationSchema = z.object({
  craneId: z.string().trim().min(1, "Choose a crane"),

  rentalRate: z.coerce
    .number({ message: "Enter the rental rate" })
    .positive("The rental rate must be greater than 0"),
  rateBasis: z.enum([RateBasis.PER_DAY, RateBasis.PER_MONTH, RateBasis.LUMP_SUM]),
  mobilisationCharges: z.coerce
    .number({ message: "Enter the mobilisation charges" })
    .min(0, "Mobilisation charges cannot be negative")
    .default(0),
  // Brief A2: demobilisation sits beside mobilisation, defaults to 0, and is
  // added into the total alongside it.
  demobilisationCharges: z.coerce
    .number({ message: "Enter the demobilisation charges" })
    .min(0, "Demobilisation charges cannot be negative")
    .default(0),
  // Whether the quoted total already includes GST. A declaration for like-for-
  // like comparison, not arithmetic; brief 6.7 defaults to Exclusive.
  taxBasis: z
    .enum(["EXCLUSIVE_OF_GST", "INCLUSIVE_OF_GST"])
    .default("EXCLUSIVE_OF_GST"),

  // The service decides whether this is required: an RFQ whose start date is
  // TBC (brief A3) does not ask the question, so the schema cannot refuse the
  // answer "no" unconditionally.
  availabilityConfirmed: commercialAnswer,
  /** Only meaningful for an Engaged crane; the service decides if it is needed. */
  availableFrom: z
    .union([z.string(), z.date(), z.null()])
    .optional()
    .transform((v): Date | null => (v == null || v === "" ? null : (parseDateInput(v) ?? null))),

  validityDate: validityDateField,

  acceptsCommercialTerms: commercialAnswer,
  /** Required when the vendor did not accept the terms, or the answer is noise. */
  deviationText: optionalText(2000),
  remarks: optionalText(2000),
});

export type SubmitQuotationInput = z.infer<typeof submitQuotationSchema>;

/**
 * Revising or withdrawing is a change to the numbers, so it takes the same body.
 *
 * The only difference is that `craneId` is not repeated: a revision belongs to
 * the version series of one crane, and letting the body move a revision onto a
 * different crane would fork the series the unique index keys on.
 */
export const reviseQuotationSchema = submitQuotationSchema
  .omit({ craneId: true })
  .extend({
    /** A reason is not required to revise, but the field is kept for withdrawal. */
    reason: optionalText(1000),
  });

export type ReviseQuotationInput = z.infer<typeof reviseQuotationSchema>;

/**
 * Withdrawing a quotation.
 *
 * A reason is not mandatory — brief 6.7 does not ask for one — but the field
 * exists because an unexplained withdrawal is the hardest thing for sales to
 * report back to a customer.
 */
export const withdrawQuotationSchema = z.object({
  reason: optionalText(1000),
});

/**
 * Declining the RFQ itself (brief 6.7).
 *
 * `note` is the vendor's chance to say what else they can offer, which the
 * enquiry mail explicitly invites. Neither field is required; both are kept.
 */
export const declineRfqSchema = z.object({
  reason: optionalText(500),
  note: optionalText(2000),
});

export type DeclineRfqInput = z.infer<typeof declineRfqSchema>;

/** The vendor inbox (brief 7.6): filters and default deadline sort. */
export const vendorInboxQuerySchema = z.object({
  responseStatus: z
    .enum(["PENDING", "QUOTED", "DECLINED", "EXPIRED", "FINALISED"])
    .optional(),
  search: z.string().trim().max(200).optional(),
});

export type VendorInboxQuery = z.infer<typeof vendorInboxQuerySchema>;
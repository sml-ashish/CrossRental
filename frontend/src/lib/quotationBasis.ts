import type { RateDayBasis } from "@/lib/settings";

/**
 * The day-basis arithmetic behind a quotation total, mirrored from the backend.
 *
 * The server owns the money. `backend/src/validation/quotationFields.ts` holds
 * `DAYS_PER_MONTH`, `DEFAULT_WORKING_DAYS_PER_MONTH`, `daysPerMonthFor`,
 * `durationInDays` and `calculateTotal`; this module reproduces the pieces the
 * Settings page needs for a worked example, and it has to stay in step with that
 * file. A preview that disagrees with the total the vendor is sent is worse than
 * no preview, so nothing here invents a rule of its own.
 */

/** Brief 6.7 fixes a calendar month at 30 days for unit conversion. */
export const DAYS_PER_MONTH = 30;

/** Brief 6's fallback when the basis is working days and the RFQ captured none. */
export const DEFAULT_WORKING_DAYS_PER_MONTH = 26;

export interface DayBasis {
  rateDayBasis: RateDayBasis;
  workingDaysPerMonth?: number | null;
}

/** Days a month counts as, under the given basis. */
export function daysPerMonthFor(basis: DayBasis): number {
  if (basis.rateDayBasis === "WORKING_DAYS_PER_MONTH") {
    const days = basis.workingDaysPerMonth ?? DEFAULT_WORKING_DAYS_PER_MONTH;
    return days > 0 ? days : DEFAULT_WORKING_DAYS_PER_MONTH;
  }
  return DAYS_PER_MONTH;
}

/** A hire measured in months, converted to days. */
export function durationInDays(months: number, basis: DayBasis): number {
  return months * daysPerMonthFor(basis);
}

/** Two decimals, avoiding float drift like 0.1 + 0.2. Mirrors the backend. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The rental charge for a per-day rate over a hire counted in months, before
 * mobilisation, demobilisation and tax.
 *
 * This is the one shape where the admin's choice moves the total: a monthly
 * rate against a monthly hire multiplies out the same either way, and a lump sum
 * has no duration to convert. A per-day rate against a two-month hire does, so
 * that is what the worked example shows.
 */
export function perDayHireTotal(ratePerDay: number, months: number, basis: DayBasis): number {
  return round2(ratePerDay * durationInDays(months, basis));
}

/** The example printed under the options: ₹8,000 a day for a two-month hire. */
export const WORKED_EXAMPLE = { ratePerDay: 8_000, months: 2 } as const;

/** Indian-format rupees without the paise, since the example is round. */
export function formatRupees(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

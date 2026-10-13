/**
 * Calendar dates: one anchor, chosen so the answer cannot depend on the server.
 *
 * A `date` input sends `YYYY-MM-DD`, and the language parses that as **UTC**
 * midnight. Truncating it afterwards with the local `setHours(0,0,0,0)` re-reads
 * that instant in the server's own timezone, so the same request stored a
 * different day depending on where it was deployed: at UTC-4, a vendor who picked
 * 5 October got 4 October stored. Nothing caught it because tests run at UTC,
 * where both readings coincide.
 *
 * UTC is the anchor rather than any local zone because these are calendar dates,
 * not instants — "free from the 5th" is the same sentence everywhere — and
 * because Prisma compares `TIMESTAMP` columns as instants, so both sides of a
 * date comparison have to share an anchor. UTC is the only one that is stable
 * across deployments.
 *
 * A real moment in time is a different thing and deliberately not routed through
 * here: `submissionDeadline` is a `datetime-local`, and it is compared against
 * `now`, so it stays a genuine instant.
 */

/** `YYYY-MM-DD`, and nothing else — a bare month or a locale format is not a date. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a date-only string, which the API and the date inputs both send. */
export function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && CALENDAR_DATE.test(value);
}

/**
 * UTC midnight of the day an instant falls on.
 *
 * Truncating by UTC rather than local is what keeps this consistent with
 * {@link parseCalendarDate}: a value that arrived as `2026-10-05` truncates to
 * `2026-10-05T00:00Z`, not to whichever day that instant lands on locally.
 */
export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/**
 * `YYYY-MM-DD` to UTC midnight. Returns `null` for a real date the string cannot
 * express — 31 February, say — rather than letting `Date.UTC` roll it over into
 * March and store a day the user never asked for.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!isCalendarDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC(2026, 1, 31) is 3 March, so a rollover means the input was not a
  // real date and has to be rejected instead of silently accepted.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

/**
 * Parses whatever a date field may carry: a date-only string becomes its UTC
 * midnight, a full timestamp is kept as the instant it names.
 */
export function parseDateInput(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (isCalendarDate(value)) return parseCalendarDate(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Start of today, on the same anchor as {@link parseCalendarDate}.
 *
 * "Today" is the server's today, which is a real limitation: a vendor in a zone
 * ahead of the deployment would be told their own today is still tomorrow for a
 * few hours. It is the honest behaviour for a single-region deployment, and
 * fixing it properly means sending the browser's zone with the request.
 */
export function todayUtcMidnight(now: Date = new Date()): Date {
  return startOfUtcDay(now);
}

/** `YYYY-MM-DD`, read back in UTC so a calendar date displays as itself. */
export function toCalendarDateString(value: Date | null | undefined): string {
  if (!value) return "";
  if (Number.isNaN(value.getTime())) return "";
  return value.toISOString().slice(0, 10);
}
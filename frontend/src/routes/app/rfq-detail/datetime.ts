/**
 * One way to print an RFQ deadline on this screen.
 *
 * The old header printed `20/11/2026, 05:30:00`, which leaves the reader to
 * guess the order of day and month, the meaning of the seconds and the zone.
 * Deadlines are moments in time and this business runs in one zone, so they are
 * printed in Asia/Kolkata and labelled as such; the exact instant stays in the
 * tooltip.
 */

const ZONE = "Asia/Kolkata";

function valid(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Fri 20 Nov, 5:30 am" — no seconds, no ambiguous numeric month. */
export function formatDeadline(iso: string | null): string {
  const date = valid(iso);
  if (!date) return "—";
  const weekday = date.toLocaleDateString("en-GB", { timeZone: ZONE, weekday: "short" });
  const day = date.toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric" });
  const month = date.toLocaleDateString("en-GB", { timeZone: ZONE, month: "short" });
  const time = date
    .toLocaleTimeString("en-GB", {
      timeZone: ZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `${weekday} ${day} ${month}, ${time}`;
}

/** The full instant, for the tooltip: "Friday, 20 November 2026 at 05:30:00 GMT+5:30". */
export function formatDeadlineExact(iso: string | null): string {
  const date = valid(iso);
  if (!date) return "—";
  return date.toLocaleString("en-GB", {
    timeZone: ZONE,
    dateStyle: "full",
    timeStyle: "long",
  });
}

/** "20 Nov" — a calendar day, read in UTC like the rest of the brief's dates. */
export function dayMonth(iso: string | null): string {
  const date = valid(iso);
  if (!date) return "—";
  return date.toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
}

/** "18 Nov 2026" — a start date, printed as the calendar day it names. */
export function startDateLabel(iso: string | null): string {
  const date = valid(iso);
  if (!date) return "—";
  return date.toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export const DEADLINE_ZONE_LABEL = ZONE;

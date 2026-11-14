import type { DurationUnit, RfqRollupStatus, RfqStatus } from "./rfqs";

/**
 * The words and tones the RFQ surfaces share.
 *
 * `statusTone` and `deadlineCountdown` are re-exported from the tracking page
 * because the detail screen already imports them from there; everything here is
 * plain display logic so the page and the preview drawer cannot drift apart.
 */

export type Tone = "neutral" | "soon" | "overdue";

/** A status is a dot and a word. Draft is deliberately neutral, never amber. */
export function statusTone(status: RfqStatus): { dot: string; text: string } {
  switch (status) {
    case "CLOSED":
      return { dot: "bg-emerald-500", text: "text-emerald-600" };
    case "CANCELLED":
      // Muted grey-red: cancelled is an outcome, not an alarm.
      return { dot: "bg-red-700/70", text: "text-red-600/80" };
    case "DRAFT":
      return { dot: "bg-slate-500", text: "text-slate-600" };
    default:
      return { dot: "bg-blue-500", text: "text-blue-600" };
  }
}

/**
 * The status column's actual word.
 *
 * A sent RFQ says what the replies are doing, because "Sent" repeats the tab and
 * hides the one distinction that matters: has anything come back yet.
 */
export function statusDisplay(
  status: RfqStatus,
  rollup: RfqRollupStatus | null,
): { label: string; dot: string; text: string } {
  if (status === "SENT") {
    if (rollup === "QUOTES_RECEIVED") {
      return { label: "Quotes received", dot: "bg-amber-500", text: "text-amber-600" };
    }
    if (rollup === "AWAITING_QUOTES") {
      return { label: "Awaiting quotes", dot: "bg-blue-500", text: "text-blue-600" };
    }
    return { label: "Sent", dot: "bg-blue-500", text: "text-blue-600" };
  }
  const tone = statusTone(status);
  const label =
    status === "DRAFT"
      ? "Draft"
      : status === "CLOSED"
        ? "Finalised"
        : status === "CANCELLED"
          ? "Cancelled"
          : "Sent";
  return { label, ...tone };
}

function plural(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? "" : "s"}`;
}

/**
 * How far away a deadline is, in plain language.
 *
 * Under 48 hours the unit becomes hours, because "in 2 days" is too coarse for
 * the window in which a reminder actually changes anything.
 */
export function deadlineRelative(
  deadline: string,
  now = Date.now(),
): { label: string; tone: Tone } {
  const target = new Date(deadline).getTime();
  if (Number.isNaN(target)) return { label: "—", tone: "neutral" };

  const ms = target - now;
  if (ms <= 0) {
    const hours = Math.max(1, Math.floor(-ms / 3_600_000));
    if (hours < 24) return { label: `passed ${hours} h ago`, tone: "overdue" };
    return { label: `passed ${plural(Math.floor(hours / 24), "day")} ago`, tone: "overdue" };
  }

  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 48) return { label: `in ${hours} h`, tone: "soon" };
  return { label: `in ${plural(Math.ceil(ms / 86_400_000), "day")}`, tone: "neutral" };
}

/**
 * The countdown for a live RFQ.
 *
 * A draft is not racing the deadline — it cannot be sent until the deadline is
 * changed — so it is described by its age instead of a countdown.
 */
export function deadlineCountdown(
  deadline: string,
  status: RfqStatus,
  now = Date.now(),
): { label: string; tone: Tone } {
  if (status === "CANCELLED") return { label: "cancelled", tone: "neutral" };
  if (status === "CLOSED") return { label: "finalised", tone: "neutral" };
  if (status === "DRAFT") return { label: "not sent yet", tone: "neutral" };
  return deadlineRelative(deadline, now);
}

/** "13 Nov 2026" — a deadline is a moment, so the browser's zone is right. */
export function formatDeadlineDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "2 Dec" — a calendar date, printed as the UTC day it names (brief 6.4). */
export function formatStartShort(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short" });
}

export function durationLabel(value: number, unit: DurationUnit): string {
  const word = unit === "MONTHS" ? "month" : "day";
  return plural(value, word);
}

/** Whole days between the stored calendar date and today's local day. */
function startDayOffset(iso: string, now: number): number {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return 0;
  const targetDay = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
  );
  const today = new Date(now);
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((targetDay - todayDay) / 86_400_000);
}

/**
 * The start line under the deadline.
 *
 * A date that has already passed is said out loud: it usually means the lift is
 * wanted now and nobody has booked it, which is exactly the sort of thing a
 * tracking list should not hide.
 */
export function startNote(
  requiredStartDate: string,
  startDateTbc: boolean,
  durationValue: number,
  durationUnit: DurationUnit,
  now = Date.now(),
): { label: string; tone: "neutral" | "warn" } {
  if (startDateTbc) return { label: "Start TBC", tone: "warn" };

  const offset = startDayOffset(requiredStartDate, now);
  if (offset === 0) {
    return {
      label: `Starts today · ${durationLabel(durationValue, durationUnit)}`,
      tone: "neutral",
    };
  }
  if (offset < 0) {
    return {
      label: `Start passed ${plural(Math.abs(offset), "day")} ago`,
      tone: "warn",
    };
  }
  return {
    label: `Starts ${formatStartShort(requiredStartDate)} · ${durationLabel(
      durationValue,
      durationUnit,
    )}`,
    tone: "neutral",
  };
}

/** "Draft for 27 days" — age is the only clock a draft is on. */
export function draftAge(createdAt: string, now = Date.now()): string {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return "Draft";
  const days = Math.floor((now - created) / 86_400_000);
  if (days <= 0) return "Draft since today";
  return `Draft for ${plural(days, "day")}`;
}

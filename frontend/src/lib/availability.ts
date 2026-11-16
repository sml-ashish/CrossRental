import type { CalendarCrane, CalendarDay, CalendarDayState } from "@/lib/calendar";

/**
 * Pure answers to the only question this screen asks: "which cranes are free
 * between these dates?"
 *
 * Everything here is a fold over a crane's day array. Keeping the folds out of
 * the component makes the sentence under each strip deterministic and keeps the
 * grouping, the strip and the expanded booking list from disagreeing.
 *
 * Day keys are UTC calendar dates (`YYYY-MM-DD`), matching the backend.
 */

const DAY_MS = 86_400_000;

/** The API accepts at most 92 days per calendar request. */
export const MAX_CHUNK_DAYS = 92;

export type StripKind = "free" | "booked" | "unavailable";
export type RangeClass = "whole" | "part" | "none";

export interface DaySegment {
  state: CalendarDayState;
  kind: StripKind;
  reservationId: string | null;
  start: string;
  end: string;
  days: number;
}

export interface RangeAvailability {
  kind: RangeClass;
  /** Every day in the range, collapsed into same-state runs. */
  segments: DaySegment[];
  freeDays: number;
  totalDays: number;
  /** The one plain sentence shown at the right of the row. */
  sentence: string;
  /** "Booked 5 to 9 Dec" — what is in the way, for a partly free crane. */
  blocker: string | null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function utcDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayKey(now: Date = new Date()): string {
  return isoDay(now);
}

export function addDays(day: string, delta: number): string {
  return isoDay(new Date(utcDate(day).getTime() + delta * DAY_MS));
}

export function diffDays(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / DAY_MS);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(day: string): number {
  return (utcDate(day).getUTCDay() + 6) % 7;
}

export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(utcDate(value).getTime());
}

/** Inclusive list of day keys. */
export function daysBetween(from: string, to: string): string[] {
  const count = Math.max(0, diffDays(from, to) + 1);
  const start = utcDate(from).getTime();
  return Array.from({ length: count }, (_, index) => isoDay(new Date(start + index * DAY_MS)));
}

/**
 * Split a range into requests the API will accept.
 *
 * A custom window is allowed to be longer than 92 days; the page then asks for
 * it in consecutive chunks and merges the answers, so the ceiling never becomes
 * a user-facing limit.
 */
export function splitRange(from: string, to: string): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, MAX_CHUNK_DAYS - 1);
    const chunkEnd = end < to ? end : to;
    chunks.push({ from: start, to: chunkEnd });
    start = addDays(chunkEnd, 1);
  }
  return chunks;
}

const dayFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const fullDayFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2 Dec" */
export function formatDay(day: string): string {
  return dayFormat.format(utcDate(day));
}

/** "Tue 2 Dec 2026" — for a title or a screen-reader label. */
export function formatDayFull(day: string): string {
  return fullDayFormat.format(utcDate(day));
}

/** "2 Dec – 31 Jan" */
export function formatRange(from: string, to: string): string {
  if (from === to) return formatDay(from);
  return `${formatDay(from)} – ${formatDay(to)}`;
}

/** "5 to 9 Dec" (same month), "28 Dec to 3 Jan", or "5 Dec". */
export function formatSpan(start: string, end: string): string {
  if (start === end) return formatDay(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${utcDate(start).getUTCDate()} to ${formatDay(end)}`
    : `${formatDay(start)} to ${formatDay(end)}`;
}

// ---------------------------------------------------------------------------
// Day states and segments
// ---------------------------------------------------------------------------

export function stripKind(state: CalendarDayState): StripKind {
  switch (state) {
    case "HIRED":
    case "RESERVED":
      return "booked";
    case "BLOCKED":
    case "UNAVAILABLE":
      return "unavailable";
    default:
      return "free";
  }
}

/** "On hire", "Reserved", … — the real wording for a booking line. */
export function stateWord(state: CalendarDayState): string {
  switch (state) {
    case "HIRED":
      return "On hire";
    case "RESERVED":
      return "Reserved";
    case "BLOCKED":
      return "Blocked";
    case "UNAVAILABLE":
      return "Under maintenance";
    default:
      return "Free";
  }
}

/** The word used mid-sentence: "then booked", "then in maintenance". */
function busyWord(state: CalendarDayState): string {
  switch (state) {
    case "HIRED":
    case "RESERVED":
      return "booked";
    case "BLOCKED":
      return "blocked";
    default:
      return "in maintenance";
  }
}

/** The word that starts a sentence: "Booked until…", "In maintenance until…". */
function busyLead(state: CalendarDayState): string {
  switch (state) {
    case "HIRED":
    case "RESERVED":
      return "Booked";
    case "BLOCKED":
      return "Blocked";
    default:
      return "In maintenance";
  }
}

/** Collapse consecutive days of the same state and reservation into one run. */
export function collapseDays(days: CalendarDay[]): DaySegment[] {
  const segments: DaySegment[] = [];
  for (const day of days) {
    const last = segments[segments.length - 1];
    if (
      last &&
      last.state === day.state &&
      last.reservationId === day.reservationId &&
      addDays(last.end, 1) === day.date
    ) {
      last.end = day.date;
      last.days += 1;
      continue;
    }
    segments.push({
      state: day.state,
      kind: stripKind(day.state),
      reservationId: day.reservationId,
      start: day.date,
      end: day.date,
      days: 1,
    });
  }
  return segments;
}

/** The crane's days inside the range, in order, collapsed into runs. */
export function segmentsWithin(crane: CalendarCrane, from: string, to: string): DaySegment[] {
  return collapseDays(crane.days.filter((day) => day.date >= from && day.date <= to));
}

/** Only the runs that keep a crane off the market — the expanded booking list. */
export function bookingsWithin(crane: CalendarCrane, from: string, to: string): DaySegment[] {
  return segmentsWithin(crane, from, to).filter((segment) => segment.kind !== "free");
}

/** "On hire, 12 Nov to 3 Jan" / "Blocked, 5 Dec". */
export function bookingLine(segment: DaySegment): string {
  return `${stateWord(segment.state)}, ${formatSpan(segment.start, segment.end)}`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function availabilityText(crane: CalendarCrane, from: string, to: string): Omit<RangeAvailability, "segments" | "freeDays" | "totalDays"> {
  const days = crane.days.filter((day) => day.date >= from && day.date <= to);
  const totalDays = Math.max(1, diffDays(from, to) + 1);

  if (days.length === 0) {
    return { kind: "none", sentence: "Not free in this period", blocker: null };
  }

  const freeDays = days.filter((day) => day.state === "FREE").length;
  if (freeDays === totalDays) {
    return { kind: "whole", sentence: "Free the whole time", blocker: null };
  }

  const firstBusyIndex = days.findIndex((day) => day.state !== "FREE");

  if (freeDays === 0) {
    // The run may continue beyond the visible window. Looking at the crane's
    // whole horizon gives "until 3 Jan" instead of stopping at the last column.
    const all = crane.days;
    const startIndex = all.findIndex((day) => day.date === from);
    const first = all[startIndex] ?? days[0]!;
    let endIndex = startIndex >= 0 ? startIndex : 0;
    while (endIndex + 1 < all.length && all[endIndex + 1]!.state !== "FREE") endIndex += 1;
    const runEnd = all[endIndex]?.date ?? first.date;
    const next = all[endIndex + 1]?.date ?? null;

    const sentence =
      first.state === "UNAVAILABLE"
        ? `In maintenance until ${formatDay(runEnd)}`
        : next
          ? `${busyLead(first.state)} until ${formatDay(runEnd)}, free from ${formatDay(next)}`
          : `${busyLead(first.state)} for the rest of this period`;

    const firstSegment = collapseDays(days).find((segment) => segment.kind !== "free")!;
    return {
      kind: "none",
      sentence,
      blocker: `${stateWord(firstSegment.state)} ${formatSpan(firstSegment.start, firstSegment.end)}`,
    };
  }

  const segments = collapseDays(days);
  const firstBusy = days[firstBusyIndex]!;

  if (firstBusyIndex === 0) {
    // Starts busy, becomes free: "Booked until 3 Jan, free from 4 Jan".
    const firstFreeIndex = days.findIndex((day) => day.state === "FREE");
    const lastBusy = days[firstFreeIndex - 1]!;
    const nextFree = days[firstFreeIndex]!;
    const sentence = `${busyLead(firstBusy.state)} until ${formatDay(lastBusy.date)}, free from ${formatDay(nextFree.date)}`;
    return {
      kind: "part",
      sentence,
      blocker: `${stateWord(firstBusy.state)} ${formatSpan(segments[0]!.start, segments[0]!.end)}`,
    };
  }

  // Starts free, then busy: "Free until 9 Dec, then booked".
  const lastFree = days[firstBusyIndex - 1]!;
  const firstBusySegment = segments.find((segment) => segment.kind !== "free")!;
  return {
    kind: "part",
    sentence: `Free until ${formatDay(lastFree.date)}, then ${busyWord(firstBusy.state)}`,
    blocker: `${stateWord(firstBusy.state)} ${formatSpan(firstBusySegment.start, firstBusySegment.end)}`,
  };
}

export function classifyRange(crane: CalendarCrane, from: string, to: string): RangeAvailability {
  const days = crane.days.filter((day) => day.date >= from && day.date <= to);
  const base = availabilityText(crane, from, to);
  return {
    ...base,
    segments: collapseDays(days),
    freeDays: days.filter((day) => day.state === "FREE").length,
    totalDays: Math.max(1, diffDays(from, to) + 1),
  };
}

// ---------------------------------------------------------------------------
// Grouping and sorting
// ---------------------------------------------------------------------------

export interface ClassifiedCrane {
  crane: CalendarCrane;
  availability: RangeAvailability;
}

export interface RangeGroups {
  whole: ClassifiedCrane[];
  part: ClassifiedCrane[];
  none: ClassifiedCrane[];
}

/**
 * Sort within a group by the smallest crane that still clears the requirement,
 * then by name. A 250 t ask should lead with the 250, not the 750.
 */
export function sortByRequirement(rows: ClassifiedCrane[]): ClassifiedCrane[] {
  return [...rows].sort(
    (a, b) =>
      a.crane.capacityT - b.crane.capacityT ||
      a.crane.craneLabel.localeCompare(b.crane.craneLabel),
  );
}

export function groupByAvailability(rows: ClassifiedCrane[]): RangeGroups {
  return {
    whole: sortByRequirement(rows.filter((row) => row.availability.kind === "whole")),
    part: sortByRequirement(rows.filter((row) => row.availability.kind === "part")),
    none: sortByRequirement(rows.filter((row) => row.availability.kind === "none")),
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface AvailabilityFilters {
  type: string;
  min: string;
  state: string;
  q: string;
}

export const EMPTY_FILTERS: AvailabilityFilters = {
  type: "",
  min: "",
  state: "",
  q: "",
};

export function matchesFilters(crane: CalendarCrane, filters: AvailabilityFilters): boolean {
  if (filters.type && crane.craneTypeCode !== filters.type) return false;
  if (filters.state && crane.stateCode !== filters.state) return false;
  if (filters.min) {
    const min = Number(filters.min);
    if (Number.isFinite(min) && crane.capacityT < min) return false;
  }
  const q = filters.q.trim().toLowerCase();
  if (q) {
    const haystack = [
      crane.craneLabel,
      crane.vendorName,
      crane.currentLocation,
      crane.stateName,
      crane.craneTypeName,
      `${crane.capacityT} t`,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface RangePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

export function presetsFor(today: string): RangePreset[] {
  return [
    { key: "week", label: "This week", from: today, to: addDays(today, 6 - weekdayIndex(today)) },
    { key: "2w", label: "Next 2 weeks", from: today, to: addDays(today, 13) },
    { key: "month", label: "Next month", from: today, to: addDays(today, 29) },
    { key: "3m", label: "Next 3 months", from: today, to: addDays(today, 89) },
  ];
}

export function defaultRange(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, 29) };
}

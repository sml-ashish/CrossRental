import type { Crane } from "./fleet";
import type { DashboardAwaitingRfq, DashboardDueCrane, VendorDashboard } from "./dashboard";
import { titleCase } from "./format";

/**
 * Words and figures for the vendor's landing screen (brief 7.5).
 *
 * The dashboard payload is a set of counters and rows. A vendor does not read
 * counters; they read "closes in 6 hours" and "which of my cranes can do this".
 * These helpers turn the payload into that language and keep the page itself
 * about layout and actions. Nothing here writes data or guesses at a field the
 * server did not send: when a fact is missing the helper returns `null` and the
 * page omits the line.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

function plural(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? "" : "s"}`;
}

/** "250" or "250.5" — capacities are scanned, so no trailing ".0". */
export function formatCapacity(value: number | string): string {
  const capacity = Number(value);
  if (!Number.isFinite(capacity)) return String(value);
  return Number.isInteger(capacity) ? String(capacity) : capacity.toFixed(1);
}

/** "Mon 16 Nov, 5:30 am" — a deadline is a moment, so the browser's zone is right. */
export function formatDayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = date
    .toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/[\u202f\u00a0]/g, " ");
  return `${day}, ${time}`;
}

/**
 * "Fri 27 Nov". Calendar dates are anchored at UTC midnight (brief 6.4), so the
 * UTC day is the one that was stored — formatting in the browser's zone would
 * print the previous day west of UTC.
 */
export function formatDayMonth(iso: string, calendarDate = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    ...(calendarDate ? { timeZone: "UTC" } : {}),
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The full moment, for the tooltip behind a short date. */
export function fullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** The full date without a time, for a calendar date that has no time of day. */
export function fullDate(iso: string, calendarDate = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    ...(calendarDate ? { timeZone: "UTC" } : {}),
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "Good morning" — the page greets the person, not the account. */
export function greetingFor(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export type DeadlineTone = "neutral" | "soon" | "closed";

export interface DeadlineInfo {
  label: string;
  tone: DeadlineTone;
  /** The full timestamp for a hover title. */
  full: string;
  closed: boolean;
}

/**
 * The one line that tells a vendor whether they still have time.
 *
 * Under 48 hours the unit becomes hours, because "in 2 days" is too coarse for
 * the window in which a reminder actually changes anything. Past that the count
 * is calendar days, which is what the "Coming up" timeline beside it shows — two
 * different numbers for the same deadline on one screen reads as a bug.
 */
export function deadlineInfo(deadline: string, now = Date.now()): DeadlineInfo {
  const target = new Date(deadline).getTime();
  const full = fullTimestamp(deadline);
  if (Number.isNaN(target)) {
    return { label: "Closing date unavailable", tone: "neutral", full, closed: false };
  }
  if (target <= now) {
    return {
      label: `Closed ${formatDayMonth(deadline)}. You can no longer quote.`,
      tone: "closed",
      full,
      closed: true,
    };
  }

  const ms = target - now;
  if (ms < 48 * HOUR) {
    const hours = Math.max(1, Math.ceil(ms / HOUR));
    return {
      label: `Closes in ${plural(hours, "hour")}`,
      tone: "soon",
      full,
      closed: false,
    };
  }

  const days = Math.max(1, Math.round((localDay(target) - localDay(now)) / DAY));
  return {
    label: `Closes in ${plural(days, "day")}`,
    tone: "neutral",
    full,
    closed: false,
  };
}

/**
 * "Pune, Maharashtra" — city and state only, title-cased, state never doubled.
 *
 * Site text is typed by hand. A stored "pune, Gujarat" and a separate state
 * field can otherwise print as "pune, Gujarat, Gujarat"; taking the first
 * segment as the city also keeps a vendor from seeing more of the site than the
 * brief allows.
 */
export function placeLabel(siteLocation: string, siteStateName: string): string {
  const city = titleCase((siteLocation.split(",")[0] ?? siteLocation).trim());
  const state = titleCase(siteStateName.trim());
  if (!city) return state || "Site not given";
  if (!state || city.toLowerCase() === state.toLowerCase()) return city;
  return `${city}, ${state}`;
}

/** "Crawler crane" — the noun stays lower-case when it trails the type name. */
export function typePhrase(name: string | null | undefined): string {
  const clean = titleCase((name ?? "").trim() || "Crane");
  if (/^crane$/i.test(clean)) return "Crane";
  return clean.replace(/\s+Crane$/i, " crane");
}

/** "Crawler crane · 250 t" — the requirement is the card's title. */
export function requirementTitle(row: DashboardAwaitingRfq): string {
  return `${typePhrase(row.craneTypeName || row.craneType)} · ${formatCapacity(row.capacityT)} t`;
}

/** What the vendor has done about this RFQ, in their words. */
export function quoteStatusText(row: DashboardAwaitingRfq): string {
  const quotes = Math.max(0, row.liveQuotationCount);
  if (quotes > 0) return `You've sent ${plural(quotes, "quote")}`;
  switch (row.responseStatus) {
    case "QUOTED":
      return "You've sent a quote";
    case "DECLINED":
      return "You declined this RFQ.";
    case "EXPIRED":
      return "This RFQ expired without a quote from you.";
    case "FINALISED":
      return "This RFQ was finalised before you quoted.";
    default:
      return "No quote sent yet";
  }
}

export interface CraneSuggestion {
  cranes: { id: string; serial: string; capacityT: number }[];
}

/**
 * The vendor's own cranes that could do this job.
 *
 * Matching is deliberately conservative: the same type code, at least the
 * required capacity, currently Available, and not carrying an SML booking. If
 * either side of that comparison is missing the helper returns `null` and the
 * card says nothing rather than guessing.
 */
export function suggestCranes(
  cranes: Crane[] | null,
  row: DashboardAwaitingRfq,
  bookedCraneIds: ReadonlySet<string>,
): CraneSuggestion | null {
  if (cranes === null) return null;
  const typeCode = row.craneType?.trim();
  const capacity = Number(row.capacityT);
  if (!typeCode || !Number.isFinite(capacity) || capacity <= 0) return null;

  return {
    cranes: cranes
      .filter(
        (crane) =>
          crane.isActive &&
          crane.typeOfCraneCode === typeCode &&
          Number(crane.capacityT) >= capacity &&
          crane.currentStatus === "AVAILABLE" &&
          !bookedCraneIds.has(crane.id),
      )
      .map((crane) => ({
        id: crane.id,
        serial: crane.serialRegistrationNo,
        capacityT: Number(crane.capacityT),
      })),
  };
}

export interface FleetStats {
  total: number;
  free: number;
  onHire: number;
  booked: number;
  maintenance: number;
  engaged: number;
  needCheck: number;
  segments: { key: string; label: string; count: number; dot: string }[];
}

/**
 * The fleet in one line.
 *
 * When the full crane list is available the statuses are overlaid with the
 * bookings the dashboard derived, because a crane on an SML contract can still
 * carry "Available" underneath and would otherwise be counted as free.
 */
export function fleetStats(data: VendorDashboard, cranes: Crane[] | null): FleetStats {
  const bookingStatus = new Map(
    data.fleet.bookings.cranes.map((booking) => [booking.craneId, booking.currentStatus]),
  );
  const counts: Record<string, number> = {};

  if (cranes) {
    for (const crane of cranes.filter((row) => row.isActive)) {
      const derived = bookingStatus.get(crane.id);
      const status =
        derived === "BOOKED" || derived === "HIRED" ? derived : crane.currentStatus;
      counts[status] = (counts[status] ?? 0) + 1;
    }
  } else {
    for (const [status, count] of Object.entries(data.fleet.byStatus)) {
      counts[status] = count;
    }
  }

  const segments = [
    { key: "AVAILABLE", label: "free now", dot: "bg-emerald-500" },
    { key: "HIRED", label: "on hire", dot: "bg-emerald-700" },
    { key: "BOOKED", label: "booked", dot: "bg-slate-600" },
    { key: "ENGAGED", label: "engaged", dot: "bg-slate-500" },
    { key: "DEPLOYED", label: "deployed", dot: "bg-slate-500" },
    { key: "UNDER_MAINTENANCE", label: "under maintenance", dot: "bg-slate-400" },
  ]
    .map((segment) => ({ ...segment, count: counts[segment.key] ?? 0 }))
    .filter((segment) => segment.count > 0);

  return {
    total: data.fleet.totalCranes,
    free: counts.AVAILABLE ?? 0,
    onHire: counts.HIRED ?? 0,
    booked: counts.BOOKED ?? 0,
    maintenance: counts.UNDER_MAINTENANCE ?? 0,
    engaged: counts.ENGAGED ?? 0,
    needCheck: data.fleet.dueForUpdate.length,
    segments,
  };
}

/** "Marked engaged 9 days ago. The availability date has passed." */
export function dueReason(row: DashboardDueCrane): { lead: string; details: string[] } {
  const status = row.currentStatus.replaceAll("_", " ").toLowerCase();
  const days = Math.max(0, row.daysSinceUpdate);
  const when = days === 0 ? "today" : `${plural(days, "day")} ago`;
  const details: string[] = [];
  if (row.availableFromLapsed) details.push("The availability date has passed.");
  if (row.locationUnverified) details.push("The map location isn't confirmed.");
  return { lead: `Marked ${status} ${when}.`, details };
}

/** "Crawler crane 600 t · DEMO-MK-0107" — the label with its serial split out. */
export function craneRowName(row: DashboardDueCrane, crane?: Crane): string {
  if (crane) {
    return `${typePhrase(crane.typeOfCrane?.name)} ${formatCapacity(crane.capacityT)} t · ${crane.serialRegistrationNo}`;
  }
  const [requirement, serial] = row.label.split(" — ");
  return serial ? `${requirement} · ${serial}` : row.label;
}

/** The serial at the end of a dashboard label, for timelines. */
export function craneSerial(label: string): string {
  const parts = label.split(" — ");
  return (parts[1] ?? parts[0] ?? label).trim();
}

export interface ComingUpItem {
  key: string;
  date: string;
  dateLabel: string;
  /** The full date (or moment) for the hover title behind `dateLabel`. */
  full: string;
  label: string;
  detail?: string;
  note: string;
}

function utcDay(iso: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function localDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function addUtcDays(iso: string, days: number): string {
  return new Date(utcDay(iso) + days * DAY).toISOString();
}

function relativeDayNote(dayIndex: number): string {
  if (dayIndex === 0) return "today";
  if (dayIndex === 1) return "tomorrow";
  return `in ${plural(dayIndex, "day")}`;
}

/**
 * The next 30 days, from bookings and RFQ deadlines.
 *
 * A booking that is running now contributes its finish, a future one its start.
 * Nothing outside the window is shown, and the list is capped so the side
 * column stays a glance rather than a second calendar.
 */
export function buildComingUp(
  data: VendorDashboard,
  now = Date.now(),
): { thisWeek: ComingUpItem[]; later: ComingUpItem[] } {
  const today = localDay(now);
  const items: (ComingUpItem & { dayIndex: number })[] = [];

  const push = (
    item: Omit<ComingUpItem, "note" | "dateLabel" | "full"> & {
      dayIndex: number;
      calendarDate: boolean;
    },
  ) => {
    if (item.dayIndex < 0 || item.dayIndex > 30) return;
    items.push({
      key: item.key,
      date: item.date,
      dateLabel: formatDayMonth(item.date, item.calendarDate),
      full: item.calendarDate ? fullDate(item.date, true) : fullTimestamp(item.date),
      label: item.label,
      detail: item.detail,
      note: relativeDayNote(item.dayIndex),
      dayIndex: item.dayIndex,
    });
  };

  for (const booking of data.fleet.bookings.cranes) {
    const serial = craneSerial(booking.label);

    if (booking.startDate) {
      const startIndex = Math.round((utcDay(booking.startDate) - today) / DAY);
      if (startIndex >= 0) {
        push({
          key: `${booking.craneId}-start`,
          date: booking.startDate,
          label: `${serial} booking starts`,
          detail: booking.endDate
            ? `Hire runs until ${formatDayMonth(booking.endDate, true)}`
            : undefined,
          dayIndex: startIndex,
          calendarDate: true,
        });
      }
    }

    if (booking.endDate) {
      const endIndex = Math.round((utcDay(booking.endDate) - today) / DAY);
      if (endIndex >= 0) {
        push({
          key: `${booking.craneId}-end`,
          date: booking.endDate,
          label: `${serial} finishes its hire`,
          detail: `Free from ${formatDayMonth(addUtcDays(booking.endDate, 1), true)}`,
          dayIndex: endIndex,
          calendarDate: true,
        });
      }
    }
  }

  for (const row of data.rfqs.awaitingResponse) {
    const deadline = new Date(row.deadline).getTime();
    if (Number.isNaN(deadline) || deadline <= now) continue;
    const deadlineDay = localDay(deadline);
    push({
      key: `rfq-${row.rfqId}`,
      date: row.deadline,
      label: `${row.rfqNumber} closes`,
      detail: requirementTitle(row),
      dayIndex: Math.round((deadlineDay - today) / DAY),
      calendarDate: false,
    });
  }

  const sorted = items
    .sort((a, b) => a.dayIndex - b.dayIndex || a.label.localeCompare(b.label))
    .slice(0, 6);

  const strip = ({ dayIndex: _dayIndex, ...item }: (typeof sorted)[number]) => item;

  return {
    thisWeek: sorted.filter((item) => item.dayIndex < 7).map(strip),
    later: sorted.filter((item) => item.dayIndex >= 7).map(strip),
  };
}

export interface GetFoundItem {
  key: string;
  text: string;
  to: string;
  linkLabel: string;
}

/**
 * The fixes that actually change whether SML can find this vendor. When every
 * check passes the list is empty and the page shows no card at all.
 */
export function getFoundItems(
  cranes: Crane[] | null,
  contacts: { receivesRfqs: boolean }[] | null,
): GetFoundItem[] {
  const items: GetFoundItem[] = [];
  if (cranes) {
    const active = cranes.filter((crane) => crane.isActive);
    const unlocated = active.filter((crane) => crane.locationUnverified).length;
    const withoutChart = active.filter((crane) => !crane.loadChart).length;

    if (unlocated > 0) {
      items.push({
        key: "location",
        text:
          unlocated === 1
            ? "1 crane has no map location. SML can't show it to customers."
            : `${unlocated} cranes have no map location. SML can't show them to customers.`,
        to: "/app/fleet",
        linkLabel: "Add a pin",
      });
    }
    if (withoutChart > 0) {
      items.push({
        key: "load-chart",
        text:
          withoutChart === 1
            ? "1 crane has no load chart."
            : `${withoutChart} cranes have no load chart.`,
        to: "/app/fleet",
        linkLabel: "Add a chart",
      });
    }
  }

  if (contacts !== null && !contacts.some((contact) => contact.receivesRfqs)) {
    items.push({
      key: "rfq-contacts",
      text: "No one on your team receives RFQ emails. Ask SML to add a contact.",
      to: "/app/profile",
      linkLabel: "View contacts",
    });
  }

  return items;
}

/** No fleet and no RFQs: the three steps that make the page useful. */
export function isFirstTime(data: VendorDashboard): boolean {
  return (
    data.fleet.totalCranes === 0 &&
    data.rfqs.openCount === 0 &&
    data.quotations.submittedCount === 0
  );
}

/** The single sentence under the greeting, and the dot that carries its tone. */
export function statusSentence(data: VendorDashboard): {
  text: string;
  tone: "amber" | "green";
} {
  const overdue = data.rfqs.awaitingResponse.filter((row) => row.overdue).length;
  const waiting = Math.max(0, data.rfqs.awaitingResponseCount - overdue);
  const checks = data.fleet.dueForUpdate.length;

  if (waiting === 0 && checks === 0) {
    return { text: "You're all caught up", tone: "green" };
  }

  const parts: string[] = [];
  if (waiting > 0) {
    parts.push(
      waiting === 1
        ? "1 RFQ needs your quote"
        : `${waiting} RFQs need your quote`,
    );
  }
  if (checks > 0) {
    parts.push(
      checks === 1
        ? "1 crane needs a quick check"
        : `${checks} cranes need a quick check`,
    );
  }

  return { text: parts.join(" · "), tone: "amber" };
}

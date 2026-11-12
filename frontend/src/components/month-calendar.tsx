import { Fragment, useMemo } from "react";
import { DAY_STATE_LABELS, type CalendarCrane, type CalendarDayState } from "@/lib/calendar";
import { cn } from "@/lib/cn";

/**
 * Month view of the booking calendar (brief 6.17).
 *
 * The timeline answers "what is this crane doing on each day"; a month grid
 * answers the question a planner actually starts with — "what is happening on
 * the 14th". Both read the same server response, so the grid adds no endpoint
 * and cannot disagree with the table.
 *
 * Only days inside the requested month carry data; the leading and trailing
 * cells exist to complete the weeks and are visibly muted rather than hidden.
 * A day shows the cranes that are *not* free, because those are the exceptions
 * that matter — a fully free day stays quiet, which is what makes the busy days
 * readable at a glance.
 */

const DAY_MS = 86_400_000;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Busy states first in the order a planner cares about them. A hired crane is a
 * commitment, a reservation is a hold, maintenance is a constraint, a block is
 * a note.
 */
export const STATE_ORDER: Record<CalendarDayState, number> = {
  HIRED: 0,
  RESERVED: 1,
  UNAVAILABLE: 2,
  BLOCKED: 3,
  FREE: 9,
};

/**
 * One tone per day state, used by the grid, the legend, the agenda and the
 * timeline. Keeping them in one object is what stops the same state appearing
 * in two colours on the same screen.
 */
export const STATE_STYLES: Record<
  CalendarDayState,
  { dot: string; chip: string; soft: string; text: string; bar: string }
> = {
  HIRED: {
    dot: "bg-emerald-500",
    chip: "border-emerald-100 bg-emerald-50 text-emerald-800",
    soft: "bg-emerald-50",
    text: "text-emerald-700",
    bar: "bg-emerald-400",
  },
  RESERVED: {
    dot: "bg-blue-500",
    chip: "border-blue-100 bg-blue-50 text-blue-800",
    soft: "bg-blue-50",
    text: "text-blue-700",
    bar: "bg-blue-400",
  },
  UNAVAILABLE: {
    dot: "bg-rose-500",
    chip: "border-rose-100 bg-rose-50 text-rose-800",
    soft: "bg-rose-50",
    text: "text-rose-700",
    bar: "bg-rose-400",
  },
  BLOCKED: {
    dot: "bg-amber-500",
    chip: "border-amber-100 bg-amber-50 text-amber-900",
    soft: "bg-amber-50",
    text: "text-amber-700",
    bar: "bg-amber-400",
  },
  FREE: {
    dot: "bg-slate-300",
    chip: "border-slate-200 bg-white text-slate-500",
    soft: "bg-slate-50",
    text: "text-slate-500",
    bar: "bg-slate-200",
  },
};

export interface DayEntry {
  crane: CalendarCrane;
  state: CalendarDayState;
}

/**
 * The server labels a crane "Crawler Crane 2500 t — DEMO-VJ-0101". In a month
 * cell only the serial distinguishes one crane from another, so the grid shows
 * that and keeps the full label for the tooltip and the agenda.
 */
export function shortLabel(craneLabel: string): string {
  const tail = craneLabel.split("—").pop()?.trim();
  return tail && tail.length > 0 ? tail : craneLabel;
}

export interface MonthCalendarProps {
  /** `YYYY-MM`. */
  month: string;
  /** Whole weeks for the month, Monday first. */
  dates: string[];
  /** The cranes scheduled on each date, busiest state first. */
  entries: Map<string, DayEntry[]>;
  /** The date shown in the agenda, or null. */
  selected: string | null;
  onSelect: (date: string) => void;
  /** The detail for the selected day, rendered under its week. */
  renderDetail?: (date: string) => React.ReactNode;
}

function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function keyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function monthBounds(month: string): { from: string; to: string } {
  const [year, monthNo] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year!, monthNo! - 1, 1));
  const last = new Date(Date.UTC(year!, monthNo!, 0));
  return { from: keyOf(first), to: keyOf(last) };
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNo] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNo! - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function todayKey(): string {
  return keyOf(new Date());
}

/** The dates the grid must draw: whole weeks, Monday first. */
export function monthGrid(month: string): string[] {
  const { from, to } = monthBounds(month);
  const first = utcDate(from);
  const last = utcDate(to);
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = lead + last.getUTCDate();
  const total = Math.ceil(cells / 7) * 7;
  const start = first.getTime() - lead * DAY_MS;
  return Array.from({ length: total }, (_, i) => keyOf(new Date(start + i * DAY_MS)));
}

export function monthLabel(month: string): string {
  return utcDate(`${month}-01`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function dayLabel(date: string): string {
  return utcDate(date).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shortDate(date: string): string {
  return utcDate(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "6 November 2026" — the agenda's heading, without repeating the weekday. */
export function fullDate(date: string): string {
  return utcDate(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function weekdayName(date: string): string {
  return utcDate(date).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" });
}

/** Index the cranes by date, busiest state first, then by label. */
export function indexCranes(cranes: CalendarCrane[]): Map<string, DayEntry[]> {
  const map = new Map<string, DayEntry[]>();
  for (const crane of cranes) {
    for (const day of crane.days) {
      const list = map.get(day.date) ?? [];
      list.push({ crane, state: day.state });
      map.set(day.date, list);
    }
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.crane.craneLabel.localeCompare(b.crane.craneLabel),
    );
  }
  return map;
}

export interface MonthStats {
  cranes: number;
  days: number;
  hired: number;
  reserved: number;
  blocked: number;
  maintenance: number;
  free: number;
  busy: number;
  /** Busy crane-days as a percentage of crane-days, rounded. */
  utilisation: number;
}

export function monthStats(cranes: CalendarCrane[]): MonthStats {
  const stats: MonthStats = {
    cranes: cranes.length,
    days: cranes[0]?.days.length ?? 0,
    hired: 0,
    reserved: 0,
    blocked: 0,
    maintenance: 0,
    free: 0,
    busy: 0,
    utilisation: 0,
  };
  for (const crane of cranes) {
    for (const day of crane.days) {
      if (day.state === "HIRED") stats.hired += 1;
      else if (day.state === "RESERVED") stats.reserved += 1;
      else if (day.state === "BLOCKED") stats.blocked += 1;
      else if (day.state === "UNAVAILABLE") stats.maintenance += 1;
      else stats.free += 1;
    }
  }
  stats.busy = stats.hired + stats.reserved + stats.blocked + stats.maintenance;
  const total = stats.busy + stats.free;
  stats.utilisation = total === 0 ? 0 : Math.round((stats.busy / total) * 100);
  return stats;
}

export function MonthCalendar({
  month,
  dates,
  entries,
  selected,
  onSelect,
  renderDetail,
}: MonthCalendarProps) {
  const today = todayKey();
  const monthDays = useMemo(
    () => new Set(dates.filter((date) => date.startsWith(month))),
    [dates, month],
  );
  const weeks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < dates.length; i += 7) out.push(dates.slice(i, i + 7));
    return out;
  }, [dates]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px] md:min-w-0">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/80">
          {WEEKDAYS.map((weekday, index) => (
            <div
              key={weekday}
              className={cn(
                "px-2 py-2 text-center text-[11px] font-medium tracking-[0.08em] uppercase",
                index > 4 ? "text-slate-400" : "text-slate-500",
              )}
            >
              {weekday}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {weeks.map((week) => (
            <Fragment key={week[0]}>
              {week.map((date, column) => {
                const inMonth = monthDays.has(date);
                const list = entries.get(date) ?? [];
                const busy = list.filter((entry) => entry.state !== "FREE");
                const shown = busy.slice(0, 2);
                const overflow = busy.length - shown.length;
                const isToday = date === today;
                const isSelected = selected === date;
                const weekend = column > 4;

                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => onSelect(date)}
                    aria-pressed={isSelected}
                    aria-label={`${dayLabel(date)}: ${busy.length} busy, ${list.length - busy.length} free`}
                    className={cn(
                      "group relative flex min-h-[108px] flex-col gap-1 border-b border-slate-100 p-1.5 text-left transition-colors",
                      column < 6 && "border-r",
                      inMonth ? "bg-white" : "bg-slate-50/50",
                      inMonth && weekend && "bg-slate-50/60",
                      inMonth && "hover:bg-brand-50/40",
                      isSelected && "z-10 bg-brand-50/50 ring-2 ring-brand-500 ring-inset",
                    )}
                  >
                    <span className="flex items-center justify-between">
                      <span
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                          isToday
                            ? "bg-slate-900 text-white"
                            : inMonth
                              ? "text-slate-700"
                              : "text-slate-400",
                        )}
                      >
                        {Number(date.slice(8, 10))}
                      </span>
                      {inMonth && busy.length > 0 ? (
                        <span className="text-[10px] font-medium text-slate-500 tabular-nums">
                          {busy.length}
                        </span>
                      ) : null}
                    </span>

                    {inMonth ? (
                      <span className="flex min-w-0 flex-col gap-1">
                        {shown.map((entry) => {
                          const tone = STATE_STYLES[entry.state];
                          return (
                            <span
                              key={entry.crane.craneId}
                              title={`${entry.crane.craneLabel} · ${DAY_STATE_LABELS[entry.state]}`}
                              className={cn(
                                "flex min-w-0 items-center gap-1 rounded border px-1 py-[2px] text-[10px] leading-4",
                                tone.chip,
                              )}
                            >
                              <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
                              <span className="truncate">
                                {shortLabel(entry.crane.craneLabel)}
                              </span>
                            </span>
                          );
                        })}
                        {overflow > 0 ? (
                          <span className="pl-1 text-[10px] font-medium text-slate-400">
                            +{overflow} more
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                );
              })}

              {renderDetail && selected && week.includes(selected) ? (
                <div className="col-span-7 border-b border-slate-200 bg-slate-50/70">
                  {renderDetail(selected)}
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The detail for one day, rendered under its week.
 *
 * Shared by the booking calendar and discovery's calendar tab so the same day
 * reads the same way on both screens. `renderCrane` lets the caller turn a
 * crane's label into a link without this component knowing about routes.
 */
export function DayAgenda({
  date,
  entries,
  month,
  renderCrane,
  includeFree = false,
}: {
  date: string;
  entries: DayEntry[];
  month: string;
  renderCrane?: (crane: CalendarCrane, label: string) => React.ReactNode;
  /**
   * List the free cranes as their own group. The booking calendar leaves them
   * out — busy days are the point there — but discovery's calendar is a view of
   * a filtered set, so its agenda has to show every crane in that set.
   */
  includeFree?: boolean;
}) {
  const busy = entries.filter((entry) => entry.state !== "FREE");
  const free = entries.length - busy.length;
  const isToday = date === todayKey();
  const inMonth = date.startsWith(month);

  const groups: Array<{ state: CalendarDayState; items: DayEntry[] }> = (
    ["HIRED", "RESERVED", "BLOCKED", "UNAVAILABLE"] as const
  )
    .map((state) => ({
      state: state as CalendarDayState,
      items: busy.filter((entry) => entry.state === state),
    }))
    .filter((group) => group.items.length > 0);
  if (includeFree && free > 0) {
    groups.push({ state: "FREE", items: entries.filter((entry) => entry.state === "FREE") });
  }

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            {inMonth ? weekdayName(date) : "Nothing scheduled"}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              {inMonth ? fullDate(date) : shortDate(date)}
            </h2>
            {isToday ? (
              <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase">
                Today
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center divide-x divide-slate-200">
          <AgendaStat label="Busy" value={busy.length} />
          <AgendaStat label="Free" value={free} />
          <AgendaStat label="Cranes" value={entries.length} />
        </div>
      </div>

      <div className="mt-3">
        {!inMonth ? (
          <p className="py-4 text-center text-xs text-slate-500">
            This day is outside the month on screen.
          </p>
        ) : entries.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            No crane is scheduled on this day.
          </p>
        ) : groups.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            Every crane is free on this day.
          </p>
        ) : (
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => {
              const tone = STATE_STYLES[group.state];
              return (
                <div key={group.state}>
                  <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                    <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                    {DAY_STATE_LABELS[group.state]}
                    <span className="text-slate-400">· {group.items.length}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {group.items.map((entry) => (
                      <li
                        key={entry.crane.craneId}
                        className="flex items-baseline justify-between gap-3 rounded-md border border-slate-200/70 bg-white px-2 py-1"
                      >
                        <span className="shrink-0 text-xs font-medium text-slate-900">
                          {renderCrane
                            ? renderCrane(entry.crane, shortLabel(entry.crane.craneLabel))
                            : shortLabel(entry.crane.craneLabel)}
                        </span>
                        <span className="truncate text-right text-[11px] text-slate-500">
                          {entry.crane.capacityT} t ·{" "}
                          {entry.crane.ownershipType === "SML" ? "SML" : entry.crane.vendorName}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AgendaStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 text-center first:pl-0 last:pr-0">
      <p className="text-sm font-semibold text-slate-900 tabular-nums">{value}</p>
      <p className="text-[10px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</p>
    </div>
  );
}

export const CALENDAR_STATE_LABELS = DAY_STATE_LABELS;

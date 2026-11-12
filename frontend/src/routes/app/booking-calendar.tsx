import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Rows3 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { Select, TextInput } from "@/components/ui/form";
import {
  MonthCalendar,
  STATE_STYLES,
  currentMonth,
  dayLabel,
  indexCranes,
  monthBounds,
  monthGrid,
  monthLabel,
  monthStats,
  fullDate,
  shortDate,
  shortLabel,
  shiftMonth,
  todayKey,
  weekdayName,
  type DayEntry,
  type MonthStats,
} from "@/components/month-calendar";
import {
  DAY_STATE_LABELS,
  getBookingCalendar,
  type CalendarCrane,
  type CalendarDayState,
  type CalendarOwnershipType,
} from "@/lib/calendar";
import { cn } from "@/lib/cn";

/**
 * The booking calendar (P2, brief 6.17 / BPD 6.17).
 *
 * Two views over one server response, because they answer different questions.
 * The month grid answers "what is happening on the 14th"; the timeline answers
 * "what is this crane doing for the next four weeks". Both are driven by the
 * same month window and the same derived day states, so they cannot disagree.
 *
 * A day answers exactly one question, "what is this crane doing", and
 * reservations win: a booking reads RESERVED or HIRED before the crane's own
 * maintenance status is consulted. The state of a day is derived by the server;
 * these screens only paint it.
 *
 * The window is capped server-side at 92 days (validation); a calendar month is
 * at most 31, so the picker is a month and never an unbounded range.
 */

type ViewMode = "calendar" | "timeline";

const STATE_LABELS = DAY_STATE_LABELS;

const LEGEND: CalendarDayState[] = ["HIRED", "RESERVED", "BLOCKED", "UNAVAILABLE", "FREE"];

export function BookingCalendarPage() {
  const [month, setMonth] = useState(() => currentMonth());
  const [view, setView] = useState<ViewMode>("calendar");
  const [ownershipType, setOwnershipType] = useState<"" | CalendarOwnershipType>("");
  const [craneType, setCraneType] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const { from, to } = useMemo(() => monthBounds(month), [month]);

  const calendar = useQuery({
    queryKey: ["booking-calendar", from, to, ownershipType, craneType],
    queryFn: () =>
      getBookingCalendar({
        from,
        to,
        ownershipType: ownershipType === "" ? undefined : ownershipType,
        craneType: craneType.trim() === "" ? undefined : craneType.trim(),
      }),
  });

  const cranes = calendar.data?.calendar.cranes ?? [];
  const dates = useMemo(() => monthGrid(month), [month]);
  const entries = useMemo(() => indexCranes(cranes), [cranes]);
  const stats = useMemo(() => monthStats(cranes), [cranes]);

  // A day selected in one month means nothing in the next, so moving the month
  // clears it and the panel falls back to today (or the first of the month).
  useEffect(() => setSelected(null), [month, ownershipType, craneType]);

  const today = todayKey();
  const activeDate = selected ?? (today.startsWith(month) ? today : `${month}-01`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking calendar"
        description="What every crane is doing, day by day. Reservations win over the crane's own status."
        actions={
          <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            <ViewButton
              active={view === "calendar"}
              onClick={() => setView("calendar")}
              icon={<CalendarDays className="size-3.5" aria-hidden />}
              label="Calendar"
            />
            <ViewButton
              active={view === "timeline"}
              onClick={() => setView("timeline")}
              icon={<Rows3 className="size-3.5" aria-hidden />}
              label="Timeline"
            />
          </div>
        }
      />

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-1">
            <IconButton
              label="Previous month"
              onClick={() => setMonth((prev) => shiftMonth(prev, -1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </IconButton>
            <span className="min-w-40 px-1 text-center text-sm font-semibold text-slate-900">
              {monthLabel(month)}
            </span>
            <IconButton label="Next month" onClick={() => setMonth((prev) => shiftMonth(prev, 1))}>
              <ChevronRight className="size-4" aria-hidden />
            </IconButton>
            <button
              type="button"
              className={cn(
                "ml-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                month === currentMonth()
                  ? "cursor-default border-slate-200 text-slate-400"
                  : "border-slate-200 text-slate-700 hover:bg-slate-50",
              )}
              onClick={() => setMonth(currentMonth())}
              disabled={month === currentMonth()}
            >
              Today
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <FilterControl label="Ownership" htmlFor="cal-ownership">
              <Select
                id="cal-ownership"
                value={ownershipType}
                onChange={(value) => setOwnershipType(value as "" | CalendarOwnershipType)}
                placeholder="All cranes"
                options={[
                  { value: "VENDOR", label: "Vendor cranes" },
                  { value: "SML", label: "SML cranes" },
                ]}
              />
            </FilterControl>
            <FilterControl label="Crane type" htmlFor="cal-type">
              <TextInput
                id="cal-type"
                value={craneType}
                onChange={setCraneType}
                placeholder="All types"
                className="min-w-40"
              />
            </FilterControl>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
          <span className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Legend
          </span>
          {LEGEND.map((state) => (
            <span key={state} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <span className={cn("size-2 rounded-full", STATE_STYLES[state].dot)} aria-hidden />
              {STATE_LABELS[state]}
            </span>
          ))}
        </div>
      </section>

      {calendar.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : calendar.isError ? (
        <Alert tone="error">Could not load the calendar.</Alert>
      ) : (
        <>
          <StatsStrip stats={stats} />

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {view === "calendar" ? "Month view" : "Timeline"}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {stats.cranes === 0
                    ? "No cranes match these filters"
                    : `${stats.cranes} cranes · ${stats.utilisation}% of crane-days committed`}
                </p>
              </div>
              <p className="text-xs text-slate-400">
                {view === "calendar" ? "Select a day for the detail" : "One row per crane"}
              </p>
            </div>

            {cranes.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                No cranes match these filters.
              </p>
            ) : view === "calendar" ? (
              <MonthCalendar
                month={month}
                dates={dates}
                entries={entries}
                selected={activeDate}
                onSelect={setSelected}
                renderDetail={(date) => (
                  <DayAgenda date={date} entries={entries.get(date) ?? []} month={month} />
                )}
              />
            ) : (
              <Timeline dates={dates} cranes={cranes} month={month} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
          : "text-slate-500 hover:text-slate-800",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
    >
      {children}
    </button>
  );
}

function FilterControl({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase"
      >
        {label}
      </label>
      <div className="[&>input]:py-1.5 [&>select]:py-1.5">{children}</div>
    </div>
  );
}

function StatsStrip({ stats }: { stats: MonthStats }) {
  const tiles: Array<{ label: string; value: string; sub: string; dot?: string }> = [
    {
      label: "Utilisation",
      value: `${stats.utilisation}%`,
      sub: "of crane-days committed",
    },
    {
      label: "Hired",
      value: stats.hired.toLocaleString("en-IN"),
      sub: "crane-days on hire",
      dot: STATE_STYLES.HIRED.dot,
    },
    {
      label: "Reserved",
      value: stats.reserved.toLocaleString("en-IN"),
      sub: "crane-days held",
      dot: STATE_STYLES.RESERVED.dot,
    },
    {
      label: "Blocked",
      value: stats.blocked.toLocaleString("en-IN"),
      sub: "crane-days blocked",
      dot: STATE_STYLES.BLOCKED.dot,
    },
    {
      label: "Maintenance",
      value: stats.maintenance.toLocaleString("en-IN"),
      sub: "crane-days unavailable",
      dot: STATE_STYLES.UNAVAILABLE.dot,
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div key={tile.label} className="card px-4 py-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            {tile.dot ? (
              <span className={cn("size-1.5 rounded-full", tile.dot)} aria-hidden />
            ) : null}
            {tile.label}
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{tile.value}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">{tile.sub}</p>
        </div>
      ))}
    </section>
  );
}

function DayAgenda({
  date,
  entries,
  month,
}: {
  date: string;
  entries: DayEntry[];
  month: string;
}) {
  const busy = entries.filter((entry) => entry.state !== "FREE");
  const free = entries.length - busy.length;
  const isToday = date === todayKey();
  const inMonth = date.startsWith(month);

  const groups = (["HIRED", "RESERVED", "BLOCKED", "UNAVAILABLE"] as const)
    .map((state) => ({ state, items: busy.filter((entry) => entry.state === state) }))
    .filter((group) => group.items.length > 0);

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
        ) : busy.length === 0 ? (
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
                    {STATE_LABELS[group.state]}
                    <span className="text-slate-400">· {group.items.length}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {group.items.map((entry) => (
                      <li
                        key={entry.crane.craneId}
                        className="flex items-baseline justify-between gap-3 rounded-md border border-slate-200/70 bg-white px-2 py-1"
                      >
                        <span className="shrink-0 text-xs font-medium text-slate-900">
                          {shortLabel(entry.crane.craneLabel)}
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

function Timeline({
  dates,
  cranes,
  month,
}: {
  dates: string[];
  cranes: CalendarCrane[];
  month: string;
}) {
  const today = todayKey();
  const monthDays = dates.filter((date) => date.startsWith(month));

  return (
    <div className="max-h-[36rem] overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-30 border-r border-b border-slate-200 bg-slate-50 px-4 py-2 text-left text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
              Crane
            </th>
            {monthDays.map((day) => {
              const weekend = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7 > 4;
              return (
                <th
                  key={day}
                  title={dayLabel(day)}
                  className={cn(
                    "sticky top-0 z-20 border-b border-slate-200 py-2 text-center text-[11px] font-medium tabular-nums",
                    day === today ? "text-slate-900" : "text-slate-400",
                    weekend ? "bg-slate-100" : "bg-slate-50",
                  )}
                >
                  {Number(day.slice(8, 10))}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {cranes.map((crane) => (
            <tr key={crane.craneId} className="group">
              <td className="sticky left-0 z-10 border-r border-b border-slate-100 bg-white px-4 py-1.5 whitespace-nowrap group-hover:bg-slate-50">
                <span className="text-xs font-medium text-slate-900">
                  {shortLabel(crane.craneLabel)}
                </span>
                <span className="ml-2 text-[11px] text-slate-500">
                  {crane.capacityT} t ·{" "}
                  {crane.ownershipType === "SML" ? "SML" : crane.vendorName}
                </span>
              </td>
              {crane.days.map((day) => {
                const weekend = (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7 > 4;
                return (
                  <td
                    key={day.date}
                    title={`${day.date}: ${STATE_LABELS[day.state]}`}
                    className={cn(
                      "border-b border-slate-100 px-0.5 py-1.5 text-center",
                      weekend && "bg-slate-50/70",
                    )}
                  >
                    {day.state === "FREE" ? null : (
                      <span
                        className={cn(
                          "mx-auto block size-3.5 rounded-[3px]",
                          STATE_STYLES[day.state].bar,
                        )}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

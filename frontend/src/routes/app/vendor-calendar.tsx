import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { Select } from "@/components/ui/form";
import {
  MonthCalendar,
  STATE_STYLES,
  currentMonth,
  dayLabel,
  fullDate,
  indexCranes,
  monthBounds,
  monthGrid,
  monthLabel,
  monthStats,
  shiftMonth,
  shortLabel,
  todayKey,
  weekdayName,
  type DayEntry,
} from "@/components/month-calendar";
import {
  DAY_STATE_LABELS,
  getVendorBookingCalendar,
  type CalendarCrane,
  type CalendarDayState,
} from "@/lib/calendar";
import { cn } from "@/lib/cn";

/**
 * The vendor's own booking calendar.
 *
 * Read-only, and only ever the caller's cranes: the endpoint takes the vendor
 * from the login token, so this screen has no vendor filter to get wrong. A day
 * answers one question — what is this crane doing — and a booking always wins
 * over the crane's own status. Who the crane is committed to, the customer, the
 * site and the commercial terms are not part of the response and are not shown.
 *
 * The internal calendar (routes/app/booking-calendar.tsx) adds the ownership and
 * vendor filters and the timeline; a vendor needs neither, so this screen stays
 * a single month view.
 */

const LEGEND: CalendarDayState[] = ["HIRED", "RESERVED", "BLOCKED", "UNAVAILABLE", "FREE"];

export function VendorBookingCalendarPage() {
  const [month, setMonth] = useState(() => currentMonth());
  const [craneId, setCraneId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const { from, to } = useMemo(() => monthBounds(month), [month]);

  const calendar = useQuery({
    queryKey: ["vendor-booking-calendar", from, to],
    queryFn: () => getVendorBookingCalendar({ from, to }),
  });

  const allCranes = calendar.data?.calendar.cranes ?? [];
  const cranes = craneId ? allCranes.filter((crane) => crane.craneId === craneId) : allCranes;

  const dates = useMemo(() => monthGrid(month), [month]);
  const entries = useMemo(() => indexCranes(cranes), [cranes]);
  const stats = useMemo(() => monthStats(cranes), [cranes]);

  // A day chosen in one month, or for one crane, means nothing after the view
  // changes, so the agenda falls back to today (or the first of the month).
  useEffect(() => setSelected(null), [month, craneId]);

  const today = todayKey();
  const activeDate = selected ?? (today.startsWith(month) ? today : `${month}-01`);

  const craneOptions = allCranes.map((crane) => ({
    value: crane.craneId,
    label: crane.craneLabel,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking calendar"
        description="What your cranes are doing, day by day. SML sets a booking when a quotation is awarded; this view is read-only."
        meta={
          calendar.data ? (
            <span className="text-xs text-slate-500">
              {allCranes.length} active crane{allCranes.length === 1 ? "" : "s"}
            </span>
          ) : null
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

          <div className="flex flex-col gap-1">
            <label
              htmlFor="vendor-cal-crane"
              className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase"
            >
              Crane
            </label>
            <div className="[&>select]:py-1.5">
              <Select
                id="vendor-cal-crane"
                value={craneId}
                onChange={setCraneId}
                placeholder="All my cranes"
                options={craneOptions}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
          <span className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Legend
          </span>
          {LEGEND.map((state) => (
            <span key={state} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <span className={cn("size-2 rounded-full", STATE_STYLES[state].dot)} aria-hidden />
              {DAY_STATE_LABELS[state]}
            </span>
          ))}
        </div>
      </section>

      {calendar.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : calendar.isError ? (
        <Alert tone="error">Could not load your calendar.</Alert>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Utilisation" value={`${stats.utilisation}%`} sub="of crane-days committed" />
            <StatTile
              label="Hired"
              value={stats.hired.toLocaleString("en-IN")}
              sub="crane-days on hire"
              dot={STATE_STYLES.HIRED.dot}
            />
            <StatTile
              label="Reserved"
              value={stats.reserved.toLocaleString("en-IN")}
              sub="crane-days held"
              dot={STATE_STYLES.RESERVED.dot}
            />
            <StatTile
              label="Maintenance"
              value={stats.maintenance.toLocaleString("en-IN")}
              sub="crane-days unavailable"
              dot={STATE_STYLES.UNAVAILABLE.dot}
            />
          </section>

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Month view</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {stats.cranes === 0
                    ? "No cranes to show"
                    : `${stats.cranes} crane${stats.cranes === 1 ? "" : "s"} · ${stats.utilisation}% of crane-days committed`}
                </p>
              </div>
              <p className="text-xs text-slate-400">Select a day for the detail</p>
            </div>

            {cranes.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                {allCranes.length === 0
                  ? "You have no active cranes yet. Add one from My fleet and it will appear here."
                  : "No crane matches that filter."}
              </p>
            ) : (
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
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  dot,
}: {
  label: string;
  value: string;
  sub: string;
  dot?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        {dot ? <span className={cn("size-1.5 rounded-full", dot)} aria-hidden /> : null}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>
    </div>
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
              {inMonth ? fullDate(date) : dayLabel(date)}
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
                    {DAY_STATE_LABELS[group.state]}
                    <span className="text-slate-400">· {group.items.length}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {group.items.map((entry) => (
                      <AgendaCrane key={entry.crane.craneId} crane={entry.crane} />
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

function AgendaCrane({ crane }: { crane: CalendarCrane }) {
  return (
    <li className="flex items-baseline justify-between gap-3 rounded-md border border-slate-200/70 bg-white px-2 py-1">
      <Link
        to="/app/fleet/$craneId/edit"
        params={{ craneId: crane.craneId }}
        className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
      >
        {shortLabel(crane.craneLabel)}
      </Link>
      <span className="truncate text-right text-[11px] text-slate-500">
        {crane.craneTypeName} · {crane.capacityT} t
      </span>
    </li>
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

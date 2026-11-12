import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  DayAgenda,
  MonthCalendar,
  STATE_STYLES,
  currentMonth,
  indexCranes,
  monthBounds,
  monthGrid,
  monthLabel,
  monthStats,
  shiftMonth,
  todayKey,
} from "@/components/month-calendar";
import { DAY_STATE_LABELS, type CalendarDayState } from "@/lib/calendar";
import { searchDiscoveryCalendar, type DiscoveryFilters } from "@/lib/discovery";
import { cn } from "@/lib/cn";

/**
 * Discovery results as a calendar (P4, BPD 6.8).
 *
 * The other three views answer "which cranes match"; this one answers "when are
 * they busy". It is the same filtered set — the server applies the discovery
 * filters before drawing the grid — so switching tabs never changes what is in
 * scope. Day states are the booking calendar's: a reservation wins the day, and
 * the crane's own status fills the rest. The hire-window filter narrows the
 * cranes, it does not paint days.
 */

const LEGEND: CalendarDayState[] = ["HIRED", "RESERVED", "BLOCKED", "UNAVAILABLE", "FREE"];

export function DiscoveryCalendar({ filters }: { filters: DiscoveryFilters }) {
  const [month, setMonth] = useState(() => currentMonth());
  const [selected, setSelected] = useState<string | null>(null);

  const { from, to } = useMemo(() => monthBounds(month), [month]);

  const calendar = useQuery({
    queryKey: ["discovery", "calendar", filters, from, to],
    queryFn: () => searchDiscoveryCalendar({ ...filters, from, to }),
  });

  const cranes = calendar.data?.calendar.cranes ?? [];
  const dates = useMemo(() => monthGrid(month), [month]);
  const entries = useMemo(() => indexCranes(cranes), [cranes]);
  const stats = useMemo(() => monthStats(cranes), [cranes]);

  // A selected day means nothing once the month or the filters change.
  useEffect(() => setSelected(null), [month, filters]);

  const today = todayKey();
  const activeDate = selected ?? (today.startsWith(month) ? today : `${month}-01`);

  return (
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

        <p className="text-xs text-slate-500">
          {calendar.isPending
            ? "Loading calendar…"
            : `${stats.cranes} crane${stats.cranes === 1 ? "" : "s"} match the filters · ${stats.utilisation}% of crane-days committed`}
        </p>
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
        <span className="ml-auto text-[11px] text-slate-400">
          A reservation wins the day; the crane&apos;s own status fills the rest.
        </span>
      </div>

      {calendar.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : calendar.isError ? (
        <div className="p-4">
          <Alert tone="error">Could not load the calendar for these filters.</Alert>
        </div>
      ) : cranes.length === 0 ? (
        <EmptyState
          icon={<Search className="size-4" aria-hidden />}
          title="No cranes match these filters"
          description="Widen the capacity or clear the location filters, then search again."
        />
      ) : (
        <MonthCalendar
          month={month}
          dates={dates}
          entries={entries}
          selected={activeDate}
          onSelect={setSelected}
          renderDetail={(date) => (
            <DayAgenda
              date={date}
              entries={entries.get(date) ?? []}
              month={month}
              includeFree
              renderCrane={(crane, label) => (
                <Link
                  to="/app/cranes/$craneId"
                  params={{ craneId: crane.craneId }}
                  className="hover:text-brand-700 hover:underline"
                >
                  {label}
                </Link>
              )}
            />
          )}
        />
      )}
    </section>
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

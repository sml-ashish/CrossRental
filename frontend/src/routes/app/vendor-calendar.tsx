import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Field, Select, TextInput } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addDays,
  bookingLine,
  bookingsWithin,
  classifyRange,
  daysBetween,
  defaultRange,
  diffDays,
  formatDay,
  formatDayFull,
  groupByAvailability,
  isDay,
  matchesFilters,
  presetsFor,
  splitRange,
  todayKey,
  type ClassifiedCrane,
  type DaySegment,
  type RangeAvailability,
} from "@/lib/availability";
import {
  getVendorBookingCalendar,
  type CalendarCrane,
  type CalendarDayState,
  type CalendarView,
} from "@/lib/calendar";
import { cn } from "@/lib/cn";

/**
 * The vendor's fleet schedule, answered the same way as the sales-side
 * availability screen: pick a period, then read three groups — free the whole
 * time, free for part of it, not available. Each row carries a plain sentence
 * and a thin strip, so the answer never depends on colour alone.
 *
 * Read-only and vendor-scoped by the endpoint: there is no customer, site,
 * budget or other vendor in the response, and nothing here writes a booking.
 * SML sets BOOKED and HIRED when a quotation is awarded.
 */

const SEGMENT_TONES: Record<CalendarDayState, string> = {
  FREE: "bg-transparent",
  HIRED: "bg-emerald-500",
  RESERVED: "bg-blue-500",
  BLOCKED: "bg-amber-500",
  UNAVAILABLE: "bg-amber-500",
};

const DOT_TONES: Record<CalendarDayState, string> = {
  FREE: "bg-transparent",
  HIRED: "bg-emerald-500",
  RESERVED: "bg-blue-500",
  BLOCKED: "bg-amber-500",
  UNAVAILABLE: "bg-amber-500",
};

function mergeCalendars(calendars: CalendarView[]): CalendarView {
  const byId = new Map<string, CalendarCrane>();
  for (const calendar of calendars) {
    for (const crane of calendar.cranes) {
      const existing = byId.get(crane.craneId);
      if (existing) {
        existing.days = [...existing.days, ...crane.days].sort((a, b) =>
          a.date.localeCompare(b.date),
        );
      } else {
        byId.set(crane.craneId, { ...crane, days: [...crane.days] });
      }
    }
  }
  return {
    from: calendars[0]?.from ?? "",
    to: calendars[calendars.length - 1]?.to ?? "",
    days: calendars[0]?.days ?? [],
    cranes: [...byId.values()],
  };
}

function stateOn(crane: CalendarCrane, day: string): CalendarDayState {
  return crane.days.find((entry) => entry.date === day)?.state ?? "FREE";
}

function summarySentence(cranes: CalendarCrane[], from: string, to: string): string {
  if (cranes.length === 0) return "No cranes to schedule yet.";

  const days = daysBetween(from, to);
  const today = todayKey();
  const reference = days.includes(today) ? today : from;

  let onHire = 0;
  let booked = 0;
  let free = 0;
  let busyDays = 0;

  for (const crane of cranes) {
    const state = stateOn(crane, reference);
    if (state === "HIRED") onHire += 1;
    else if (state === "RESERVED") booked += 1;
    else if (state === "FREE") free += 1;

    for (const day of days) {
      const dayState = stateOn(crane, day);
      if (dayState === "HIRED" || dayState === "RESERVED") busyDays += 1;
    }
  }

  const totalDays = cranes.length * days.length;
  const percent = totalDays === 0 ? 0 : Math.round((busyDays / totalDays) * 100);
  const label = reference === today ? "today" : `on ${formatDay(reference)}`;

  return `${onHire} on hire · ${booked} booked · ${free} free ${label}. Your cranes are booked ${percent}% of this period.`;
}

export function VendorBookingCalendarPage() {
  const today = todayKey();
  const [range, setRange] = useState(() => defaultRange(today));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNotAvailable, setShowNotAvailable] = useState(false);
  const [typeCode, setTypeCode] = useState("");
  const [minCapacity, setMinCapacity] = useState("");

  const chunks = useMemo(() => splitRange(range.from, range.to), [range.from, range.to]);
  const calendar = useQuery({
    queryKey: ["vendor-booking-calendar", range.from, range.to],
    queryFn: async () => {
      const parts: CalendarView[] = [];
      for (const chunk of chunks) {
        const response = await getVendorBookingCalendar(chunk);
        parts.push(response.calendar);
      }
      return mergeCalendars(parts);
    },
  });

  const cranes = useMemo(() => calendar.data?.cranes ?? [], [calendar.data]);
  const types = useMemo(() => {
    const map = new Map<string, string>();
    for (const crane of cranes) map.set(crane.craneTypeCode, crane.craneTypeName);
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [cranes]);
  const classified = useMemo(
    () =>
      cranes
        .filter((crane) =>
          matchesFilters(crane, {
            type: typeCode,
            min: minCapacity,
            state: "",
            q: "",
          }),
        )
        .map((crane) => ({
          crane,
          availability: classifyRange(crane, range.from, range.to),
        })),
    [cranes, range.from, range.to, typeCode, minCapacity],
  );
  const groups = useMemo(() => groupByAvailability(classified), [classified]);
  const freeCount = groups.whole.length + groups.part.length;
  const summary = useMemo(
    () => summarySentence(cranes, range.from, range.to),
    [cranes, range.from, range.to],
  );

  const presets = useMemo(() => presetsFor(today), [today]);
  const rangeProse = `${formatDay(range.from)} to ${formatDay(range.to)}`;
  const activeFilters = typeCode !== "" || minCapacity !== "";

  const clearFilters = () => {
    setTypeCode("");
    setMinCapacity("");
    setExpandedId(null);
  };

  const changeFrom = (value: string) => {
    if (!isDay(value)) return;
    setRange((previous) => ({
      from: value,
      to:
        value > previous.to
          ? addDays(value, Math.max(0, diffDays(previous.from, previous.to)))
          : previous.to,
    }));
    setExpandedId(null);
  };

  const changeTo = (value: string) => {
    if (!isDay(value)) return;
    setRange((previous) => ({
      from: value < previous.from ? value : previous.from,
      to: value,
    }));
    setExpandedId(null);
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 pb-8">
      <PageHeader
        title="Fleet schedule"
        description="When each of your cranes is on hire, booked or unavailable. SML books a crane when a quotation is awarded, so this view is read-only."
      />

      {!calendar.isError ? (
        <p className="mt-4 text-[14px] text-slate-700">
          {calendar.isPending ? "Loading your schedule…" : summary}
        </p>
      ) : null}

      <section className="card mt-4 p-4" aria-labelledby="vendor-dates-heading">
        <h2
          id="vendor-dates-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Choose the dates
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          See what each of your cranes is doing across the period. Narrow the
          list by type or capacity if you need to.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="vendor-calendar-from">
            <TextInput
              id="vendor-calendar-from"
              type="date"
              value={range.from}
              onChange={changeFrom}
            />
          </Field>
          <Field label="To" htmlFor="vendor-calendar-to">
            <TextInput
              id="vendor-calendar-to"
              type="date"
              value={range.to}
              onChange={changeTo}
            />
          </Field>

          <div
            className="flex flex-wrap items-center gap-1.5 pb-1"
            role="group"
            aria-label="Quick date ranges"
          >
            {presets.map((preset) => {
              const selected =
                range.from === preset.from && range.to === preset.to;
              return (
                <button
                  key={preset.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setRange({ from: preset.from, to: preset.to });
                    setExpandedId(null);
                  }}
                  className={cn(
                    "rounded-full border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
                    selected
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-ink-800 text-slate-600 hover:bg-ink-850 hover:text-slate-900",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Crane type" htmlFor="vendor-calendar-type">
            <Select
              id="vendor-calendar-type"
              value={typeCode}
              onChange={(value) => {
                setTypeCode(value);
                setExpandedId(null);
              }}
              placeholder="Any type"
              options={types}
            />
          </Field>

          <Field label="Min capacity (t)" htmlFor="vendor-calendar-min">
            <TextInput
              id="vendor-calendar-min"
              type="number"
              value={minCapacity}
              onChange={(value) => {
                setMinCapacity(value.replace(/[^0-9]/g, ""));
                setExpandedId(null);
              }}
              placeholder="Any"
              inputMode="numeric"
            />
          </Field>

          {activeFilters ? (
            <div className="flex items-end pb-1">
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <div className="mt-4">
        {calendar.isPending ? (
          <LoadingRows />
        ) : calendar.isError ? (
          <div className="card p-6">
            <p className="text-[14px] text-slate-700">
              The schedule could not be read for these dates. Nothing has changed;
              try again.
            </p>
            <button
              type="button"
              onClick={() => void calendar.refetch()}
              className="btn-secondary mt-3 px-3 py-1.5 text-xs"
            >
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </button>
          </div>
        ) : cranes.length === 0 ? (
          <div className="card px-6 py-10 text-center">
            <p className="text-[14px] text-slate-700">
              You haven't added any cranes yet.
            </p>
            <Link
              to="/app/fleet"
              className="mt-3 inline-block text-[13px] text-brand-700 underline-offset-4 hover:underline"
            >
              Go to My fleet
            </Link>
          </div>
        ) : (
          <section
            className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900"
            aria-label="Your cranes by availability"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-800 px-4 py-2.5">
              <p className="text-[13px] text-slate-600" aria-live="polite">
                <span className="font-semibold text-slate-900">{freeCount}</span>{" "}
                {freeCount === 1 ? "crane" : "cranes"} free for all or part of{" "}
                <span className="font-medium text-slate-800">{rangeProse}</span>
              </p>
              <p className="text-[12px] text-slate-500 tabular-nums">
                {groups.whole.length} free the whole time · {groups.part.length}{" "}
                partly free
              </p>
            </div>

            {classified.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-[14px] text-slate-700">
                  No cranes match these filters.
                </p>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="btn-secondary mt-3 px-3 py-1.5 text-xs"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <>
                <GroupSection
                  title="Free for your whole period"
                  count={groups.whole.length}
                  rows={groups.whole}
                  open
                  from={range.from}
                  to={range.to}
                  expandedId={expandedId}
                  onToggle={(craneId) =>
                    setExpandedId((current) =>
                      current === craneId ? null : craneId,
                    )
                  }
                />
                <GroupSection
                  title="Free for part of your period"
                  count={groups.part.length}
                  rows={groups.part}
                  open
                  from={range.from}
                  to={range.to}
                  expandedId={expandedId}
                  onToggle={(craneId) =>
                    setExpandedId((current) =>
                      current === craneId ? null : craneId,
                    )
                  }
                />
                <GroupSection
                  title="Not available"
                  count={groups.none.length}
                  rows={groups.none}
                  open={showNotAvailable}
                  onOpenChange={setShowNotAvailable}
                  from={range.from}
                  to={range.to}
                  expandedId={expandedId}
                  onToggle={(craneId) =>
                    setExpandedId((current) =>
                      current === craneId ? null : craneId,
                    )
                  }
                />
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="card space-y-3 p-4" role="status" aria-label="Loading your schedule">
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(220px,1.5fr)_minmax(0,1fr)] md:items-center"
        >
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-4 w-44" />
        </div>
      ))}
    </div>
  );
}

function GroupSection({
  title,
  count,
  rows,
  open,
  onOpenChange,
  from,
  to,
  expandedId,
  onToggle,
}: {
  title: string;
  count: number;
  rows: ClassifiedCrane[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  from: string;
  to: string;
  expandedId: string | null;
  onToggle: (craneId: string) => void;
}) {
  const collapsible = Boolean(onOpenChange);
  const headerContent = (
    <>
      {collapsible ? (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-slate-500 transition-transform",
            !open && "-rotate-90 motion-reduce:transition-none",
          )}
          aria-hidden
        />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <span className="text-[13px] font-semibold text-slate-800">{title}</span>
      <span className="text-[13px] text-slate-500 tabular-nums">· {count}</span>
      {!open && collapsible && count > 0 ? (
        <span className="ml-auto text-[12px] font-medium text-brand-700">Show</span>
      ) : null}
    </>
  );

  return (
    <section aria-label={`${title}, ${count}`} className="border-t border-ink-800">
      {collapsible ? (
        <button
          type="button"
          onClick={() => onOpenChange?.(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-ink-850"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
          {headerContent}
        </div>
      )}

      {open
        ? rows.map((row) => (
            <VendorCraneRow
              key={row.crane.craneId}
              row={row}
              from={from}
              to={to}
              expanded={expandedId === row.crane.craneId}
              onToggle={onToggle}
            />
          ))
        : null}
    </section>
  );
}

function VendorCraneRow({
  row,
  from,
  to,
  expanded,
  onToggle,
}: {
  row: ClassifiedCrane;
  from: string;
  to: string;
  expanded: boolean;
  onToggle: (craneId: string) => void;
}) {
  const { crane, availability } = row;
  const panelId = `vendor-availability-panel-${crane.craneId}`;
  const bookings = useMemo(
    () => bookingsWithin(crane, from, to),
    [crane, from, to],
  );
  const totalDays = Math.max(1, diffDays(from, to) + 1);
  const today = todayKey();
  const todayOffset = diffDays(from, today);
  const showToday = todayOffset >= 0 && todayOffset < totalDays;

  return (
    <article
      className={cn(
        "border-t border-ink-800",
        expanded && "bg-ink-850/60",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${crane.craneLabel}, ${crane.capacityT} tonnes, ${crane.craneTypeName}. ${availability.sentence}.`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a,button")) return;
          onToggle(crane.craneId);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(crane.craneId);
          }
        }}
        className={cn(
          "grid cursor-pointer grid-cols-1 gap-2 px-4 py-3 outline-offset-[-2px] transition-colors hover:bg-ink-850/70",
          "md:grid-cols-[minmax(0,1.2fr)_minmax(220px,1.5fr)_minmax(0,1fr)] md:items-center md:gap-4",
          expanded && "border-l-2 border-brand-500",
        )}
      >
        <div className="order-1 min-w-0">
          <p className="flex items-center gap-1.5 text-[15px] leading-tight font-semibold text-slate-900">
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-slate-500 transition-transform",
                !expanded && "-rotate-90 motion-reduce:transition-none",
              )}
              aria-hidden
            />
            <span className="truncate">{crane.craneLabel}</span>
          </p>
          <p className="mt-1 truncate text-[13px] text-slate-600 tabular-nums">
            {crane.capacityT} t · {crane.craneTypeName.replace(/\s+Crane$/i, "")}
          </p>
        </div>

        <div className="order-3 min-w-0 md:order-2">
          <CraneStrip
            availability={availability}
            from={from}
            to={to}
            totalDays={totalDays}
            todayPosition={showToday ? todayOffset : null}
          />
        </div>

        <div className="order-2 min-w-0 md:order-3">
          <p className="text-sm text-slate-800">{availability.sentence}</p>
          {availability.kind === "part" && availability.blocker ? (
            <p className="mt-0.5 text-[13px] text-slate-500">{availability.blocker}</p>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div id={panelId} className="border-t border-ink-800 px-4 py-3 md:pl-11">
          <p className="text-[12px] font-medium text-slate-500">In this period</p>
          {bookings.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-slate-500">
              No bookings or blocks in this period.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {bookings.map((segment) => (
                <BookingLineRow
                  key={`${segment.start}-${segment.state}-${segment.reservationId ?? "none"}`}
                  segment={segment}
                />
              ))}
            </ul>
          )}

          <div className="mt-3">
            <Link
              to="/app/fleet/$craneId/edit"
              params={{ craneId: crane.craneId }}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
              Open crane
            </Link>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function BookingLineRow({ segment }: { segment: DaySegment }) {
  return (
    <li className="flex items-baseline gap-2 text-[13px] text-slate-700">
      <span
        className={cn("mt-1 size-1.5 shrink-0 rounded-full", DOT_TONES[segment.state])}
        aria-hidden
      />
      <span>{bookingLine(segment)}</span>
    </li>
  );
}

function CraneStrip({
  availability,
  from,
  to,
  totalDays,
  todayPosition,
}: {
  availability: RangeAvailability;
  from: string;
  to: string;
  totalDays: number;
  todayPosition: number | null;
}) {
  const segments =
    availability.segments.length > 0
      ? availability.segments
      : [
          {
            state: "FREE" as const,
            kind: "free" as const,
            reservationId: null,
            start: from,
            end: to,
            days: totalDays,
          },
        ];

  return (
    <div>
      <div
        className="relative flex h-2.5 gap-px overflow-hidden rounded-full bg-ink-800"
        role="img"
        aria-label={`${availability.sentence}. From ${formatDayFull(from)} to ${formatDayFull(to)}.${todayPosition !== null ? " Today is inside this period." : ""}`}
      >
        {segments.map((segment) => (
          <span
            key={`${segment.start}-${segment.state}-${segment.reservationId ?? "none"}`}
            title={bookingLine(segment)}
            className={cn("h-full", SEGMENT_TONES[segment.state])}
            style={{ flexGrow: segment.days, flexBasis: 0 }}
          />
        ))}
        {todayPosition !== null ? (
          <span
            className="absolute inset-y-0 z-10 w-px bg-brand-500"
            style={{ left: `${((todayPosition + 0.5) / totalDays) * 100}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[12px] text-slate-500 tabular-nums">
        <span>{formatDay(from)}</span>
        {todayPosition !== null ? (
          <span className="text-brand-700">Today</span>
        ) : null}
        <span>{formatDay(to)}</span>
      </div>
    </div>
  );
}


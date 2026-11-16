import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import {
  ArrowUpRight,
  ChevronDown,
  Mail,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, TextInput } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { RequestCraneDialog } from "@/components/request-crane-dialog";
import {
  EMPTY_FILTERS,
  addDays,
  bookingLine,
  bookingsWithin,
  classifyRange,
  defaultRange,
  diffDays,
  formatDay,
  formatDayFull,
  formatRange,
  groupByAvailability,
  isDay,
  matchesFilters,
  presetsFor,
  splitRange,
  todayKey,
  type AvailabilityFilters,
  type ClassifiedCrane,
  type DaySegment,
  type RangeAvailability,
} from "@/lib/availability";
import { getBookingCalendar, type CalendarView, type CalendarCrane } from "@/lib/calendar";
import { cn } from "@/lib/cn";

/**
 * Crane availability — "which cranes are free between these dates?".
 *
 * A salesperson is on the phone with a request. The page answers it in one
 * screen: pick the dates, optionally narrow by type and capacity, and read down
 * three groups — free the whole time, free for part of it, not available. Each
 * row carries a plain sentence as well as a strip, so the answer survives both
 * a colour-blind reader and a screen reader.
 *
 * The day grid and the timeline toggle that lived here before answered a
 * different question ("what happens on the 14th") and needed a legend to read.
 * This page has one question and one answer.
 *
 * Everything is read-only. The API caps a calendar request at 92 days, so a
 * longer custom period is fetched in consecutive chunks and merged.
 */

const SEARCH_DEBOUNCE_MS = 220;

interface ViewState {
  from: string;
  to: string;
  filters: AvailabilityFilters;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  // The router parses query values as JSON, so `?min=250` arrives as a number.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function parseView(search: Record<string, unknown>, today: string): ViewState {
  const fallback = defaultRange(today);
  const from = isDay(text(search.from)) ? text(search.from) : fallback.from;
  const rawTo = isDay(text(search.to)) ? text(search.to) : addDays(from, 29);
  const to = rawTo < from ? addDays(from, 29) : rawTo;
  return {
    from,
    to,
    filters: {
      type: text(search.type),
      min: text(search.min),
      state: text(search.state),
      q: text(search.q),
    },
  };
}

function toSearch(view: ViewState): Record<string, string | number> {
  const search: Record<string, string | number> = { from: view.from, to: view.to };
  if (view.filters.type) search.type = view.filters.type;
  if (view.filters.min) search.min = Number(view.filters.min);
  if (view.filters.state) search.state = view.filters.state;
  if (view.filters.q) search.q = view.filters.q;
  return search;
}

function keyOf(search: Record<string, unknown>): string {
  return Object.keys(search)
    .sort()
    .map((key) => `${key}=${String(search[key] ?? "")}`)
    .join("&");
}

/** One response from one or more 92-day chunks, keyed by crane. */
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

export function BookingCalendarPage() {
  const today = todayKey();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();

  const [view, setView] = useState<ViewState>(() => parseView(routeSearch, today));
  const [query, setQuery] = useState(view.filters.q);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNotAvailable, setShowNotAvailable] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ---- URL is the view -----------------------------------------------------
  const routeKey = keyOf(routeSearch);
  const lastRouteKey = useRef(routeKey);
  const lastWrittenKey = useRef<string | null>(null);

  useEffect(() => {
    if (routeKey === lastRouteKey.current) return;
    lastRouteKey.current = routeKey;
    if (routeKey === lastWrittenKey.current) return;
    const next = parseView(routeSearch, today);
    setView(next);
    setQuery(next.filters.q);
  }, [routeKey, routeSearch, today]);

  useEffect(() => {
    if (pathname !== "/app/bookings") return;
    const search = toSearch(view);
    lastWrittenKey.current = keyOf(search);
    void navigate({ to: "/app/bookings", search, replace: true });
  }, [view, pathname, navigate]);

  // Typing stays local until it settles, so the list is not rebuilt per key.
  useEffect(() => {
    setQuery(view.filters.q);
  }, [view.filters.q]);
  useEffect(() => {
    if (query === view.filters.q) return;
    const timer = window.setTimeout(() => {
      setView((previous) => ({ ...previous, filters: { ...previous.filters, q: query } }));
      setExpandedId(null);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, view.filters.q]);

  // ---- Calendar ------------------------------------------------------------
  const chunks = useMemo(() => splitRange(view.from, view.to), [view.from, view.to]);
  const calendar = useQuery({
    queryKey: ["availability", view.from, view.to],
    queryFn: async () => {
      const parts: CalendarView[] = [];
      for (const chunk of chunks) {
        const response = await getBookingCalendar(chunk);
        parts.push(response.calendar);
      }
      return mergeCalendars(parts);
    },
  });

  const cranes = useMemo(() => calendar.data?.cranes ?? [], [calendar.data]);
  const classified = useMemo(
    () =>
      cranes
        .filter((crane) => matchesFilters(crane, view.filters))
        .map((crane) => ({ crane, availability: classifyRange(crane, view.from, view.to) })),
    [cranes, view.filters, view.from, view.to],
  );
  const groups = useMemo(() => groupByAvailability(classified), [classified]);
  const freeCount = groups.whole.length + groups.part.length;

  const types = useMemo(() => {
    const map = new Map<string, string>();
    for (const crane of cranes) map.set(crane.craneTypeCode, crane.craneTypeName);
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [cranes]);

  const states = useMemo(() => {
    const map = new Map<string, string>();
    for (const crane of cranes) map.set(crane.stateCode, crane.stateName);
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [cranes]);

  const presets = useMemo(() => presetsFor(today), [today]);

  // ---- Handlers ------------------------------------------------------------
  const setRange = useCallback((from: string, to: string) => {
    setView((previous) => {
      const keepLength = Math.max(0, diffDays(previous.from, previous.to));
      const nextTo = to < from ? addDays(from, keepLength) : to;
      return { ...previous, from, to: nextTo };
    });
    setExpandedId(null);
  }, []);

  const setFrom = useCallback(
    (value: string) => {
      if (!isDay(value)) return;
      setView((previous) => ({
        ...previous,
        from: value,
        to: value > previous.to ? addDays(value, Math.max(0, diffDays(previous.from, previous.to))) : previous.to,
      }));
      setExpandedId(null);
    },
    [],
  );

  const setTo = useCallback((value: string) => {
    if (!isDay(value)) return;
    setView((previous) => ({
      ...previous,
      to: value,
      from: value < previous.from ? value : previous.from,
    }));
    setExpandedId(null);
  }, []);

  const setFilter = useCallback(<K extends keyof AvailabilityFilters>(key: K, value: AvailabilityFilters[K]) => {
    setView((previous) => ({ ...previous, filters: { ...previous.filters, [key]: value } }));
    setExpandedId(null);
  }, []);

  const clearFilters = useCallback(() => {
    setQuery("");
    setView((previous) => ({ ...previous, filters: { ...EMPTY_FILTERS } }));
    setExpandedId(null);
  }, []);

  const activeFilters = Boolean(
    view.filters.type || view.filters.min || view.filters.state || view.filters.q,
  );

  const rangeLabel = formatRange(view.from, view.to);
  const rangeProse = `${formatDay(view.from)} to ${formatDay(view.to)}`;
  const summaryParts = [
    rangeLabel,
    view.filters.type ? types.find((type) => type.value === view.filters.type)?.label : "",
    view.filters.min ? `${view.filters.min} t or larger` : "",
    view.filters.state ? states.find((state) => state.value === view.filters.state)?.label : "",
  ].filter(Boolean);

  const toggleExpanded = useCallback((craneId: string) => {
    setExpandedId((previous) => (previous === craneId ? null : craneId));
  }, []);

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title="Crane availability" description="Which cranes are free, and when?" />

      <section className="card p-4" aria-labelledby="availability-dates-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="availability-dates-heading" className="text-sm font-semibold text-slate-900">
              When do you need a crane?
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Choose the dates, then narrow the list if you need to.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="availability-filters"
            onClick={() => setFiltersOpen((open) => !open)}
            className="btn-secondary px-3 py-1.5 text-xs md:hidden"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            {filtersOpen ? "Hide filters" : "Change dates and filters"}
          </button>
        </div>

        <p className="mt-2 text-[13px] text-slate-500 md:hidden">{summaryParts.join(" · ")}</p>

        <div
          id="availability-filters"
          className={cn("mt-3 space-y-3", !filtersOpen && "hidden md:block")}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" htmlFor="availability-from">
              <TextInput
                id="availability-from"
                type="date"
                value={view.from}
                onChange={setFrom}
              />
            </Field>
            <Field label="To" htmlFor="availability-to">
              <TextInput id="availability-to" type="date" value={view.to} onChange={setTo} />
            </Field>

            <div
              className="flex flex-wrap items-center gap-1.5 pb-1"
              role="group"
              aria-label="Quick date ranges"
            >
              {presets.map((preset) => {
                const selected = view.from === preset.from && view.to === preset.to;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setRange(preset.from, preset.to)}
                    className={cn(
                      "rounded-full border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
                      selected
                        ? "border-brand-300 bg-brand-50 text-brand-700"
                        : "border-slate-200 text-slate-600 hover:bg-ink-800 hover:text-slate-900",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Crane type" htmlFor="availability-type">
              <Select
                id="availability-type"
                value={view.filters.type}
                onChange={(value) => setFilter("type", value)}
                placeholder="Any type"
                options={types}
              />
            </Field>

            <Field label="Min capacity (t)" htmlFor="availability-min">
              <TextInput
                id="availability-min"
                type="number"
                value={view.filters.min}
                onChange={(value) => setFilter("min", value.replace(/[^0-9]/g, ""))}
                placeholder="Any"
                inputMode="numeric"
              />
            </Field>

            <Field label="State" htmlFor="availability-state">
              <Select
                id="availability-state"
                value={view.filters.state}
                onChange={(value) => setFilter("state", value)}
                placeholder="Any state"
                options={states}
              />
            </Field>

            <Field label="Search crane or vendor" htmlFor="availability-q">
              <TextInput
                id="availability-q"
                value={query}
                onChange={setQuery}
                placeholder="Name, vendor or city"
              />
            </Field>
          </div>

          {activeFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      {calendar.isPending ? (
        <LoadingRows />
      ) : calendar.isError ? (
        <Alert tone="error" title="Could not load crane availability">
          <p>The calendar could not be read for these dates. Nothing has changed; try again.</p>
          <button
            type="button"
            onClick={() => void calendar.refetch()}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Retry
          </button>
        </Alert>
      ) : cranes.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No cranes in this period"
            description="The calendar returned no cranes for these dates. Try another period."
            action={
              <button type="button" onClick={() => setRange(today, addDays(today, 29))} className="btn-secondary px-3 py-1.5 text-xs">
                Reset dates
              </button>
            }
          />
        </div>
      ) : (
        <section className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900" aria-label="Cranes by availability">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-800 px-4 py-2.5">
            <p className="text-[13px] text-slate-600" aria-live="polite">
              <span className="font-semibold text-slate-900">{freeCount}</span>{" "}
              {freeCount === 1 ? "crane" : "cranes"} free for all or part of{" "}
              <span className="font-medium text-slate-800">{rangeProse}</span>
            </p>
            <p className="text-[12px] text-slate-500 tabular-nums">
              {groups.whole.length} free the whole time · {groups.part.length} partly free
            </p>
          </div>

          {freeCount === 0 ? (
            <EmptyState
              title="No cranes match these dates and filters."
              description="Try a shorter period or fewer filters."
              action={
                activeFilters ? (
                  <button type="button" onClick={clearFilters} className="btn-secondary px-3 py-1.5 text-xs">
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          ) : (
            <>
              <GroupSection
                title="Free for your whole period"
                count={groups.whole.length}
                rows={groups.whole}
                open
                expandedId={expandedId}
                view={view}
                onToggle={toggleExpanded}
              />
              <GroupSection
                title="Free for part of your period"
                count={groups.part.length}
                rows={groups.part}
                open
                expandedId={expandedId}
                view={view}
                onToggle={toggleExpanded}
              />
              <GroupSection
                title="Not available"
                count={groups.none.length}
                rows={groups.none}
                open={showNotAvailable}
                onOpenChange={setShowNotAvailable}
                expandedId={expandedId}
                view={view}
                onToggle={toggleExpanded}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="card space-y-3 p-4" role="status" aria-label="Loading crane availability">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(220px,1.5fr)_minmax(0,1fr)] md:items-center">
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
  expandedId,
  view,
  onToggle,
}: {
  title: string;
  count: number;
  rows: ClassifiedCrane[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  expandedId: string | null;
  view: ViewState;
  onToggle: (craneId: string) => void;
}) {
  const collapsible = Boolean(onOpenChange);
  const headerContent = (
    <>
      {collapsible ? (
        <ChevronDown
          className={cn("size-4 shrink-0 text-slate-500 transition-transform", !open && "-rotate-90 motion-reduce:transition-none")}
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
            <CraneRow
              key={row.crane.craneId}
              row={row}
              view={view}
              expanded={expandedId === row.crane.craneId}
              onToggle={onToggle}
            />
          ))
        : null}
    </section>
  );
}

function CraneRow({
  row,
  view,
  expanded,
  onToggle,
}: {
  row: ClassifiedCrane;
  view: ViewState;
  expanded: boolean;
  onToggle: (craneId: string) => void;
}) {
  const { crane, availability } = row;
  const [requestOpen, setRequestOpen] = useState(false);
  const panelId = `availability-panel-${crane.craneId}`;
  const bookings = useMemo(
    () => bookingsWithin(crane, view.from, view.to),
    [crane, view.from, view.to],
  );
  const totalDays = Math.max(1, diffDays(view.from, view.to) + 1);
  const today = todayKey();
  const todayOffset = diffDays(view.from, today);
  const showToday = todayOffset >= 0 && todayOffset < totalDays;

  // The first free run is what the request window is told about. It is not the
  // whole period on screen: a partly free crane may only be free from the 20th.
  const firstFree = availability.segments.find((segment) => segment.kind === "free");
  const freeWindow =
    availability.kind === "none"
      ? undefined
      : { from: firstFree?.start ?? view.from, to: firstFree?.end ?? view.to };

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
        aria-label={`${crane.craneLabel}, ${crane.capacityT} tonnes, ${crane.craneTypeName}. ${availability.sentence}. ${crane.vendorName}, ${crane.currentLocation}.`}
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
              className={cn("size-3.5 shrink-0 text-slate-500 transition-transform", !expanded && "-rotate-90 motion-reduce:transition-none")}
              aria-hidden
            />
            <span className="truncate">{crane.craneLabel}</span>
          </p>
          <p className="mt-1 truncate text-[13px] text-slate-600 tabular-nums">
            {crane.capacityT} t · {crane.craneTypeName.replace(/\s+Crane$/i, "")}
          </p>
          <p className="truncate text-[13px] text-slate-500">
            {crane.vendorName} · {crane.currentLocation}
          </p>
        </div>

        <div className="order-3 min-w-0 md:order-2">
          <CraneStrip
            availability={availability}
            from={view.from}
            to={view.to}
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
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            In this period
          </p>
          {bookings.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-slate-500">
              No bookings or blocks in this period.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {bookings.map((segment) => (
                <BookingLineRow key={`${segment.start}-${segment.state}-${segment.reservationId ?? "none"}`} segment={segment} />
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              to="/app/cranes/$craneId"
              params={{ craneId: crane.craneId }}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
              Open crane
            </Link>
            <button
              type="button"
              onClick={() => setRequestOpen(true)}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              <Mail className="size-3.5" aria-hidden />
              Start an RFQ
            </button>
          </div>

          <RequestCraneDialog
            open={requestOpen}
            onOpenChange={setRequestOpen}
            freeWindow={freeWindow}
            availabilityNote={
              availability.kind === "none"
                ? availability.blocker ?? "Not free in this period"
                : undefined
            }
            crane={{
              craneId: crane.craneId,
              vendorId: crane.vendorId,
              vendorName: crane.vendorName,
              typeOfCraneCode: crane.craneTypeCode,
              typeOfCraneName: crane.craneTypeName,
              capacityT: crane.capacityT,
              mainBoomM: null,
              currentLocation: crane.currentLocation,
              stateCode: crane.stateCode,
              stateName: crane.stateName,
              availableFrom: null,
              latitude: null,
              longitude: null,
            }}
          />
        </div>
      ) : null}
    </article>
  );
}

function BookingLineRow({ segment }: { segment: DaySegment }) {
  return (
    <li className="flex items-baseline gap-2 text-[13px] text-slate-700">
      <span
        className={cn(
          "mt-1 size-1.5 shrink-0 rounded-full",
          segment.kind === "booked" ? "bg-blue-500" : "bg-amber-500",
        )}
        aria-hidden
      />
      <span>
        {bookingLine(segment)}
      </span>
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
      : [{ state: "FREE" as const, kind: "free" as const, reservationId: null, start: from, end: to, days: totalDays }];

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
            className={cn(
              "h-full",
              segment.kind === "booked" && "bg-blue-500",
              segment.kind === "unavailable" && "bg-amber-500",
              segment.kind === "free" && "bg-transparent",
            )}
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
        {todayPosition !== null ? <span className="text-brand-700">Today</span> : null}
        <span>{formatDay(to)}</span>
      </div>
    </div>
  );
}

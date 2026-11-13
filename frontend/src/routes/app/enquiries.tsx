import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarDays,
  Check,
  Clock,
  Compass,
  FileText,
  Inbox,
  MapPin,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  createRfqFromLine,
  getEnquiry,
  getEnquirySummary,
  listEnquiries,
  type EnquiryBucket,
  type EnquiryLine,
  type EnquiryListRow,
  type EnquiryOverallStatus,
  type EnquirySort,
  type EnquirySummaryCounts,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { EnquiryBulkUpload } from "@/components/enquiry-bulk-upload";
import { SiteMap } from "@/components/site-map";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";

/**
 * The enquiry workspace.
 *
 * Two columns, both full height: the list on the left, the selected enquiry's
 * requirements on the right. The page answers "what needs attention", "how far
 * along is this" and "what is the next action" without leaving the screen — the
 * old table made every one of those a navigation.
 *
 * Status is never editable here. The row's status and the progress bar are the
 * server's roll-up of the lines, so the list can never disagree with the detail
 * screen (P1 section 4).
 *
 * Filters, sort and the selected row live in the URL, so a view can be sent to
 * a colleague and land on the same enquiry with the same filters.
 */

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Array<{ value: EnquiryOverallStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "RECEIVED_PENDING_SOURCING", label: "Pending sourcing" },
  { value: "PARTIALLY_QUOTED", label: "Partially quoted" },
  { value: "PARTIALLY_FINALISED", label: "Partially finalised" },
  { value: "FULLY_FINALISED", label: "Fully finalised" },
  { value: "CLOSED", label: "Closed" },
];

/**
 * Status colour, from the same palette the discovery pins use. Status is always
 * a dot plus a word, never colour alone.
 */
function statusTone(status: EnquiryOverallStatus): {
  dot: string;
  text: string;
  ring: string;
  tint: string;
} {
  switch (status) {
    case "FULLY_FINALISED":
      return {
        dot: "bg-emerald-500",
        text: "text-emerald-600",
        ring: "ring-emerald-500/30",
        tint: "bg-emerald-500/10",
      };
    case "PARTIALLY_FINALISED":
    case "PARTIALLY_QUOTED":
      return {
        dot: "bg-amber-500",
        text: "text-amber-600",
        ring: "ring-amber-500/30",
        tint: "bg-amber-500/10",
      };
    case "CLOSED":
      return {
        dot: "bg-slate-400",
        text: "text-slate-500",
        ring: "ring-slate-500/30",
        tint: "bg-slate-500/10",
      };
    default:
      return {
        dot: "bg-accent-500",
        text: "text-accent-400",
        ring: "ring-accent-500/30",
        tint: "bg-accent-500/10",
      };
  }
}

/** The KPI cards and the bucket each one filters by. */
const KPI_CARDS: Array<{
  bucket: Exclude<EnquiryBucket, "closed">;
  label: string;
  accent?: boolean;
}> = [
  { bucket: "pending", label: "Pending sourcing", accent: true },
  { bucket: "awaiting", label: "Awaiting quotes" },
  { bucket: "quotes", label: "Quotes in" },
  { bucket: "finalised", label: "Finalised" },
];

/**
 * The chips and the card pill must use the same words for the same status;
 * the API's own labels are long ("Received — Pending Sourcing") and are meant
 * for the detail screens, not a 375px panel.
 */
const STATUS_LABEL = Object.fromEntries(
  STATUS_FILTERS.map((filter) => [filter.value, filter.label]),
) as Record<EnquiryOverallStatus, string>;

function kpiValue(
  counts: EnquirySummaryCounts | undefined,
  bucket: Exclude<EnquiryBucket, "closed">,
): number {
  if (!counts) return 0;
  if (bucket === "pending") return counts.pendingSourcing;
  if (bucket === "awaiting") return counts.awaitingQuotes;
  if (bucket === "quotes") return counts.quotesIn;
  return counts.finalised;
}

/**
 * A line's next action, derived from the trail. The button changes with the
 * state so the panel never offers an action the line has already moved past.
 */
function lineAction(line: EnquiryLine): {
  label: string;
  kind: "rfq" | "quotes" | "booking" | "view-rfq";
} {
  // A sourced line's next action is the paperwork, even if quotes exist: the
  // decision is made, and offering "View quotes" again would suggest it is not.
  if (line.trailStatus === "VENDOR_FINALISED") return { label: "View PO", kind: "booking" };
  if (line.trailStatus === "BOOKED" || line.trailStatus === "FULFILLED_INTERNALLY") {
    return { label: "View booking", kind: "booking" };
  }
  if (line.quoteCount && line.quoteCount > 0) {
    return { label: `View quotes (${line.quoteCount})`, kind: "quotes" };
  }
  if (line.rfqId) return { label: "View RFQ", kind: "view-rfq" };
  return { label: "Create RFQ", kind: "rfq" };
}

/**
 * The six line states the brief asks for, folded from the finer internal trail.
 * The trail has eleven steps because sourcing really does have that many, but a
 * 375px panel only needs to answer "can I act on this line, and what is next".
 */
function lineState(status: EnquiryLine["trailStatus"]): string {
  switch (status) {
    case "NEW":
      return "New";
    case "AVAILABILITY_CHECK":
    case "VENDOR_SHORTLISTED":
      return "Availability check";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
      return "RFQ sent";
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "Quotes in";
    case "VENDOR_FINALISED":
    case "BOOKED":
    case "FULFILLED_INTERNALLY":
      return "Awarded";
    default:
      return "Closed";
  }
}

function lineTone(status: EnquiryLine["trailStatus"]): string {
  switch (status) {
    case "VENDOR_FINALISED":
    case "BOOKED":
    case "FULFILLED_INTERNALLY":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600";
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "border-blue-500/30 bg-blue-500/10 text-blue-600";
    case "CLOSED":
    case "CANCELLED":
      return "border-slate-500/30 bg-slate-500/10 text-slate-500";
    default:
      return "border-ink-700 bg-ink-850 text-slate-500";
  }
}

const SORT_OPTIONS: Array<{ value: EnquirySort; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "startDate", label: "Start date soonest" },
  { value: "progress", label: "Least progress" },
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function fullDate(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

function durationLabel(line: EnquiryLine): string {
  if (!line.durationValue || !line.durationUnit) return "Duration not set";
  const unit = line.durationUnit === "MONTHS" ? "month" : "day";
  const value = line.durationValue === 1 ? unit : `${unit}s`;
  return `${line.durationValue} ${value}`;
}

function cityOf(row: { siteLocation: string }): string {
  return row.siteLocation.split(",")[0]?.trim() || row.siteLocation;
}

/**
 * "Crawler Crane · 250t" repeats the noun; next to a capacity the type alone is
 * what the buyer scans for, so the trailing "Crane" is dropped for display.
 */
function craneTypeLabel(name: string | null | undefined): string {
  return (name ?? "Crane").replace(/\s+Crane$/i, "");
}

/** Numbers tick up on load; the count is the point of a KPI card. */
function useCountUp(value: number, duration = 550): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return display;
}

function KpiCard({
  label,
  value,
  delta,
  accent,
  active,
  loading,
  onClick,
}: {
  label: string;
  value: number;
  delta: number;
  accent?: boolean;
  active: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  const shown = useCountUp(value);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-busy={loading}
      className={cn(
        "group flex flex-col items-start rounded-[14px] border px-4 py-3 text-left transition-all duration-150",
        "hover:-translate-y-0.5 hover:border-ink-700 hover:bg-ink-850",
        active
          ? "border-accent-500/60 bg-ink-850 ring-1 ring-accent-500/40"
          : "border-ink-800 bg-ink-900",
      )}
    >
      {loading ? (
        <span className="mt-1 h-6 w-8 animate-pulse rounded bg-ink-800" aria-label={label} />
      ) : (
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums",
            accent ? "text-accent-400" : "text-white",
          )}
        >
          {shown}
        </span>
      )}
      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] tracking-wide text-slate-500">
        {label}
        {delta > 0 ? (
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600">
            +{delta} today
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ProgressBar({ row }: { row: EnquiryListRow }) {
  const lines = Math.max(row.lineCount, 1);
  // One segment per line, filled from the server's sourced-line count. A
  // percentage rounded across segments would claim a line is done when only
  // some of its cranes are.
  const filled = Math.min(row.sourcedLineCount, lines);
  const fill =
    row.sourcedPercent >= 100
      ? "bg-emerald-500"
      : row.sourcedPercent > 0
        ? "bg-amber-500"
        : "bg-accent-500/70";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={row.sourcedPercent}
      aria-label={`${row.sourcedPercent}% sourced`}
      className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-ink-800"
    >
      {Array.from({ length: lines }).map((_, index) => (
        <span
          key={index}
          className={cn("h-full flex-1", index < filled ? fill : "bg-ink-700")}
        />
      ))}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="rounded-[14px] border border-ink-800 bg-ink-900 p-4">
      <div className="animate-pulse space-y-2">
        <div className="h-2.5 w-24 rounded bg-ink-800" />
        <div className="h-3.5 w-52 rounded bg-ink-800" />
        <div className="h-2.5 w-40 rounded bg-ink-800" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function EnquiryIndexPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const canCreate = user?.role === "sales_user" || user?.role === "admin_user";

  const [status, setStatus] = useState<EnquiryOverallStatus | "ALL">(() => {
    const value = routeSearch.status;
    return typeof value === "string" &&
      STATUS_FILTERS.some((filter) => filter.value === value && value !== "ALL")
      ? (value as EnquiryOverallStatus)
      : "ALL";
  });
  const [bucket, setBucket] = useState<EnquiryBucket | null>(() => {
    const value = routeSearch.bucket;
    return value === "pending" || value === "awaiting" || value === "quotes" || value === "finalised"
      ? value
      : null;
  });
  const [sort, setSort] = useState<EnquirySort>(() => {
    const value = routeSearch.sort;
    return value === "startDate" || value === "progress" ? value : "newest";
  });
  const [searchInput, setSearchInput] = useState(() =>
    typeof routeSearch.q === "string" ? routeSearch.q : "",
  );
  const [search, setSearch] = useState(() =>
    typeof routeSearch.q === "string" ? routeSearch.q : "",
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof routeSearch.selected === "string" ? routeSearch.selected : null,
  );
  const [rfqLine, setRfqLine] = useState<EnquiryLine | null>(null);
  const [deadline, setDeadline] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date.toISOString().slice(0, 10);
  });

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  // Shareable view. `replace` keeps a filter change from filling the back stack.
  useEffect(() => {
    void navigate({
      to: pathname,
      search: {
        ...(status === "ALL" ? {} : { status }),
        ...(bucket ? { bucket } : {}),
        ...(search ? { q: search } : {}),
        ...(sort === "newest" ? {} : { sort }),
        ...(selectedId ? { selected: selectedId } : {}),
      },
      replace: true,
    });
  }, [status, bucket, search, sort, selectedId, navigate, pathname]);

  const summary = useQuery({
    queryKey: ["enquiries", "summary"],
    queryFn: getEnquirySummary,
  });

  const list = useQuery({
    queryKey: ["enquiries", "list", status, search, sort],
    queryFn: () =>
      listEnquiries({
        ...(status === "ALL" ? {} : { status }),
        ...(search ? { search } : {}),
        sort,
      }),
    placeholderData: (previous) => previous,
  });

  const rows = useMemo(() => {
    const all = list.data?.enquiries ?? [];
    return bucket ? all.filter((row) => row.bucket === bucket) : all;
  }, [list.data, bucket]);

  // Select the first row once the list arrives, so the panel is never empty
  // while there is something to look at.
  useEffect(() => {
    if (selectedId || rows.length === 0) return;
    if (list.isPending) return;
    const first = rows[0];
    if (first) setSelectedId(first.id);
  }, [rows, selectedId, list.isPending]);

  // A selection that no longer matches the filters is a dead panel.
  useEffect(() => {
    if (!selectedId || list.isPending) return;
    if (rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId, list.isPending]);

  const detail = useQuery({
    queryKey: ["enquiries", "detail", selectedId],
    queryFn: () => getEnquiry(selectedId as string),
    enabled: Boolean(selectedId),
  });

  const createRfq = useMutation({
    mutationFn: (input: { lineId: string; deadline: string }) =>
      createRfqFromLine(input.lineId, input.deadline),
    onSuccess: async () => {
      setRfqLine(null);
      await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
    },
  });

  const counts = summary.data?.summary;
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const enquiry = detail.data?.enquiry ?? null;

  const clearFilters = () => {
    setStatus("ALL");
    setBucket(null);
    setSearch("");
    setSearchInput("");
    setSort("newest");
  };

  const listRef = useRef<HTMLDivElement | null>(null);

  // Up/down move the selection; Enter opens the full enquiry. The list is a
  // listbox, so this is the keyboard behaviour a listbox is expected to have.
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === selectedId);

    if (event.key === "Enter") {
      if (selectedId) {
        event.preventDefault();
        void navigate({ to: "/app/enquiries/$enquiryId", params: { enquiryId: selectedId } });
      }
      return;
    }

    event.preventDefault();
    const next =
      event.key === "ArrowDown"
        ? rows[Math.min(index + 1, rows.length - 1)]
        : rows[Math.max(index - 1, 0)];
    if (!next) return;
    setSelectedId(next.id);
    document.getElementById(`enquiry-row-${next.id}`)?.scrollIntoView({ block: "nearest" });
  };

  const findCranesHref = (row: EnquiryListRow | null, line: EnquiryLine | null) => {
    return {
      to: "/app/discovery" as const,
      search: {
        ...(row?.siteLocation ? { siteLocation: row.siteLocation } : {}),
        ...(line?.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
        ...(line?.capacityT ? { capacityT: line.capacityT } : {}),
        ...(line?.capacityT ? { capacityRule: "AT_LEAST" } : {}),
      },
    };
  };

  const activeFilters = Boolean(bucket || search) || status !== "ALL";
  const nothingAtAll = (counts?.total ?? 0) === 0;

  return (
    <div className="theme-dark -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6">
      {/* ------------------------------------------------------------ list */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-ink-800 px-6 pt-5 pb-4">
          <p className="text-xs text-slate-500">
            {greeting()}
            {user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}
            {counts ? ` · ${counts.active} active ${counts.active === 1 ? "request" : "requests"}` : ""}
          </p>

          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-white">Who needs a lift?</h1>
            {canCreate ? (
              <div className="flex items-center gap-2">
                <EnquiryBulkUpload />
                <Link to="/app/enquiries/new" className="btn-primary py-2 text-[13px]">
                  <Plus className="size-4" aria-hidden />
                  New enquiry
                </Link>
              </div>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {KPI_CARDS.map((card) => (
              <KpiCard
                key={card.bucket}
                label={card.label}
                value={kpiValue(counts, card.bucket)}
                delta={counts?.raisedTodayByBucket[card.bucket] ?? 0}
                accent={card.accent}
                active={bucket === card.bucket}
                loading={summary.isPending}
                onClick={() => setBucket((current) => (current === card.bucket ? null : card.bucket))}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Enquiry no, customer, reference"
                aria-label="Search enquiries"
                className="field-input h-9 py-0 pl-9 text-[13px]"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-white"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>

            <label className="sr-only" htmlFor="enquiry-sort">
              Sort enquiries
            </label>
            <select
              id="enquiry-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as EnquirySort)}
              className="field-input h-9 w-auto py-0 pr-8 text-[13px]"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div
            role="tablist"
            aria-label="Enquiry status"
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {STATUS_FILTERS.map((filter) => {
              const active = status === filter.value;
              return (
                <button
                  key={filter.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatus(filter.value)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-150",
                    active
                      ? "bg-white text-ink-950"
                      : "border border-ink-800 text-slate-500 hover:border-ink-700 hover:bg-ink-850 hover:text-white",
                  )}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={listRef}
          role="list"
          aria-label="Enquiries"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-6 py-4 focus:outline-none"
        >
          {list.isPending ? (
            <>
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </>
          ) : list.isError ? (
            <div className="rounded-[14px] border border-ink-800 bg-ink-900 p-4">
              <Alert tone="error">
                {list.error instanceof Error ? list.error.message : "Could not load enquiries."}
              </Alert>
              <button
                type="button"
                onClick={() => void list.refetch()}
                className="btn-secondary mt-3 py-1.5 text-[13px]"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Retry
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-[14px] border border-ink-800 bg-ink-900 px-5 py-10 text-center">
              <Inbox className="mx-auto size-6 text-slate-500" aria-hidden />
              <p className="mt-2 text-sm font-medium text-white">
                {nothingAtAll ? "No enquiries yet" : "No enquiries match your filters"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                {nothingAtAll
                  ? "Raise the first requirement and it will appear here, ready to source."
                  : "Clear the search and status filters, or pick another view."}
              </p>
              {nothingAtAll && canCreate ? (
                <Link to="/app/enquiries/new" className="btn-primary mt-4 py-1.5 text-[13px]">
                  <Plus className="size-4" aria-hidden />
                  Raise your first enquiry
                </Link>
              ) : activeFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="btn-secondary mt-4 py-1.5 text-[13px]"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            rows.map((row) => {
              const tone = statusTone(row.overallStatus);
              const selected = row.id === selectedId;
              const days = daysUntil(row.nextUnsourcedStart);
              const urgent = days !== null && days <= 14 && row.sourcedPercent < 100;

              return (
                <div
                  key={row.id}
                  id={`enquiry-row-${row.id}`}
                  role="listitem"
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "group relative rounded-[14px] border px-4 py-4 transition-all duration-150 md:min-h-[94px]",
                    selected
                      ? "border-accent-500/70 bg-ink-850 shadow-[0_0_0_1px_rgba(196,68,63,0.25),0_0_24px_rgba(196,68,63,0.10)]"
                      : "border-ink-800 bg-ink-900 hover:border-ink-700 hover:bg-ink-850",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    onDoubleClick={() =>
                      void navigate({
                        to: "/app/enquiries/$enquiryId",
                        params: { enquiryId: row.id },
                      })
                    }
                    aria-label={`${row.enquiryNo} · ${row.customerName}`}
                    className="absolute inset-0 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  />

                  <div className="pointer-events-none relative grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] tracking-[0.08em] text-slate-500 uppercase">
                        {row.enquiryNo}
                      </p>
                      <p className="truncate text-[15px] font-semibold text-white">
                        {row.customerName}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {row.project ?? row.siteLocation}
                      </p>
                    </div>

                    <div className="min-w-0 text-xs text-slate-500">
                      <p className="flex items-center gap-1.5">
                        <MapPin className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">
                          {row.siteLocation}
                          {row.siteStateName && !row.siteLocation.includes(row.siteStateName)
                            ? `, ${row.siteStateName}`
                            : ""}
                        </span>
                      </p>
                      <p className="mt-0.5 pl-[18px] text-slate-500">
                        {row.craneCount} {row.craneCount === 1 ? "crane" : "cranes"} ·{" "}
                        {row.lineCount} {row.lineCount === 1 ? "line" : "lines"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <ProgressBar row={row} />
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
                        <span>{row.sourcedPercent}% sourced</span>
                        <span aria-hidden>·</span>
                        <span title={`Raised ${fullDate(row.enquiryDate)}`}>
                          {shortDate(row.enquiryDate)}
                        </span>
                        {urgent ? (
                          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                            <Clock className="size-2.5" aria-hidden />
                            {days === 0 ? "Starts today" : `Starts in ${days} days`}
                          </span>
                        ) : null}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 md:justify-end">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
                          tone.tint,
                          tone.text,
                          tone.ring,
                        )}
                      >
                        <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                        {STATUS_LABEL[row.overallStatus]}
                      </span>
                    </div>
                  </div>

                  {/* Quick actions appear on hover/focus, in the space between
                      the progress bar and the status. */}
                  <div className="pointer-events-none absolute inset-y-0 right-4 hidden items-center gap-1.5 md:flex md:opacity-0 md:transition-opacity md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100">
                    <Link
                      {...findCranesHref(row, null)}
                      className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-slate-600 hover:text-white"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Compass className="mr-1 inline size-3" aria-hidden />
                      Find cranes
                    </Link>
                    <Link
                      to="/app/enquiries/$enquiryId"
                      params={{ enquiryId: row.id }}
                      className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-slate-600 hover:text-white"
                    >
                      Open
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ----------------------------------------------------------- panel */}
      <aside
        aria-label="Enquiry detail"
        className="hidden w-[375px] shrink-0 flex-col border-l border-ink-800 bg-ink-900 lg:flex"
      >
        {detail.isPending && selectedId ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <div className="p-4">
            <Alert tone="error">
              {detail.error instanceof Error
                ? detail.error.message
                : "Could not load this enquiry."}
            </Alert>
          </div>
        ) : !enquiry ? (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <Compass className="size-6 text-slate-500" aria-hidden />
            <p className="mt-2 text-sm font-medium text-white">Nothing selected</p>
            <p className="mt-1 text-xs text-slate-500">
              Select an enquiry to see its crane requirements.
            </p>
          </div>
        ) : (
          <>
            <div key={enquiry.id} className="panel-in min-h-0 flex-1 overflow-y-auto">
              {/* site */}
              <div className="relative">
                {enquiry.siteLatitude !== null && enquiry.siteLongitude !== null ? (
                  <SiteMap
                    latitude={enquiry.siteLatitude}
                    longitude={enquiry.siteLongitude}
                    label={`Map of ${enquiry.siteLocation}`}
                    onOpen={() => void navigate(findCranesHref(selectedRow, null))}
                  />
                ) : (
                  <div className="flex h-[140px] w-full items-center justify-center bg-ink-950">
                    <MapPin className="size-6 text-slate-500" aria-hidden />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void navigate(findCranesHref(selectedRow, null))}
                  className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full border border-ink-800 bg-black/70 px-2.5 py-1 text-[11px] text-neutral-200 backdrop-blur-sm hover:border-ink-700"
                >
                  <MapPin className="size-3 text-accent-400" aria-hidden />
                  {enquiry.siteLocation}
                </button>
              </div>

              {/* summary */}
              <div className="border-b border-ink-800 px-4 py-4">
                <p className="font-mono text-[10px] tracking-[0.08em] text-accent-400 uppercase">
                  {enquiry.enquiryNo}
                </p>
                <h2 className="mt-1 text-lg leading-tight font-semibold text-white">
                  {enquiry.customerName}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {selectedRow?.project ?? enquiry.siteLocation}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" aria-hidden />
                    {cityOf(enquiry)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden />
                    Raised {shortDate(enquiry.enquiryDate)}
                  </span>
                </div>
              </div>

              {/* requirements */}
              <div className="px-4 py-4">
                <p className="text-[10px] font-medium tracking-[0.14em] text-slate-500 uppercase">
                  Crane requirements
                </p>

                <ul className="mt-2.5 space-y-2">
                  {enquiry.lines.length === 0 ? (
                    <li className="rounded-[14px] border border-dashed border-ink-700 px-3 py-6 text-center text-xs text-slate-500">
                      This enquiry has no lines yet.
                    </li>
                  ) : (
                    enquiry.lines.map((line) => {
                      const action = lineAction(line);
                      return (
                        <li
                          key={line.id}
                          className="rounded-[14px] border border-ink-800 bg-ink-850 p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 text-[13px] font-medium text-white">
                              {line.quantity} × {craneTypeLabel(line.craneTypeName)} ·{" "}
                              {line.capacityT !== null ? `${line.capacityT}t` : "capacity TBC"}
                            </p>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              Line {line.lineNo}
                            </span>
                          </div>

                          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                            <Clock className="size-3 shrink-0" aria-hidden />
                            {line.requiredStartDate
                              ? `From ${shortDate(line.requiredStartDate)}`
                              : "Start date TBC"}
                            <span aria-hidden>·</span>
                            {durationLabel(line)}
                          </p>

                          <div className="mt-2.5 flex items-center justify-between gap-2">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                lineTone(line.trailStatus),
                              )}
                            >
                              {lineState(line.trailStatus)}
                            </span>

                            {action.kind === "rfq" ? (
                              <button
                                type="button"
                                onClick={() => {
                                  createRfq.reset();
                                  setRfqLine(line);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition-colors hover:border-accent-500/60 hover:text-white"
                              >
                                <FileText className="size-3" aria-hidden />
                                {action.label}
                              </button>
                            ) : action.kind === "quotes" ? (
                              <Link
                                to="/app/enquiries/lines/$lineId/comparison"
                                params={{ lineId: line.id }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition-colors hover:border-accent-500/60 hover:text-white"
                              >
                                <FileText className="size-3" aria-hidden />
                                {action.label}
                              </Link>
                            ) : action.kind === "booking" ? (
                              <Link
                                to="/app/bookings"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition-colors hover:border-accent-500/60 hover:text-white"
                              >
                                <Check className="size-3" aria-hidden />
                                {action.label}
                              </Link>
                            ) : (
                              <Link
                                to="/app/rfqs/$rfqId"
                                params={{ rfqId: line.rfqId as string }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition-colors hover:border-accent-500/60 hover:text-white"
                              >
                                <FileText className="size-3" aria-hidden />
                                {action.label}
                              </Link>
                            )}
                          </div>

                          <Link
                            {...findCranesHref(selectedRow, line)}
                            className="mt-2 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-accent-400"
                          >
                            <Compass className="size-2.5" aria-hidden />
                            Find cranes for this line
                          </Link>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            </div>

            {/* pinned CTA */}
            <div className="shrink-0 border-t border-ink-800 p-3">
              <Link
                {...findCranesHref(
                  selectedRow,
                  enquiry.lines.find(
                    (line) =>
                      line.trailStatus === "NEW" || line.trailStatus === "AVAILABILITY_CHECK",
                  ) ??
                    enquiry.lines[0] ??
                    null,
                )}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-600"
              >
                Find cranes for this
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          </>
        )}
      </aside>

      {/* ------------------------------------------------------- RFQ dialog */}
      {rfqLine ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancel"
            className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setRfqLine(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create RFQ"
            className="relative w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900 p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Create RFQ</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Line {rfqLine.lineNo} · {rfqLine.quantity} ×{" "}
                  {craneTypeLabel(rfqLine.craneTypeName)}
                  {rfqLine.capacityT !== null ? ` · ${rfqLine.capacityT}t` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRfqLine(null)}
                aria-label="Close"
                className="rounded-md p-1 text-slate-500 hover:bg-ink-850 hover:text-white"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <label className="field-label mt-4" htmlFor="rfq-deadline">
              Quotes due
            </label>
            <input
              id="rfq-deadline"
              type="date"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              className="field-input"
            />

            <p className="mt-2 text-[11px] text-slate-500">
              The RFQ is prefilled from this line. The customer, address and budget are never sent
              to vendors.
            </p>

            {createRfq.isError ? (
              <div className="mt-3">
                <Alert tone="error">
                  {createRfq.error instanceof Error
                    ? createRfq.error.message
                    : "The RFQ could not be created."}
                </Alert>
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn-secondary py-1.5 text-[13px]"
                onClick={() => setRfqLine(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary py-1.5 text-[13px]"
                disabled={!deadline || createRfq.isPending}
                onClick={() => {
                  if (!rfqLine) return;
                  createRfq.mutate({
                    lineId: rfqLine.id,
                    deadline: new Date(`${deadline}T18:00:00`).toISOString(),
                  });
                }}
              >
                {createRfq.isPending ? "Sending…" : "Send RFQ"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

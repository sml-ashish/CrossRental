import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Compass,
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
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { EnquiryBulkUpload } from "@/components/enquiry-bulk-upload";
import { SiteMap } from "@/components/site-map";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { cityOf, craneTypeLabel, titleCase } from "@/lib/format";
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
 * a dot plus a word, never colour alone — and never a bordered pill.
 */
function statusTone(status: EnquiryOverallStatus): {
  dot: string;
  text: string;
} {
  switch (status) {
    case "FULLY_FINALISED":
      return { dot: "bg-emerald-500", text: "text-emerald-600" };
    case "PARTIALLY_FINALISED":
    case "PARTIALLY_QUOTED":
      return { dot: "bg-amber-500", text: "text-amber-600" };
    case "CLOSED":
      return { dot: "bg-slate-400", text: "text-slate-500" };
    default:
      return { dot: "bg-accent-500", text: "text-accent-400" };
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

function lineDot(status: EnquiryLine["trailStatus"]): string {
  switch (status) {
    case "VENDOR_FINALISED":
    case "BOOKED":
    case "FULFILLED_INTERNALLY":
      return "bg-emerald-500";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
      return "bg-amber-500";
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "bg-blue-500";
    case "CLOSED":
    case "CANCELLED":
      return "bg-slate-500";
    default:
      return "bg-ink-700";
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

/**
 * Numbers tick up once, on first load. A filter click must not re-animate the
 * strip: the count is not the news, the list is. Reduced motion skips it.
 */
function useCountUp(value: number, duration = 550, enabled = true): number {
  const [display, setDisplay] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (done.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done.current = true;
      setDisplay(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(value * eased));
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        done.current = true;
        setDisplay(value);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, enabled]);

  return done.current ? value : display;
}

/**
 * One quarter of the KPI strip. The strip is a single band divided by hairlines,
 * not four boxes: the numbers are the hierarchy, the labels are the caption.
 */
function KpiStat({
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
  const shown = useCountUp(value, 550, !loading);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-busy={loading}
      className="group relative flex flex-col items-start px-4 py-4 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 sm:px-6 sm:first:pl-0"
    >
      {loading ? (
        <span
          aria-hidden
          className="mt-1 h-7 w-8 animate-pulse rounded bg-ink-800 motion-reduce:animate-none"
        />
      ) : (
        <span
          className={cn(
            "text-[28px] leading-none font-semibold tabular-nums",
            accent && value > 0 ? "text-accent-400" : "text-white",
          )}
        >
          {shown}
        </span>
      )}
      <span className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[15px] text-slate-500 transition-colors group-hover:text-slate-700">
        {label}
        {delta > 0 ? (
          <span className="text-[14px] text-slate-500 tabular-nums">{delta} new today</span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 bottom-0 h-0.5 transition-colors duration-150",
          active ? "bg-accent-500" : "bg-transparent",
        )}
      />
    </button>
  );
}

function ProgressBar({ row }: { row: EnquiryListRow }) {
  const lines = Math.max(row.lineCount, 1);
  // One segment per line, filled from the server's sourced-line count. A
  // percentage rounded across segments would claim a line is done when only
  // some of its cranes are.
  const filled = Math.min(row.sourcedLineCount, lines);
  const fill = statusTone(row.overallStatus).dot;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={row.sourcedPercent}
      aria-label={`${row.sourcedPercent}% sourced`}
      className="flex h-1 w-full gap-0.5 overflow-hidden rounded-full bg-ink-800"
    >
      {Array.from({ length: lines }).map((_, index) => (
        <span
          key={index}
          className={cn("h-full flex-1", index < filled ? fill : "bg-ink-800")}
        />
      ))}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-ink-800 py-4 md:grid-cols-[minmax(0,1fr)_220px_260px_150px] md:items-center md:gap-6">
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-2.5 w-24 rounded bg-ink-800" />
        <div className="h-3.5 w-52 rounded bg-ink-800" />
        <div className="h-2.5 w-40 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-3 w-32 rounded bg-ink-800" />
        <div className="h-2.5 w-24 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-1 w-full rounded bg-ink-800" />
        <div className="h-2.5 w-36 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse motion-reduce:animate-none">
        <div className="h-3 w-20 rounded bg-ink-800" />
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
    mutationFn: (input: {
      lineId: string;
      deadline: string;
      fields: RfqLineFieldKey[];
      remark?: string;
    }) => createRfqFromLine(input.lineId, input.deadline, input.fields, input.remark),
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
        ...(line ? { line: line.id } : {}),
        ...(row?.siteLocation ? { siteLocation: row.siteLocation } : {}),
        ...(line?.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
        ...(line?.capacityT ? { capacityT: line.capacityT } : {}),
        ...(line?.capacityT ? { capacityRule: "AT_LEAST" } : {}),
      },
    };
  };

  const activeFilters = Boolean(bucket || search) || status !== "ALL";
  const nothingAtAll = (counts?.total ?? 0) === 0;

  const allRows = list.data?.enquiries ?? [];

  // Per-tab counts are only honest while the "All" view is loaded: a filtered
  // request returns one status, and the summary counts sourcing buckets rather
  // than overall status. Showing them on the unfiltered view is better than
  // inventing a number for the others.
  const tabCounts = useMemo(() => {
    if (status !== "ALL") return null;
    const map: Partial<Record<EnquiryOverallStatus | "ALL", number>> = {
      ALL: allRows.length,
    };
    for (const row of allRows) {
      map[row.overallStatus] = (map[row.overallStatus] ?? 0) + 1;
    }
    return map;
  }, [allRows, status]);

  // Grouping only makes sense in the server's newest-first order. The other
  // sorts are answers to a question ("what starts soonest?"), and cutting them
  // into status sections would undo the sort the user asked for.
  const groups = useMemo(() => {
    if (sort !== "newest") return null;
    return [
      {
        key: "needs-sourcing",
        label: "Needs sourcing",
        rows: rows.filter((row) => row.bucket === "pending"),
      },
      {
        key: "in-progress",
        label: "In progress",
        rows: rows.filter((row) => row.bucket === "awaiting" || row.bucket === "quotes"),
      },
      {
        key: "done",
        label: "Done",
        rows: rows.filter((row) => row.bucket === "finalised" || row.bucket === "closed"),
      },
    ].filter((group) => group.rows.length > 0);
  }, [rows, sort]);

  const hiddenClosed =
    status !== "CLOSED" && !search && !bucket ? (counts?.closed ?? 0) : 0;

  const renderRow = (row: EnquiryListRow) => {
    const tone = statusTone(row.overallStatus);
    const selected = row.id === selectedId;
    const days = daysUntil(row.nextUnsourcedStart);
    const urgent = days !== null && days <= 14 && row.sourcedPercent < 100;
    const project = row.project ?? row.siteLocation;
    const site = row.siteStateName
      ? `${cityOf(row)}, ${titleCase(row.siteStateName)}`
      : cityOf(row);

    return (
      <div
        key={row.id}
        id={`enquiry-row-${row.id}`}
        role="listitem"
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group relative transition-colors duration-150 motion-reduce:transition-none",
          selected ? "bg-ink-850" : "hover:bg-ink-850/60",
        )}
      >
        {selected ? (
          <span className="absolute inset-y-0 left-0 w-0.5 bg-accent-500" aria-hidden />
        ) : null}

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
          className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
        />

        {/* Below 1024 the fixed 220/260/150 tracks would squeeze the customer
            column to nothing, so the row folds to two lines: identity across
            the top, site/progress/status beneath. From lg it is the table. */}
        <div className="pointer-events-none relative grid grid-cols-1 gap-x-6 gap-y-2 py-3 pr-3 pl-3 sm:pl-4 md:grid-cols-[minmax(0,160px)_minmax(0,1fr)_140px] md:items-center lg:grid-cols-[minmax(0,1fr)_220px_260px_150px]">
          <div className="min-w-0 md:col-span-3 md:row-start-1 lg:col-span-1 lg:col-start-1">
            <p className="font-mono text-[14px] leading-tight text-slate-500">{row.enquiryNo}</p>
            <p
              className="mt-0.5 truncate text-[17px] leading-tight font-semibold text-white"
              title={row.customerName}
            >
              {row.customerName}
            </p>
            <p className="truncate text-[15px] leading-tight text-slate-500" title={project}>
              {project}
            </p>
          </div>

          <div className="min-w-0 text-[15px] leading-tight md:col-start-1 md:row-start-2 lg:col-start-2 lg:row-start-1">
            <p className="truncate text-slate-600" title={site}>
              {site}
            </p>
            <p className="mt-0.5 text-[14px] leading-tight text-slate-500 tabular-nums">
              {row.craneCount} {row.craneCount === 1 ? "crane" : "cranes"} · {row.lineCount}{" "}
              {row.lineCount === 1 ? "line" : "lines"}
            </p>
          </div>

          <div className="min-w-0 md:col-start-2 md:row-start-2 lg:col-start-3 lg:row-start-1">
            <ProgressBar row={row} />
            <p className="mt-1.5 text-[14px] leading-tight text-slate-500 tabular-nums">
              {row.sourcedPercent === 0 ? "Nothing sourced yet" : `${row.sourcedPercent}% sourced`}
              <span aria-hidden> · </span>
              <span title={`Raised ${fullDate(row.enquiryDate)}`}>
                raised {shortDate(row.enquiryDate)}
              </span>
            </p>
            {urgent ? (
              <p className="mt-0.5 text-[14px] font-medium text-amber-600">
                {days === 0 ? "Starts today" : `Starts in ${days} ${days === 1 ? "day" : "days"}`}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 md:col-start-3 md:row-start-2 lg:col-start-4 lg:row-start-1">
            <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
            <span className={cn("truncate text-[15px] font-medium", tone.text)}>
              {STATUS_LABEL[row.overallStatus]}
            </span>
            {/* With no side panel below 1280 there is nothing to select into,
                so the row carries its own way in. */}
            <Link
              to="/app/enquiries/$enquiryId"
              params={{ enquiryId: row.id }}
              onClick={(event) => event.stopPropagation()}
              className="pointer-events-auto ml-auto inline-flex shrink-0 items-center gap-1 text-[15px] text-slate-500 transition-colors hover:text-white xl:hidden"
            >
              Open
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </div>

        {/* Quick actions fade in over the status column on hover/focus. They are
            plain text links: the row itself is already the primary target. */}
        <div className="pointer-events-none absolute inset-y-0 right-3 z-10 hidden items-center gap-5 bg-gradient-to-l from-ink-850 via-ink-850 to-transparent pr-1 pl-12 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none xl:flex">
          <Link
            {...findCranesHref(row, null)}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 text-[15px] text-slate-500 transition-colors hover:text-white"
          >
            Find cranes
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Link
            to="/app/enquiries/$enquiryId"
            params={{ enquiryId: row.id }}
            className="inline-flex items-center gap-1 text-[15px] font-medium text-white"
          >
            Open
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    );
  };

  return (
    <div className="theme-dark -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6">
      {/* ------------------------------------------------------------ list */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-5 sm:px-8">
          <div className="w-full max-w-[1180px]">
            <p className="text-[15px] text-slate-500">
              {greeting()}
              {user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}
              {counts
                ? ` · ${counts.active} active ${counts.active === 1 ? "request" : "requests"}`
                : ""}
            </p>

            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-white">
                Who needs a lift?
              </h1>
              {canCreate ? (
                <div className="flex items-center gap-1">
                  <EnquiryBulkUpload triggerClassName="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[15px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500" />
                  <Link
                    to="/app/enquiries/new"
                    className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[15px] font-medium text-white transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    <Plus className="size-4" aria-hidden />
                    New enquiry
                  </Link>
                </div>
              ) : null}
            </div>

            <div className="mt-5 grid grid-cols-2 border-y border-ink-800 sm:grid-cols-4 sm:divide-x sm:divide-ink-800">
              {KPI_CARDS.map((card) => (
                <KpiStat
                  key={card.bucket}
                  label={card.label}
                  value={kpiValue(counts, card.bucket)}
                  delta={counts?.raisedTodayByBucket[card.bucket] ?? 0}
                  accent={card.accent}
                  active={bucket === card.bucket}
                  loading={summary.isPending}
                  onClick={() =>
                    setBucket((current) => (current === card.bucket ? null : card.bucket))
                  }
                />
              ))}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <div className="relative w-full max-w-[380px]">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                  aria-hidden
                />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Enquiry no, customer, reference"
                  aria-label="Search enquiries"
                  className="field-input h-9 py-0 pl-10 text-[15px]"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput("");
                      setSearch("");
                    }}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-4" aria-hidden />
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
                className="field-input ml-auto h-9 w-auto py-0 pr-8 text-[15px]"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4 flex items-end justify-between gap-4 border-b border-ink-800">
              <div
                role="tablist"
                aria-label="Enquiry status"
                className="flex min-w-0 gap-5 overflow-x-auto"
              >
                {STATUS_FILTERS.map((filter) => {
                  const active = status === filter.value;
                  const count = tabCounts?.[filter.value];
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setStatus(filter.value)}
                      className={cn(
                        "-mb-px shrink-0 border-b-2 pb-2.5 text-[15px] whitespace-nowrap transition-colors duration-150",
                        active
                          ? "border-accent-500 font-medium text-white"
                          : "border-transparent text-slate-500 hover:text-white",
                      )}
                    >
                      {filter.label}
                      {typeof count === "number" ? (
                        <span className="ml-1.5 text-[14px] text-slate-500 tabular-nums">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <span className="hidden shrink-0 pb-2.5 text-[14px] text-slate-500 tabular-nums sm:block">
                {rows.length} shown
              </span>
            </div>
          </div>
        </div>

        <div
          ref={listRef}
          role="list"
          aria-label="Enquiries"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
        >
          <div className="w-full max-w-[1180px] px-4 pb-6 sm:px-8">
            {list.isPending ? (
              <>
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </>
            ) : list.isError ? (
              <div className="mt-6">
                <Alert tone="error">
                  {list.error instanceof Error ? list.error.message : "Could not load enquiries."}
                </Alert>
                <button
                  type="button"
                  onClick={() => void list.refetch()}
                  className="btn-secondary mt-3 py-1.5 text-[15px]"
                >
                  <RotateCcw className="size-4" aria-hidden />
                  Retry
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-24 text-center">
                <Inbox className="size-6 text-slate-600" aria-hidden />
                <p className="mt-3 text-[17px] font-medium text-white">
                  {nothingAtAll ? "No enquiries yet" : "No enquiries match your filters"}
                </p>
                <p className="mt-1 max-w-sm text-[15px] leading-relaxed text-slate-500">
                  {nothingAtAll
                    ? "Raise the first requirement and it will appear here, ready to source."
                    : "Clear the search and status filters, or pick another view."}
                </p>
                {nothingAtAll && canCreate ? (
                  <Link
                    to="/app/enquiries/new"
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[15px] font-medium text-white transition-colors hover:bg-accent-600"
                  >
                    <Plus className="size-4" aria-hidden />
                    Raise your first enquiry
                  </Link>
                ) : activeFilters ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[15px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                {groups ? (
                  groups.map((group) => (
                    <section key={group.key} aria-label={group.label}>
                      <h2 className="flex items-baseline justify-between gap-4 pt-5 pb-2 text-[14px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                        {group.label}
                        <span className="tabular-nums">{group.rows.length}</span>
                      </h2>
                      <div className="divide-y divide-ink-800 border-t border-ink-800">
                        {group.rows.map(renderRow)}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="mt-5 divide-y divide-ink-800 border-y border-ink-800">
                    {rows.map(renderRow)}
                  </div>
                )}

                <div className="flex items-center justify-between gap-4 border-t border-ink-800 py-3 text-[14px] text-slate-500 tabular-nums">
                  <span>
                    {rows.length} {rows.length === 1 ? "enquiry" : "enquiries"}
                    {hiddenClosed > 0 ? ` · ${hiddenClosed} closed hidden` : ""}
                  </span>
                  <span>{SORT_OPTIONS.find((option) => option.value === sort)?.label}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- panel */}
      <aside
        aria-label="Enquiry detail"
        className="hidden w-[375px] shrink-0 flex-col border-l border-ink-800 bg-ink-900 xl:flex 2xl:w-[420px]"
      >
        {detail.isPending && selectedId ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <div className="p-6">
            <Alert tone="error">
              {detail.error instanceof Error
                ? detail.error.message
                : "Could not load this enquiry."}
            </Alert>
          </div>
        ) : !enquiry ? (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <Compass className="size-6 text-slate-600" aria-hidden />
            <p className="mt-3 text-[17px] font-medium text-white">Nothing selected</p>
            <p className="mt-1 text-[15px] text-slate-500">
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
                    className="h-[180px]"
                    onOpen={() => void navigate(findCranesHref(selectedRow, null))}
                  />
                ) : (
                  <div className="flex h-[180px] w-full items-center justify-center bg-ink-950">
                    <MapPin className="size-5 text-slate-600" aria-hidden />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void navigate(findCranesHref(selectedRow, null))}
                  className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-md bg-black/65 px-2 py-1 text-[14px] text-neutral-200 backdrop-blur-sm transition-colors hover:bg-black/80"
                >
                  <MapPin className="size-4 text-accent-400" aria-hidden />
                  {cityOf(enquiry)}
                </button>
              </div>

              {/* summary */}
              <div className="px-6 py-5">
                <p className="font-mono text-[14px] text-slate-500">{enquiry.enquiryNo}</p>
                <h2 className="mt-1 text-[22px] leading-tight font-semibold text-white">
                  {enquiry.customerName}
                </h2>
                <p
                  className="mt-1 truncate text-[16px] text-slate-500"
                  title={selectedRow?.project ?? enquiry.siteLocation}
                >
                  {selectedRow?.project ?? enquiry.siteLocation}
                </p>
                <p className="mt-2 text-[15px] text-slate-500">
                  {cityOf(enquiry)}
                  <span aria-hidden> · </span>
                  Raised {shortDate(enquiry.enquiryDate)}
                </p>
              </div>

              {/* requirements */}
              <div className="border-t border-ink-800 px-6 py-5">
                <p className="text-[14px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                  Crane requirements
                </p>

                {enquiry.lines.length === 0 ? (
                  <p className="py-8 text-center text-[15px] text-slate-500">
                    This enquiry has no lines yet.
                  </p>
                ) : (
                  <ul className="mt-1 divide-y divide-ink-800">
                    {enquiry.lines.map((line) => {
                      const action = lineAction(line);
                      const actionClass =
                        "inline-flex items-center gap-1 text-[15px] font-medium text-accent-400 transition-colors hover:text-accent-300";
                      return (
                        <li key={line.id} className="py-4">
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 text-[17px] font-medium text-white">
                              {line.quantity} × {craneTypeLabel(line.craneTypeName)} ·{" "}
                              {line.capacityT !== null ? `${line.capacityT} t` : "capacity TBC"}
                            </p>
                            <span className="shrink-0 text-[14px] text-slate-500">
                              Line {line.lineNo}
                            </span>
                          </div>

                          <p className="mt-1 text-[15px] text-slate-500">
                            {line.requiredStartDate
                              ? `From ${shortDate(line.requiredStartDate)}`
                              : "Start date TBC"}
                            <span aria-hidden> · </span>
                            {durationLabel(line)}
                          </p>

                          <div className="mt-3 flex items-center justify-between gap-3">
                            <span className="inline-flex items-center gap-2 text-[15px] text-slate-600">
                              <span
                                className={cn("size-1.5 rounded-full", lineDot(line.trailStatus))}
                                aria-hidden
                              />
                              {lineState(line.trailStatus)}
                            </span>

                            {action.kind === "rfq" ? (
                              <button
                                type="button"
                                onClick={() => {
                                  createRfq.reset();
                                  setRfqLine(line);
                                }}
                                className={actionClass}
                              >
                                {action.label}
                                <ArrowRight className="size-4" aria-hidden />
                              </button>
                            ) : action.kind === "quotes" ? (
                              <Link
                                to="/app/enquiries/lines/$lineId/comparison"
                                params={{ lineId: line.id }}
                                className={actionClass}
                              >
                                {action.label}
                                <ArrowRight className="size-4" aria-hidden />
                              </Link>
                            ) : action.kind === "booking" ? (
                              <Link to="/app/bookings" className={actionClass}>
                                {action.label}
                                <ArrowRight className="size-4" aria-hidden />
                              </Link>
                            ) : (
                              <Link
                                to="/app/rfqs/$rfqId"
                                params={{ rfqId: line.rfqId as string }}
                                className={actionClass}
                              >
                                {action.label}
                                <ArrowRight className="size-4" aria-hidden />
                              </Link>
                            )}
                          </div>

                          <Link
                            {...findCranesHref(selectedRow, line)}
                            className="mt-2 inline-flex items-center gap-1.5 text-[15px] text-slate-500 transition-colors hover:text-white"
                          >
                            <Compass className="size-4" aria-hidden />
                            Find cranes for this line
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* pinned CTA */}
            <div className="shrink-0 border-t border-ink-800 p-4">
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
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-accent-600"
              >
                Find cranes for this enquiry
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          </>
        )}
      </aside>

      {/* ------------------------------------------------------- RFQ dialog */}
      <RfqFieldsScreen
        open={Boolean(rfqLine)}
        line={rfqLine}
        title="Create RFQ"
        lineLabel={
          rfqLine
            ? `Line ${rfqLine.lineNo} · ${rfqLine.quantity} × ${craneTypeLabel(rfqLine.craneTypeName)}${
                rfqLine.capacityT !== null ? ` · ${rfqLine.capacityT} t` : ""
              }`
            : undefined
        }
        deadline={deadline}
        onDeadline={setDeadline}
        confirmLabel="Create RFQ"
        pending={createRfq.isPending}
        error={
          createRfq.isError
            ? createRfq.error instanceof Error
              ? createRfq.error.message
              : "The RFQ could not be created."
            : null
        }
        onConfirm={(keys, remark) => {
          if (!rfqLine) return;
          createRfq.mutate({
            lineId: rfqLine.id,
            deadline: new Date(`${deadline}T18:00:00`).toISOString(),
            fields: keys,
            remark,
          });
        }}
        onClose={() => setRfqLine(null)}
      />
    </div>
  );
}


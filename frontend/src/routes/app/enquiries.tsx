import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Compass,
  Inbox,
  MapPin,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
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
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { EnquiryBulkUpload } from "@/components/enquiry-bulk-upload";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { cityOf, craneTypeLabel, titleCase } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

/**
 * The enquiry workspace — a list report with a docked object preview.
 *
 * Laid out the way SAP Fiori lays out a "List Report":
 *
 *   1. a compact page header (title, live counts, the primary actions),
 *   2. an icon tab bar that quick-filters by sourcing stage, with counts,
 *   3. a filter bar (search, "starting soon", clear),
 *   4. one dense, sortable table — a row is one enquiry,
 *   5. a docked preview pane for the selected row (the master/detail split),
 *      so reading an enquiry never hides the list and never costs a navigation.
 *
 * The keyboard works the way it does in SAP: Up/Down move through rows and
 * update the preview, Enter opens the preview, Esc closes it.
 *
 * Status is never editable here. The row's status is the
 * server's roll-up of the lines, so the list can never disagree with the detail
 * screen (P1 section 4).
 *
 * Tab, filters, sort and the selected row live in the URL, so a view can be sent
 * to a colleague and land on the same enquiry with the same filters.
 */

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

type Stage = Exclude<EnquiryBucket, "closed">;
type Tab = "all" | Stage | "closed";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "all", label: "All active" },
  { value: "pending", label: "Pending sourcing" },
  { value: "awaiting", label: "Awaiting quotes" },
  { value: "quotes", label: "Quotes in" },
  { value: "finalised", label: "Finalised" },
  { value: "closed", label: "Closed" },
];

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.value === value);
}

const STATUS_LABEL: Record<EnquiryOverallStatus, string> = {
  RECEIVED_PENDING_SOURCING: "Pending sourcing",
  PARTIALLY_QUOTED: "Partially quoted",
  PARTIALLY_FINALISED: "Partially finalised",
  FULLY_FINALISED: "Fully finalised",
  CLOSED: "Closed",
};

const EMPTY_HINT: Record<Tab, string> = {
  all: "Raise a requirement and it will appear here, ready to source.",
  pending: "New enquiries wait here until sourcing starts.",
  awaiting: "RFQs are out. Replies will land here.",
  quotes: "Quotes are in and ready to compare.",
  finalised: "Vendors are chosen. Nothing left to source.",
  closed: "Closed enquiries are kept here for reference.",
};

/**
 * Semantic status colour (SAP "ObjectStatus": Error / Warning / Success / None).
 * Status is always a dot plus a word, never colour alone.
 */
function statusTone(status: EnquiryOverallStatus): { dot: string; text: string } {
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
 * side panel only needs to answer "can I act on this line, and what is next".
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

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function shortDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function fullDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
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
 * A line is "awarded" once a vendor has been chosen or the line is closed.
 * From then on, offering to find more cranes for it is noise.
 */
function isAwarded(status: EnquiryLine["trailStatus"]): boolean {
  return (
    status === "VENDOR_FINALISED" ||
    status === "BOOKED" ||
    status === "FULFILLED_INTERNALLY" ||
    status === "CLOSED" ||
    status === "CANCELLED"
  );
}

/**
 * The start-date warning for an enquiry that still has unsourced lines.
 * A date in the past is its own, louder state: the old copy printed
 * "Starts in -3 days", which is both wrong and the most urgent case.
 */
function startNote(row: EnquiryListRow): { label: string; tone: "late" | "soon" } | null {
  if (row.overallStatus === "CLOSED" || row.sourcedPercent >= 100) return null;
  const days = daysUntil(row.nextUnsourcedStart);
  if (days === null) return null;
  if (days < 0) {
    const ago = -days;
    return {
      label: `Start date passed ${ago} ${ago === 1 ? "day" : "days"} ago`,
      tone: "late",
    };
  }
  if (days === 0) return { label: "Starts today", tone: "soon" };
  if (days <= 14) return { label: `Starts in ${days} ${days === 1 ? "day" : "days"}`, tone: "soon" };
  return null;
}

function siteOf(row: EnquiryListRow): string {
  return row.siteStateName ? `${cityOf(row)}, ${titleCase(row.siteStateName)}` : cityOf(row);
}

function cranesLabel(row: EnquiryListRow): string {
  return `${row.craneCount} ${row.craneCount === 1 ? "crane" : "cranes"} · ${row.lineCount} ${
    row.lineCount === 1 ? "line" : "lines"
  }`;
}

/** SAP "ObjectStatus": a coloured dot and a word. */
function ObjectStatus({ status }: { status: EnquiryOverallStatus }) {
  const tone = statusTone(status);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-medium", tone.text)}>
      <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} aria-hidden />
      <span className="truncate">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** The warning under a start date: icon, words, colour — never colour alone. */
function StartNote({ note }: { note: { label: string; tone: "late" | "soon" } }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[12px] font-medium",
        note.tone === "late" ? "text-red-700" : "text-amber-700",
      )}
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {note.label}
    </span>
  );
}

/** A sortable column head. Only the sorts the server supports are offered. */
function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: EnquirySort;
  sort: EnquirySort;
  onSort: (next: EnquirySort) => void;
  className?: string;
}) {
  const active = sort === sortKey;
  const Icon = !active ? ArrowUpDown : sortKey === "newest" ? ArrowDown : ArrowUp;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortKey === "newest" ? "descending" : "ascending") : "none"}
      className={cn("p-0 text-left", className)}
    >
      <button
        type="button"
        onClick={() => onSort(active && sortKey !== "newest" ? "newest" : sortKey)}
        className={cn(
          "flex w-full items-center gap-1 px-3 py-2.5 text-left text-[12px] font-semibold whitespace-nowrap transition-colors hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
          active ? "text-white" : "text-slate-600",
        )}
      >
        {label}
        <Icon className={cn("size-3.5", !active && "opacity-50")} aria-hidden />
      </button>
    </th>
  );
}

const TH = "px-3 py-2.5 text-left text-[12px] font-semibold whitespace-nowrap text-slate-600";

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function EnquiryIndexPage() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const canCreate = user?.role === "sales_user" || user?.role === "admin_user";

  const [tab, setTab] = useState<Tab>(() =>
    routeSearch.status === "CLOSED" ? "closed" : isTab(routeSearch.tab) ? routeSearch.tab : "all",
  );
  const [sort, setSort] = useState<EnquirySort>(() => {
    const value = routeSearch.sort;
    return value === "startDate" ? value : "newest";
  });
  const [urgentOnly, setUrgentOnly] = useState(
    () => routeSearch.urgent === true || routeSearch.urgent === "true",
  );
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
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Closed enquiries are a server-side status; every other tab is a stage of
  // the active work and is filtered here from one list.
  const status: EnquiryOverallStatus | "ALL" = tab === "closed" ? "CLOSED" : "ALL";

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
        ...(tab === "closed" ? { status: "CLOSED" } : tab !== "all" ? { tab } : {}),
        ...(search ? { q: search } : {}),
        ...(sort === "newest" ? {} : { sort }),
        ...(urgentOnly ? { urgent: true } : {}),
        ...(selectedId ? { selected: selectedId } : {}),
      },
      replace: true,
    });
  }, [tab, search, sort, urgentOnly, selectedId, navigate, pathname]);

  // Escape closes the preview; "/" jumps to search, as in SAP list reports.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (event.key === "Escape" && selectedId && !rfqLine) setSelectedId(null);
      if (event.key === "/" && !typing && !rfqLine) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, rfqLine]);

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

  const allRows = list.data?.enquiries ?? [];

  // The rows behind the tab counts: everything the filters allow, before the
  // tab narrows it, so each tab shows how many enquiries it would hold.
  const filteredRows = useMemo(
    () => (urgentOnly ? allRows.filter((row) => startNote(row) !== null) : allRows),
    [allRows, urgentOnly],
  );

  const rows = useMemo(() => {
    if (tab === "closed") return filteredRows;
    const active = filteredRows.filter((row) => row.bucket !== "closed");
    return tab === "all" ? active : active.filter((row) => row.bucket === tab);
  }, [filteredRows, tab]);

  const tabCount = (value: Tab): number | null => {
    const counts = summary.data?.summary;
    if (value === "closed") return counts?.closed ?? null;
    // With a search or "starting soon" on, the count is what the list would show.
    if (list.data && tab !== "closed" && (search || urgentOnly)) {
      const active = filteredRows.filter((row) => row.bucket !== "closed");
      return value === "all" ? active.length : active.filter((row) => row.bucket === value).length;
    }
    if (!counts) return null;
    switch (value) {
      case "all":
        return counts.active;
      case "pending":
        return counts.pendingSourcing;
      case "awaiting":
        return counts.awaitingQuotes;
      case "quotes":
        return counts.quotesIn;
      default:
        return counts.finalised;
    }
  };

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
  const enquiry = detail.data?.enquiry ?? null;
  const selectedRow = allRows.find((row) => row.id === selectedId) ?? null;
  const activeFilters = Boolean(search || urgentOnly);
  const nothingAtAll = (counts?.total ?? 0) === 0;
  const urgentCount = allRows.filter((row) => startNote(row) !== null).length;
  const previewOpen = Boolean(selectedId);

  const clearFilters = () => {
    setUrgentOnly(false);
    setSearch("");
    setSearchInput("");
    setSort("newest");
  };

  const findCranesHref = (row: EnquiryListRow | null, line: EnquiryLine | null) => ({
    to: "/app/discovery" as const,
    search: {
      ...(line ? { line: line.id } : {}),
      ...(row?.siteLocation ? { siteLocation: row.siteLocation } : {}),
      ...(line?.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
      ...(line?.capacityT ? { capacityT: line.capacityT } : {}),
      ...(line?.capacityT ? { capacityRule: "AT_LEAST" } : {}),
    },
  });

  // Up/Down walk the table and keep the preview in step, like a SAP list.
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(rows[index]?.id ?? null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
    const target = rows[next];
    if (!target) return;
    if (previewOpen) setSelectedId(target.id);
    tbodyRef.current
      ?.querySelector<HTMLTableRowElement>(`tr[data-row-id="${target.id}"]`)
      ?.focus();
  };

  // Columns that give way when the preview docks beside the table.
  const wide = previewOpen ? "hidden 2xl:table-cell" : "hidden lg:table-cell";
  const mid = previewOpen ? "hidden xl:table-cell" : "hidden md:table-cell";

  // -------------------------------------------------- preview: one line
  const renderLine = (line: EnquiryLine, row: EnquiryListRow | null) => {
    const action = lineAction(line);
    const awarded = isAwarded(line.trailStatus);
    const lineDays = daysUntil(line.requiredStartDate);
    const late = !awarded && lineDays !== null && lineDays < 0;
    const actionClass =
      "inline-flex shrink-0 items-center gap-1 rounded-md border border-ink-800 bg-ink-850 px-2.5 py-1 text-[13px] font-medium text-accent-400 transition-colors hover:border-accent-500/50 hover:bg-accent-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

    return (
      <li key={line.id} className="border-b border-ink-800 px-5 py-3.5 last:border-b-0">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-[14px] leading-snug font-semibold text-white">
            {line.quantity} × {craneTypeLabel(line.craneTypeName)},{" "}
            {line.capacityT !== null ? `${line.capacityT} t` : "capacity TBC"}
          </p>
          <span className="shrink-0 text-[12px] text-slate-500 tabular-nums">
            Line {line.lineNo}
          </span>
        </div>
        <p className={cn("mt-0.5 text-[13px]", late ? "font-medium text-red-700" : "text-slate-500")}>
          {line.requiredStartDate ? `From ${shortDate(line.requiredStartDate)}` : "Start date TBC"}
          <span aria-hidden> · </span>
          {durationLabel(line)}
          {late ? " · start date passed" : ""}
        </p>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-[13px] text-slate-700">
            <span className={cn("size-2 rounded-full", lineDot(line.trailStatus))} aria-hidden />
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
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : action.kind === "quotes" ? (
            <Link
              to="/app/enquiries/lines/$lineId/comparison"
              params={{ lineId: line.id }}
              className={actionClass}
            >
              {action.label}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          ) : action.kind === "booking" ? (
            <Link to="/app/bookings" className={actionClass}>
              {action.label}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          ) : (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: line.rfqId as string }}
              className={actionClass}
            >
              {action.label}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>
        {awarded ? null : (
          <Link
            {...findCranesHref(row, line)}
            className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] text-slate-600 transition-colors hover:text-white"
          >
            <Compass className="size-3.5" aria-hidden />
            Find cranes for this line
          </Link>
        )}
      </li>
    );
  };

  const selectedNote = selectedRow ? startNote(selectedRow) : null;

  return (
    <div
      className={cn(
        "enq enq-fiori -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6",
        theme === "light" ? "theme-light" : "theme-dark",
      )}
    >
      {/* =========================================================== list report */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------------------------ page header */}
        <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-4 pt-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-semibold text-white">Enquiries</h1>
              <p className="mt-0.5 text-[13px] text-slate-600">
                {counts
                  ? `${counts.active} active ${counts.active === 1 ? "request" : "requests"}`
                  : "Loading your requests"}
                {counts && urgentCount > 0 ? (
                  <>
                    <span aria-hidden> · </span>
                    <button
                      type="button"
                      onClick={() => {
                        setTab("all");
                        setUrgentOnly(true);
                      }}
                      className="inline-flex items-center gap-1 font-medium text-red-700 underline decoration-red-700/40 underline-offset-4 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                    >
                      <TriangleAlert className="size-3.5" aria-hidden />
                      {urgentCount} {urgentCount === 1 ? "needs" : "need"} attention
                    </button>
                  </>
                ) : null}
              </p>
            </div>

            {canCreate ? (
              <div className="flex items-center gap-2">
                <EnquiryBulkUpload triggerClassName="btn-secondary !py-1.5 !text-[13px]" />
                <Link to="/app/enquiries/new" className="btn-primary !py-1.5 !text-[13px]">
                  <Plus className="size-4" aria-hidden />
                  New enquiry
                </Link>
              </div>
            ) : null}
          </div>

          {/* ------------------------------------------- icon tab bar */}
          <div
            role="tablist"
            aria-label="Sourcing stage"
            className="-mb-px mt-3 flex gap-1 overflow-x-auto"
          >
            {TABS.map((item) => {
              const count = tabCount(item.value);
              const selected = tab === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(item.value)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[14px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
                    selected
                      ? "border-accent-500 font-semibold text-white"
                      : "border-transparent text-slate-600 hover:border-ink-700 hover:text-white",
                  )}
                >
                  {item.label}
                  <span
                    className={cn(
                      "min-w-6 rounded-full px-1.5 py-px text-center text-[12px] font-medium tabular-nums",
                      selected ? "bg-accent-500 text-white" : "bg-ink-800 text-slate-600",
                    )}
                  >
                    {count ?? "–"}
                  </span>
                </button>
              );
            })}
          </div>
        </header>

        {/* ------------------------------------------------ filter bar */}
        <div className="shrink-0 border-b border-ink-800 bg-ink-950 px-4 py-2.5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-[360px] min-w-[200px] flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                ref={searchRef}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search enquiry no, customer or reference   ( / )"
                aria-label="Search enquiries"
                className="field-input h-9 py-0 pr-9 pl-9 text-[13px]"
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

            <button
              type="button"
              role="switch"
              aria-checked={urgentOnly}
              onClick={() => {
                if (tab === "closed") setTab("all");
                setUrgentOnly((current) => !current);
              }}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                urgentOnly
                  ? "border-red-200 bg-red-50 font-medium text-red-700"
                  : "border-ink-800 bg-ink-850 text-slate-700 hover:border-ink-700 hover:text-white",
              )}
            >
              <TriangleAlert className="size-3.5" aria-hidden />
              Needs attention
              <span className="tabular-nums opacity-80">{urgentCount}</span>
            </button>

            {activeFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-accent-400 transition-colors hover:text-white"
              >
                <X className="size-3.5" aria-hidden />
                Clear filters
              </button>
            ) : null}

            <p className="ml-auto text-[13px] text-slate-600 tabular-nums" aria-live="polite">
              {list.isPending ? "" : `${rows.length} ${rows.length === 1 ? "enquiry" : "enquiries"}`}
              {list.isFetching && !list.isPending ? " · updating" : ""}
            </p>
          </div>
        </div>

        {/* ------------------------------------------------ table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {list.isError ? (
            <div className="mx-auto max-w-xl p-6">
              <Alert tone="error">
                {list.error instanceof Error ? list.error.message : "Could not load enquiries."}
              </Alert>
              <button
                type="button"
                onClick={() => void list.refetch()}
                className="btn-secondary mt-3 !py-1.5 !text-[13px]"
              >
                <RotateCcw className="size-4" aria-hidden />
                Retry
              </button>
            </div>
          ) : list.isPending ? (
            <div className="divide-y divide-ink-800" aria-busy="true" aria-label="Loading enquiries">
              {[0, 1, 2, 3, 4, 5].map((row) => (
                <div
                  key={row}
                  className="flex animate-pulse items-center gap-6 px-6 py-4 motion-reduce:animate-none"
                >
                  <div className="h-3 w-24 rounded bg-ink-800" />
                  <div className="h-3 w-44 rounded bg-ink-800" />
                  <div className="hidden h-3 w-32 rounded bg-ink-800 md:block" />
                  <div className="hidden h-3 w-24 rounded bg-ink-800 md:block" />
                  <div className="ml-auto h-3 w-20 rounded bg-ink-800" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-20 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-ink-800 text-slate-600">
                <Inbox className="size-6" strokeWidth={1.5} aria-hidden />
              </span>
              <p className="mt-4 text-[16px] font-semibold text-white">
                {nothingAtAll
                  ? "No enquiries yet"
                  : activeFilters
                    ? "No enquiries match these filters"
                    : "Nothing in this stage"}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
                {nothingAtAll
                  ? "Raise the first requirement and it will appear here, ready to source."
                  : activeFilters
                    ? "Try a different search, or clear the filters to see everything."
                    : EMPTY_HINT[tab]}
              </p>
              {nothingAtAll && canCreate ? (
                <Link to="/app/enquiries/new" className="btn-primary mt-5 !py-1.5 !text-[13px]">
                  <Plus className="size-4" aria-hidden />
                  Raise your first enquiry
                </Link>
              ) : activeFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="btn-secondary mt-5 !py-1.5 !text-[13px]"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {/* ---- phone: a list of object items instead of a wide table */}
              <ul className="divide-y divide-ink-800 md:hidden">
                {rows.map((row) => {
                  const note = startNote(row);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(row.id)}
                        data-selected={row.id === selectedId}
                        className="fiori-row block w-full px-4 py-3 text-left"
                      >
                        <span className="flex items-center justify-between gap-3 text-[12px]">
                          <span className="text-slate-500 tabular-nums">{row.enquiryNo}</span>
                          <ObjectStatus status={row.overallStatus} />
                        </span>
                        <span className="mt-1 block truncate text-[15px] font-semibold text-white">
                          {row.customerName}
                        </span>
                        <span className="block truncate text-[13px] text-slate-600">
                          {row.project ?? row.siteLocation}
                        </span>
                        <span className="mt-1.5 flex items-center gap-1.5 text-[13px] text-slate-600">
                          <MapPin className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{siteOf(row)}</span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0 tabular-nums">{cranesLabel(row)}</span>
                        </span>
                        {note ? (
                          <span className="mt-1.5 block">
                            <StartNote note={note} />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* ---- tablet and up: one dense, sortable table */}
              <table className="hidden w-full border-collapse text-[13px] md:table">
                <caption className="sr-only">
                  Enquiries. Use the arrow keys to move between rows and Enter to preview one.
                </caption>
                <thead className="sticky top-0 z-10 border-b border-ink-800 bg-ink-900">
                  <tr>
                    <th scope="col" className={cn(TH, "pl-6")}>
                      Enquiry
                    </th>
                    <th scope="col" className={TH}>
                      Customer / project
                    </th>
                    <th scope="col" className={cn(TH, wide)}>
                      Site
                    </th>
                    <th scope="col" className={cn(TH, mid)}>
                      Cranes
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <SortHead
                      label="Start"
                      sortKey="startDate"
                      sort={sort}
                      onSort={setSort}
                      className={wide}
                    />
                    <SortHead
                      label="Raised"
                      sortKey="newest"
                      sort={sort}
                      onSort={setSort}
                      className={wide}
                    />
                    <th scope="col" className="w-10 pr-3">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody ref={tbodyRef} className="divide-y divide-ink-800 bg-ink-900">
                  {rows.map((row, index) => {
                    const note = startNote(row);
                    return (
                      <tr
                        key={row.id}
                        data-row-id={row.id}
                        data-selected={row.id === selectedId}
                        tabIndex={0}
                        aria-current={row.id === selectedId ? "true" : undefined}
                        onClick={() => setSelectedId(row.id)}
                        onKeyDown={(event) => onRowKeyDown(event, index)}
                        className="fiori-row cursor-pointer"
                      >
                        <td className="py-3 pr-3 pl-6 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                          {row.enquiryNo}
                        </td>
                        <td className="max-w-[320px] px-3 py-3 align-middle">
                          <span className="block truncate font-semibold text-white" title={row.customerName}>
                            {row.customerName}
                          </span>
                          <span className="block truncate text-[12px] text-slate-600">
                            {row.project ?? row.siteLocation}
                          </span>
                        </td>
                        <td className={cn("px-3 py-3 align-middle text-slate-700", wide)}>
                          <span className="block max-w-[200px] truncate">{siteOf(row)}</span>
                        </td>
                        <td
                          className={cn(
                            "px-3 py-3 align-middle whitespace-nowrap text-slate-700 tabular-nums",
                            mid,
                          )}
                        >
                          {cranesLabel(row)}
                        </td>
                        <td className="px-3 py-3 align-middle whitespace-nowrap">
                          <ObjectStatus status={row.overallStatus} />
                        </td>
                        <td className={cn("px-3 py-3 align-middle whitespace-nowrap", wide)}>
                          <span className="block text-slate-700">
                            {row.sourcedPercent >= 100 || row.overallStatus === "CLOSED"
                              ? "—"
                              : shortDate(row.nextUnsourcedStart)}
                          </span>
                          {note ? <StartNote note={note} /> : null}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-3 align-middle whitespace-nowrap text-slate-600",
                            wide,
                          )}
                        >
                          {fullDate(row.enquiryDate)}
                        </td>
                        <td className="py-3 pr-3 text-right align-middle">
                          <Link
                            to="/app/enquiries/$enquiryId"
                            params={{ enquiryId: row.id }}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`Open enquiry ${row.enquiryNo}`}
                            title="Open full enquiry"
                            className="inline-grid size-7 place-items-center rounded-md text-slate-500 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500"
                          >
                            <ChevronRight className="size-4" aria-hidden />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>

      {/* ========================================== docked object preview pane */}
      {previewOpen ? (
        <aside
          role="complementary"
          aria-label="Enquiry preview"
          className="enq-slide fixed inset-0 z-40 flex flex-col bg-ink-900 text-neutral-200 lg:static lg:inset-auto lg:z-auto lg:w-[460px] lg:shrink-0 lg:border-l lg:border-ink-800"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-5 py-3">
            <p className="text-[13px] text-slate-600 tabular-nums">
              {selectedRow?.enquiryNo ?? enquiry?.enquiryNo ?? ""}
            </p>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="Close preview"
              title="Close (Esc)"
              className="grid size-8 place-items-center rounded-md text-slate-600 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>

          {detail.isPending ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : detail.isError || !enquiry ? (
            <div className="p-5">
              <Alert tone="error">
                {detail.error instanceof Error ? detail.error.message : "Could not load this enquiry."}
              </Alert>
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* ---- object header */}
                <div className="px-5 pt-4 pb-5">
                  <h2 className="text-[20px] leading-tight font-semibold text-white">
                    {enquiry.customerName}
                  </h2>
                  <p className="mt-1 text-[14px] text-slate-600">
                    {selectedRow?.project ?? enquiry.siteLocation}
                  </p>

                  {selectedRow ? (
                    <div className="mt-4">
                      <div className="text-[13px]">
                        <ObjectStatus status={selectedRow.overallStatus} />
                      </div>
                      {selectedNote ? (
                        <p className="mt-2.5">
                          <StartNote note={selectedNote} />
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 text-[13px]">
                    <div>
                      <dt className="text-slate-500">Site</dt>
                      <dd className="mt-0.5 text-slate-800">
                        {selectedRow ? siteOf(selectedRow) : cityOf(enquiry)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Raised</dt>
                      <dd className="mt-0.5 text-slate-800">{fullDate(enquiry.enquiryDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Requirement</dt>
                      <dd className="mt-0.5 text-slate-800 tabular-nums">
                        {selectedRow ? cranesLabel(selectedRow) : `${enquiry.lines.length} lines`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">RFQs / quotes</dt>
                      <dd className="mt-0.5 text-slate-800 tabular-nums">
                        {selectedRow ? `${selectedRow.rfqCount} / ${selectedRow.quoteCount}` : "—"}
                      </dd>
                    </div>
                  </dl>
                </div>

                {/* ---- section: crane requirements */}
                <div className="border-t border-ink-800">
                  <h3 className="flex items-baseline gap-2 bg-ink-950 px-5 py-2.5 text-[13px] font-semibold text-slate-700">
                    Crane requirements
                    <span className="font-normal text-slate-500 tabular-nums">
                      {enquiry.lines.length}
                    </span>
                  </h3>
                  {enquiry.lines.length === 0 ? (
                    <p className="px-5 py-8 text-center text-[13px] text-slate-500">
                      This enquiry has no lines yet.
                    </p>
                  ) : (
                    <ul>{enquiry.lines.map((line) => renderLine(line, selectedRow))}</ul>
                  )}
                </div>
              </div>

              {/* ---- footer toolbar: the page's primary actions */}
              <div className="flex shrink-0 gap-2 border-t border-ink-800 bg-ink-900 p-3">
                <Link
                  to="/app/enquiries/$enquiryId"
                  params={{ enquiryId: enquiry.id }}
                  className="btn-primary flex-1 !py-2 !text-[14px]"
                >
                  Open full enquiry
                </Link>
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
                  className="btn-secondary flex-1 !py-2 !text-[14px]"
                >
                  <Compass className="size-4" aria-hidden />
                  Find cranes
                </Link>
              </div>
            </>
          )}
        </aside>
      ) : null}

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

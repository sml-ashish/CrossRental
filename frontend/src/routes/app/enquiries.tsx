import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
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
  lineStatusDot,
  lineStatusOf,
  listEnquiries,
  type EnquiryLine,
  type EnquiryListRow,
  type EnquiryOverallStatus,
  type EnquirySort,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { PageBackButton } from "@/components/ui/page-back-button";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { EnquiryBulkUpload } from "@/components/enquiry-bulk-upload";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { craneTypeLabel, titleCase } from "@/lib/format";
import { siteLine } from "@/lib/enquiryDetail";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

/**
 * The enquiry workspace — one panel with a docked object preview.
 *
 * The panel follows the agreed wireframe:
 *
 *   1. a top row that names the view and holds Bulk upload / New enquiry,
 *   2. a compact filter row: status, starts-by, logged-date range, search,
 *   3. one dense, sortable table — a row is one enquiry,
 *   4. a bottom pagination strip, shown only when there is more than one page,
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

type Tab = "all" | EnquiryOverallStatus;

const PAGE_SIZE = 10;

const STATUS_LABEL: Record<EnquiryOverallStatus, string> = {
  RECEIVED_PENDING_SOURCING: "Received — pending sourcing",
  PARTIALLY_QUOTED: "Partially quoted",
  PARTIALLY_FINALISED: "Partially finalised",
  FULLY_FINALISED: "Fully finalised",
  CLOSED: "Closed",
};

/** The dropdown follows the server's overall status, not the finer line trail. */
const TABS: Array<{ value: Tab; label: string; help: string }> = [
  { value: "all", label: "All active", help: "Every enquiry that is not closed." },
  {
    value: "RECEIVED_PENDING_SOURCING",
    label: STATUS_LABEL.RECEIVED_PENDING_SOURCING,
    help: "No line has a quote or a chosen vendor yet.",
  },
  {
    value: "PARTIALLY_QUOTED",
    label: STATUS_LABEL.PARTIALLY_QUOTED,
    help: "At least one line has quotes, but no vendor is finalised yet.",
  },
  {
    value: "PARTIALLY_FINALISED",
    label: STATUS_LABEL.PARTIALLY_FINALISED,
    help: "Some lines are done, but other lines still need work.",
  },
  {
    value: "FULLY_FINALISED",
    label: STATUS_LABEL.FULLY_FINALISED,
    help: "Every live line has a chosen outcome. No action needed.",
  },
  {
    value: "CLOSED",
    label: STATUS_LABEL.CLOSED,
    help: "Every line is booked or cancelled. Archive only.",
  },
];

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.value === value);
}

function pageFromSearch(value: unknown): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function dateFromSearch(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

/** Old shared links still land on the nearest real status. */
function tabFromSearch(value: unknown): Tab {
  if (value === "no-quotes" || value === "pending" || value === "awaiting") {
    return "RECEIVED_PENDING_SOURCING";
  }
  if (value === "quotes") return "PARTIALLY_QUOTED";
  if (value === "done" || value === "finalised") return "FULLY_FINALISED";
  if (value === "closed") return "CLOSED";
  return isTab(value) ? value : "all";
}

function rowInTab(row: EnquiryListRow, tab: Tab): boolean {
  return tab === "all" ? row.bucket !== "closed" : row.overallStatus === tab;
}

const EMPTY_HINT: Record<Tab, string> = {
  all: "Raise a requirement and it will appear here.",
  RECEIVED_PENDING_SOURCING: "No enquiries are waiting for sourcing or vendor replies.",
  PARTIALLY_QUOTED: "No enquiries have quotes waiting to be reviewed.",
  PARTIALLY_FINALISED: "No enquiries are partly finalised.",
  FULLY_FINALISED: "No enquiries are fully finalised yet.",
  CLOSED: "No closed enquiries yet.",
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
 * A line's next action, derived from its visible status. A cancelled line is
 * finished, so it offers nothing; every other line routes into its RFQ.
 */
function lineAction(line: EnquiryLine): {
  label: string;
  kind: "rfq" | "view-rfq";
} | null {
  if (lineStatusOf(line) === "Cancelled") return null;
  // Every line with an RFQ opens that RFQ, whatever stage the trail has reached.
  // Award paperwork and quotes both live in the RFQ, not in the enquiry preview.
  if (line.rfqId) return { label: "Open RFQ", kind: "view-rfq" };
  return { label: "Create RFQ", kind: "rfq" };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The list carries the soonest unsourced crane start; that is what we filter. */
function startsByDate(row: EnquiryListRow, date: string): boolean {
  const start = dateOnly(row.nextUnsourcedStart);
  return start !== null && start <= date;
}

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
  const city = titleCase(row.shipToCity);
  const state = row.siteStateName ? titleCase(row.siteStateName) : "";
  if (!state || city.toLowerCase().includes(state.toLowerCase())) return city;
  return `${state}, ${city}`;
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
        "inline-flex items-center gap-1 text-[13px] font-medium",
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
          "flex w-full items-center gap-1 px-3 py-2.5 text-left text-[14px] font-semibold whitespace-nowrap transition-colors hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
          active ? "text-white" : "text-slate-600",
        )}
      >
        {label}
        <Icon className={cn("size-3.5", !active && "opacity-50")} aria-hidden />
      </button>
    </th>
  );
}

const TH = "px-3 py-2.5 text-left text-[14px] font-semibold whitespace-nowrap text-slate-600";

const PAGE_BUTTON =
  "inline-flex h-8 items-center gap-1 rounded-md border border-ink-800 px-2.5 text-[13px] font-medium text-slate-600 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

const CELL_CONTROL =
  "-mx-1 rounded px-1 py-0.5 transition-colors hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

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

  const [tab, setTab] = useState<Tab>(() => tabFromSearch(routeSearch.tab));
  const [sort, setSort] = useState<EnquirySort>(() => {
    const value = routeSearch.sort;
    return value === "startDate" ? value : "newest";
  });
  const [searchInput, setSearchInput] = useState(() =>
    typeof routeSearch.q === "string" ? routeSearch.q : "",
  );
  const [search, setSearch] = useState(() =>
    typeof routeSearch.q === "string" ? routeSearch.q : "",
  );
  const [startBy, setStartBy] = useState(() =>
    dateFromSearch(routeSearch.startBy ?? routeSearch.startDate),
  );
  const [loggedFrom, setLoggedFrom] = useState(() => dateFromSearch(routeSearch.loggedFrom));
  const [loggedTo, setLoggedTo] = useState(() => dateFromSearch(routeSearch.loggedTo));
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof routeSearch.selected === "string" ? routeSearch.selected : null,
  );
  const [page, setPage] = useState(() => pageFromSearch(routeSearch.page));
  const [rfqLine, setRfqLine] = useState<EnquiryLine | null>(null);
  const [deadline, setDeadline] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date.toISOString().slice(0, 10);
  });
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // One fetch feeds every filter. Status is applied here; the logged-date range
  // is applied by the server so the page only receives enquiries in that range.
  const status: EnquiryOverallStatus | "ALL" = "ALL";

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  // Shareable view. `replace` keeps a filter change from filling the back stack.
  useEffect(() => {
    void navigate({
      to: pathname,
      search: {
        ...(tab === "all" ? {} : { tab }),
        ...(search ? { q: search } : {}),
        ...(startBy ? { startBy } : {}),
        ...(loggedFrom ? { loggedFrom } : {}),
        ...(loggedTo ? { loggedTo } : {}),
        ...(sort === "newest" ? {} : { sort }),
        ...(page > 1 ? { page } : {}),
        ...(selectedId ? { selected: selectedId } : {}),
      },
      replace: true,
    });
  }, [tab, search, startBy, loggedFrom, loggedTo, sort, page, selectedId, navigate, pathname]);

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
    queryKey: ["enquiries", "list", status, search, loggedFrom, loggedTo, sort],
    queryFn: () =>
      listEnquiries({
        ...(status === "ALL" ? {} : { status }),
        ...(search ? { search } : {}),
        ...(loggedFrom ? { from: loggedFrom } : {}),
        ...(loggedTo ? { to: loggedTo } : {}),
        sort,
      }),
    placeholderData: (previous) => previous,
  });

  const allRows = list.data?.enquiries ?? [];

  // Search and the logged-date range are applied by the server; "starts by" is
  // applied here to the same rows so the dropdown counts and the table agree.
  const dateMatchedRows = useMemo(
    () => (startBy ? allRows.filter((row) => startsByDate(row, startBy)) : allRows),
    [allRows, startBy],
  );

  const rows = useMemo(
    () => dateMatchedRows.filter((row) => rowInTab(row, tab)),
    [dateMatchedRows, tab],
  );

  const tabCount = (value: Tab): number | null => {
    // The list already carries the server's overall status, so exact status
    // counts come from the same rows the table shows.
    if (list.data) return dateMatchedRows.filter((row) => rowInTab(row, value)).length;
    const counts = summary.data?.summary;
    if (!counts) return null;
    if (value === "all") return counts.active;
    if (value === "CLOSED") return counts.closed;
    return null;
  };

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const firstRow = rows.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(safePage * PAGE_SIZE, rows.length);
  const visibleRows = rows.length === 0 ? [] : rows.slice(firstRow - 1, lastRow);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

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
  const tabHelp = TABS.find((item) => item.value === tab)?.help ?? "";
  const dateHintParts: string[] = [];
  if (startBy) dateHintParts.push(`starts by ${fullDate(`${startBy}T00:00:00.000Z`)}`);
  if (loggedFrom && loggedTo) {
    dateHintParts.push(
      `logged ${fullDate(`${loggedFrom}T00:00:00.000Z`)} to ${fullDate(`${loggedTo}T00:00:00.000Z`)}`,
    );
  } else if (loggedFrom) {
    dateHintParts.push(`logged from ${fullDate(`${loggedFrom}T00:00:00.000Z`)}`);
  } else if (loggedTo) {
    dateHintParts.push(`logged up to ${fullDate(`${loggedTo}T00:00:00.000Z`)}`);
  }
  const dateHint = dateHintParts.join(" · ");
  const enquiry = detail.data?.enquiry ?? null;
  const selectedRow = allRows.find((row) => row.id === selectedId) ?? null;
  const activeFilters =
    tab !== "all" || Boolean(search || startBy || loggedFrom || loggedTo);
  const nothingAtAll = (counts?.total ?? 0) === 0;
  const previewOpen = Boolean(selectedId);
  const listIsEmpty = !list.isPending && !list.isError && rows.length === 0;
  const headerTitle = listIsEmpty
    ? activeFilters
      ? "No matching enquiries"
      : "No enquiries"
    : "Enquiries";

  const clearFilters = () => {
    setTab("all");
    setSearch("");
    setSearchInput("");
    setStartBy("");
    setLoggedFrom("");
    setLoggedTo("");
    setSort("newest");
    setPage(1);
  };

  const applySearch = (value: string) => {
    const next = value.trim();
    if (!next) return;
    setSearchInput(next);
    setSearch(next);
    setPage(1);
  };

  // Cell controls stop the row's click/key handlers so filtering or opening a
  // link never also toggles the docked preview.
  const stopRowClick = (event: ReactMouseEvent) => event.stopPropagation();
  const stopRowKey = (event: ReactKeyboardEvent<HTMLElement>) => event.stopPropagation();

  // Up/Down walk the table and keep the preview in step, like a SAP list.
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(visibleRows[index]?.id ?? null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = Math.min(
      Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0),
      visibleRows.length - 1,
    );
    const target = visibleRows[next];
    if (!target) return;
    if (previewOpen) setSelectedId(target.id);
    tbodyRef.current
      ?.querySelector<HTMLTableRowElement>(`tr[data-row-id="${target.id}"]`)
      ?.focus();
  };

  // -------------------------------------------------- preview: one line
  const renderLine = (line: EnquiryLine) => {
    const action = lineAction(line);
    const status = lineStatusOf(line);
    const done = status === "Booked" || status === "Cancelled";
    const lineDays = daysUntil(line.requiredStartDate);
    const late = !done && lineDays !== null && lineDays < 0;
    const actionClass =
      "inline-flex shrink-0 items-center gap-1 rounded-md border border-ink-800 bg-ink-850 px-2.5 py-1 text-[13px] font-medium text-accent-400 transition-colors hover:border-accent-500/50 hover:bg-accent-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

    return (
      <li key={line.id} className="border-b border-ink-800 px-5 py-3.5 last:border-b-0">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-[14px] leading-snug font-semibold text-white">
            {craneTypeLabel(line.craneTypeName)},{" "}
            {line.capacityT !== null ? `${line.capacityT} t+` : "capacity TBC"}
          </p>
          <span className="shrink-0 text-[13px] text-slate-500 tabular-nums">
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
            <span className={cn("size-2 rounded-full", lineStatusDot(status))} aria-hidden />
            {status}
          </span>
          {action === null ? null : action.kind === "rfq" ? (
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
      </li>
    );
  };

  const selectedNote = selectedRow ? startNote(selectedRow) : null;

  return (
    <div
      className={cn(
        "enq enq-fiori -mx-4 -my-6 flex h-[calc(100dvh-49px)] gap-4 overflow-hidden bg-ink-950 p-4 text-neutral-200 sm:-mx-6 sm:p-6",
        theme === "light" ? "theme-light" : "theme-dark",
      )}
    >
      {/* =========================================================== list panel */}
      <section className="enq-card flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* --------------------------------------------- top row + filters */}
        <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-5 pt-4 pb-3 sm:px-6">
          <div className="mb-3">
            <PageBackButton className="text-slate-400 hover:text-white" />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="enq-serif text-[26px] leading-tight font-semibold text-white">
                {headerTitle}
              </h1>
            </div>

            {canCreate ? (
              <div className="flex items-center gap-2 pt-1">
                <EnquiryBulkUpload triggerClassName="btn-secondary !py-1.5 !text-[14px]" />
                <Link to="/app/enquiries/new" className="btn-primary !py-1.5 !text-[14px]">
                  <Plus className="size-4" aria-hidden />
                  New enquiry
                </Link>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="flex min-w-[210px] flex-1 flex-col gap-1">
              <label
                htmlFor="enquiry-status"
                className="text-[12px] font-semibold tracking-[0.12em] text-slate-500 uppercase"
              >
                Status
              </label>
              <select
                id="enquiry-status"
                value={tab}
                onChange={(event) => {
                  setTab(event.target.value as Tab);
                  setPage(1);
                }}
                className="field-input h-9 px-2 text-[14px]"
              >
                {TABS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label} ({tabCount(item.value) ?? "–"})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex w-[168px] flex-col gap-1">
              <label
                htmlFor="enquiry-start-by"
                className="text-[12px] font-semibold tracking-[0.12em] text-slate-500 uppercase"
              >
                Starts by
              </label>
              <div className="relative">
                <input
                  id="enquiry-start-by"
                  type="date"
                  value={startBy}
                  onChange={(event) => {
                    setStartBy(event.target.value);
                    setPage(1);
                  }}
                  className="field-input h-9 w-full px-2 pr-8 text-[14px]"
                />
                {startBy ? (
                  <button
                    type="button"
                    onClick={() => {
                      setStartBy("");
                      setPage(1);
                    }}
                    aria-label="Clear starts-by date"
                    className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex w-[272px] flex-col gap-1">
              <span className="text-[12px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
                Logged date
              </span>
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  aria-label="Logged from"
                  value={loggedFrom}
                  onChange={(event) => {
                    setLoggedFrom(event.target.value);
                    setPage(1);
                  }}
                  className="field-input h-9 w-[112px] px-2 text-[14px]"
                />
                <span aria-hidden className="text-[12px] text-slate-600">
                  –
                </span>
                <input
                  type="date"
                  aria-label="Logged to"
                  value={loggedTo}
                  onChange={(event) => {
                    setLoggedTo(event.target.value);
                    setPage(1);
                  }}
                  className="field-input h-9 w-[112px] px-2 text-[14px]"
                />
                {loggedFrom || loggedTo ? (
                  <button
                    type="button"
                    onClick={() => {
                      setLoggedFrom("");
                      setLoggedTo("");
                      setPage(1);
                    }}
                    aria-label="Clear logged date range"
                    className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <label
                htmlFor="enquiry-search"
                className="text-[12px] font-semibold tracking-[0.12em] text-slate-500 uppercase"
              >
                Search
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                  aria-hidden
                />
                <input
                  id="enquiry-search"
                  ref={searchRef}
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="No, state, city or status   ( / )"
                  className="field-input h-9 w-full py-0 pr-9 pl-9 text-[14px]"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput("");
                      setSearch("");
                      setPage(1);
                    }}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-slate-600">
            {tabHelp}
            {dateHint ? ` Showing ${dateHint}.` : ""} Click a value to filter, a number to open, or a row to preview.
          </p>
        </header>

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
                className="btn-secondary mt-3 !py-1.5 !text-[14px]"
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
              <p className="mt-4 text-[14px] leading-relaxed text-slate-600">
                {nothingAtAll
                  ? "Raise the first requirement and it will appear here, ready to source."
                  : activeFilters
                    ? "Try a different search or date, or clear the filters to see everything."
                    : EMPTY_HINT[tab]}
              </p>
              {nothingAtAll && canCreate ? (
                <Link to="/app/enquiries/new" className="btn-primary mt-5 !py-1.5 !text-[14px]">
                  <Plus className="size-4" aria-hidden />
                  New enquiry
                </Link>
              ) : activeFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="btn-secondary mt-5 !py-1.5 !text-[14px]"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {/* ---- phone: the same six fields, stacked as an object item */}
              <ul className="divide-y divide-ink-800 md:hidden">
                {visibleRows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.id)}
                      data-selected={row.id === selectedId}
                      className="fiori-row block w-full px-5 py-3 text-left"
                    >
                      <span className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="font-mono text-slate-500 tabular-nums">{row.enquiryNo}</span>
                        <ObjectStatus status={row.overallStatus} />
                      </span>
                      <span className="mt-1 block truncate text-[16px] font-semibold text-white">
                        {siteOf(row)}
                      </span>
                      <span className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[13px] text-slate-600 tabular-nums">
                        <span>Start {shortDate(row.nextUnsourcedStart)}</span>
                        <span>Logged {fullDate(row.enquiryDate)}</span>
                        <span>Updated {fullDate(row.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {/* ---- tablet and up: enquiry no | state, city | status | dates */}
              <table className="hidden w-full border-collapse text-[15px] md:table">
                <caption className="sr-only">
                  Enquiries. Use the arrow keys to move between rows and Enter to preview one.
                </caption>
                <thead className="sticky top-0 z-10 border-b border-ink-800 bg-ink-900">
                  <tr>
                    <th scope="col" className={cn(TH, "pl-6")}>
                      Enquiry no
                    </th>
                    <th scope="col" className={TH}>
                      State, city
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <SortHead
                      label="Start date"
                      sortKey="startDate"
                      sort={sort}
                      onSort={(next) => {
                        setSort(next);
                        setPage(1);
                      }}
                    />
                    <SortHead
                      label="Logged date"
                      sortKey="newest"
                      sort={sort}
                      onSort={(next) => {
                        setSort(next);
                        setPage(1);
                      }}
                    />
                    <th scope="col" className={cn(TH, "pr-6")}>
                      Last updated
                    </th>
                  </tr>
                </thead>
                <tbody ref={tbodyRef} className="divide-y divide-ink-800 bg-ink-900">
                  {visibleRows.map((row, index) => {
                    const stateName = row.siteStateName ? titleCase(row.siteStateName) : "";
                    const cityName = row.shipToCity ? titleCase(row.shipToCity) : "";
                    // Avoid "Gujarat, Gujarat": if the city already carries the
                    // state name, the city cell alone describes the location.
                    const showState =
                      Boolean(stateName) &&
                      !cityName.toLowerCase().includes(stateName.toLowerCase());
                    const startDay = dateOnly(row.nextUnsourcedStart);
                    const loggedDay = dateOnly(row.enquiryDate);

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
                        <td className="py-3 pr-3 pl-6 align-middle whitespace-nowrap font-mono tabular-nums">
                          <Link
                            to="/app/enquiries/$enquiryId"
                            params={{ enquiryId: row.id }}
                            onClick={stopRowClick}
                            onKeyDown={stopRowKey}
                            className={cn(CELL_CONTROL, "font-medium text-white")}
                            title={`Open enquiry ${row.enquiryNo}`}
                          >
                            {row.enquiryNo}
                          </Link>
                        </td>
                        <td className="max-w-[360px] px-3 py-3 align-middle">
                          <span
                            className="block truncate font-medium text-white"
                            title={siteOf(row)}
                          >
                            {showState ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  applySearch(row.siteStateName ?? "");
                                }}
                                onKeyDown={stopRowKey}
                                className={CELL_CONTROL}
                                title={`Filter by state ${stateName}`}
                              >
                                {stateName}
                              </button>
                            ) : null}
                            {showState && cityName ? (
                              <span className="text-slate-600">, </span>
                            ) : null}
                            {cityName ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  applySearch(row.shipToCity ?? "");
                                }}
                                onKeyDown={stopRowKey}
                                className={CELL_CONTROL}
                                title={`Filter by city ${cityName}`}
                              >
                                {cityName}
                              </button>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setTab(row.overallStatus);
                              setPage(1);
                            }}
                            onKeyDown={stopRowKey}
                            className={CELL_CONTROL}
                            title={`Filter by status ${STATUS_LABEL[row.overallStatus]}`}
                          >
                            <ObjectStatus status={row.overallStatus} />
                          </button>
                        </td>
                        <td className="px-3 py-3 align-middle whitespace-nowrap font-mono text-slate-700 tabular-nums">
                          {startDay ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setStartBy(startDay);
                                setPage(1);
                              }}
                              onKeyDown={stopRowKey}
                              className={CELL_CONTROL}
                              title={`Show enquiries starting by ${fullDate(row.nextUnsourcedStart)}`}
                            >
                              {shortDate(row.nextUnsourcedStart)}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle whitespace-nowrap font-mono text-slate-600 tabular-nums">
                          {loggedDay ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setLoggedFrom(loggedDay);
                                setLoggedTo(loggedDay);
                                setPage(1);
                              }}
                              onKeyDown={stopRowKey}
                              className={CELL_CONTROL}
                              title={`Show enquiries logged on ${fullDate(row.enquiryDate)}`}
                            >
                              {fullDate(row.enquiryDate)}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-3 pr-6 pl-3 align-middle whitespace-nowrap font-mono text-slate-600 tabular-nums">
                          <span
                            title={
                              row.updatedAt
                                ? new Date(row.updatedAt).toLocaleString("en-IN")
                                : undefined
                            }
                          >
                            {fullDate(row.updatedAt)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        {pageCount > 1 ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ink-800 bg-ink-900 px-5 py-3 sm:px-6">
            <p className="text-[13px] text-slate-600 tabular-nums">
              Showing {firstRow}–{lastRow} of {rows.length} enquiries
            </p>
            <nav aria-label="Enquiry pages" className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 1}
                className={PAGE_BUTTON}
              >
                <ChevronLeft className="size-3.5" aria-hidden />
                Previous
              </button>
              <span className="text-[13px] font-medium text-slate-600 tabular-nums">
                Page {safePage} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage === pageCount}
                className={PAGE_BUTTON}
              >
                Next
                <ChevronRight className="size-3.5" aria-hidden />
              </button>
            </nav>
          </footer>
        ) : null}
      </section>

      {/* ========================================== docked object preview pane */}
      {previewOpen ? (
        <aside
          role="complementary"
          aria-label="Enquiry preview"
          className="enq-slide fixed inset-0 z-40 flex flex-col overflow-hidden bg-ink-900 text-neutral-200 lg:static lg:inset-auto lg:z-auto lg:w-[420px] lg:shrink-0 lg:rounded-2xl lg:border lg:border-ink-800"
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
                    {titleCase(enquiry.shipToCity)}
                  </h2>
                  <p className="mt-1 text-[14px] text-slate-600">
                    {selectedRow?.project ?? siteLine(enquiry)}
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
                        {selectedRow ? siteOf(selectedRow) : siteLine(enquiry)}
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
                    <ul>{enquiry.lines.map((line) => renderLine(line))}</ul>
                  )}
                </div>
              </div>

              {/* ---- footer toolbar: continue into the full enquiry */}
              <div className="shrink-0 border-t border-ink-800 bg-ink-900 p-3">
                <Link
                  to="/app/enquiries/$enquiryId"
                  params={{ enquiryId: enquiry.id }}
                  className="btn-primary flex w-full !py-2 !text-[14px]"
                >
                  Open full enquiry
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
            ? `Line ${rfqLine.lineNo} · ${craneTypeLabel(rfqLine.craneTypeName)}${
                rfqLine.capacityT !== null ? ` · ${rfqLine.capacityT} t+` : ""
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

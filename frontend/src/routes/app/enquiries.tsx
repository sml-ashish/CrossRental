import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CircleCheck,
  Compass,
  Hourglass,
  Inbox,
  MapPin,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  Send,
  X,
  type LucideIcon,
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
 * The enquiry workspace.
 *
 * A board: one column per sourcing stage, compact cards, and a slide-over for
 * the selected enquiry's requirements. The page answers "what needs attention", "how far
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
  icon: LucideIcon;
  accent?: boolean;
}> = [
  { bucket: "pending", label: "Pending sourcing", icon: Hourglass, accent: true },
  { bucket: "awaiting", label: "Awaiting quotes", icon: Send },
  { bucket: "quotes", label: "Quotes in", icon: Receipt },
  { bucket: "finalised", label: "Finalised", icon: CircleCheck },
];

/**
 * The chips and the card pill must use the same words for the same status;
 * the API's own labels are long ("Received — Pending Sourcing") and are meant
 * for the detail screens, not a 375px panel.
 */
const STATUS_LABEL = Object.fromEntries(
  STATUS_FILTERS.map((filter) => [filter.value, filter.label]),
) as Record<EnquiryOverallStatus, string>;

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

function NoteChip({ note }: { note: { label: string; tone: "late" | "soon" } }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[14px] font-medium",
        note.tone === "late" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700",
      )}
    >
      {note.label}
    </span>
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
      className="flex h-1.5 w-full gap-1 overflow-hidden rounded-full"
    >
      {Array.from({ length: lines }).map((_, index) => (
        <span
          key={index}
          className={cn("h-full flex-1 rounded-full", index < filled ? fill : "bg-ink-800")}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

type Stage = Exclude<EnquiryBucket, "closed">;

const STAGE_HINT: Record<Stage, string> = {
  pending: "New enquiries wait here until sourcing starts.",
  awaiting: "RFQs are out. Replies will land here.",
  quotes: "Quotes are in and ready to compare.",
  finalised: "Vendors are chosen. Nothing left to source.",
};

export function EnquiryIndexPage() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const canCreate = user?.role === "sales_user" || user?.role === "admin_user";

  const [status, setStatus] = useState<EnquiryOverallStatus | "ALL">(() =>
    routeSearch.status === "CLOSED" ? "CLOSED" : "ALL",
  );
  const [stage, setStage] = useState<Stage>("pending");
  const [stageTouched, setStageTouched] = useState(false);
  const [sort, setSort] = useState<EnquirySort>(() => {
    const value = routeSearch.sort;
    return value === "startDate" || value === "progress" ? value : "newest";
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
        ...(status === "CLOSED" ? { status } : {}),
        ...(search ? { q: search } : {}),
        ...(sort === "newest" ? {} : { sort }),
        ...(urgentOnly ? { urgent: true } : {}),
        ...(selectedId ? { selected: selectedId } : {}),
      },
      replace: true,
    });
  }, [status, search, sort, urgentOnly, selectedId, navigate, pathname]);

  // Escape closes the slide-over.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !rfqLine) setSelectedId(null);
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

  const rows = useMemo(
    () => (urgentOnly ? allRows.filter((row) => startNote(row) !== null) : allRows),
    [allRows, urgentOnly],
  );

  const columns = useMemo(
    () =>
      KPI_CARDS.map((card) => ({
        ...card,
        rows: rows.filter((row) => row.bucket === card.bucket),
      })),
    [rows],
  );

  // On a phone only one stage shows at a time. Start on the first stage that
  // has something in it, unless the person has already picked one.
  useEffect(() => {
    if (stageTouched || list.isPending) return;
    const first = columns.find((column) => column.rows.length > 0);
    if (first && first.bucket !== stage) setStage(first.bucket);
  }, [columns, stage, stageTouched, list.isPending]);

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
  const showingClosed = status === "CLOSED";
  const activeFilters = Boolean(search || urgentOnly);
  const nothingAtAll = (counts?.total ?? 0) === 0;
  const urgentCount = allRows.filter((row) => startNote(row) !== null).length;

  const clearFilters = () => {
    setStatus("ALL");
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

  const chip =
    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[15px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";
  const chipOff = "border-ink-800 bg-ink-850/80 text-slate-600 hover:border-ink-700 hover:text-white";

  // ------------------------------------------------------------ board card
  const renderCard = (row: EnquiryListRow) => {
    const tone = statusTone(row.overallStatus);
    const note = startNote(row);
    const selected = row.id === selectedId;
    const site = row.siteStateName
      ? `${cityOf(row)}, ${titleCase(row.siteStateName)}`
      : cityOf(row);

    return (
      <li key={row.id} className="list-none">
        <button
          type="button"
          onClick={() => setSelectedId(row.id)}
          aria-haspopup="dialog"
          data-selected={selected}
          data-interactive="true"
          className="enq-card block w-full p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          <span className="block text-[14px] text-slate-500 tabular-nums">{row.enquiryNo}</span>
          <span
            className="mt-1 block truncate text-[17px] leading-tight font-semibold text-white"
            title={row.customerName}
          >
            {row.customerName}
          </span>
          <span className="mt-0.5 block truncate text-[15px] text-slate-500">
            {row.project ?? row.siteLocation}
          </span>

          <span className="mt-3 flex items-center gap-1.5 text-[15px] text-slate-700">
            <MapPin className="size-4 shrink-0 text-slate-500" aria-hidden />
            <span className="truncate">{site}</span>
          </span>
          <span className="mt-0.5 block pl-[22px] text-[14px] text-slate-500 tabular-nums">
            {row.craneCount} {row.craneCount === 1 ? "crane" : "cranes"}, {row.lineCount}{" "}
            {row.lineCount === 1 ? "line" : "lines"}
          </span>

          <span className="mt-3.5 block">
            <ProgressBar row={row} />
          </span>
          <span className="mt-2 flex items-center justify-between gap-2 text-[14px]">
            <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-medium", tone.text)}>
              <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} aria-hidden />
              <span className="truncate">{STATUS_LABEL[row.overallStatus]}</span>
            </span>
            <span className="shrink-0 text-slate-500 tabular-nums">{row.sourcedPercent}%</span>
          </span>
          {note ? (
            <span className="mt-2.5 block">
              <NoteChip note={note} />
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  // -------------------------------------------------- slide-over: one line
  const renderLine = (line: EnquiryLine, row: EnquiryListRow | null) => {
    const action = lineAction(line);
    const awarded = isAwarded(line.trailStatus);
    const lineDays = daysUntil(line.requiredStartDate);
    const late = !awarded && lineDays !== null && lineDays < 0;
    const actionClass =
      "inline-flex items-center gap-1.5 rounded-full bg-accent-500/10 px-3.5 py-1.5 text-[15px] font-medium text-accent-400 transition-colors hover:bg-accent-500/20";

    return (
      <li key={line.id} className="enq-card p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-[17px] leading-snug font-semibold text-white">
            {line.quantity} × {craneTypeLabel(line.craneTypeName)},{" "}
            {line.capacityT !== null ? `${line.capacityT} t` : "capacity TBC"}
          </p>
          <span className="shrink-0 text-[14px] text-slate-500">Line {line.lineNo}</span>
        </div>
        <p
          className={cn("mt-1 text-[15px]", late ? "font-medium text-red-700" : "text-slate-500")}
        >
          {line.requiredStartDate ? `From ${shortDate(line.requiredStartDate)}` : "Start date TBC"}
          <span aria-hidden>, </span>
          {durationLabel(line)}
          {late ? " (start date passed)" : ""}
        </p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-[15px] text-slate-700">
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
        {awarded ? null : (
          <Link
            {...findCranesHref(row, line)}
            className="mt-3 inline-flex items-center gap-1.5 text-[15px] text-slate-600 transition-colors hover:text-white"
          >
            <Compass className="size-4" aria-hidden />
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
        "enq -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6",
        theme === "light" ? "theme-light" : "theme-dark",
      )}
    >
      <section className="relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="enq-mesh" aria-hidden />

        {/* ---------------------------------------------------- header */}
        <div className="relative px-4 pt-7 sm:px-8">
          <div className="mx-auto w-full max-w-[1400px]">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
              <div className="min-w-0">
                <p className="text-[15px] text-slate-600">
                  {greeting()}
                  {user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}
                </p>
                <h1 className="enq-serif mt-1 text-[38px] leading-[1.05] font-medium tracking-[-0.015em] text-white sm:text-[46px]">
                  Who needs a lift?
                </h1>
                <p className="mt-2 text-[16px] text-slate-600">
                  {counts
                    ? `${counts.active} active ${counts.active === 1 ? "request" : "requests"}`
                    : "Loading your requests"}
                  {counts && urgentCount > 0 ? (
                    <>
                      <span aria-hidden>, </span>
                      <button
                        type="button"
                        onClick={() => {
                          setStatus("ALL");
                          setUrgentOnly((current) => !current);
                        }}
                        className="font-medium text-accent-400 underline decoration-accent-500/40 underline-offset-4 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                      >
                        {urgentCount} {urgentCount === 1 ? "needs" : "need"} attention
                      </button>
                    </>
                  ) : null}
                </p>
              </div>

              {canCreate ? (
                <div className="flex items-center gap-2">
                  <EnquiryBulkUpload triggerClassName="inline-flex items-center gap-2 rounded-full border border-ink-800 bg-ink-850/80 px-4 py-2 text-[15px] font-medium text-slate-700 backdrop-blur transition-colors hover:border-ink-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500" />
                  <Link
                    to="/app/enquiries/new"
                    className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-5 py-2 text-[15px] font-medium text-white shadow-[0_8px_20px_-8px_rgba(196,68,63,0.7)] transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    <Plus className="size-4" aria-hidden />
                    New enquiry
                  </Link>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <div className="relative w-full max-w-[380px] flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-slate-500"
                  aria-hidden
                />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search by enquiry no, customer or reference"
                  aria-label="Search enquiries"
                  className="field-input h-10 rounded-full py-0 pr-10 pl-10 text-[15px]"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput("");
                      setSearch("");
                    }}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                aria-pressed={urgentOnly}
                onClick={() => {
                  setStatus("ALL");
                  setUrgentOnly((current) => !current);
                }}
                className={cn(
                  chip,
                  urgentOnly ? "border-red-200 bg-red-50 font-medium text-red-700" : chipOff,
                )}
              >
                Starting soon
                <span className="text-[14px] tabular-nums opacity-80">{urgentCount}</span>
              </button>
              <button
                type="button"
                aria-pressed={showingClosed}
                onClick={() => setStatus((current) => (current === "CLOSED" ? "ALL" : "CLOSED"))}
                className={cn(
                  chip,
                  showingClosed ? "border-white bg-white font-medium text-ink-950" : chipOff,
                )}
              >
                Closed
                <span className="text-[14px] tabular-nums opacity-80">{counts?.closed ?? 0}</span>
              </button>
              {activeFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="px-1 text-[15px] font-medium text-accent-400 transition-colors hover:text-white"
                >
                  Clear filters
                </button>
              ) : null}

              <div className="ml-auto flex items-center gap-2 text-[15px] text-slate-600">
                <label htmlFor="enquiry-sort">Sort by</label>
                <select
                  id="enquiry-sort"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as EnquirySort)}
                  className="field-input h-10 w-auto rounded-full py-0 pr-8 pl-4 text-[15px]"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------ board */}
        {list.isError ? (
          <div className="relative mx-auto mt-6 w-full max-w-[1400px] px-4 sm:px-8">
            <Alert tone="error">
              {list.error instanceof Error ? list.error.message : "Could not load enquiries."}
            </Alert>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="btn-secondary mt-3 rounded-full py-1.5 text-[15px]"
            >
              <RotateCcw className="size-4" aria-hidden />
              Retry
            </button>
          </div>
        ) : showingClosed ? (
          <div className="relative mx-auto mt-6 w-full max-w-[1400px] px-4 pb-12 sm:px-8">
            <h2 className="flex items-baseline gap-2 pb-3 text-[16px] font-medium text-slate-700">
              Closed enquiries
              <span className="text-[15px] font-normal text-slate-500 tabular-nums">
                {rows.length}
              </span>
              <button
                type="button"
                onClick={() => setStatus("ALL")}
                className="ml-3 text-[15px] font-medium text-accent-400 hover:text-white"
              >
                Back to board
              </button>
            </h2>
            {rows.length === 0 ? (
              <p className="py-12 text-center text-[15px] text-slate-500">
                No closed enquiries match.
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{rows.map(renderCard)}</ul>
            )}
          </div>
        ) : (
          <>
            {/* phone: one stage at a time */}
            <div className="sticky top-0 z-20 mt-5 border-b border-ink-800 bg-ink-950/90 px-4 py-2 backdrop-blur-md sm:px-8 lg:hidden">
              <div role="tablist" aria-label="Stage" className="flex gap-1 overflow-x-auto">
                {columns.map((column) => (
                  <button
                    key={column.bucket}
                    type="button"
                    role="tab"
                    aria-selected={stage === column.bucket}
                    onClick={() => {
                      setStageTouched(true);
                      setStage(column.bucket);
                    }}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[15px] whitespace-nowrap",
                      stage === column.bucket
                        ? "bg-white font-medium text-ink-950"
                        : "text-slate-600 hover:bg-ink-850 hover:text-white",
                    )}
                  >
                    {column.label}
                    <span className="text-[14px] tabular-nums opacity-70">
                      {column.rows.length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* desktop: column headers stay pinned while the page scrolls */}
            <div className="sticky top-0 z-20 mt-5 hidden border-b border-ink-800 bg-ink-950/90 px-8 py-3 backdrop-blur-md lg:block">
              <div className="mx-auto grid w-full max-w-[1400px] grid-cols-4 gap-4">
                {columns.map((column) => (
                  <div key={column.bucket} className="flex items-center gap-2.5">
                    <span className="enq-orb !size-8" data-tone={column.bucket} aria-hidden>
                      <column.icon className="size-4" strokeWidth={1.75} />
                    </span>
                    <h2 className="text-[16px] font-medium text-white">{column.label}</h2>
                    <span className="text-[15px] text-slate-500 tabular-nums">
                      {summary.isPending && list.isPending ? "" : column.rows.length}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-[1400px] px-4 pt-4 pb-12 sm:px-8">
              {list.isPending ? (
                <div className="grid gap-4 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((column) => (
                    <div key={column} className={cn("space-y-3", column > 0 && "hidden lg:block")}>
                      {[0, 1].map((card) => (
                        <div key={card} className="enq-card animate-pulse p-4 motion-reduce:animate-none">
                          <div className="h-2.5 w-24 rounded bg-ink-800" />
                          <div className="mt-2.5 h-4 w-40 rounded bg-ink-800" />
                          <div className="mt-2 h-2.5 w-28 rounded bg-ink-800" />
                          <div className="mt-5 h-1.5 w-full rounded bg-ink-800" />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="enq-card mt-4 flex flex-col items-center px-6 py-20 text-center">
                  <span className="enq-orb" data-tone="quotes" aria-hidden>
                    <Inbox className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <p className="enq-serif mt-4 text-[24px] font-medium text-white">
                    {nothingAtAll ? "No enquiries yet" : "No enquiries match these filters"}
                  </p>
                  <p className="mt-1 max-w-sm text-[15px] leading-relaxed text-slate-600">
                    {nothingAtAll
                      ? "Raise the first requirement and it will appear here, ready to source."
                      : "Try a different search, or clear the filters to see everything."}
                  </p>
                  {nothingAtAll && canCreate ? (
                    <Link
                      to="/app/enquiries/new"
                      className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent-500 px-5 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-accent-600"
                    >
                      <Plus className="size-4" aria-hidden />
                      Raise your first enquiry
                    </Link>
                  ) : activeFilters ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-6 inline-flex items-center gap-2 rounded-full border border-ink-800 px-5 py-2.5 text-[15px] font-medium text-slate-700 transition-colors hover:border-ink-700 hover:text-white"
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="grid items-start gap-4 lg:grid-cols-4">
                  {columns.map((column) => (
                    <ul
                      key={column.bucket}
                      aria-label={column.label}
                      className={cn(
                        "space-y-3",
                        stage === column.bucket ? "block" : "hidden",
                        "lg:block",
                      )}
                    >
                      {column.rows.length === 0 ? (
                        <li className="list-none rounded-2xl border border-dashed border-ink-700 px-4 py-8 text-center text-[15px] leading-relaxed text-slate-500">
                          {STAGE_HINT[column.bucket]}
                        </li>
                      ) : (
                        column.rows.map(renderCard)
                      )}
                    </ul>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------ slide-over */}
      {selectedId ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            onClick={() => setSelectedId(null)}
            aria-hidden
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Enquiry detail"
            className="enq enq-slide fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col border-l border-ink-800 bg-ink-900 text-neutral-200 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 px-6 pt-5">
              <p className="text-[14px] text-slate-500 tabular-nums">
                {selectedRow?.enquiryNo ?? enquiry?.enquiryNo ?? ""}
              </p>
              <button
                type="button"
                autoFocus
                onClick={() => setSelectedId(null)}
                aria-label="Close"
                className="grid size-9 place-items-center rounded-full text-slate-600 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {detail.isPending ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : detail.isError || !enquiry ? (
              <div className="p-6">
                <Alert tone="error">
                  {detail.error instanceof Error
                    ? detail.error.message
                    : "Could not load this enquiry."}
                </Alert>
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="px-6 pt-2 pb-5">
                    <h2 className="enq-serif text-[30px] leading-[1.1] font-medium tracking-[-0.01em] text-white">
                      {enquiry.customerName}
                    </h2>
                    <p className="mt-1.5 text-[16px] text-slate-600">
                      {selectedRow?.project ?? enquiry.siteLocation}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-[15px] text-slate-500">
                      <MapPin className="size-4" aria-hidden />
                      {cityOf(enquiry)}, raised {shortDate(enquiry.enquiryDate)}
                    </p>

                    {selectedRow ? (
                      <div className="mt-4">
                        <div className="mb-2 flex items-center gap-2 text-[15px]">
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              statusTone(selectedRow.overallStatus).dot,
                            )}
                            aria-hidden
                          />
                          <span
                            className={cn("font-medium", statusTone(selectedRow.overallStatus).text)}
                          >
                            {STATUS_LABEL[selectedRow.overallStatus]}
                          </span>
                          <span className="ml-auto text-[14px] text-slate-500 tabular-nums">
                            {selectedRow.sourcedPercent}% sourced
                          </span>
                        </div>
                        <ProgressBar row={selectedRow} />
                        {selectedNote ? (
                          <div className="mt-3">
                            <NoteChip note={selectedNote} />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="border-t border-ink-800 px-6 pt-5 pb-6">
                    <h3 className="flex items-baseline gap-2 text-[16px] font-medium text-slate-700">
                      Crane requirements
                      <span className="text-[15px] font-normal text-slate-500 tabular-nums">
                        {enquiry.lines.length}
                      </span>
                    </h3>
                    {enquiry.lines.length === 0 ? (
                      <p className="py-8 text-center text-[15px] text-slate-500">
                        This enquiry has no lines yet.
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-3">
                        {enquiry.lines.map((line) => renderLine(line, selectedRow))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 gap-2 border-t border-ink-800 bg-ink-900 p-4">
                  <Link
                    to="/app/enquiries/$enquiryId"
                    params={{ enquiryId: enquiry.id }}
                    className="inline-flex flex-1 items-center justify-center rounded-full border border-ink-800 px-4 py-3 text-[16px] font-medium text-slate-700 transition-colors hover:border-ink-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
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
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent-500 px-4 py-3 text-[16px] font-medium text-white shadow-[0_10px_24px_-10px_rgba(196,68,63,0.75)] transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    Find cranes
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>
              </>
            )}
          </aside>
        </>
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

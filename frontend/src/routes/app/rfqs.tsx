import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  Info,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  DELIVERY_LABELS,
  RFQ_STATUS_LABELS,
  cancelRfq,
  extendDeadline,
  listRfqs,
  remindRfq,
  type MessageChannel,
  type RfqStatus,
} from "@/lib/rfqs";
import {
  LIST_FILTERS,
  LIST_SORTS,
  declinedCount,
  duplicateGroups,
  duplicateKeep,
  isListFilter,
  isListSort,
  matchesFilters,
  quoteCount,
  repliedCount,
  sortRows,
  summaryStats,
  tabCounts,
  type ListFilter,
  type ListSort,
  type RfqRow,
} from "@/lib/rfq-list";
import {
  deadlineCountdown,
  deadlineRelative,
  draftAge,
  formatDeadlineDate,
  startNote,
  statusDisplay,
  statusTone,
} from "@/lib/rfq-display";
import {
  cityOf,
  craneTypeLabel,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  titleCase,
} from "@/lib/format";
import { pincodeStateMismatch } from "@/lib/geo";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { VendorRfqIndexPage } from "@/routes/app/vendor-rfqs";
import { RfqPreview } from "@/routes/app/rfq-preview";

/**
 * Internal RFQ tracking.
 *
 * This is a queue, not a report. The page answers four questions in one screen —
 * what needs action, who has replied, what is overdue, and what the next step is —
 * so the list is built around those rather than around the database columns.
 *
 * The vendor's own RFQ inbox is a different audience reading a different entity
 * (their recipient row, not the RFQ) behind a different endpoint, so the vendor
 * branch hands off to `vendor-rfqs.tsx` rather than sharing this screen's queries.
 */

type Density = "comfortable" | "compact";

type ListUrlState = {
  status: RfqStatus | "ALL";
  q: string;
  filters: ListFilter[];
  sort: ListSort;
  rfqId: string | null;
};

type Notice = { tone: "success" | "error" | "info"; text: string };

type DialogState =
  | { kind: "extend"; rows: RfqRow[] }
  | { kind: "cancel"; rows: RfqRow[]; duplicates?: boolean }
  | null;

const STATUS_TABS: ReadonlyArray<{ value: RfqStatus | "ALL"; label: string }> = [
  { value: "SENT", label: "Sent" },
  { value: "DRAFT", label: "Drafts" },
  { value: "CLOSED", label: "Finalised" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

const DENSITY_KEY = "sml.rfqs.density";
const PAGE_WIDTH = "mx-auto w-full max-w-[1400px]";

/**
 * One template for every row at a breakpoint. The widths are deliberately not
 * proportional: requirement gets the slack, the rest are fixed so the eye can
 * travel down a column instead of re-finding it on every line.
 */
const ROW_GRID =
  "grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 " +
  "md:grid-cols-[20px_minmax(0,1fr)_170px_140px_88px] md:gap-y-1 " +
  "xl:grid-cols-[32px_minmax(0,1fr)_176px_184px_232px_132px_88px] xl:gap-x-4 xl:items-center";

const SKELETON_GRID =
  "grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 " +
  "md:grid-cols-[20px_minmax(0,1fr)_170px_140px_88px] " +
  "xl:grid-cols-[32px_minmax(0,1fr)_176px_184px_232px_132px_88px] xl:gap-x-4";

const STRIP_ITEMS: ReadonlyArray<{
  key: "ready" | "soon" | "quotes" | "failed" | "overdue";
  label: string;
  filter: ListFilter;
  status: RfqStatus | "ALL";
}> = [
  { key: "ready", label: "Drafts ready to send", filter: "ready", status: "DRAFT" },
  { key: "soon", label: "Deadline within 48 h", filter: "soon", status: "SENT" },
  { key: "quotes", label: "Quotes ready to compare", filter: "quotes", status: "SENT" },
  { key: "failed", label: "Failed deliveries", filter: "failed", status: "ALL" },
  { key: "overdue", label: "Overdue", filter: "passed", status: "ALL" },
];

const EMPTY_STATE: Record<
  RfqStatus | "ALL",
  { title: string; body: string }
> = {
  SENT: {
    title: "Nothing is out with vendors.",
    body: "Raise an RFQ from an enquiry line and it will appear here once it is sent.",
  },
  DRAFT: {
    title: "No drafts.",
    body: "Raise an RFQ from an enquiry line to start sourcing a crane.",
  },
  CLOSED: {
    title: "Nothing finalised yet.",
    body: "Awarded RFQs are kept here once the deal is done.",
  },
  CANCELLED: {
    title: "Nothing cancelled.",
    body: "Cancelled RFQs and the reason they were dropped appear here.",
  },
  ALL: {
    title: "No RFQs yet.",
    body: "Raise an RFQ from an enquiry line to start sourcing a crane.",
  },
};

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

const STATUS_VALUES: ReadonlyArray<RfqStatus | "ALL"> = [
  "SENT",
  "DRAFT",
  "CLOSED",
  "CANCELLED",
  "ALL",
];

function readListUrl(): ListUrlState {
  const params = new URLSearchParams(window.location.search);
  const rawStatus = params.get("status");
  const status =
    rawStatus && (STATUS_VALUES as string[]).includes(rawStatus)
      ? (rawStatus as RfqStatus | "ALL")
      : "SENT";

  const filters = Array.from(
    new Set(
      (params.get("f") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is ListFilter => isListFilter(value)),
    ),
  );
  // The admin dashboard's deep link is a filter, not a separate screen.
  if (params.get("delivery") === "FAILED" && !filters.includes("failed")) {
    filters.push("failed");
  }

  const rawSort = params.get("sort");
  const sort = rawSort && isListSort(rawSort) ? rawSort : "deadline";

  return {
    status,
    q: params.get("q") ?? "",
    filters,
    sort,
    rfqId: params.get("rfq"),
  };
}

function writeListUrl(state: ListUrlState) {
  const params = new URLSearchParams();
  // The default view is Sent; keeping it out of the URL makes the common link short.
  if (state.status !== "SENT") params.set("status", state.status);
  if (state.q) params.set("q", state.q);
  if (state.filters.length > 0) params.set("f", state.filters.join(","));
  if (state.filters.includes("failed")) params.set("delivery", "FAILED");
  if (state.sort !== "deadline") params.set("sort", state.sort);
  if (state.rfqId) params.set("rfq", state.rfqId);

  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  // Merge the router's history entry rather than replacing it, so Back still
  // works after a filter has been changed or a preview opened.
  window.history.replaceState(window.history.state, "", url);
}

function useListUrl() {
  const [state, setState] = useState<ListUrlState>(readListUrl);

  useEffect(() => {
    const onPop = () => setState(readListUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    writeListUrl(state);
  }, [state]);

  const update = useCallback(
    (patch: Partial<ListUrlState> | ((current: ListUrlState) => Partial<ListUrlState>)) => {
      setState((current) => ({
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      }));
    },
    [],
  );

  return [state, update] as const;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

function readDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function useDensity() {
  const [density, setDensity] = useState<Density>(readDensity);

  useEffect(() => {
    try {
      window.localStorage.setItem(DENSITY_KEY, density);
    } catch {
      // Storage can be unavailable in private windows; density is not worth failing over.
    }
  }, [density]);

  return [density, setDensity] as const;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function RfqIndexPage() {
  const { user } = useAuth();

  if (user?.role === "vendor_user") {
    return <VendorRfqIndexPage />;
  }
  return <RfqTrackingPage canCreate={user?.role === "sales_user"} />;
}

export function RfqTrackingPage({ canCreate }: { canCreate: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [url, update] = useListUrl();
  const [density, setDensity] = useDensity();
  const docked = useMediaQuery("(min-width: 1800px)");

  const [searchInput, setSearchInput] = useState(url.q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const deliveryFailed = url.filters.includes("failed");
  const awaitingOnly = url.filters.includes("awaiting");

  // Kept in the URL after a debounce so a shared link lands on the same search.
  useEffect(() => {
    setSearchInput(url.q);
  }, [url.q]);

  useEffect(() => {
    if (searchInput === url.q) return;
    const timer = window.setTimeout(() => update({ q: searchInput.trim() }), 220);
    return () => window.clearTimeout(timer);
  }, [searchInput, url.q, update]);

  const listQuery = useQuery({
    queryKey: ["rfqs", url.status, url.q, awaitingOnly, deliveryFailed],
    queryFn: () =>
      listRfqs({
        // A failed delivery can sit on any status, so that filter widens the set.
        ...(deliveryFailed || url.status === "ALL" ? {} : { status: url.status }),
        ...(url.q ? { search: url.q } : {}),
        ...(awaitingOnly ? { awaitingResponse: true } : {}),
      }),
  });

  // One unfiltered read for the counts. The tab query above stays separate so
  // changing tabs never re-counts the strip.
  const summaryQuery = useQuery({
    queryKey: ["rfqs", "summary"],
    queryFn: () => listRfqs({}),
  });

  const summaryRows = (summaryQuery.data?.rfqs ?? []) as RfqRow[];
  const counts = summaryQuery.data ? tabCounts(summaryRows) : undefined;
  const stats = summaryQuery.data ? summaryStats(summaryRows, Date.now()) : undefined;

  const rows = useMemo(() => {
    const now = Date.now();
    const loaded = (listQuery.data?.rfqs ?? []) as RfqRow[];
    let visible = loaded;

    if (deliveryFailed) visible = visible.filter((row) => row.failedCount > 0);
    if (url.filters.length > 0) {
      visible = visible.filter((row) => matchesFilters(row, url.filters, now));
    }
    if (url.q) {
      // The server matched RFQ no, enquiry and site. Recipients and the crane
      // type are already on the row, so they can be matched here for free.
      const needle = url.q.toLowerCase();
      visible = visible.filter((row) => {
        const haystack = [
          row.rfqNumber,
          row.enquiryNo,
          row.siteLocation,
          craneTypeLabel(row.craneTypeRef?.name ?? row.craneType),
          ...row.recipients.map((recipient) => recipient.vendorName),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    return sortRows(visible, url.sort);
  }, [listQuery.data, url.filters, url.q, url.sort, deliveryFailed]);

  const groups = useMemo(() => duplicateGroups(rows), [rows]);

  // Members after the first in each group are folded away until asked for.
  const foldedIds = useMemo(() => {
    const folded = new Set<string>();
    for (const members of groups.values()) {
      for (const member of members.slice(1)) folded.add(member.id);
    }
    return folded;
  }, [groups]);

  /**
   * What is actually drawn. "Select all" and the counts must agree with the
   * rows on screen: a folded duplicate is still in `rows`, but selecting it
   * would put a hidden RFQ into a bulk action.
   */
  const visibleRows = useMemo(
    () => rows.filter((row) => !foldedIds.has(row.id) || expandedGroups.has(row.id)),
    [rows, foldedIds, expandedGroups],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );
  const selectedSent = selectedRows.filter((row) => row.status === "SENT");
  const selectedLive = selectedRows.filter(
    (row) => row.status === "SENT" || row.status === "DRAFT",
  );
  const selectedPending = selectedSent.filter((row) => row.pendingCount > 0);

  // Selection must not outlive the filter that exposed it.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const visible = new Set(rows.map((row) => row.id));
      const next = new Set<string>();
      let changed = false;
      for (const id of current) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [rows]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedIds.size > 0 && selectedIds.size < visibleRows.length;
    }
  }, [selectedIds, visibleRows.length]);

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["rfqs"] }),
      queryClient.invalidateQueries({ queryKey: ["rfq"] }),
    ]);
  }, [queryClient]);

  const closePreview = useCallback(() => {
    const id = url.rfqId;
    update({ rfqId: null });
    if (id) {
      window.requestAnimationFrame(() => {
        document.getElementById(`rfq-row-${id}`)?.focus();
      });
    }
  }, [update, url.rfqId]);

  const openPreview = useCallback(
    (id: string) => update({ rfqId: id === url.rfqId ? null : id }),
    [update, url.rfqId],
  );

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((current) => {
      if (current.size > 0) return new Set();
      return new Set(visibleRows.map((row) => row.id));
    });
  }, [visibleRows]);

  const toggleFilter = useCallback(
    (filter: ListFilter) => {
      update((current) => ({
        filters: current.filters.includes(filter)
          ? current.filters.filter((value) => value !== filter)
          : [...current.filters, filter],
      }));
    },
    [update],
  );

  const applyStat = useCallback(
    (item: (typeof STRIP_ITEMS)[number]) => {
      const active = url.filters.includes(item.filter);
      update((current) => ({
        filters: active
          ? current.filters.filter((value) => value !== item.filter)
          : [...current.filters, item.filter],
        status: active ? current.status : item.status,
      }));
    },
    [update, url.filters],
  );

  // The preview owns focus while it is open; on a wide screen it is a column,
  // not a modal, but Escape still closes it.
  useEffect(() => {
    if (!url.rfqId) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[aria-label="RFQ preview"]')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [url.rfqId]);

  useEffect(() => {
    if (!url.rfqId || docked) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [url.rfqId, docked]);

  async function remindOne(row: RfqRow) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await remindRfq(row.id);
      await invalidate();
      setNotice({
        tone: "success",
        text: `Reminder sent for ${row.rfqNumber} to ${result.result.sent} of ${result.result.reminded} pending ${
          result.result.reminded === 1 ? "vendor" : "vendors"
        }.`,
      });
    } catch (caught) {
      setNotice({
        tone: "error",
        text: caught instanceof Error ? caught.message : "The reminder could not be sent.",
      });
    } finally {
      setBusy(false);
    }
  }

  function resultNotice(
    results: PromiseSettledResult<unknown>[],
    successText: string,
  ): Notice {
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length === 0) return { tone: "success", text: successText };

    const reasons = Array.from(
      new Set(
        failures.map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        ),
      ),
    );
    const done = results.length - failures.length;
    return {
      tone: "error",
      text: `${done} done, ${failures.length} failed${reasons.length ? `: ${reasons.join("; ")}` : ""}.`,
    };
  }

  async function extendRows(rowsToExtend: RfqRow[], deadline: string, reason: string) {
    setBusy(true);
    const results = await Promise.allSettled(
      rowsToExtend.map((row) => extendDeadline(row.id, deadline, reason)),
    );
    await invalidate();
    setBusy(false);
    setDialog(null);
    setNotice(
      resultNotice(
        results,
        `Deadline extended for ${results.length} ${
          results.length === 1 ? "RFQ" : "RFQs"
        }. Pending vendors were emailed.`,
      ),
    );
  }

  async function cancelRows(rowsToCancel: RfqRow[], reason: string) {
    setBusy(true);
    const results = await Promise.allSettled(
      rowsToCancel.map((row) => cancelRfq(row.id, reason)),
    );
    await invalidate();
    setBusy(false);
    setDialog(null);
    setNotice(
      resultNotice(
        results,
        `${results.length} ${results.length === 1 ? "RFQ" : "RFQs"} cancelled.`,
      ),
    );
  }

  async function remindRows(rowsToRemind: RfqRow[]) {
    setBusy(true);
    const results = await Promise.allSettled(rowsToRemind.map((row) => remindRfq(row.id)));
    await invalidate();
    setBusy(false);
    setNotice(
      resultNotice(
        results,
        `Reminders sent for ${results.length} ${results.length === 1 ? "RFQ" : "RFQs"}.`,
      ),
    );
  }

  function openCancel(rowsToCancel: RfqRow[], duplicates = false) {
    const live = rowsToCancel.filter(
      (row) => row.status === "SENT" || row.status === "DRAFT",
    );
    if (live.length === 0) return;
    setDialog({ kind: "cancel", rows: live, duplicates });
  }

  function openExtend(rowsToExtend: RfqRow[]) {
    const sent = rowsToExtend.filter((row) => row.status === "SENT");
    if (sent.length === 0) return;
    setDialog({ kind: "extend", rows: sent });
  }

  function cancelDuplicates(group: RfqRow[]) {
    const keep = duplicateKeep(group);
    if (!keep) return;
    openCancel(
      group.filter((row) => row.id !== keep.id),
      true,
    );
  }

  function toggleGroup(leaderId: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(leaderId)) next.delete(leaderId);
      else next.add(leaderId);
      return next;
    });
  }

  // ---------------------------------------------------------------- keyboard

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    document.getElementById(`rfq-row-${id}`)?.focus();
  }, []);

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
      );
    }

    function onKey(event: KeyboardEvent) {
      const typing = isTyping(event.target);

      if (event.key === "Escape") {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (dialog) {
          setDialog(null);
          return;
        }
        if (url.rfqId) {
          closePreview();
          return;
        }
        if (filtersOpen) setFiltersOpen(false);
        return;
      }

      if (typing) return;

      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((value) => !value);
        return;
      }

      if (dialog || shortcutsOpen) return;

      const movesDown = event.key === "j" || event.key === "ArrowDown";
      const movesUp = event.key === "k" || event.key === "ArrowUp";
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      if (arrow && !listRef.current?.contains(document.activeElement)) return;
      if (!movesDown && !movesUp) {
        if (event.key === "x") {
          const target = focusedId ?? url.rfqId;
          if (target) {
            event.preventDefault();
            toggleSelected(target);
          }
        }
        return;
      }

      if (rows.length === 0) return;
      event.preventDefault();
      const index = rows.findIndex((row) => row.id === focusedId);
      const next = movesDown
        ? rows[Math.min(index + 1, rows.length - 1)]
        : rows[Math.max(index - 1, 0)];
      const fallback = movesDown ? rows[0] : rows[rows.length - 1];
      const target = index === -1 ? fallback : next;
      if (target) focusRow(target.id);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closePreview,
    dialog,
    filtersOpen,
    focusRow,
    focusedId,
    rows,
    shortcutsOpen,
    toggleSelected,
    url.rfqId,
  ]);

  // ---------------------------------------------------------------- actions

  function exportCsv() {
    const header = [
      "RFQ no",
      "Enquiry line",
      "Crane",
      "Capacity",
      "Qty",
      "Site",
      "State",
      "Start",
      "Deadline",
      "Status",
      "Vendors sent",
      "Replied",
      "Quotes",
    ];
    const body = rows.map((row) => {
      const display = statusDisplay(row.status, row.rollupStatus);
      return [
        row.rfqNumber,
        `${row.enquiryNo}/${row.lineNo}`,
        craneTypeLabel(row.craneTypeRef?.name ?? row.craneType),
        `${row.capacityT} t${row.capacityRule === "AT_LEAST" ? "+" : ""}`,
        String(row.quantity),
        cityOf(row),
        row.siteState?.name ?? row.siteStateCode,
        row.requiredStartDate.slice(0, 10),
        row.submissionDeadline.slice(0, 10),
        display.label,
        String(row.recipientCount),
        String(repliedCount(row)),
        String(quoteCount(row) ?? row.quotedCount),
      ];
    });

    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `rfqs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function clearFilters() {
    update({ q: "", filters: [], sort: "deadline" });
    setSearchInput("");
  }

  const hasQuery = Boolean(url.q) || url.filters.length > 0;
  const activeView = STATUS_TABS.find((tab) => tab.value === url.status)?.label ?? "All";
  const empty = EMPTY_STATE[url.status];
  /**
   * The Sent tab is the landing view. If there is nothing out but drafts are
   * sitting there, "nothing is out" is true and useless — point at the work.
   */
  const draftsWaiting =
    url.status === "SENT" && !hasQuery && !deliveryFailed ? (counts?.DRAFT ?? 0) : 0;
  const previewRow = url.rfqId
    ? rows.find((row) => row.id === url.rfqId) ??
      summaryRows.find((row) => row.id === url.rfqId) ??
      null
    : null;

  const groupFor = (row: RfqRow): RfqRow[] | undefined => {
    const members = groups.get(row.id);
    return members && members.length > 1 ? members : undefined;
  };

  return (
    <div className="theme-dark -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6">
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-5 sm:px-8">
          <div className={PAGE_WIDTH}>
            {/* header */}
            <p className="text-[13px] text-slate-500">RFQ tracking</p>

            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-white">
                What&rsquo;s out with vendors?
              </h1>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={rows.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  <Download className="size-4" aria-hidden />
                  Export CSV
                </button>
                {canCreate ? (
                  <Link
                    to="/app/rfqs/new"
                    className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    <Plus className="size-4" aria-hidden />
                    Raise RFQ
                  </Link>
                ) : null}
              </div>
            </div>

            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-slate-500 sm:items-center">
              The customer, the site address and the budget never leave the building.
              <button
                type="button"
                title="The customer, the site address and the budget never leave the building. Vendors only ever see the crane requirement."
                aria-label="Full privacy note"
                className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 sm:mt-0"
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </p>

            {/* needs-action strip */}
            <div className="mt-4 grid grid-cols-2 border-y border-ink-800 sm:grid-cols-5 sm:divide-x sm:divide-ink-800">
              {STRIP_ITEMS.map((item, index) => {
                const value = stats?.[item.key];
                const active = url.filters.includes(item.filter);
                const loading = summaryQuery.isPending;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => applyStat(item)}
                    aria-pressed={active}
                    aria-busy={loading}
                    className={cn(
                      "relative flex flex-col items-start px-3 py-3 text-left transition-colors duration-150 hover:bg-ink-900/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 sm:px-4 sm:first:pl-0",
                      index === STRIP_ITEMS.length - 1 && "col-span-2 sm:col-span-1",
                    )}
                  >
                    {loading ? (
                      <span
                        aria-hidden
                        className="mt-0.5 h-5 w-6 animate-pulse rounded bg-ink-800 motion-reduce:animate-none"
                      />
                    ) : (
                      <span
                        className={cn(
                          "text-[20px] leading-none font-semibold tabular-nums",
                          value && value > 0 ? "text-white" : "text-slate-600",
                        )}
                      >
                        {value ?? "—"}
                      </span>
                    )}
                    <span className="mt-1.5 text-[13px] text-slate-500 transition-colors group-hover:text-slate-700">
                      {item.label}
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
              })}
            </div>

            {/* search */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <form
                className="relative min-w-0 flex-1 sm:max-w-[380px]"
                onSubmit={(event) => {
                  event.preventDefault();
                  update({ q: searchInput.trim() });
                }}
              >
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                  aria-hidden
                />
                <input
                  ref={searchRef}
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="RFQ no, enquiry, site or vendor"
                  aria-label="Search RFQs"
                  title="Searches RFQ no, enquiry, site, vendor and crane type"
                  className="field-input h-9 py-0 pr-9 pl-10 text-[13px]"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput("");
                      update({ q: "" });
                    }}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-white"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
                <button type="submit" className="sr-only">
                  Search
                </button>
              </form>

              <button
                type="button"
                onClick={() => setFiltersOpen((value) => !value)}
                aria-expanded={filtersOpen}
                aria-controls="rfq-filters"
                className="inline-flex items-center gap-2 rounded-lg border border-ink-800 px-3 py-2 text-[13px] font-medium text-slate-500 transition-colors hover:border-ink-700 hover:text-white lg:hidden"
              >
                <SlidersHorizontal className="size-4" aria-hidden />
                Filters
                {url.filters.length > 0 ? (
                  <span className="rounded-full bg-ink-800 px-1.5 text-[12px] text-white tabular-nums">
                    {url.filters.length}
                  </span>
                ) : null}
              </button>

              <button
                type="button"
                onClick={() => setShortcutsOpen(true)}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                className="ml-auto inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                <CircleHelp className="size-4" aria-hidden />
              </button>
            </div>

            {/* tabs */}
            <div className="mt-3 flex items-end justify-between gap-4 border-b border-ink-800">
              <div
                role="tablist"
                aria-label="RFQ status"
                className="flex min-w-0 gap-5 overflow-x-auto"
                onKeyDown={(event) => {
                  const index = STATUS_TABS.findIndex((tab) => tab.value === url.status);
                  if (index === -1) return;
                  let next = index;
                  if (event.key === "ArrowRight") next = (index + 1) % STATUS_TABS.length;
                  else if (event.key === "ArrowLeft")
                    next = (index - 1 + STATUS_TABS.length) % STATUS_TABS.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = STATUS_TABS.length - 1;
                  else return;

                  event.preventDefault();
                  const target = STATUS_TABS[next];
                  if (!target) return;
                  update({ status: target.value });
                  document.getElementById(`rfq-tab-${target.value}`)?.focus();
                }}
              >
                {STATUS_TABS.map((tab) => {
                  const active = url.status === tab.value;
                  const count = counts?.[tab.value];
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      id={`rfq-tab-${tab.value}`}
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      onClick={() => update({ status: tab.value })}
                      className={cn(
                        "-mb-px shrink-0 border-b-2 pb-2.5 text-[13px] whitespace-nowrap transition-colors duration-150",
                        active
                          ? "border-accent-500 font-medium text-white"
                          : "border-transparent text-slate-500 hover:text-white",
                      )}
                    >
                      {tab.label}
                      {typeof count === "number" ? (
                        <span className="ml-1.5 hidden text-[12px] text-slate-500 tabular-nums sm:inline">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="hidden shrink-0 items-center gap-2 pb-2.5 sm:flex">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={visibleRows.length > 0 && selectedIds.size >= visibleRows.length}
                  onChange={toggleAll}
                  disabled={visibleRows.length === 0}
                  aria-label="Select all RFQs in this view"
                  className="size-3.5 rounded border-ink-700 bg-ink-900 accent-accent-500"
                />
                <span
                  className="text-[12px] text-slate-500 tabular-nums"
                  aria-live="polite"
                >
                  {visibleRows.length}
                  {visibleRows.length !== rows.length ? ` of ${rows.length}` : ""}{" "}
                  {rows.length === 1 ? "RFQ" : "RFQs"}
                  {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ""}
                </span>
              </div>
            </div>

            {/* filters + sort + density */}
            <div
              id="rfq-filters"
              className={cn(
                "mt-2.5 flex flex-wrap items-center gap-2",
                filtersOpen ? "flex" : "hidden",
                "lg:flex",
              )}
            >
              {LIST_FILTERS.map((filter) => {
                const active = url.filters.includes(filter.value);
                return (
                  <button
                    key={filter.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleFilter(filter.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
                      active
                        ? "border-accent-500/50 bg-ink-850 text-white"
                        : "border-ink-800 text-slate-500 hover:border-ink-700 hover:text-white",
                    )}
                  >
                    {active ? <Check className="size-3" aria-hidden /> : null}
                    {filter.label}
                  </button>
                );
              })}

              {url.filters.includes("ready") ? (
                <button
                  type="button"
                  onClick={() => toggleFilter("ready")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-accent-500/50 bg-ink-850 px-2 py-1 text-[12px] text-white"
                >
                  <Check className="size-3" aria-hidden />
                  Drafts ready to send
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}

              {hasQuery || url.sort !== "deadline" ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1 px-1 text-[12px] text-slate-500 transition-colors hover:text-white"
                >
                  Clear filters
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <label htmlFor="rfq-sort" className="sr-only">
                  Sort RFQs
                </label>
                <select
                  id="rfq-sort"
                  value={url.sort}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (isListSort(value)) update({ sort: value });
                  }}
                  className="field-input h-8 w-auto py-0 pr-7 text-[13px]"
                >
                  {LIST_SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <div
                  role="group"
                  aria-label="Row density"
                  className="inline-flex items-center rounded-lg border border-ink-800 p-0.5"
                >
                  {(["comfortable", "compact"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={density === value}
                      onClick={() => setDensity(value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[12px] capitalize transition-colors",
                        density === value
                          ? "bg-ink-800 text-white"
                          : "text-slate-500 hover:text-white",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 pb-2 sm:hidden">
              <span className="text-[12px] text-slate-500 tabular-nums">
                {visibleRows.length}
                {visibleRows.length !== rows.length ? ` of ${rows.length}` : ""}{" "}
                {rows.length === 1 ? "RFQ" : "RFQs"}
                {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ""}
              </span>
              <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-500">
                <input
                  type="checkbox"
                  checked={visibleRows.length > 0 && selectedIds.size >= visibleRows.length}
                  onChange={toggleAll}
                  disabled={visibleRows.length === 0}
                  className="size-3.5 rounded border-ink-700 bg-ink-900 accent-accent-500"
                />
                Select all
              </label>
            </div>
          </div>
        </div>

        {/* list */}
        <div
          ref={listRef}
          role="list"
          aria-label="RFQs"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className={cn(PAGE_WIDTH, "px-4 pb-28 sm:px-8")}>
            {deliveryFailed ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 bg-ink-900 px-3 py-2 text-[13px] text-amber-600">
                <span>Showing only RFQs with a failed delivery.</span>
                <button
                  type="button"
                  onClick={() => toggleFilter("failed")}
                  className="font-medium text-slate-500 underline decoration-ink-700 underline-offset-4 transition-colors hover:text-white"
                >
                  Clear
                </button>
              </div>
            ) : null}

            {notice ? (
              <div className="mt-3 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Alert tone={notice.tone}>{notice.text}</Alert>
                </div>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss message"
                  className="mt-1 rounded p-1 text-slate-500 transition-colors hover:text-white"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : null}

            {listQuery.isPending ? (
              <div className="mt-3 divide-y divide-ink-800 border-y border-ink-800" aria-hidden>
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : listQuery.isError ? (
              <div className="mt-6">
                <Alert tone="error">
                  {listQuery.error instanceof Error
                    ? listQuery.error.message
                    : "Could not load the RFQ list."}
                </Alert>
                <button
                  type="button"
                  onClick={() => void listQuery.refetch()}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
                >
                  <RotateCcw className="size-4" aria-hidden />
                  Retry
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-20 text-center">
                <FileText className="size-6 text-slate-600" aria-hidden />
                <p className="mt-3 text-[15px] font-medium text-white">
                  {deliveryFailed
                    ? "No failed deliveries"
                    : hasQuery
                      ? "No RFQs match these filters"
                      : draftsWaiting > 0
                        ? "Nothing is out with vendors yet."
                        : empty.title}
                </p>
                <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-slate-500">
                  {deliveryFailed
                    ? "Every email sent from this queue reached the vendor."
                    : hasQuery
                      ? "Clear the search and filters, or pick another view."
                      : draftsWaiting > 0
                        ? `${draftsWaiting} draft ${
                            draftsWaiting === 1 ? "RFQ is" : "RFQs are"
                          } waiting to be sent.`
                        : empty.body}
                </p>
                {deliveryFailed ? (
                  <button
                    type="button"
                    onClick={() => toggleFilter("failed")}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
                  >
                    Show every RFQ
                  </button>
                ) : hasQuery ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
                  >
                    Clear filters
                  </button>
                ) : draftsWaiting > 0 ? (
                  <button
                    type="button"
                    onClick={() => update({ status: "DRAFT", filters: [] })}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600"
                  >
                    Review drafts
                    <ArrowRight className="size-4" aria-hidden />
                  </button>
                ) : canCreate ? (
                  <Link
                    to="/app/enquiries"
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600"
                  >
                    <Plus className="size-4" aria-hidden />
                    Start from an enquiry line
                  </Link>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 divide-y divide-ink-800 border-y border-ink-800">
                {rows.map((row) => {
                  const hidden = foldedIds.has(row.id) && !expandedGroups.has(row.id);
                  if (hidden) return null;

                  const group = groupFor(row);
                  const members = group ? group.length : 0;
                  const expanded = group ? expandedGroups.has(row.id) : false;

                  return (
                    <div key={row.id} className="contents">
                      <RfqRowView
                        row={row}
                        now={Date.now()}
                        density={density}
                        checked={selectedIds.has(row.id)}
                        previewing={url.rfqId === row.id}
                        focused={focusedId === row.id}
                        canCreate={canCreate}
                        onFocusRow={() => setFocusedId(row.id)}
                        onOpen={() => openPreview(row.id)}
                        onOpenFull={() =>
                          void navigate({
                            to: "/app/rfqs/$rfqId",
                            params: { rfqId: row.id },
                          })
                        }
                        onToggleSelect={() => toggleSelected(row.id)}
                        onRemind={() => void remindOne(row)}
                        onExtend={() => openExtend([row])}
                        onCancel={() => openCancel([row])}
                      />

                      {group ? (
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-ink-900/50 py-2 pr-3 pl-8 text-[12px] text-slate-500 md:pl-10">
                          <button
                            type="button"
                            onClick={() => toggleGroup(row.id)}
                            aria-expanded={expanded}
                            className="inline-flex items-center gap-1.5 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                          >
                            {expanded ? (
                              <ChevronDown className="size-3.5" aria-hidden />
                            ) : (
                              <ChevronRight className="size-3.5" aria-hidden />
                            )}
                            {members} {row.status === "DRAFT" ? "drafts" : "RFQs"} for{" "}
                            {row.enquiryNo}/{row.lineNo}
                            <span className="sr-only">
                              {expanded ? ". Hide duplicates" : ". Show duplicates"}
                            </span>
                          </button>

                          {expanded ? (
                            <button
                              type="button"
                              onClick={() => cancelDuplicates(group)}
                              className="inline-flex items-center gap-1 text-slate-500 transition-colors hover:text-white"
                            >
                              Keep one, cancel the others
                              <ArrowRight className="size-3.5" aria-hidden />
                            </button>
                          ) : (
                            <span>Keep one, cancel the others</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {rows.length > 0 ? (
              <div className="flex items-center justify-between gap-4 border-t border-ink-800 py-3 text-[12px] text-slate-500 tabular-nums">
                <span>
                  {visibleRows.length} {visibleRows.length === 1 ? "RFQ" : "RFQs"} · {activeView}
                </span>
                <span>{LIST_SORTS.find((option) => option.value === url.sort)?.label}</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* bulk bar */}
        {selectedIds.size > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-4 pb-4 sm:px-8">
            <div className="pointer-events-auto mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-1 rounded-xl border border-ink-800 bg-ink-900/95 px-2 py-1.5 shadow-xl backdrop-blur">
              <span className="px-2 text-[13px] font-medium text-white tabular-nums">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={() => openExtend(selectedSent)}
                disabled={selectedSent.length === 0 || busy}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-ink-850 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CalendarClock className="size-3.5" aria-hidden />
                Extend deadline
              </button>
              <button
                type="button"
                onClick={() => void remindRows(selectedPending)}
                disabled={selectedPending.length === 0 || busy}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-ink-850 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Bell className="size-3.5" aria-hidden />
                Remind pending
              </button>
              <button
                type="button"
                onClick={() => openCancel(selectedLive)}
                disabled={selectedLive.length === 0 || busy}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-ink-850 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Ban className="size-3.5" aria-hidden />
                Cancel
              </button>
              {busy ? <Spinner /> : null}
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-slate-500 transition-colors hover:text-white"
              >
                Clear
                <X className="size-3" aria-hidden />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* preview */}
      {url.rfqId ? (
        <>
          {!docked ? (
            <button
              type="button"
              aria-label="Close preview"
              onClick={closePreview}
              className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px]"
            />
          ) : null}
          <RfqPreview
            rfqId={url.rfqId}
            row={previewRow}
            docked={docked}
            onClose={closePreview}
            onChanged={invalidate}
          />
        </>
      ) : null}

      {/* dialogs */}
      {dialog?.kind === "extend" ? (
        <ExtendDialog
          rows={dialog.rows}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(deadline, reason) => void extendRows(dialog.rows, deadline, reason)}
        />
      ) : null}

      {dialog?.kind === "cancel" ? (
        <CancelDialog
          rows={dialog.rows}
          duplicates={Boolean(dialog.duplicates)}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => void cancelRows(dialog.rows, reason)}
        />
      ) : null}

      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function RfqRowView({
  row,
  now,
  density,
  checked,
  previewing,
  focused,
  canCreate,
  onFocusRow,
  onOpen,
  onOpenFull,
  onToggleSelect,
  onRemind,
  onExtend,
  onCancel,
}: {
  row: RfqRow;
  now: number;
  density: Density;
  checked: boolean;
  previewing: boolean;
  focused: boolean;
  canCreate: boolean;
  onFocusRow: () => void;
  onOpen: () => void;
  onOpenFull: () => void;
  onToggleSelect: () => void;
  onRemind: () => void;
  onExtend: () => void;
  onCancel: () => void;
}) {
  const display = statusDisplay(row.status, row.rollupStatus);
  const relative = row.status === "SENT" || row.status === "DRAFT"
    ? deadlineRelative(row.submissionDeadline, now)
    : null;
  const start = startNote(
    row.requiredStartDate,
    row.startDateTbc,
    row.durationValue,
    row.durationUnit,
    now,
  );
  const site = row.siteState
    ? `${cityOf(row)}, ${titleCase(row.siteState.name)}`
    : cityOf(row);
  const mismatch = pincodeStateMismatch(row.sitePincode, row.siteStateCode);
  const staleDraft =
    row.status === "DRAFT" && new Date(row.submissionDeadline).getTime() < now;
  const quiet = "text-[13px] leading-tight text-slate-500";

  // A touch press that turns into a long press selects instead of opening.
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const clearPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <div
      className={cn(
        "group relative transition-colors duration-150 motion-reduce:transition-none",
        previewing ? "bg-ink-850" : "hover:bg-ink-850/60",
      )}
    >
      {previewing ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 z-10 w-0.5 bg-accent-500"
        />
      ) : null}

      <button
        type="button"
        id={`rfq-row-${row.id}`}
        onClick={(event) => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          if (event.metaKey || event.ctrlKey) onOpenFull();
          else onOpen();
        }}
        onPointerDown={(event) => {
          if (event.pointerType !== "touch") return;
          longPressed.current = false;
          pressTimer.current = window.setTimeout(() => {
            longPressed.current = true;
            onToggleSelect();
          }, 500);
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onPointerLeave={clearPress}
        onFocus={onFocusRow}
        aria-label={`Preview ${row.rfqNumber}`}
        aria-current={previewing ? "true" : undefined}
        className={cn(
          "absolute inset-0 z-0 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
          focused && "outline-2 -outline-offset-2 outline-accent-500/40",
        )}
      />

      <div
        className={cn(
          "pointer-events-none relative",
          ROW_GRID,
          density === "compact" ? "py-2" : "py-3.5",
        )}
      >
        {/* select */}
        <div className="col-start-1 row-start-1 flex items-start justify-center pt-0.5 md:row-span-2 xl:row-span-1 xl:items-center xl:pt-0">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleSelect}
            aria-label={`Select ${row.rfqNumber}`}
            className="pointer-events-auto size-3.5 rounded border-ink-700 bg-ink-900 accent-accent-500"
          />
        </div>

        {/* identity */}
        <div className="col-start-2 row-start-1 min-w-0 pr-14 md:col-start-2 md:row-start-1 md:pr-0 xl:col-start-2">
          <p className="font-mono text-[12px] leading-tight text-slate-500">
            {row.rfqNumber}
          </p>
          <p
            className="mt-0.5 truncate text-[15px] leading-tight font-semibold text-white"
            title={`${craneTypeLabel(row.craneTypeRef?.name ?? row.craneType)} · ${
              row.capacityT
            } t${row.capacityRule === "AT_LEAST" ? "+" : ""}${
              row.quantity > 1 ? ` · ${row.quantity} required` : ""
            }`}
          >
            {craneTypeLabel(row.craneTypeRef?.name ?? row.craneType)} ·{" "}
            <span className="tabular-nums">
              {row.capacityT} t{row.capacityRule === "AT_LEAST" ? "+" : ""}
            </span>
            {row.quantity > 1 ? (
              <span className="ml-1.5 text-[13px] font-normal text-slate-500 tabular-nums">
                × {row.quantity}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-tight text-slate-500">
            <Link
              to="/app/enquiries"
              search={{ q: row.enquiryNo }}
              onClick={(event) => event.stopPropagation()}
              title={`Open enquiry ${row.enquiryNo}`}
              className="pointer-events-auto shrink-0 font-mono transition-colors hover:text-white"
            >
              {row.enquiryNo}/{row.lineNo}
            </Link>
            {row.applicationDescription ? (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <span className="truncate" title={row.applicationDescription}>
                  {row.applicationDescription}
                </span>
              </>
            ) : null}
          </p>
        </div>

        {/* site */}
        <div className="col-start-2 row-start-2 min-w-0 md:col-start-2 md:row-start-2 xl:col-start-3 xl:row-start-1">
          <p className="truncate text-[13px] leading-tight text-slate-600" title={site}>
            {site}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-tight text-slate-500">
            <span className="tabular-nums">{row.sitePincode ?? "No pincode"}</span>
            {mismatch ? (
              <>
                <span aria-hidden>·</span>
                <span
                  title={`${row.sitePincode} is a ${mismatch.expected} pincode, but the state is ${
                    row.siteState?.name ?? row.siteStateCode
                  }.`}
                  className="underline decoration-dotted underline-offset-2"
                >
                  Check state
                </span>
              </>
            ) : null}
          </p>
          {row.siteLocationUnverified ? (
            <p className="mt-0.5 text-[12px] leading-tight text-amber-600">
              Location unverified
            </p>
          ) : null}
        </div>

        {/* timing */}
        <div className="col-start-2 row-start-3 min-w-0 md:col-start-3 md:row-start-1 xl:col-start-4 xl:row-start-1">
          <p className={cn(quiet, "text-slate-600 tabular-nums")}>
            <span className="text-slate-500">Due</span>{" "}
            {formatDeadlineDate(row.submissionDeadline)}
          </p>
          {relative ? (
            <p
              className={cn(
                "mt-0.5 text-[12px] leading-tight tabular-nums",
                relative.tone === "overdue"
                  ? "font-medium text-red-600"
                  : relative.tone === "soon"
                    ? "font-medium text-amber-600"
                    : "text-slate-500",
              )}
            >
              {relative.label}
            </p>
          ) : null}
          <p
            className={cn(
              "mt-0.5 truncate text-[12px] leading-tight tabular-nums",
              start.tone === "warn" ? "text-amber-600" : "text-slate-500",
            )}
            title={start.label}
          >
            {start.label}
          </p>
          {row.status === "DRAFT" ? (
            <p className="mt-0.5 text-[12px] leading-tight text-slate-500 tabular-nums">
              {draftAge(row.createdAt, now)}
            </p>
          ) : null}
        </div>

        {/* progress / next step */}
        <div className="col-start-2 row-start-4 min-w-0 md:col-start-3 md:row-start-2 md:col-span-2 xl:col-start-5 xl:row-start-1 xl:col-span-1">
          {row.status === "DRAFT" ? (
            <>
              {canCreate ? (
                <Link
                  to="/app/rfqs/$rfqId"
                  params={{ rfqId: row.id }}
                  search={{ tab: "vendors" }}
                  onClick={(event) => event.stopPropagation()}
                  className="pointer-events-auto inline-flex items-center gap-1 text-[13px] font-medium text-accent-400 transition-colors hover:text-accent-300"
                >
                  Choose vendors
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : (
                <p className="text-[13px] leading-tight text-slate-500">Not sent yet</p>
              )}
              {staleDraft ? (
                <p className="mt-0.5 text-[12px] leading-tight text-red-600">
                  Deadline passed.{" "}
                  {canCreate ? (
                    <Link
                      to="/app/rfqs/$rfqId/edit"
                      params={{ rfqId: row.id }}
                      onClick={(event) => event.stopPropagation()}
                      className="pointer-events-auto underline decoration-red-600/50 underline-offset-2 hover:text-red-500"
                    >
                      Set a new one
                    </Link>
                  ) : (
                    "Set a new one before sending."
                  )}
                </p>
              ) : null}
            </>
          ) : row.status === "SENT" ? (
            <RecipientProgress
              row={row}
              overdue={relative?.tone === "overdue"}
              onRemind={onRemind}
            />
          ) : row.status === "CLOSED" ? (
            <p className="text-[13px] leading-tight text-slate-600">
              Awarded
              {quoteCount(row) ? (
                <span className="text-slate-500">
                  {" "}
                  · {quoteCount(row)} {quoteCount(row) === 1 ? "quote" : "quotes"}
                </span>
              ) : null}
            </p>
          ) : (
            <p
              className="truncate text-[13px] leading-tight text-slate-500"
              title={row.cancelReason ?? "No reason recorded"}
            >
              {row.cancelReason ?? "Cancelled without a reason"}
            </p>
          )}
        </div>

        {/* status */}
        <div className="col-start-2 row-start-5 flex items-start gap-2 md:col-start-4 md:row-start-1 xl:col-start-6 xl:row-start-1 xl:items-center">
          <span
            className={cn("mt-1.5 size-1.5 shrink-0 rounded-full xl:mt-0", display.dot)}
            aria-hidden
          />
          <div className="min-w-0">
            <p className={cn("text-[13px] leading-tight font-medium", display.text)}>
              {display.label}
            </p>
            {row.failedCount > 0 ? (
              <p className="mt-0.5 text-[12px] leading-tight font-medium text-red-600">
                {row.failedCount} failed
              </p>
            ) : null}
          </div>
        </div>

        {/* actions */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 md:static md:col-start-5 md:row-span-2 md:justify-end xl:col-start-7 xl:row-span-1">
          {row.status === "DRAFT" && canCreate ? (
            <Link
              to="/app/rfqs/$rfqId/edit"
              params={{ rfqId: row.id }}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Edit ${row.rfqNumber}`}
              title="Edit draft"
              className="pointer-events-auto hidden size-7 items-center justify-center rounded-md text-slate-500 opacity-0 transition-colors group-hover:opacity-100 hover:bg-ink-800 hover:text-white focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 xl:inline-flex"
            >
              <Pencil className="size-3.5" aria-hidden />
            </Link>
          ) : row.status === "SENT" && row.pendingCount > 0 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRemind();
              }}
              aria-label={`Remind pending vendors on ${row.rfqNumber}`}
              title="Remind pending vendors"
              className="pointer-events-auto hidden size-7 items-center justify-center rounded-md text-slate-500 opacity-0 transition-colors group-hover:opacity-100 hover:bg-ink-800 hover:text-white focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 xl:inline-flex"
            >
              <Bell className="size-3.5" aria-hidden />
            </button>
          ) : null}

          <Link
            to="/app/rfqs/$rfqId"
            params={{ rfqId: row.id }}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Open ${row.rfqNumber}`}
            title="Open full page"
            className="pointer-events-auto inline-flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>

          <RowMenu
            row={row}
            onRemind={onRemind}
            onExtend={onExtend}
            onCancel={onCancel}
          />
        </div>
      </div>
    </div>
  );
}

function RecipientProgress({
  row,
  overdue,
  onRemind,
}: {
  row: RfqRow;
  overdue: boolean;
  onRemind: () => void;
}) {
  const replied = repliedCount(row);
  const declined = declinedCount(row);
  const total = Math.max(row.recipientCount, 1);
  const segments =
    row.recipients.length > 0
      ? row.recipients
      : Array.from({ length: row.recipientCount }).map((_, index) => ({
          recipientId: `empty-${index}`,
          vendorName: "Vendor",
          emailDeliveryStatus: "QUEUED" as const,
          whatsappDeliveryStatus: null,
          responseStatus: "PENDING" as const,
        }));

  return (
    <>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(replied, total)}
        aria-valuetext={`${replied} of ${total} vendors replied`}
        aria-label={`Vendor replies for ${row.rfqNumber}`}
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-ink-800"
      >
        {segments.map((segment) => {
          const tone =
            segment.responseStatus === "QUOTED"
              ? "bg-emerald-500"
              : segment.responseStatus === "DECLINED"
                ? "bg-red-500"
                : segment.responseStatus === "EXPIRED"
                  ? "bg-slate-500/60"
                  : "bg-ink-700";
          return (
            <span
              key={segment.recipientId}
              tabIndex={0}
              title={`${segment.vendorName} · ${segment.responseStatus
                .toLowerCase()
                .replaceAll("_", " ")}`}
              aria-label={`${segment.vendorName}: ${segment.responseStatus
                .toLowerCase()
                .replaceAll("_", " ")}`}
              className={cn("h-full flex-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-500", tone)}
            />
          );
        })}
      </div>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-tight text-slate-500 tabular-nums">
        <span>
          {replied} of {row.recipientCount} replied
        </span>
        {declined > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{declined} declined</span>
          </>
        ) : null}
        {row.channels?.length ? (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              {row.channels.includes("EMAIL") ? (
                <Mail className="size-3" aria-label="Email" />
              ) : null}
              {row.channels.includes("WHATSAPP") ? (
                <MessageCircle className="size-3" aria-label="WhatsApp" />
              ) : null}
            </span>
          </>
        ) : null}
      </p>

      {row.pendingCount > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemind();
          }}
          className={cn(
            "pointer-events-auto mt-0.5 inline-flex items-center gap-1 text-[12px] transition-colors",
            overdue
              ? "font-medium text-accent-400 hover:text-accent-300"
              : "text-slate-500 hover:text-white",
          )}
        >
          Remind {row.pendingCount} pending
          <ArrowRight className="size-3" aria-hidden />
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// row menu
// ---------------------------------------------------------------------------

function RowMenu({
  row,
  onRemind,
  onExtend,
  onCancel,
}: {
  row: RfqRow;
  onRemind: () => void;
  onExtend: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onScroll = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow < 240 ? Math.max(8, rect.top - 240) : rect.bottom + 4;
    setPosition({ top, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-600 transition-colors hover:bg-ink-850 hover:text-white";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${row.rfqNumber}`}
        className="pointer-events-auto inline-flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close actions"
            onClick={close}
            className="fixed inset-0 z-[70] cursor-default"
          />
          <div
            role="menu"
            aria-label={`Actions for ${row.rfqNumber}`}
            style={{ top: position.top, right: position.right }}
            className="fixed z-[80] w-56 rounded-xl border border-ink-800 bg-ink-900 p-1.5 shadow-2xl"
          >
            {row.status === "DRAFT" ? (
              <>
                <Link
                  to="/app/rfqs/$rfqId"
                  params={{ rfqId: row.id }}
                  search={{ tab: "vendors" }}
                  onClick={close}
                  role="menuitem"
                  className={itemClass}
                >
                  <ArrowRight className="size-3.5" aria-hidden />
                  Choose vendors
                </Link>
                <Link
                  to="/app/rfqs/$rfqId/edit"
                  params={{ rfqId: row.id }}
                  onClick={close}
                  role="menuitem"
                  className={itemClass}
                >
                  <Pencil className="size-3.5" aria-hidden />
                  Edit draft
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onCancel();
                  }}
                  className={itemClass}
                >
                  <Ban className="size-3.5" aria-hidden />
                  Cancel RFQ
                </button>
              </>
            ) : row.status === "SENT" ? (
              <>
                {row.pendingCount > 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close();
                      onRemind();
                    }}
                    className={itemClass}
                  >
                    <Bell className="size-3.5" aria-hidden />
                    Remind {row.pendingCount} pending
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onExtend();
                  }}
                  className={itemClass}
                >
                  <CalendarClock className="size-3.5" aria-hidden />
                  Extend deadline
                </button>
                {quoteCount(row) ? (
                  <Link
                    to="/app/rfqs/$rfqId"
                    params={{ rfqId: row.id }}
                    search={{ tab: "quotations" }}
                    onClick={close}
                    role="menuitem"
                    className={itemClass}
                  >
                    <Check className="size-3.5" aria-hidden />
                    Compare quotes
                  </Link>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onCancel();
                  }}
                  className={itemClass}
                >
                  <Ban className="size-3.5" aria-hidden />
                  Cancel RFQ
                </button>
              </>
            ) : (
              <Link
                to="/app/rfqs/$rfqId"
                params={{ rfqId: row.id }}
                onClick={close}
                role="menuitem"
                className={itemClass}
              >
                <ArrowUpRight className="size-3.5" aria-hidden />
                Open full page
              </Link>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-[1px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md rounded-2xl border border-ink-800 bg-ink-900 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold text-white">{title}</h2>
            {description ? (
              <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function ExtendDialog({
  rows,
  busy,
  onClose,
  onSubmit,
}: {
  rows: RfqRow[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (deadline: string, reason: string) => void;
}) {
  const [deadline, setDeadline] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    date.setHours(18, 0, 0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  const [reason, setReason] = useState("");

  const valid = deadline !== "" && new Date(deadline).getTime() > Date.now();

  return (
    <Dialog
      title={
        rows.length === 1 ? `Extend ${rows[0]?.rfqNumber ?? "RFQ"}` : `Extend ${rows.length} RFQs`
      }
      description="Pending recipients are emailed the new deadline. Only a later date is accepted — to move a deadline earlier, cancel instead."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSubmit(deadline, reason);
        }}
        className="space-y-3"
      >
        <div>
          <label htmlFor="extend-deadline" className="field-label">
            New deadline
          </label>
          <input
            id="extend-deadline"
            type="datetime-local"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
            className="field-input"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="extend-reason" className="field-label">
            Reason <span className="font-normal text-slate-500">(included in the email)</span>
          </label>
          <input
            id="extend-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="field-input"
          />
        </div>
        {rows.length > 1 ? (
          <p className="text-[12px] text-slate-500">
            {rows.map((row) => row.rfqNumber).join(", ")}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Spinner /> : null}
            Extend and notify
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({
  rows,
  duplicates,
  busy,
  onClose,
  onSubmit,
}: {
  rows: RfqRow[];
  duplicates: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState(
    duplicates ? "Duplicate RFQ for the same enquiry line." : "",
  );

  return (
    <Dialog
      title={
        duplicates
          ? `Cancel ${rows.length} duplicate ${rows.length === 1 ? "draft" : "drafts"}`
          : rows.length === 1
            ? `Cancel ${rows[0]?.rfqNumber ?? "RFQ"}`
            : `Cancel ${rows.length} RFQs`
      }
      description="This emails every recipient who has not yet declined. It is recorded and cannot be undone."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(reason);
        }}
        className="space-y-3"
      >
        <div className="max-h-36 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
          <ul className="space-y-1 text-[13px] text-slate-600">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[12px] text-slate-500">{row.rfqNumber}</span>
                <span className="truncate text-slate-500">
                  {row.enquiryNo}/{row.lineNo}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <label htmlFor="cancel-reason" className="field-label">
            Reason
          </label>
          <textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="field-input resize-y"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
          >
            Keep {rows.length === 1 ? "it" : "them"}
          </button>
          <button
            type="submit"
            disabled={reason.trim().length < 3 || busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Spinner /> : null}
            Cancel {rows.length === 1 ? "this RFQ" : `${rows.length} RFQs`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows = [
    { keys: "/", label: "Search" },
    { keys: "j / k", label: "Next / previous row" },
    { keys: "↑ / ↓", label: "Move within the list" },
    { keys: "Enter", label: "Open the preview" },
    { keys: "x", label: "Select or unselect" },
    { keys: "Esc", label: "Close the preview or dialog" },
    { keys: "?", label: "This list" },
  ];

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="divide-y divide-ink-800">
        {rows.map((row) => (
          <div key={row.keys} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-[13px] text-slate-500">{row.label}</dt>
            <dd>
              <kbd className="rounded border border-ink-800 bg-ink-850 px-1.5 py-0.5 font-mono text-[12px] text-slate-600">
                {row.keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
      >
        Close
      </button>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function RowSkeleton() {
  return (
    <div className={cn(SKELETON_GRID, "py-3.5")} aria-hidden>
      <Skeleton className="size-3.5" />
      <div className="min-w-0 space-y-1.5">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-3.5 w-44" />
        <Skeleton className="h-2.5 w-36" />
      </div>
      <div className="hidden space-y-1.5 md:block">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-2.5 w-24" />
      </div>
      <div className="hidden space-y-1.5 md:block">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="hidden space-y-1.5 md:block">
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="hidden md:block">
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="hidden xl:block">
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// exports kept for the detail screen
// ---------------------------------------------------------------------------

/** Shared with the detail screen so a delivery state is coloured the same way. */
export function DeliveryBadge({ status }: { status: string }) {
  return (
    <Badge tone={status === "FAILED" ? "red" : status === "SENT" ? "emerald" : "amber"}>
      {DELIVERY_LABELS[status as "SENT" | "FAILED" | "QUEUED"] ?? status}
    </Badge>
  );
}

export {
  RFQ_STATUS_LABELS,
  deadlineCountdown,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  statusTone,
};
export type { MessageChannel };

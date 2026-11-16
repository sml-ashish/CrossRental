import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { formatInr, listVendorRfqs, type VendorInboxRow } from "@/lib/quotations";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";

/**
 * The vendor's RFQ inbox (brief 7.6).
 *
 * The server decides which RFQs exist — one recipient row per enquiry SML
 * actually sent this vendor — and this page fetches that list once. Tabs,
 * counts, search and sort are all derived here, so moving between views is
 * instant and the counts can never disagree with each other.
 *
 * The view lives in the URL: `?response=` selects the tab and `?q=` the search
 * term, so Back from an RFQ returns to the list the vendor left and a filtered
 * list can be bookmarked. The server still governs visibility; the URL only
 * decides which rows are shown.
 *
 * Nothing here may reveal the end customer, the site address, the rental budget
 * or the Sales Partner — `VendorInboxRow` does not carry those fields, so the
 * page cannot print them even by accident.
 */

type Tab = "to-quote" | "quoted" | "closed" | "declined" | "all";
type Bucket = Exclude<Tab, "all">;
type SortKey = "closing" | "newest" | "biggest";
type Group = "soon" | "week" | "later";

type InboxSearch = { response?: string; q?: string; delivery?: "FAILED" };

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "to-quote", label: "To quote" },
  { value: "quoted", label: "Quoted" },
  { value: "closed", label: "Closed" },
  { value: "declined", label: "Declined" },
  { value: "all", label: "All" },
];

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: "closing", label: "Closing soonest" },
  { value: "newest", label: "Newest" },
  { value: "biggest", label: "Biggest crane" },
];

const GROUPS: Array<{ value: Group; label: string }> = [
  { value: "soon", label: "Closing soon" },
  { value: "week", label: "This week" },
  { value: "later", label: "Later" },
];

/** Old bookmarks used response statuses as tab values. */
const LEGACY_TABS: Record<string, Tab> = {
  PENDING: "to-quote",
  QUOTED: "quoted",
  FINALISED: "closed",
  EXPIRED: "closed",
  DECLINED: "declined",
  ALL: "all",
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function parseTab(value: unknown): Tab {
  if (typeof value !== "string") return "to-quote";
  if (TABS.some((tab) => tab.value === value)) return value as Tab;
  return LEGACY_TABS[value] ?? "to-quote";
}

/**
 * One row, one tab. A closed RFQ can never be counted as live: terminal
 * statuses, a passed deadline and a server refusal all win over anything else.
 * A part-quoted job belongs to Quoted, where it keeps its "quote the other
 * crane" action.
 */
function tabOf(row: VendorInboxRow): Bucket {
  if (row.responseStatus === "DECLINED") return "declined";
  if (
    row.responseStatus === "FINALISED" ||
    row.responseStatus === "EXPIRED" ||
    row.overdue
  ) {
    return "closed";
  }
  if (row.responseStatus === "QUOTED") return "quoted";
  if (row.quotationCount > 0) return "quoted";
  return row.canRespond ? "to-quote" : "closed";
}

/** Where a live row sits inside the To quote tab. */
function groupOf(row: VendorInboxRow, now: number): Group {
  const diff = deadlineValue(row) - now;
  if (diff < 48 * HOUR) return "soon";
  if (diff <= 7 * DAY) return "week";
  return "later";
}

function deadlineValue(row: VendorInboxRow): number {
  const value = new Date(row.submissionDeadline).getTime();
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function compareRows(a: VendorInboxRow, b: VendorInboxRow, sort: SortKey): number {
  if (sort === "biggest") {
    return (
      b.capacityT - a.capacityT ||
      b.quantity - a.quantity ||
      deadlineValue(a) - deadlineValue(b)
    );
  }
  if (sort === "newest") {
    // Recipient rows carry no received-at timestamp; the RFQ number is the
    // closest stable proxy for arrival order. Deadlines break ties.
    const byNumber = b.rfqNumber.localeCompare(a.rfqNumber, undefined, { numeric: true });
    return byNumber !== 0 ? byNumber : deadlineValue(a) - deadlineValue(b);
  }
  return deadlineValue(a) - deadlineValue(b);
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function titleCase(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z'’-]*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/** "Pune, Maharashtra", without repeating a state already typed into the city. */
function placeOf(row: VendorInboxRow): string {
  const [cityPart] = row.siteLocation.split(",");
  const city = titleCase((cityPart ?? row.siteLocation).trim());
  const state = titleCase(row.siteStateName.trim());
  if (!city) return state;
  if (!state) return city;

  const key = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");
  if (key(city).endsWith(key(state))) return city;
  return `${city}, ${state}`;
}

function startLabel(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function startHasPassed(iso: string): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

function neededLine(row: VendorInboxRow): string {
  const duration = `${row.durationValue} ${
    row.durationUnit === "MONTHS" ? "month" : "day"
  }${row.durationValue === 1 ? "" : "s"}`;

  if (startHasPassed(row.requiredStartDate)) return "Start date has passed";
  const start = startLabel(row.requiredStartDate);
  return start ? `Needed from ${start} · ${duration}` : `Needed for ${duration}`;
}

/** "Wed 18 Nov, 9:05 am" — the deadline in the reader's local time. */
function formatExact(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "No deadline";

  const day = date
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(/,/g, "");
  const time = date
    .toLocaleTimeString("en-GB", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\u202f/g, " ")
    .toLowerCase();

  return `${day}, ${time}`;
}

function timeUntil(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return plural(minutes, "minute");

  const hours = Math.round(ms / HOUR);
  if (hours < 24) return plural(hours, "hour");

  const days = Math.round(ms / DAY);
  if (days < 60) return plural(days, "day");

  return plural(Math.round(days / 30), "month");
}

function timeAgo(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;

  const hours = Math.floor(ms / HOUR);
  if (hours < 24) return `${plural(hours, "hour")} ago`;

  const days = Math.floor(ms / DAY);
  if (days < 60) return `${plural(days, "day")} ago`;

  return `${plural(Math.floor(days / 30), "month")} ago`;
}

function countdownFor(
  row: VendorInboxRow,
  now: number,
  closed: boolean,
): { text: string; tone: "closed" | "soon" | "normal" } {
  const deadline = new Date(row.submissionDeadline).getTime();
  if (Number.isNaN(deadline)) {
    return { text: closed ? "Closed" : "No deadline", tone: closed ? "closed" : "normal" };
  }

  const diff = deadline - now;
  if (diff <= 0) return { text: `Closed ${timeAgo(-diff)}`, tone: "closed" };
  if (closed) return { text: "Closed", tone: "closed" };

  return {
    text: `Closes in ${timeUntil(diff)}`,
    tone: diff < 48 * HOUR ? "soon" : "normal",
  };
}

function quoteLine(row: VendorInboxRow, bucket: Bucket): string {
  if (bucket === "declined") return "You declined this job";
  if (bucket === "closed") return "Closed. You can no longer quote.";
  if (row.quotationCount === 0) return "No quote yet";

  const amount =
    row.latestQuotationTotal !== null ? formatInr(row.latestQuotationTotal, 0) : null;

  if (row.quotationCount < row.quantity) {
    const cranes = row.quantity === 1 ? "crane" : "cranes";
    return `You quoted ${row.quotationCount} of ${row.quantity} ${cranes}${
      amount ? ` · ${amount}` : ""
    }`;
  }

  return amount ? `Quoted · ${amount}` : "Quoted";
}

function primaryLabel(row: VendorInboxRow): string {
  if (row.quotationCount === 0) return "Send quote";
  if (row.quotationCount < row.quantity) return "Quote the other crane";
  return "Edit quote";
}

function emptyMessage(tab: Tab): string {
  switch (tab) {
    case "to-quote":
      return "You're all caught up. New RFQs from SML appear here.";
    case "quoted":
      return "No quotes sent yet. Jobs you quote appear here.";
    case "closed":
      return "No closed RFQs yet.";
    case "declined":
      return "You haven't declined any jobs.";
    default:
      return "Nothing has been sent to your company yet.";
  }
}

export function VendorRfqIndexPage() {
  const routeSearch = useSearch({ strict: false }) as InboxSearch;
  const navigate = useNavigate();

  // An unrecognised ?response= (a hand-edited URL, an old bookmark) falls back
  // to To quote rather than rendering an empty screen for a tab that no longer
  // exists.
  const tab = parseTab(routeSearch.response);
  const search = routeSearch.q?.trim() ?? "";

  const [searchInput, setSearchInput] = useState(search);
  const [sort, setSort] = useState<SortKey>("closing");

  // One live field: typing settles into the URL after 250 ms, and the fetch
  // below is never repeated for a search.
  useEffect(() => {
    const nextQuery = searchInput.trim();
    if (nextQuery === search) return;

    const timer = window.setTimeout(() => {
      void navigate({
        to: "/app/rfqs",
        replace: true,
        search: {
          delivery: routeSearch.delivery,
          response: tab === "to-quote" ? undefined : tab,
          q: nextQuery || undefined,
        },
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchInput, search, tab, routeSearch.delivery, navigate]);

  // Clear, Back and a hand-edited URL all change ?q=; mirror that into the
  // field. Only react to the URL changing, or each keystroke would be erased.
  useEffect(() => {
    setSearchInput((current) => (current.trim() === search ? current : search));
  }, [search]);

  const rfqs = useQuery({
    queryKey: ["vendor-rfqs", "inbox"],
    queryFn: () => listVendorRfqs({}),
  });

  const rows = rfqs.data?.rfqs ?? [];

  const counts = useMemo(() => {
    const next: Record<Bucket, number> = {
      "to-quote": 0,
      quoted: 0,
      closed: 0,
      declined: 0,
    };
    for (const row of rows) next[tabOf(row)] += 1;
    return next;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.toLowerCase();
    return rows
      .filter((row) => {
        if (tab !== "all" && tabOf(row) !== tab) return false;
        if (!needle) return true;
        return [row.rfqNumber, row.siteLocation, row.siteStateName, row.craneTypeName].some(
          (value) => value.toLowerCase().includes(needle),
        );
      })
      .sort((a, b) => compareRows(a, b, sort));
  }, [rows, tab, search, sort]);

  const now = Date.now();
  const grouped =
    tab === "to-quote"
      ? GROUPS.map((group) => ({
          ...group,
          rows: visible.filter((row) => groupOf(row, now) === group.value),
        })).filter((group) => group.rows.length > 0)
      : null;

  function changeTab(next: Tab) {
    void navigate({
      to: "/app/rfqs",
      replace: true,
      search: {
        delivery: routeSearch.delivery,
        response: next === "to-quote" ? undefined : next,
        q: search || undefined,
      },
    });
  }

  function clearSearch() {
    setSearchInput("");
    void navigate({
      to: "/app/rfqs",
      replace: true,
      search: {
        delivery: routeSearch.delivery,
        response: tab === "to-quote" ? undefined : tab,
      },
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6">
      <PageHeader title="My RFQs" description="Jobs SML has asked you to quote for." />

      <nav
        aria-label="RFQ views"
        className="mt-5 -mx-1 flex gap-6 overflow-x-auto border-b border-ink-800 px-1"
      >
        {TABS.map((option) => {
          const active = option.value === tab;
          const count = option.value === "all" ? rows.length : counts[option.value];

          return (
            <button
              key={option.value}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => changeTab(option.value)}
              className={cn(
                "shrink-0 border-b-2 pb-3 pt-2 text-[14px] leading-5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
                active
                  ? "-mb-px border-white text-white"
                  : "border-transparent text-slate-500 hover:text-slate-300",
              )}
            >
              {option.label}
              {rfqs.data ? (
                <span
                  className={cn(
                    "ml-1.5 text-[12px] tabular-nums",
                    active ? "text-slate-400" : "text-slate-600",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by RFQ number, city or crane type"
          label="Search my RFQs"
          className="w-full sm:max-w-sm"
        />

        <label className="flex items-center gap-2 text-[13px] text-slate-500">
          <span className="shrink-0">Sort</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="h-9 rounded-md border border-ink-800 bg-ink-900 px-2.5 text-[13px] text-slate-200 transition-colors hover:border-ink-700 focus:border-ink-700 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rfqs.isLoading ? (
        <RfqSkeletons />
      ) : rfqs.error ? (
        <div className="mt-8 border-t border-ink-800 pt-8">
          <p className="text-[14px] leading-5 text-slate-300">Could not load your RFQs.</p>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">
            {(rfqs.error as Error).message}
          </p>
          <button
            type="button"
            onClick={() => void rfqs.refetch()}
            className="btn-secondary mt-4 px-3 py-1.5 text-[13px]"
          >
            Retry
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-8 border-t border-ink-800 py-16">
          {search ? (
            <>
              <p className="text-[14px] leading-5 text-slate-300">
                No RFQs match “{search}”
              </p>
              <button
                type="button"
                onClick={clearSearch}
                className="mt-4 rounded-sm text-[13px] font-medium text-slate-400 underline underline-offset-2 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                Clear
              </button>
            </>
          ) : (
            <p className="text-[14px] leading-5 text-slate-400">{emptyMessage(tab)}</p>
          )}
        </div>
      ) : grouped ? (
        <div>
          {grouped.map((group) => (
            <section key={group.value} className="mt-8 first:mt-6">
              <div className="flex items-baseline justify-between border-b border-ink-800 pb-2">
                <h2 className="text-[13px] leading-5 font-medium text-slate-300">
                  {group.label}
                </h2>
                <span className="text-[12px] tabular-nums text-slate-300">
                  {group.rows.length}
                </span>
              </div>
              <ul className="divide-y divide-ink-800">
                {group.rows.map((row) => (
                  <li key={row.recipientId}>
                    <RfqCard row={row} bucket={tabOf(row)} now={now} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-ink-800 border-t border-ink-800">
          {visible.map((row) => (
            <li key={row.recipientId}>
              <RfqCard row={row} bucket={tabOf(row)} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RfqCard({
  row,
  bucket,
  now,
}: {
  row: VendorInboxRow;
  bucket: Bucket;
  now: number;
}) {
  const closed = bucket === "closed";
  const countdown = countdownFor(row, now, closed);
  // `canRespond` is the server's answer for an unanswered enquiry, so a quoted
  // row reports false even while its deadline is open. Quoted and To quote are
  // therefore the live tabs; only Closed and Declined lose the action.
  const live = bucket === "to-quote" || bucket === "quoted";

  return (
    <article className="grid gap-x-8 gap-y-4 py-6 min-[900px]:grid-cols-[minmax(0,1fr)_220px]">
      <div className="min-w-0">
        <p className="text-[14px] leading-5 font-medium text-white">
          {row.craneTypeName} · {row.capacityT} t × {row.quantity}
        </p>
        <p className="mt-1.5 text-[14px] leading-5 text-slate-400">{placeOf(row)}</p>
        <p className="mt-0.5 text-[14px] leading-5 text-slate-400">{neededLine(row)}</p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4 text-slate-500">
          <span>{row.rfqNumber}</span>
          {row.unread ? (
            <span className="text-[12px] leading-4 font-medium text-accent-400">New</span>
          ) : null}
          {row.reminderCount > 0 ? (
            <span className="text-slate-400">
              SML sent {row.reminderCount} reminder
              {row.reminderCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <p className="mt-3 text-[13px] leading-5 text-slate-400">
          {quoteLine(row, bucket)}
        </p>
      </div>

      <div className="flex flex-col gap-3 min-[900px]:items-end">
        <div className="min-[900px]:text-right">
          <p
            className={cn(
              "text-[15px] leading-5 font-semibold",
              countdown.tone === "closed"
                ? "text-red-400"
                : countdown.tone === "soon"
                  ? "text-amber-400"
                  : "text-white",
            )}
          >
            {countdown.text}
          </p>
          <p className="mt-0.5 text-[12px] leading-4 text-slate-500">
            {formatExact(row.submissionDeadline)}
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 min-[900px]:w-auto min-[900px]:items-end">
          {live ? (
            <>
              <Link
                to="/app/rfqs/$rfqId"
                params={{ rfqId: row.rfqId }}
                className="btn-primary w-full justify-center px-4 py-2 text-[13px] min-[900px]:w-auto"
              >
                {primaryLabel(row)}
              </Link>
              <Link
                to="/app/rfqs/$rfqId"
                params={{ rfqId: row.rfqId }}
                className="rounded-sm text-center text-[13px] text-slate-500 underline underline-offset-2 transition-colors hover:text-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                Can't do this
              </Link>
            </>
          ) : (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: row.rfqId }}
              className="rounded-sm text-[13px] font-medium text-slate-300 underline underline-offset-2 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 min-[900px]:text-right"
            >
              View
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function RfqSkeletons() {
  return (
    <div aria-hidden className="mt-6 divide-y divide-ink-800 border-t border-ink-800">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="grid gap-x-8 gap-y-4 py-6 min-[900px]:grid-cols-[minmax(0,1fr)_220px]"
        >
          <div className="space-y-2.5">
            <Skeleton className="h-4 w-52 max-w-full" />
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

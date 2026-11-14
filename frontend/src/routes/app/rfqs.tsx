import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Plus, RotateCcw, Search, X } from "lucide-react";
import {
  DELIVERY_LABELS,
  RFQ_STATUS_LABELS,
  ROLLUPE_STATUS_LABELS,
  listRfqs,
  type RfqListRow,
  type RfqStatus,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { cityOf, craneTypeLabel, titleCase } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { VendorRfqIndexPage } from "@/routes/app/vendor-rfqs";

/**
 * Internal RFQ tracking (brief 7.9).
 *
 * Sales users create, send and chase; admins can view and track all RFQs but do
 * not get the create button, which mirrors the capability table — though the
 * backend refuses the call either way.
 *
 * The vendor's own RFQ inbox is a different audience reading a different entity
 * (their recipient row, not the RFQ) behind a different endpoint, so the vendor
 * branch hands off to `vendor-rfqs.tsx` rather than sharing this screen's queries.
 * The path is shared so a link to `/app/rfqs` is valid for both audiences.
 *
 * This screen is a queue, not a report. Three things change what a person does
 * next — a deadline that has passed, a reply nobody has given, an email that
 * never arrived — so those are the only things said in colour. Everything else
 * is the reference material you need to make the call.
 */

const STATUS_TABS: Array<{ value: RfqStatus | "ALL"; label: string }> = [
  { value: "SENT", label: "Sent" },
  { value: "DRAFT", label: "Drafts" },
  { value: "CLOSED", label: "Finalised" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

/** Status is a dot and a word here too, never a bordered pill. */
export function statusTone(status: RfqStatus): { dot: string; text: string } {
  switch (status) {
    case "CLOSED":
      return { dot: "bg-emerald-500", text: "text-emerald-600" };
    case "CANCELLED":
      return { dot: "bg-slate-500", text: "text-slate-500" };
    case "DRAFT":
      return { dot: "bg-amber-500", text: "text-amber-600" };
    default:
      return { dot: "bg-blue-500", text: "text-blue-600" };
  }
}

function durationLabel(value: number, unit: RfqListRow["durationUnit"]): string {
  const word = unit === "MONTHS" ? "month" : "day";
  return `${value} ${value === 1 ? word : `${word}s`}`;
}

export function RfqIndexPage() {
  const { user } = useAuth();

  if (user?.role === "vendor_user") {
    return <VendorRfqIndexPage />;
  }
  return <RfqTrackingPage canCreate={user?.role === "sales_user"} />;
}

export function RfqTrackingPage({ canCreate }: { canCreate: boolean }) {
  const [status, setStatus] = useState<RfqStatus | "ALL">("SENT");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [awaitingOnly, setAwaitingOnly] = useState(false);

  // The admin dashboard links here with ?delivery=FAILED, so the counter lands
  // on the rows that need chasing.
  const routeSearch = useSearch({ strict: false }) as { delivery?: string };
  const deliveryFailed = routeSearch.delivery === "FAILED";

  const rfqs = useQuery({
    queryKey: ["rfqs", status, search, awaitingOnly, deliveryFailed],
    queryFn: () =>
      listRfqs({
        // A failed delivery can sit on a sent, closed or cancelled RFQ, so the
        // filter widens the status set rather than hiding behind the default tab.
        ...(deliveryFailed || status === "ALL" ? {} : { status }),
        ...(search ? { search } : {}),
        ...(awaitingOnly ? { awaitingResponse: true } : {}),
      }),
  });

  const allRows = rfqs.data?.rfqs ?? [];
  const rows = deliveryFailed ? allRows.filter((r) => r.failedCount > 0) : allRows;

  // Counted from the rows on screen, so the line above the list can never
  // disagree with the list itself.
  const overdue = rows.filter(
    (row) => deadlineCountdown(row.submissionDeadline, row.status).tone === "overdue",
  ).length;
  const unanswered = rows.filter(
    (row) => row.status === "SENT" && row.pendingCount > 0,
  ).length;
  const failedDeliveries = rows.filter((row) => row.failedCount > 0).length;

  const activeView = STATUS_TABS.find((tab) => tab.value === status)?.label ?? "All";

  return (
    <div className="theme-dark -mx-4 -my-6 flex h-[calc(100dvh-49px)] flex-col overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6">
      <div className="shrink-0 px-4 pt-5 sm:px-8">
        <div className="w-full max-w-[1180px]">
          <p className="text-[13px] text-slate-500">RFQ tracking</p>

          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-white">
              What&rsquo;s out with vendors?
            </h1>
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

          <p className="mt-2 max-w-[720px] text-[13px] leading-relaxed text-slate-500">
            One crane requirement, sent to a shortlist. The customer, the site address and the
            budget never leave the building.
          </p>

          {/* Only the exceptions: what is late, what is unanswered, what never
              arrived. A count that is zero is not news, so it is not shown. */}
          {overdue > 0 || unanswered > 0 || failedDeliveries > 0 ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] tabular-nums">
              {overdue > 0 ? (
                <span className="text-amber-600">
                  {overdue} past deadline
                </span>
              ) : null}
              {unanswered > 0 ? (
                <span className="text-slate-500">{unanswered} awaiting a reply</span>
              ) : null}
              {failedDeliveries > 0 ? (
                <span className="text-red-600">{failedDeliveries} delivery failed</span>
              ) : null}
            </p>
          ) : null}

          {/* search + the one filter that changes the question */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <form
              className="relative w-full max-w-[380px]"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchInput);
              }}
            >
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="RFQ number, enquiry number or site"
                aria-label="Search RFQs"
                className="field-input h-9 py-0 pr-16 pl-10 text-[13px]"
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
              <button type="submit" className="sr-only">
                Search
              </button>
            </form>

            <button
              type="button"
              aria-pressed={awaitingOnly}
              onClick={() => setAwaitingOnly((value) => !value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                awaitingOnly
                  ? "bg-ink-850 text-white"
                  : "text-slate-500 hover:bg-ink-900 hover:text-white",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  awaitingOnly ? "bg-accent-500" : "bg-ink-700",
                )}
              />
              Awaiting a reply only
            </button>

            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                }}
                className="inline-flex items-center gap-1 text-[13px] text-slate-500 transition-colors hover:text-white"
              >
                Clear
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex items-end justify-between gap-4 border-b border-ink-800">
            <div
              role="tablist"
              aria-label="RFQ status"
              className="flex min-w-0 gap-5 overflow-x-auto"
            >
              {STATUS_TABS.map((tab) => {
                const active = status === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setStatus(tab.value)}
                    className={cn(
                      "-mb-px shrink-0 border-b-2 pb-2.5 text-[13px] whitespace-nowrap transition-colors duration-150",
                      active
                        ? "border-accent-500 font-medium text-white"
                        : "border-transparent text-slate-500 hover:text-white",
                    )}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <span className="hidden shrink-0 pb-2.5 text-[12px] text-slate-500 tabular-nums sm:block">
              {rows.length} shown
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[1180px] px-4 pb-6 sm:px-8">
          {deliveryFailed ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 bg-ink-900 px-4 py-2.5 text-[13px] text-amber-600">
              <span>Showing only RFQs with a failed email delivery.</span>
              <Link
                to="/app/rfqs"
                search={{ delivery: undefined }}
                className="font-medium text-slate-600 underline decoration-ink-700 underline-offset-4 hover:text-white"
              >
                Clear
              </Link>
            </div>
          ) : null}

          {rfqs.isPending ? (
            <>
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </>
          ) : rfqs.error ? (
            <div className="mt-6">
              <Alert tone="error">
                {(rfqs.error as Error).message || "Could not load the RFQ list."}
              </Alert>
              <button
                type="button"
                onClick={() => void rfqs.refetch()}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
              >
                <RotateCcw className="size-4" aria-hidden />
                Retry
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-24 text-center">
              <FileText className="size-6 text-slate-600" aria-hidden />
              <p className="mt-3 text-[15px] font-medium text-white">
                {deliveryFailed ? "No failed deliveries" : "No RFQs in this view"}
              </p>
              <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-slate-500">
                {deliveryFailed
                  ? "Every email sent from this queue reached the vendor."
                  : "Raise an RFQ from an enquiry line to start sourcing a crane."}
              </p>
              {search || awaitingOnly ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setSearchInput("");
                    setAwaitingOnly(false);
                  }}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-4 py-2 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="mt-5 divide-y divide-ink-800 border-y border-ink-800">
                {rows.map((row) => (
                  <RfqRow key={row.id} rfq={row} />
                ))}
              </div>

              <div className="flex items-center justify-between gap-4 border-t border-ink-800 py-3 text-[12px] text-slate-500 tabular-nums">
                <span>
                  {rows.length} {rows.length === 1 ? "RFQ" : "RFQs"}
                  {status === "ALL" ? "" : ` · ${activeView}`}
                </span>
                <span>Soonest deadline first</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RfqRow({ rfq }: { rfq: RfqListRow }) {
  const countdown = deadlineCountdown(rfq.submissionDeadline, rfq.status);
  const tone = statusTone(rfq.status);
  // The city is taken from the first comma segment, so the state is always
  // safe to append: "Vadodara, Gujarat" and "pune" both end up reading the same.
  const site = rfq.siteState ? `${cityOf(rfq)}, ${titleCase(rfq.siteState.name)}` : cityOf(rfq);
  const quoted = Math.min(rfq.quotedCount, Math.max(rfq.recipientCount, 1));
  const failed = Math.min(rfq.failedCount, Math.max(rfq.recipientCount - quoted, 0));

  return (
    <div className="group relative transition-colors duration-150 hover:bg-ink-850/60 motion-reduce:transition-none">
      <Link
        to="/app/rfqs/$rfqId"
        params={{ rfqId: rfq.id }}
        aria-label={`${rfq.rfqNumber} · ${craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)}`}
        className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
      />

      {/* Below 1280 the five fixed tracks would squeeze the identity column to
          nothing, so the row folds to two pairs of lines first. */}
      <div className="pointer-events-none relative grid grid-cols-1 gap-x-6 gap-y-2 py-3 pr-3 pl-3 sm:pl-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.85fr)] md:items-start xl:grid-cols-[minmax(0,1fr)_190px_190px_170px_140px] xl:items-center">
        <div className="min-w-0 md:col-span-4 md:row-start-1 xl:col-span-1 xl:col-start-1">
          <p className="font-mono text-[12px] leading-tight text-slate-500">{rfq.rfqNumber}</p>
          <p
            className="mt-0.5 truncate text-[15px] leading-tight font-semibold text-white"
            title={`${rfq.craneTypeRef?.name ?? rfq.craneType} · ${rfq.capacityT} t`}
          >
            {craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} ·{" "}
            <span className="tabular-nums">{rfq.capacityT} t</span>
          </p>
          <p className="truncate font-mono text-[12px] leading-tight text-slate-500">
            {rfq.enquiryNo}/{rfq.lineNo}
            <span className="font-sans tabular-nums"> · qty {rfq.quantity}</span>
          </p>
        </div>

        <div className="min-w-0 text-[13px] leading-tight md:col-start-1 md:row-start-2 xl:col-start-2 xl:row-start-1">
          <p className="truncate text-slate-600" title={rfq.siteLocation}>
            {site}
          </p>
          {rfq.siteLocationUnverified ? (
            <p className="mt-0.5 text-[12px] text-amber-600">Location unverified</p>
          ) : rfq.sitePincode ? (
            <p className="mt-0.5 text-[12px] text-slate-500 tabular-nums">{rfq.sitePincode}</p>
          ) : null}
        </div>

        <div className="min-w-0 md:col-start-2 md:row-start-2 xl:col-start-3 xl:row-start-1">
          <p className="text-[13px] leading-tight text-slate-600 tabular-nums">
            <span className="text-slate-500">Due</span>{" "}
            {formatDeadline(rfq.submissionDeadline)}
          </p>
          {/* Only a sent RFQ is racing a clock. For a draft, a finalised or a
              cancelled one the status column already says why time stopped
              mattering, so saying it twice is noise. */}
          {rfq.status === "SENT" ? (
            <p
              className={cn(
                "mt-0.5 text-[12px] leading-tight",
                countdown.tone === "overdue"
                  ? "font-medium text-red-600"
                  : countdown.tone === "soon"
                    ? "font-medium text-amber-600"
                    : "text-slate-500",
              )}
            >
              {countdown.label}
            </p>
          ) : null}
          <p className="mt-0.5 text-[12px] leading-tight text-slate-500 tabular-nums">
            Starts {formatStart(rfq.requiredStartDate)} ·{" "}
            {durationLabel(rfq.durationValue, rfq.durationUnit)}
          </p>
        </div>

        <div className="min-w-0 md:col-start-3 md:row-start-2 xl:col-start-4 xl:row-start-1">
          {rfq.recipientCount === 0 ? (
            <p className="text-[12px] leading-tight text-slate-500">No vendors yet</p>
          ) : (
            <>
              <div
                role="img"
                aria-label={`${rfq.quotedCount} of ${rfq.recipientCount} vendors quoted`}
                className="flex h-1 w-full gap-0.5 overflow-hidden rounded-full bg-ink-800"
              >
                {Array.from({ length: rfq.recipientCount }).map((_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-full flex-1",
                      index < quoted
                        ? "bg-emerald-500"
                        : index < quoted + failed
                          ? "bg-red-500"
                          : "bg-ink-700",
                    )}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[12px] leading-tight text-slate-500 tabular-nums">
                {rfq.quotedCount} of {rfq.recipientCount} quoted
              </p>
              {rfq.failedCount > 0 ? (
                <p className="mt-0.5 text-[12px] leading-tight font-medium text-red-600">
                  {rfq.failedCount} delivery failed
                </p>
              ) : rfq.pendingCount > 0 ? (
                <p className="mt-0.5 text-[12px] leading-tight text-amber-600">
                  {rfq.pendingCount} pending
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 md:col-start-4 md:row-start-2 xl:col-start-5 xl:row-start-1">
          <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
          <div className="min-w-0">
            <p className={cn("truncate text-[13px] leading-tight font-medium", tone.text)}>
              {RFQ_STATUS_LABELS[rfq.status]}
            </p>
            {rfq.rollupStatus ? (
              <p className="mt-0.5 truncate text-[12px] leading-tight text-slate-500">
                {ROLLUPE_STATUS_LABELS[rfq.rollupStatus]}
              </p>
            ) : null}
          </div>
          <ArrowRight
            className="ml-auto size-4 shrink-0 text-slate-600 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-ink-800 py-4 md:grid-cols-4 xl:grid-cols-[minmax(0,1fr)_190px_190px_170px_140px] xl:items-center">
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none md:col-span-4 xl:col-span-1">
        <div className="h-2.5 w-24 rounded bg-ink-800" />
        <div className="h-3.5 w-44 rounded bg-ink-800" />
        <div className="h-2.5 w-32 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-3 w-28 rounded bg-ink-800" />
        <div className="h-2.5 w-20 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-3 w-32 rounded bg-ink-800" />
        <div className="h-2.5 w-24 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse space-y-1.5 motion-reduce:animate-none">
        <div className="h-1 w-full rounded bg-ink-800" />
        <div className="h-2.5 w-24 rounded bg-ink-800" />
      </div>
      <div className="animate-pulse motion-reduce:animate-none">
        <div className="h-3 w-16 rounded bg-ink-800" />
      </div>
    </div>
  );
}

/** "20 Nov 2026" — a deadline is a moment, so the browser's zone is right. */
function formatDeadline(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A calendar date, printed as the UTC day it names (brief 6.4). */
function formatStart(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
      });
}

/**
 * How long is left on the deadline, and how loudly to say it.
 *
 * A sales user works a queue of these, so "overdue" and "under a day" are the
 * only two states that change what they do next. Everything else is neutral —
 * colouring every deadline would flatten the two that matter.
 */
export function deadlineCountdown(
  deadline: string,
  status: RfqStatus,
): { label: string; tone: "neutral" | "soon" | "overdue" } {
  if (status === "CANCELLED") return { label: "cancelled", tone: "neutral" };
  if (status === "CLOSED") return { label: "finalised", tone: "neutral" };
  if (status === "DRAFT") return { label: "not sent yet", tone: "neutral" };

  const ms = new Date(deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return { label: "—", tone: "neutral" };
  if (ms <= 0) return { label: "deadline passed", tone: "overdue" };

  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) {
    const whole = Math.max(1, Math.floor(hours));
    return { label: `${whole} hour${whole === 1 ? "" : "s"} left`, tone: "soon" };
  }
  const days = Math.floor(hours / 24);
  return { label: `${days} day${days === 1 ? "" : "s"} left`, tone: "neutral" };
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

/**
 * A calendar date, printed as the UTC day it names.
 *
 * Brief 6.4 anchors calendar dates (required start, quote validity, available
 * from) at UTC midnight so the stored date means the same thing everywhere.
 * Formatting that instant in the browser's own zone shifts it by a day for
 * anyone west of UTC — `2026-01-01T00:00:00Z` would print as 31 December, which
 * is a deadline stated wrongly. Only calendar dates belong here; a real moment in
 * time, such as a submission deadline, still uses `formatDateTime`.
 */
export function formatCalendarDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { timeZone: "UTC" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Shared with the detail screen so a delivery state is coloured the same way. */
export function DeliveryBadge({ status }: { status: string }) {
  return (
    <Badge
      tone={status === "FAILED" ? "red" : status === "SENT" ? "emerald" : "amber"}
    >
      {DELIVERY_LABELS[status as "SENT" | "FAILED" | "QUEUED"] ?? status}
    </Badge>
  );
}

export { RFQ_STATUS_LABELS };

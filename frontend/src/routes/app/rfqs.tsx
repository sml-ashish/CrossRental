import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import {
  DELIVERY_LABELS,
  RFQ_STATUS_LABELS,
  ROLLUPE_STATUS_LABELS,
  listRfqs,
  type RfqListRow,
  type RfqStatus,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { SearchInput, Toolbar } from "@/components/ui/toolbar";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
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
 */

const STATUS_TABS: Array<{ value: RfqStatus | "ALL"; label: string }> = [
  { value: "SENT", label: "Sent" },
  { value: "DRAFT", label: "Drafts" },
  { value: "CLOSED", label: "Finalised" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="RFQs"
        description="Crane enquiries sent to vendors against an enquiry line, and how each one is progressing."
        actions={
          canCreate ? (
            <Link to="/app/rfqs/new" className="btn-primary">
              <Plus className="size-4" aria-hidden />
              Raise RFQ
            </Link>
          ) : null
        }
      />

      <Toolbar>
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Status
          </p>
          <div className="mt-1 flex flex-wrap gap-1" role="tablist" aria-label="RFQ status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={status === tab.value}
                onClick={() => setStatus(tab.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  status === tab.value
                    ? "bg-ink-700 text-white"
                    : "border border-slate-200 bg-ink-850 text-slate-600 hover:bg-ink-800",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={awaitingOnly}
            onChange={(event) => setAwaitingOnly(event.target.checked)}
            className="size-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Awaiting a response only
        </label>
      </Toolbar>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput);
        }}
      >
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by RFQ number, enquiry number or site"
          label="Search RFQs"
          className="flex-1"
        />
        <button type="submit" className="btn-secondary">
          Search
        </button>
        {search ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setSearch("");
              setSearchInput("");
            }}
          >
            Clear
          </button>
        ) : null}
      </form>

      {deliveryFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span>Showing only RFQs with a failed email delivery.</span>
          <Link to="/app/rfqs" search={{ delivery: undefined }} className="font-medium underline">
            Clear
          </Link>
        </div>
      ) : null}

      {rfqs.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading RFQs
        </div>
      ) : rfqs.error ? (
        <Alert title="Could not load the RFQ list">{(rfqs.error as Error).message}</Alert>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Search className="size-4" aria-hidden />}
            title={deliveryFailed ? "No failed deliveries" : "No RFQs in this view"}
            description={
              deliveryFailed
                ? "Every email sent from this queue reached the vendor."
                : "Create an RFQ to start sourcing a crane for an enquiry."
            }
          />
        </div>
      ) : (
        <Panel bodyClassName="">
          <Table>
            <THead>
              <tr>
                <TH>RFQ</TH>
                <TH>Requirement</TH>
                <TH>Site</TH>
                <TH>Deployment</TH>
                <TH>Deadline</TH>
                <TH>Recipients</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <RfqRow key={row.id} rfq={row} />
              ))}
            </TBody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

function RfqRow({ rfq }: { rfq: RfqListRow }) {
  const countdown = deadlineCountdown(rfq.submissionDeadline, rfq.status);

  return (
    <TR className="align-top">
      <TD>
        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: rfq.id }}
          className="font-mono text-xs font-semibold text-brand-700 hover:underline"
        >
          {rfq.rfqNumber}
        </Link>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
          {rfq.enquiryNo}/{rfq.lineNo}
        </p>
      </TD>
      <TD>
        <p className="text-slate-900">{rfq.craneTypeRef?.name ?? rfq.craneType}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {rfq.capacityT} t · qty {rfq.quantity}
        </p>
      </TD>
      <TD>
        <p>{rfq.siteLocation}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {rfq.siteState?.name ?? rfq.siteStateCode}
          {rfq.siteLocationUnverified ? (
            <span className="ml-1.5 text-amber-600">location unverified</span>
          ) : null}
        </p>
      </TD>
      <TD className="text-xs">
        <p>{formatCalendarDate(rfq.requiredStartDate)}</p>
        <p className="text-[11px] text-slate-500">
          {rfq.durationValue} {rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}
        </p>
      </TD>
      <TD className="text-xs">
        <p>{formatDate(rfq.submissionDeadline)}</p>
        <p
          className={
            countdown.tone === "overdue"
              ? "mt-0.5 text-[11px] font-medium text-red-600"
              : countdown.tone === "soon"
                ? "mt-0.5 text-[11px] font-medium text-amber-600"
                : "mt-0.5 text-[11px] text-slate-500"
          }
        >
          {countdown.label}
        </p>
      </TD>
      <TD>
        <p className="text-xs">
          {rfq.quotedCount} of {rfq.recipientCount} quoted
        </p>
        {rfq.failedCount > 0 ? (
          <p className="mt-0.5 text-[11px] font-medium text-red-600">
            {rfq.failedCount} failed delivery
          </p>
        ) : null}
        {rfq.pendingCount > 0 ? (
          <p className="mt-0.5 text-[11px] text-amber-600">{rfq.pendingCount} pending</p>
        ) : null}
      </TD>
      <TD>
        <StatusBadge status={rfq.status} />
        {rfq.rollupStatus ? (
          <p className="mt-1 text-[11px] text-slate-500">
            {ROLLUPE_STATUS_LABELS[rfq.rollupStatus]}
          </p>
        ) : null}
      </TD>
    </TR>
  );
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

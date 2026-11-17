import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock, MapPin, Plus, Search, Truck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { listRfqs, type RfqListRow, type RfqStatus } from "@/lib/rfqs";
import {
  deadlineCountdown,
  durationLabel,
  formatDeadlineDate,
  formatStartShort,
  statusDisplay,
} from "@/lib/rfq-display";
import { cityOf, craneTypeLabel } from "@/lib/format";
import { VendorRfqIndexPage } from "@/routes/app/vendor-rfqs";

/**
 * RFQs, kept simple.
 *
 * One card per RFQ, and each card answers the same four questions: what is
 * needed (crane, capacity, quantity), where (site), when (start, duration) and
 * how it is going (status, replies, deadline). Everything else lives on the
 * detail screen. Vendors are reached by email only, so there is no channel
 * column to read.
 */

type Tab = RfqStatus | "ALL";

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "SENT", label: "Sent" },
  { value: "DRAFT", label: "Drafts" },
  { value: "CLOSED", label: "Finalised" },
  { value: "CANCELLED", label: "Cancelled" },
];

export function RfqIndexPage() {
  const { user } = useAuth();
  if (user?.role === "vendor_user") return <VendorRfqIndexPage />;
  return <RfqTrackingPage canCreate={user?.role === "sales_user"} />;
}

export function RfqTrackingPage({ canCreate }: { canCreate: boolean }) {
  const [tab, setTab] = useState<Tab>("ALL");
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["rfqs", "list"],
    queryFn: () => listRfqs({}),
  });

  const rows = query.data?.rfqs ?? [];

  const counts = useMemo(() => {
    const next: Record<Tab, number> = { ALL: rows.length, SENT: 0, DRAFT: 0, CLOSED: 0, CANCELLED: 0 };
    for (const row of rows) next[row.status] += 1;
    return next;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows
      .filter((row) => tab === "ALL" || row.status === tab)
      .filter(
        (row) =>
          !needle ||
          `${row.rfqNumber} ${row.enquiryNo} ${row.siteLocation} ${row.craneType}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [rows, tab, search]);

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">RFQs</h1>
        {canCreate ? (
          <Link
            to="/app/rfqs/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-[15px] font-semibold text-white hover:bg-brand-600"
          >
            <Plus className="size-4" aria-hidden />
            New RFQ
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="RFQ status">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-[15px] font-medium transition-colors",
                tab === item.value
                  ? "border-slate-900 bg-slate-900 text-slate-50"
                  : "border-slate-300 text-slate-700 hover:bg-slate-100",
              )}
            >
              {item.label} <span className="opacity-70">{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto block w-full sm:w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search RFQ, enquiry, site or crane"
            className="w-full rounded-lg border border-slate-300 bg-slate-100 py-2.5 pr-3 pl-9 text-[15px] text-slate-900 placeholder:text-slate-500 focus:outline-none"
          />
        </label>
      </div>

      {query.isError ? (
        <Alert tone="error" title="Could not load RFQs">
          <p>{query.error instanceof Error ? query.error.message : "Try again in a moment."}</p>
        </Alert>
      ) : query.isPending ? (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[132px] w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-12 text-center text-[16px] text-slate-600">
          {rows.length === 0 ? "No RFQs yet." : "No RFQs match."}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((row) => (
            <RfqCard key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RfqCard({ row }: { row: RfqListRow }) {
  const status = statusDisplay(row.status, row.rollupStatus);
  const countdown = deadlineCountdown(row.submissionDeadline, row.status);
  const capacity = `${row.capacityRule === "AT_LEAST" ? "≥ " : ""}${row.capacityT} t`;
  const replied = row.recipientCount - row.pendingCount;

  return (
    <li>
      <Link
        to="/app/rfqs/$rfqId"
        params={{ rfqId: row.id }}
        className="block rounded-xl border border-slate-200 bg-slate-100 p-5 transition-colors hover:border-slate-400"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[17px] font-semibold text-slate-900">
              {row.rfqNumber}
              <span className="ml-2 text-[15px] font-normal text-slate-600">
                {row.enquiryNo} / line {row.lineNo}
              </span>
            </p>
            <p className="mt-1 flex items-center gap-2 text-[16px] text-slate-800">
              <Truck className="size-4 shrink-0 text-slate-500" aria-hidden />
              {craneTypeLabel(row.craneTypeRef?.name ?? row.craneType)} · {capacity}
              {row.quantity > 1 ? ` · ${row.quantity} cranes` : ""}
            </p>
          </div>
          <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold", status.text)}>
            <span className={cn("size-2 rounded-full", status.dot)} aria-hidden />
            {status.label}
          </span>
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-2 text-[15px] text-slate-700 sm:grid-cols-3">
          <div className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0 text-slate-500" aria-hidden />
            <dd className="truncate">{cityOf(row)}{row.siteState ? `, ${row.siteState.name}` : ""}</dd>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays className="size-4 shrink-0 text-slate-500" aria-hidden />
            <dd>
              {row.startDateTbc ? "Start TBC" : `From ${formatStartShort(row.requiredStartDate)}`} ·{" "}
              {durationLabel(row.durationValue, row.durationUnit)}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="size-4 shrink-0 text-slate-500" aria-hidden />
            <dd className={cn(countdown.tone === "overdue" && "text-red-600", countdown.tone === "soon" && "text-amber-600")}>
              {row.status === "DRAFT"
                ? "Not sent yet"
                : `Due ${formatDeadlineDate(row.submissionDeadline)} · ${countdown.label}`}
            </dd>
          </div>
        </dl>

        {row.status !== "DRAFT" ? (
          <p className="mt-3 border-t border-slate-200 pt-3 text-[15px] text-slate-700">
            {row.recipientCount} vendor{row.recipientCount === 1 ? "" : "s"} emailed ·{" "}
            <span className="font-semibold text-slate-900">{replied} replied</span> ·{" "}
            {row.quotedCount} quote{row.quotedCount === 1 ? "" : "s"}
            {row.failedCount > 0 ? (
              <span className="font-semibold text-red-600"> · {row.failedCount} email failed</span>
            ) : null}
          </p>
        ) : null}
      </Link>
    </li>
  );
}

// Re-exported for the detail screen, which imports these from here.
export { RFQ_STATUS_LABELS } from "@/lib/rfqs";
export { deadlineCountdown, statusTone } from "@/lib/rfq-display";
export { formatCalendarDate, formatDate, formatDateTime } from "@/lib/format";


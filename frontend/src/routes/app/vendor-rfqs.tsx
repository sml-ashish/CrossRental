import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import {
  VENDOR_RESPONSE_LABELS,
  formatInr,
  listVendorRfqs,
  type VendorInboxRow,
  type VendorResponseStatus,
} from "@/lib/quotations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { deadlineCountdown, formatCalendarDate, formatDateTime } from "@/routes/app/rfqs";

/**
 * The vendor's RFQ inbox (brief 7.6, M5).
 *
 * A different list from the internal tracking screen, and deliberately so: this
 * one is built from the vendor's own recipient rows, so a row exists only where
 * SML actually sent that vendor an enquiry. There is no vendor-wide RFQ list to
 * accidentally widen — the server scopes by the token's vendor id and answers
 * 404 for anything else.
 *
 * **An overdue RFQ is shown, not hidden.** A vendor needs to see that a deadline
 * passed; being unable to act on it is a different fact, reported per row as
 * `overdue` and `canRespond` rather than by silently dropping the row.
 */

const RESPONSE_TABS: Array<{ value: VendorResponseStatus | "ALL"; label: string }> = [
  { value: "PENDING", label: "Awaiting your quote" },
  { value: "QUOTED", label: "Quoted" },
  { value: "DECLINED", label: "Declined" },
  { value: "EXPIRED", label: "Expired" },
  { value: "ALL", label: "All" },
];

export function VendorRfqIndexPage() {
  const [tab, setTab] = useState<VendorResponseStatus | "ALL">("PENDING");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const rfqs = useQuery({
    queryKey: ["vendor-rfqs", tab, search],
    queryFn: () =>
      listVendorRfqs({
        ...(tab === "ALL" ? {} : { responseStatus: tab }),
        ...(search ? { search } : {}),
      }),
  });

  const rows = rfqs.data?.rfqs ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">My RFQs</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Enquiries SML has sent you, and what you have quoted back.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {RESPONSE_TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setTab(option.value)}
            className={
              tab === option.value
                ? "rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-300"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput);
        }}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            className="field-input pl-9"
            placeholder="Search by RFQ number, enquiry number or site"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            aria-label="Search my RFQs"
          />
        </div>
        <button type="submit" className="btn-secondary px-4 text-sm">
          Search
        </button>
        {search ? (
          <button
            type="button"
            className="btn-secondary px-4 text-sm"
            onClick={() => {
              setSearch("");
              setSearchInput("");
            }}
          >
            Clear
          </button>
        ) : null}
      </form>

      {rfqs.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading your RFQs
        </div>
      ) : rfqs.error ? (
        <Alert title="Could not load your RFQs">{(rfqs.error as Error).message}</Alert>
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          {tab === "PENDING"
            ? "Nothing is waiting on a quote from you right now."
            : "No RFQs here."}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">RFQ</th>
                <th className="px-4 py-2.5 font-medium">Requirement</th>
                <th className="px-4 py-2.5 font-medium">Site</th>
                <th className="px-4 py-2.5 font-medium">Deployment</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
                <th className="px-4 py-2.5 font-medium">Your quote</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <VendorInboxRow key={row.recipientId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VendorInboxRow({ row }: { row: VendorInboxRow }) {
  // A vendor row has no internal RFQ status to hand the helper, and passing a
  // terminal one would flatten every row to "closed". Passing SENT lets it do
  // the real arithmetic, so a passed deadline reads as passed rather than as a
  // vague state.
  const countdown = deadlineCountdown(row.submissionDeadline, "SENT");

  return (
    <tr className="align-top hover:bg-slate-50/60">
      <td className="px-4 py-3">
        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: row.rfqId }}
          className="font-mono text-xs font-semibold text-brand-700 hover:underline"
        >
          {row.unread ? <span className="mr-1 text-brand-600" aria-label="Unread">●</span> : null}
          {row.rfqNumber}
        </Link>
      </td>
      <td className="px-4 py-3">
        <p className="text-slate-900">{row.craneTypeName}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {row.capacityT} t · qty {row.quantity}
        </p>
      </td>
      <td className="px-4 py-3">
        <p className="text-slate-700">{row.siteLocation}</p>
        <p className="mt-0.5 text-xs text-slate-500">{row.siteStateName}</p>
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">
        <p>{formatCalendarDate(row.requiredStartDate)}</p>
        <p className="text-slate-500">
          {row.durationValue} {row.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}
        </p>
      </td>
      <td className="px-4 py-3 text-xs">
        <p className="text-slate-700">{formatDateTime(row.submissionDeadline)}</p>
        <p
          className={
            countdown.tone === "overdue"
              ? "mt-0.5 font-medium text-red-600"
              : countdown.tone === "soon"
                ? "mt-0.5 font-medium text-amber-600"
                : "mt-0.5 text-slate-500"
          }
        >
          {countdown.label}
        </p>
      </td>
      <td className="px-4 py-3 text-xs">
        {row.quotationCount > 0 ? (
          <>
            <p className="font-medium text-slate-900">
              {formatInr(row.latestQuotationTotal)}
            </p>
            <p className="mt-0.5 text-slate-500">
              {row.quotationCount} crane{row.quotationCount === 1 ? "" : "s"} quoted
            </p>
          </>
        ) : (
          <p className="text-slate-400">Not quoted</p>
        )}
      </td>
      <td className="px-4 py-3">
        <Badge tone={responseTone(row.responseStatus)}>
          {VENDOR_RESPONSE_LABELS[row.responseStatus]}
        </Badge>
        {row.overdue && row.responseStatus === "PENDING" ? (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600">
            <AlertTriangle className="size-3" aria-hidden />
            Deadline passed
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function responseTone(status: VendorResponseStatus) {
  switch (status) {
    case "QUOTED":
      return "emerald" as const;
    case "DECLINED":
      return "neutral" as const;
    case "EXPIRED":
      return "red" as const;
    default:
      return "amber" as const;
  }
}
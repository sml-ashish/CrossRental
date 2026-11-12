import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox } from "lucide-react";
import {
  VENDOR_RESPONSE_LABELS,
  formatInr,
  listVendorRfqs,
  type VendorInboxRow,
  type VendorResponseStatus,
} from "@/lib/quotations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Segmented, SearchInput, Toolbar } from "@/components/ui/toolbar";
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
      <PageHeader
        title="My RFQs"
        description="Enquiries SML has sent you, and what you have quoted back."
        meta={
          rfqs.data ? (
            <span className="text-xs text-slate-500">
              {rows.length} RFQ{rows.length === 1 ? "" : "s"} in this view
            </span>
          ) : null
        }
      />

      <Toolbar>
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Response
          </p>
          <div className="mt-1">
            <Segmented
              value={tab}
              onChange={setTab}
              label="Response status"
              options={RESPONSE_TABS}
            />
          </div>
        </div>

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
            placeholder="RFQ number, enquiry number or site"
            label="Search my RFQs"
            className="w-64"
          />
          <button type="submit" className="btn-secondary py-[7px]">
            Search
          </button>
          {search ? (
            <button
              type="button"
              className="btn-secondary py-[7px]"
              onClick={() => {
                setSearch("");
                setSearchInput("");
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
      </Toolbar>

      {rfqs.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading your RFQs
        </div>
      ) : rfqs.error ? (
        <Alert title="Could not load your RFQs">{(rfqs.error as Error).message}</Alert>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Inbox className="size-4" aria-hidden />}
            title={tab === "PENDING" ? "Nothing waiting on a quote" : "No RFQs in this view"}
            description={
              tab === "PENDING"
                ? "New enquiries appear here the moment SML sends one to your company."
                : "Try another response status or clear the search."
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <Table className="min-w-[60rem]">
            <THead>
              <tr>
                <TH>RFQ</TH>
                <TH>Requirement</TH>
                <TH>Site</TH>
                <TH>Deployment</TH>
                <TH>Deadline</TH>
                <TH>Your quote</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <VendorInboxRow key={row.recipientId} row={row} />
              ))}
            </TBody>
          </Table>
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
    <TR className="align-top">
      <TD>
        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: row.rfqId }}
          className="font-mono text-xs font-semibold text-brand-700 hover:underline"
        >
          {row.unread ? <span className="mr-1 text-brand-600" aria-label="Unread">●</span> : null}
          {row.rfqNumber}
        </Link>
      </TD>
      <TD>
        <p className="text-slate-900">{row.craneTypeName}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {row.capacityT} t · qty {row.quantity}
        </p>
      </TD>
      <TD>
        <p className="text-slate-700">{row.siteLocation}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">{row.siteStateName}</p>
      </TD>
      <TD className="text-xs text-slate-600">
        <p>{formatCalendarDate(row.requiredStartDate)}</p>
        <p className="text-slate-500">
          {row.durationValue} {row.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}
        </p>
      </TD>
      <TD className="text-xs">
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
      </TD>
      <TD className="text-xs">
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
      </TD>
      <TD>
        <Badge tone={responseTone(row.responseStatus)}>
          {VENDOR_RESPONSE_LABELS[row.responseStatus]}
        </Badge>
        {row.overdue && row.responseStatus === "PENDING" ? (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600">
            <AlertTriangle className="size-3" aria-hidden />
            Deadline passed
          </p>
        ) : null}
      </TD>
    </TR>
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
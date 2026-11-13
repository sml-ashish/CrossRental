import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
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
 *
 * **The view lives in the URL.** Tab and search term are search params, not
 * component state, so Back from an RFQ returns to the tab the vendor left and a
 * filtered list can be bookmarked. The server still decides which rows exist;
 * the URL only decides which of them are shown.
 */

const RESPONSE_TABS: Array<{ value: VendorResponseStatus | "ALL"; label: string }> = [
  { value: "PENDING", label: "Awaiting quote" },
  { value: "QUOTED", label: "Quoted" },
  { value: "FINALISED", label: "Finalised" },
  { value: "DECLINED", label: "Declined" },
  { value: "EXPIRED", label: "Expired" },
  { value: "ALL", label: "All" },
];

type InboxSearch = { response?: string; q?: string; delivery?: "FAILED" };

function isResponseTab(value: unknown): value is VendorResponseStatus | "ALL" {
  return RESPONSE_TABS.some((tab) => tab.value === value);
}

export function VendorRfqIndexPage() {
  const routeSearch = useSearch({ strict: false }) as InboxSearch;
  const navigate = useNavigate();

  // An unrecognised ?response= (a hand-edited URL, an old bookmark) falls back
  // to the default tab rather than rendering an empty screen for a status the
  // filter no longer offers.
  const tab = isResponseTab(routeSearch.response) ? routeSearch.response : "PENDING";
  const search = routeSearch.q?.trim() ?? "";

  const [searchInput, setSearchInput] = useState(search);
  // The URL is the source of truth, so Clear — and any other navigation — has
  // to reach back into the input the vendor is typing in.
  useEffect(() => setSearchInput(search), [search]);

  const setView = (next: { response?: VendorResponseStatus | "ALL"; q?: string }) => {
    void navigate({
      to: "/app/rfqs",
      // Filter changes replace the history entry: Back should leave the list,
      // not walk back through every tab the vendor tried.
      replace: true,
      search: {
        delivery: routeSearch.delivery,
        // PENDING is the default, so it stays out of the URL.
        response: next.response && next.response !== "PENDING" ? next.response : undefined,
        q: next.q || undefined,
      },
    });
  };

  const rfqs = useQuery({
    queryKey: ["vendor-rfqs", tab, search],
    queryFn: () =>
      listVendorRfqs({
        ...(tab === "ALL" ? {} : { responseStatus: tab }),
        ...(search ? { search } : {}),
      }),
  });

  const rows = rfqs.data?.rfqs ?? [];
  const clearSearch = () => setView({ response: tab });

  return (
    <div className="space-y-5">
      <PageHeader
        title="My RFQs"
        description="Enquiries SML has sent you, and what you have quoted back."
        meta={
          rfqs.data ? (
            <span className="text-xs text-slate-500">
              {rows.length} RFQ{rows.length === 1 ? "" : "s"}
              {search ? ` matching “${search}”` : " in this view"}
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
              onChange={(next) => setView({ response: next, q: search })}
              label="Response status"
              options={RESPONSE_TABS}
            />
          </div>
        </div>

        <form
          className="flex w-full flex-wrap gap-2 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            setView({ response: tab, q: searchInput.trim() });
          }}
        >
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="RFQ number, enquiry number or site"
            label="Search my RFQs"
            className="w-full sm:w-64"
          />
          <button type="submit" className="btn-secondary shrink-0 py-[7px]">
            Search
          </button>
          {search ? (
            <button
              type="button"
              className="btn-secondary shrink-0 py-[7px]"
              onClick={clearSearch}
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
        <Alert title="Could not load your RFQs">
          <p>{(rfqs.error as Error).message}</p>
          <button
            type="button"
            className="btn-secondary mt-3 py-[7px]"
            onClick={() => void rfqs.refetch()}
          >
            Try again
          </button>
        </Alert>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Inbox className="size-4" aria-hidden />}
            title={
              tab === "PENDING"
                ? "Nothing waiting on a quote"
                : tab === "FINALISED"
                  ? "No finalised RFQs yet"
                  : "No RFQs in this view"
            }
            description={
              tab === "PENDING"
                ? "New enquiries appear here the moment SML sends one to your company."
                : tab === "FINALISED"
                  ? "RFQs SML finalised without a quote from you are kept here as a record."
                  : tab === "ALL"
                    ? "Nothing has been sent to your company yet."
                    : "Try another response status or clear the search."
            }
            action={
              search ? (
                <button type="button" className="btn-secondary py-[7px]" onClick={clearSearch}>
                  Clear search
                </button>
              ) : tab !== "ALL" ? (
                <button
                  type="button"
                  className="btn-secondary py-[7px]"
                  onClick={() => setView({ response: "ALL" })}
                >
                  View all RFQs
                </button>
              ) : null
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <Table className="min-w-[64rem]">
            <THead>
              <tr>
                <TH>RFQ</TH>
                <TH>Requirement</TH>
                <TH>Site</TH>
                <TH>Deployment</TH>
                {/* The server sorts by deadline, soonest first, so say so. */}
                <TH ariaSort="ascending">Deadline</TH>
                <TH align="right">Your quote</TH>
                <TH>Status</TH>
                <TH align="right">
                  <span className="sr-only">Action</span>
                </TH>
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
  //
  // A finalised row is the exception: its deadline is irrelevant because the RFQ
  // was closed by an award, so "3 days left" would invite a quote the server
  // would refuse.
  const countdown = deadlineCountdown(
    row.submissionDeadline,
    row.responseStatus === "FINALISED" ? "CLOSED" : "SENT",
  );

  // The expiry sweep runs on a schedule, so a PENDING row can sit past its
  // deadline for a while. "Awaiting your quote" next to "Deadline passed" is the
  // contradiction; this says what is true now, once.
  const lapsed = row.overdue && row.responseStatus === "PENDING";

  return (
    <TR className="align-top">
      <TD>
        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: row.rfqId }}
          className="font-mono text-xs font-semibold text-brand-700 hover:underline"
        >
          {row.unread ? (
            <>
              {/* The dot is a glyph, so it is hidden from assistive tech and the
                  word carries the meaning. `aria-label` on a bare span is not
                  reliably announced. */}
              <span className="mr-1 text-brand-600" aria-hidden>
                ●
              </span>
              <span className="sr-only">Unread </span>
            </>
          ) : null}
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
                ? // amber-600 is 3.2:1 on white — below the 4.5:1 floor for 12px
                  // text. amber-700 clears it at 5.0:1.
                  "mt-0.5 font-medium text-amber-700"
                : "mt-0.5 text-slate-500"
          }
        >
          {countdown.label}
        </p>
      </TD>
      <TD align="right" className="text-xs">
        {row.quotationCount > 0 ? (
          <>
            {/* Whole rupees: this column is scanned, not agreed. */}
            <p className="font-medium tabular-nums text-slate-900">
              {formatInr(row.latestQuotationTotal, 0)}
            </p>
            <p className="mt-0.5 text-slate-500">
              {row.quotationCount} crane{row.quotationCount === 1 ? "" : "s"} quoted
            </p>
          </>
        ) : (
          <p className="text-slate-500">Not quoted</p>
        )}
      </TD>
      <TD>
        <Badge tone={responseTone(row.responseStatus)} className="whitespace-nowrap">
          {VENDOR_RESPONSE_LABELS[row.responseStatus]}
        </Badge>
        {lapsed ? (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600">
            <AlertTriangle className="size-3" aria-hidden />
            No longer accepting quotes
          </p>
        ) : null}
      </TD>
      <TD align="right">
        {/* The inbox has one job — get the vendor to quote — so the row says
            what to do instead of hiding it behind an 11px link. */}
        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: row.rfqId }}
          className={
            row.canRespond
              ? "btn-primary px-3 py-1.5 text-xs"
              : "btn-secondary px-3 py-1.5 text-xs"
          }
        >
          {row.canRespond ? "Quote now" : "View"}
        </Link>
      </TD>
    </TR>
  );
}

function responseTone(status: VendorResponseStatus) {
  switch (status) {
    case "QUOTED":
      return "emerald" as const;
    case "DECLINED":
    case "FINALISED":
      return "neutral" as const;
    case "EXPIRED":
      return "red" as const;
    default:
      return "amber" as const;
  }
}

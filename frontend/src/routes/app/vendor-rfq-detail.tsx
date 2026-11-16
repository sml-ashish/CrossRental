import { useState, type CSSProperties } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, Send } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatCalendarDate } from "@/lib/format";
import {
  formatInr,
  getVendorRfq,
  type VendorQuotation,
  type VendorRfqDetail,
} from "@/lib/quotations";
import { DeclineDialog } from "./vendor-rfq-detail/decline-dialog";
import { GlanceStrip } from "./vendor-rfq-detail/glance-strip";
import { QuotePanel } from "./vendor-rfq-detail/quote-panel";
import { QuotesList } from "./vendor-rfq-detail/quotes-list";
import { Requirement } from "./vendor-rfq-detail/requirement";
import { SummaryBar } from "./vendor-rfq-detail/summary-bar";

/**
 * One vendor-visible RFQ: the requirement, and the vendor's own quotes on it
 * (brief 7.8, M5).
 *
 * The page is composed for the order a dispatcher asks questions: what is it and
 * when is it due, can I do it, what will it cost me, quote it. The sticky summary
 * keeps the deadline and the primary action in reach; the requirement is grouped
 * rather than listed; the quote panel sits beside it on desktop and underneath it
 * on a phone.
 *
 * The brief requires the customer, the internal user, and the vendor to read the
 * same *facts* about an RFQ while seeing different things: the vendor never sees
 * SML's internal notes, who else was invited, delivery status, or the recipient
 * list. That separation lives on the server — this screen is only a projection
 * of `/api/vendor/rfqs/:id`, and it never re-derives a deadline or a status.
 *
 * **The rate maths is never done here.** Every total on this screen comes from
 * the backend's `calculationNote`, because brief 6.4 fixes the 30-days-per-month
 * convention and the per-unit rules that go with it; a second implementation in
 * the client would eventually disagree with the one that was emailed.
 *
 * **Warnings do not block.** A crane of the wrong type or one that frees up late
 * is something for the vendor to see and decide about, so the preview's warnings
 * are rendered and the submit button stays live (brief 6.7).
 */
export function VendorRfqDetailPage() {
  const { rfqId } = useParams({ from: "/app/rfqs/$rfqId" }) as { rfqId: string };
  const [quotingAnother, setQuotingAnother] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  // Height of the sticky summary row, reported by the bar itself. The CSS
  // variable adds the 3rem application header, because the bar sticks at
  // `top-12` and the quote rail has to clear both.
  const [barHeight, setBarHeight] = useState(64);

  const detail = useQuery({
    queryKey: ["vendor-rfq", rfqId],
    queryFn: () => getVendorRfq(rfqId),
  });

  const startQuote = () => {
    setQuotingAnother(true);
    requestAnimationFrame(() =>
      document
        .getElementById("quote-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  if (detail.isLoading || !detail.data) {
    if (detail.error) {
      const error = detail.error as ApiError;
      return (
        <Alert title="Could not open this RFQ">
          {error.status === 404
            ? "This RFQ was not sent to you, or it has been removed."
            : error.message}
        </Alert>
      );
    }
    return <PageSkeleton />;
  }

  const { rfq, response, quotations } = detail.data;
  const showQuoteForm =
    response.canRespond && (quotations.length === 0 || quotingAnother);
  const latestQuote =
    quotations.find((quotation) => quotation.isLatest && quotation.status !== "WITHDRAWN") ??
    quotations[0] ??
    null;

  return (
    <div
      className="space-y-4 pb-28 lg:pb-0"
      style={{ "--rfq-bar-h": `${barHeight + 48}px` } as CSSProperties}
    >
      <h1 className="sr-only">
        RFQ {rfq.rfqNumber} — {rfq.enquiryNo}
        {rfq.lineNo ? `, line ${rfq.lineNo}` : ""}
      </h1>

      <SummaryBar
        rfq={rfq}
        response={response}
        quotations={quotations}
        quoting={quotingAnother}
        onQuote={startQuote}
        onCancelQuote={() => setQuotingAnother(false)}
        onDecline={() => setDeclineOpen(true)}
        onBarHeightChange={setBarHeight}
      />

      <GlanceStrip rfq={rfq} />

      {response.responseStatus === "DECLINED" &&
      (response.declineReason || response.declineNote) ? (
        <Alert tone="info" title="You declined this RFQ">
          {response.declineReason ? <p>{response.declineReason}</p> : null}
          {response.declineNote ? (
            <p className="mt-0.5 whitespace-pre-line text-slate-600">{response.declineNote}</p>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <div id="rfq-print" className="min-w-0 space-y-5">
          <Requirement rfq={rfq} />
        </div>

        <aside className="min-w-0 space-y-5 lg:sticky lg:top-[calc(var(--rfq-bar-h)+1rem)] lg:z-20 lg:max-h-[calc(100vh-var(--rfq-bar-h)-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
          {showQuoteForm ? (
            <div id="quote-panel" className="scroll-mt-40">
              <QuotePanel
                rfqId={rfqId}
                rfq={rfq}
                quotations={quotations}
                onQuoted={() => setQuotingAnother(false)}
              />
            </div>
          ) : latestQuote ? (
            <LatestQuote
              quotation={latestQuote}
              canRespond={response.canRespond}
              onQuote={startQuote}
            />
          ) : (
            <ReadOnlyCard rfq={rfq} response={response} />
          )}
        </aside>
      </div>

      {quotations.length > 0 ? (
        <QuotesList rfqId={rfqId} rfq={rfq} quotations={quotations} />
      ) : null}

      <DeclineDialog rfqId={rfqId} open={declineOpen} onOpenChange={setDeclineOpen} />
    </div>
  );
}

/** The calm rail when a quote exists and the form is put away. */
function LatestQuote({
  quotation,
  canRespond,
  onQuote,
}: {
  quotation: VendorQuotation;
  canRespond: boolean;
  onQuote: () => void;
}) {
  return (
    <Panel title="Your latest quote" description="Kept on record while SML reviews it.">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-2xl font-semibold text-slate-900 tabular-nums">
            {formatInr(quotation.totalQuotedValue)}
          </p>
          <StatusBadge status={quotation.status} />
        </div>
        <p className="text-sm text-slate-700">{quotation.craneLabel}</p>
        <p className="text-xs text-slate-500">
          Version {quotation.version} · valid until {formatCalendarDate(quotation.validityDate)}
        </p>

        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {canRespond ? (
            <button type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={onQuote}>
              <Send className="size-4" aria-hidden />
              Quote another crane
            </button>
          ) : null}
          <a
            href="#your-quotes"
            className="btn-secondary min-h-11 px-4 text-sm"
          >
            <ArrowDownRight className="size-4" aria-hidden />
            See all quotes
          </a>
        </div>
      </div>
    </Panel>
  );
}

/** Finalised, declined, expired or locked: quiet, complete, and clearly final. */
function ReadOnlyCard({
  rfq,
  response,
}: {
  rfq: VendorRfqDetail["rfq"];
  response: VendorRfqDetail["response"];
}) {
  const message =
    rfq.locked || response.responseStatus === "FINALISED"
      ? "This RFQ is finalised. It stays here so you can read the requirement again, and any quote you sent remains on record."
      : response.responseStatus === "DECLINED"
        ? "You declined this RFQ. It stays here as a record of what was asked."
        : response.responseStatus === "EXPIRED"
          ? "This RFQ expired without a quote from you. It stays here as a record."
          : "This RFQ is not accepting quotes right now.";

  return (
    <Panel title="Read-only">
      <div className="space-y-2 p-4">
        <p className="text-sm text-slate-700">{message}</p>
        <p className="text-xs text-slate-500">
          Nothing on this page can be changed. Contact SML from the summary bar if you need to
          discuss it.
        </p>
      </div>
    </Panel>
  );
}

/** Holds the shape of the page so the first paint does not jump. */
function PageSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading RFQ">
      <div className="-mx-4 border-b border-ink-800 px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-24" />
        </div>
        <Skeleton className="mt-2 h-3 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="card space-y-4 p-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full max-w-md" />
          <Skeleton className="h-3 w-full max-w-sm" />
          <Skeleton className="h-3 w-full max-w-lg" />
          <Skeleton className="h-3 w-full max-w-xs" />
        </div>
        <div className="card space-y-3 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}

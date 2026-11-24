import { useState, type CSSProperties } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, Send } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { PageBackButton } from "@/components/ui/page-back-button";
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
import { VendorNegotiations } from "./vendor-rfq-detail/negotiation";
import { QuotePanel } from "./vendor-rfq-detail/quote-panel";
import { QuotesList } from "./vendor-rfq-detail/quotes-list";
import { Requirement, RequirementFull } from "./vendor-rfq-detail/requirement";
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
  // Read first, then quote: the requirement is what the price is based on, so
  // it gets the whole page until the vendor chooses to move on.
  const [step, setStep] = useState<"requirement" | "quote" | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  // Height of the sticky summary row, reported by the bar itself. The CSS
  // variable adds the 3rem application header, because the bar sticks at
  // `top-12` and the quote rail has to clear both.
  const [barHeight, setBarHeight] = useState(64);

  const detail = useQuery({
    queryKey: ["vendor-rfq", rfqId],
    queryFn: () => getVendorRfq(rfqId),
  });

  const goTo = (next: "requirement" | "quote") => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startQuote = () => {
    setQuotingAnother(true);
    goTo("quote");
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
  // A vendor who has already responded, or can no longer respond, lands on
  // their response; a new RFQ opens on the requirement.
  const activeStep: "requirement" | "quote" =
    step ?? (quotations.length > 0 || !response.canRespond ? "quote" : "requirement");
  const latestQuote =
    quotations.find((quotation) => quotation.isLatest && quotation.status !== "WITHDRAWN") ??
    quotations[0] ??
    null;

  return (
    <div
      className="space-y-4 pb-28 lg:pb-0"
      style={{ "--rfq-bar-h": `${barHeight + 48}px` } as CSSProperties}
    >
      <div className="mb-2">
        <PageBackButton />
      </div>

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

      {response.responseStatus === "DECLINED" &&
      (response.declineReason || response.declineNote) ? (
        <Alert tone="info" title="You declined this RFQ">
          {response.declineReason ? <p>{response.declineReason}</p> : null}
          {response.declineNote ? (
            <p className="mt-0.5 whitespace-pre-line text-slate-600">{response.declineNote}</p>
          ) : null}
        </Alert>
      ) : null}

      <StepSwitch
        step={activeStep}
        onChange={goTo}
        quoteLabel={quotations.length > 0 || !response.canRespond ? "Your response" : "Your quote"}
        quoteCount={quotations.length}
      />

      <VendorNegotiations rfqId={rfqId} submissionDeadline={rfq.submissionDeadline} />

      {activeStep === "requirement" ? (
        <div id="rfq-print">
          <RequirementFull
            rfq={rfq}
            canQuote={response.canRespond}
            onQuote={startQuote}
          />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <div className="min-w-0 space-y-5">
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

            {quotations.length > 0 ? (
              <QuotesList rfqId={rfqId} rfq={rfq} quotations={quotations} />
            ) : null}
          </div>

          {/* While pricing, the requirement stays in view as a recap. */}
          <aside className="min-w-0 space-y-3 lg:sticky lg:top-[calc(var(--rfq-bar-h)+1rem)] lg:max-h-[calc(100vh-var(--rfq-bar-h)-2rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
            <button
              type="button"
              onClick={() => goTo("requirement")}
              className="text-[14px] font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
            >
              ← Back to the full requirement
            </button>
            <div id="rfq-print">
              <Requirement rfq={rfq} />
            </div>
          </aside>
        </div>
      )}

      <DeclineDialog rfqId={rfqId} open={declineOpen} onOpenChange={setDeclineOpen} />
    </div>
  );
}

function StepSwitch({
  step,
  onChange,
  quoteLabel,
  quoteCount,
}: {
  step: "requirement" | "quote";
  onChange: (step: "requirement" | "quote") => void;
  quoteLabel: string;
  quoteCount: number;
}) {
  const items = [
    { value: "requirement" as const, n: 1, label: "Requirement" },
    { value: "quote" as const, n: 2, label: quoteLabel },
  ];
  return (
    <div
      role="tablist"
      aria-label="RFQ steps"
      className="inline-flex max-w-full gap-1 rounded-xl border border-ink-800 bg-ink-850 p-1 print:hidden"
    >
      {items.map((item) => {
        const active = step === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[15px] whitespace-nowrap transition-colors " +
              (active
                ? "bg-ink-900 font-medium text-slate-900 shadow-sm ring-1 ring-ink-800"
                : "text-slate-500 hover:text-slate-900")
            }
          >
            <span
              className={
                "flex size-5 items-center justify-center rounded-full text-[12px] font-semibold " +
                (active ? "bg-accent-500 text-[#fff]" : "bg-ink-800 text-slate-600")
              }
            >
              {item.n}
            </span>
            {item.label}
            {item.value === "quote" && quoteCount > 0 ? (
              <span className="rounded-full bg-ink-800 px-1.5 text-[12px] text-slate-600">
                {quoteCount}
              </span>
            ) : null}
          </button>
        );
      })}
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
      <Skeleton className="h-20 rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
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

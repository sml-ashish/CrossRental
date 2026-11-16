import { useLayoutEffect, useRef, useState } from "react";
import {
  CalendarPlus,
  Check,
  ClipboardCopy,
  Mail,
  Phone,
  Printer,
  XCircle,
} from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { CountdownChip } from "@/components/ui/countdown-chip";
import { LifecycleStepper } from "@/components/ui/lifecycle-stepper";
import { Menu } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import {
  VENDOR_RESPONSE_LABELS,
  type VendorQuotation,
  type VendorRfqDetail,
} from "@/lib/quotations";
import {
  buildRfqSummary,
  copyText,
  deadlineInfo,
  downloadIcs,
  printRequirement,
} from "./rfq-utils";

/**
 * The top of the RFQ: what it is, how long is left, and the one action that
 * matters. A single compact row sticks under the application header so a vendor
 * reading the terms never loses the deadline or the way to quote; everything
 * explanatory (the full deadline, the status message, reminders, the stepper)
 * sits in the page body, where it can be as tall as it needs to be.
 *
 * The measured height is reported upward so the page can keep its quote rail
 * below the bar. The deadline, the status and its message are projections of the
 * server's fields — the same wording the screen used before the redesign.
 * Contact links are plain `tel:`/`mailto:` URLs and the calendar file is built
 * in the browser.
 */
export function SummaryBar({
  rfq,
  response,
  quotations,
  quoting,
  onQuote,
  onCancelQuote,
  onDecline,
  onBarHeightChange,
}: {
  rfq: VendorRfqDetail["rfq"];
  response: VendorRfqDetail["response"];
  quotations: VendorQuotation[];
  quoting: boolean;
  onQuote: () => void;
  onCancelQuote: () => void;
  onDecline: () => void;
  /** Reports the sticky row's height so the page can offset its sticky rail. */
  onBarHeightChange: (height: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);

  // The row wraps on narrow screens and the countdown chip changes width with
  // its label, so the height is measured rather than assumed.
  useLayoutEffect(() => {
    const node = barRef.current;
    if (!node) return;
    const report = () => onBarHeightChange(Math.ceil(node.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onBarHeightChange]);

  const countdown = deadlineInfo(rfq);
  const status = response.responseStatus;
  const canDecline = response.canRespond && status === "PENDING";

  const tone: BadgeTone =
    status === "QUOTED"
      ? "purple"
      : status === "DECLINED" || status === "EXPIRED"
        ? "red"
        : status === "FINALISED"
          ? "neutral"
          : "amber";

  const message =
    status === "FINALISED"
      ? "This RFQ was finalised before you quoted. It stays here as a record."
      : rfq.locked
        ? "This RFQ is finalised. You can still read it and your quotes remain on record."
        : status === "QUOTED"
          ? "Quote received. You can revise it until the deadline."
          : status === "DECLINED"
            ? "You declined this RFQ."
            : status === "EXPIRED"
              ? "This RFQ expired without a quote from you."
              : countdown.label;

  const steps = [
    { key: "received", label: "Received" },
    { key: "answered", label: status === "DECLINED" ? "Declined" : "Quoted" },
    { key: "decision", label: "Decision" },
  ] as const;
  const current =
    status === "FINALISED" ? 2 : status === "QUOTED" || status === "DECLINED" ? 1 : 0;

  const primary = !response.canRespond
    ? null
    : quoting
      ? { label: "Close form", onClick: onCancelQuote, quiet: true }
      : {
          label: quotations.length > 0 ? "Quote another crane" : "Quote this RFQ",
          onClick: onQuote,
          quiet: false,
        };

  // For a pending RFQ the message is the countdown label, which already shows in
  // the chip — repeating it in the body would be the same sentence twice.
  const showMessage = message !== countdown.label;

  const tel = rfq.smlContact.mobile?.replace(/[^+\d]/g, "") ?? null;

  const copy = async () => {
    const done = await copyText(buildRfqSummary(rfq));
    if (!done) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <section
        ref={barRef}
        aria-label="RFQ summary"
        className="sticky top-12 z-30 -mx-4 border-b border-ink-800 bg-ink-950 px-4 sm:-mx-6 sm:px-6 print:hidden"
      >
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="truncate font-mono text-base leading-tight font-semibold text-slate-900">
              {rfq.rfqNumber}
            </p>
            <Badge tone={tone}>{VENDOR_RESPONSE_LABELS[status]}</Badge>
            <CountdownChip
              label={countdown.label}
              tone={countdown.tone}
              urgent={countdown.tone === "soon" && response.canRespond}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {tel ? (
              <a
                href={`tel:${tel}`}
                aria-label={`Call ${rfq.smlContact.name ?? "SML"}`}
                title="Call SML"
                className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-slate-900 lg:size-9"
              >
                <Phone className="size-4" aria-hidden />
              </a>
            ) : null}
            {rfq.smlContact.email ? (
              <a
                href={`mailto:${rfq.smlContact.email}`}
                aria-label={`Email ${rfq.smlContact.name ?? "SML"}`}
                title="Email SML"
                className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-slate-900 lg:size-9"
              >
                <Mail className="size-4" aria-hidden />
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy RFQ summary"
              title={copied ? "Copied" : "Copy RFQ summary"}
              className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-slate-900 lg:size-9"
            >
              {copied ? (
                <Check className="size-4 text-emerald-700" aria-hidden />
              ) : (
                <ClipboardCopy className="size-4" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => downloadIcs(rfq)}
              aria-label="Add the quote deadline to your calendar"
              title="Add to calendar"
              className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-slate-900 lg:size-9"
            >
              <CalendarPlus className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={printRequirement}
              aria-label="Print the requirement"
              title="Print requirement"
              className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-slate-900 lg:size-9"
            >
              <Printer className="size-4" aria-hidden />
            </button>
            {canDecline ? (
              <Menu
                label="More actions"
                items={[
                  {
                    label: "Decline this RFQ",
                    icon: <XCircle className="size-4" aria-hidden />,
                    tone: "danger",
                    onSelect: onDecline,
                  },
                ]}
              />
            ) : null}

            {primary ? (
              <button
                type="button"
                onClick={primary.onClick}
                className={cn(
                  "hidden min-h-9 items-center px-3.5 py-1.5 text-sm lg:inline-flex",
                  primary.quiet ? "btn-secondary" : "btn-primary",
                )}
              >
                {primary.label}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/* Everything explanatory stays in the flow below the sticky row, where it
          can wrap without making the bar taller than the rail can clear. */}
      <div className="space-y-2.5 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3 print:hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-xs text-slate-500">
            {rfq.enquiryNo}
            {rfq.lineNo ? ` · line ${rfq.lineNo}` : ""} · quotes due{" "}
            {formatDateTime(rfq.submissionDeadline)}
            {!response.canRespond && !rfq.locked ? " · no longer accepted" : ""}
          </p>
          <p className="text-[11px] text-slate-500">
            {rfq.startDateTbc
              ? "Start date to be confirmed"
              : `Start ${formatDateTime(rfq.requiredStartDate).split(",")[0]}`}
          </p>
        </div>

        {showMessage ? (
          <p className="text-sm text-slate-700">
            {message}
            {response.respondedAt && status !== "PENDING"
              ? ` You responded ${formatDateTime(response.respondedAt)}.`
              : ""}
          </p>
        ) : null}

        {response.reminderCount > 0 ? (
          <p className="text-[11px] text-amber-700">
            SML sent {response.reminderCount} reminder
            {response.reminderCount === 1 ? "" : "s"} about this RFQ
          </p>
        ) : null}

        <LifecycleStepper steps={steps} current={current} />
      </div>

      {/* Below `lg` the primary action stays under the thumb. */}
      {primary ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-800 bg-ink-950/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur lg:hidden print:hidden">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-800">
                {showMessage ? message : VENDOR_RESPONSE_LABELS[status]}
              </p>
              <p className="truncate text-[11px] text-slate-500">
                Quotes due {formatDateTime(rfq.submissionDeadline)}
              </p>
            </div>
            <button
              type="button"
              onClick={primary.onClick}
              className={cn(
                "min-h-11 shrink-0 px-4 text-sm",
                primary.quiet ? "btn-secondary" : "btn-primary",
              )}
            >
              {primary.label}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

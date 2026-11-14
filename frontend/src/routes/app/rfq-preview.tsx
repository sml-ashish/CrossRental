import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Mail,
  MapPin,
  MessageCircle,
  X,
} from "lucide-react";
import {
  ROLLUPE_STATUS_LABELS,
  RESPONSE_LABELS,
  getRfq,
  remindRfq,
  type RfqRecipient,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { SiteMap } from "@/components/site-map";
import { formatInr } from "@/lib/quotations";
import {
  cityOf,
  craneTypeLabel,
  formatCalendarDate,
  titleCase,
} from "@/lib/format";
import {
  deadlineRelative,
  durationLabel,
  formatDeadlineDate,
  statusDisplay,
} from "@/lib/rfq-display";
import { pincodeStateMismatch } from "@/lib/geo";
import type { RfqRow } from "@/lib/rfq-list";
import { cn } from "@/lib/cn";

/**
 * The RFQ preview drawer.
 *
 * It answers the question the list raises — who was asked, who has answered,
 * what came back and when — without leaving the queue. It deliberately shows no
 * customer, site address, budget or internal notes: `getRfq` carries them, and
 * this surface is a glance, not the full record.
 *
 * On a wide screen it docks beside the list. Below that it is a slide-over, and
 * the page draws the backdrop.
 */

const RESPONSE_TONE: Record<string, string> = {
  QUOTED: "bg-emerald-500",
  DECLINED: "bg-red-500",
  EXPIRED: "bg-slate-500",
  FINALISED: "bg-emerald-500",
  PENDING: "bg-ink-700",
};

function shortMoment(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
      {children}
    </h2>
  );
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-slate-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-[13px] text-slate-700",
          mono && "font-mono text-[12px]",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

export function RfqPreview({
  rfqId,
  row,
  docked,
  onClose,
  onChanged,
}: {
  rfqId: string;
  /** The list row, used for the header until the detail lands. */
  row: RfqRow | null;
  docked: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const detail = useQuery({
    queryKey: ["rfq", rfqId],
    queryFn: () => getRfq(rfqId),
    placeholderData: (previous) => previous,
  });
  const rfq = detail.data?.rfq ?? null;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const status = rfq?.status ?? row?.status ?? "DRAFT";
  const display = statusDisplay(status, rfq?.rollupStatus ?? row?.rollupStatus ?? null);

  const countdown =
    status === "SENT" || status === "DRAFT"
      ? deadlineRelative(rfq?.submissionDeadline ?? row?.submissionDeadline ?? "", Date.now())
      : null;

  const recipients = rfq?.recipients ?? [];
  const pending = recipients.filter((recipient) => recipient.responseStatus === "PENDING");
  const quotations = (rfq?.quotations ?? []).filter((quotation) => quotation.isLatest);
  const lowest = quotations.reduce<number | null>(
    (min, quotation) =>
      min === null || quotation.totalQuotedValue < min ? quotation.totalQuotedValue : min,
    null,
  );
  const mismatch = rfq
    ? pincodeStateMismatch(rfq.sitePincode, rfq.siteStateCode)
    : null;
  const channels = rfq?.channels ?? row?.channels ?? [];

  async function remind(recipientId?: string) {
    if (!rfq) return;
    setBusy(recipientId ?? "all");
    setError(null);
    setNotice(null);
    try {
      const result = await remindRfq(rfq.id, recipientId ? [recipientId] : undefined);
      await onChanged();
      setNotice(
        `Reminder sent to ${result.result.sent} of ${result.result.reminded} pending ${
          result.result.reminded === 1 ? "vendor" : "vendors"
        }.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reminder could not be sent.");
    } finally {
      setBusy(null);
    }
  }

  const fullHref = { to: "/app/rfqs/$rfqId" as const, params: { rfqId } };

  return (
    <aside
      aria-label="RFQ preview"
      aria-modal={docked ? undefined : true}
      role="dialog"
      tabIndex={-1}
      className={cn(
        "flex min-h-0 flex-col border-ink-800 bg-ink-900 outline-none",
        docked
          ? "relative z-0 w-[420px] shrink-0 border-l"
          : "fixed inset-y-0 right-0 z-[60] w-[420px] max-w-[92vw] border-l shadow-2xl",
      )}
    >
      {/* header */}
      <div className="flex shrink-0 items-start gap-3 border-b border-ink-800 px-4 py-4">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[12px] leading-tight text-slate-500">
            {rfq?.rfqNumber ?? row?.rfqNumber ?? "RFQ"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("size-1.5 rounded-full", display.dot)} aria-hidden />
            <span className={cn("text-[13px] font-medium", display.text)}>{display.label}</span>
            {rfq?.rollupStatus && status === "SENT" ? (
              <span className="text-[12px] text-slate-500">
                · {ROLLUPE_STATUS_LABELS[rfq.rollupStatus]}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-slate-500 tabular-nums">
            Due {formatDeadlineDate(rfq?.submissionDeadline ?? row?.submissionDeadline ?? null)}
            {countdown && countdown.label !== "—" ? (
              <>
                {" · "}
                <span
                  className={cn(
                    countdown.tone === "overdue"
                      ? "text-red-600"
                      : countdown.tone === "soon"
                        ? "text-amber-600"
                        : "text-slate-500",
                  )}
                >
                  {countdown.label}
                </span>
              </>
            ) : null}
          </p>
          <Link
            {...fullHref}
            className="mt-2 inline-flex items-center gap-1 text-[13px] text-slate-500 transition-colors hover:text-white"
          >
            Open full page
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.isError ? (
          <div className="p-4">
            <Alert title="Could not load this RFQ">
              {detail.error instanceof Error ? detail.error.message : "Try again."}
            </Alert>
            <button
              type="button"
              onClick={() => void detail.refetch()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-800 px-3 py-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
            >
              Retry
            </button>
          </div>
        ) : !rfq ? (
          <div className="flex items-center gap-2 p-4 text-[13px] text-slate-500" role="status">
            <Spinner /> Loading the RFQ
          </div>
        ) : (
          <>
            {/* requirement */}
            <section className="border-b border-ink-800 px-4 py-4">
              <SectionLabel>Requirement</SectionLabel>
              <p className="mt-1.5 text-[15px] leading-tight font-semibold text-white">
                {craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} ·{" "}
                <span className="tabular-nums">
                  {rfq.capacityT} t{rfq.capacityRule === "AT_LEAST" ? "+" : ""}
                </span>
                {rfq.quantity > 1 ? (
                  <span className="ml-2 text-[13px] font-normal text-slate-500 tabular-nums">
                    × {rfq.quantity}
                  </span>
                ) : null}
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                <Item label="Enquiry line" value={`${rfq.enquiryNo}/${rfq.lineNo}`} mono />
                <Item label="Quantity" value={String(rfq.quantity)} />
                {rfq.mainBoomM !== null ? (
                  <Item label="Boom" value={`${rfq.mainBoomM} m`} />
                ) : null}
                {rfq.jibLengthM !== null ? (
                  <Item label="Jib" value={`${rfq.jibLengthM} m`} />
                ) : null}
                <Item
                  label="Start"
                  value={
                    rfq.startDateTbc
                      ? "To be confirmed"
                      : formatCalendarDate(rfq.requiredStartDate)
                  }
                />
                <Item
                  label="Duration"
                  value={durationLabel(rfq.durationValue, rfq.durationUnit)}
                />
                {rfq.configuration ? (
                  <Item label="Configuration" value={rfq.configuration} />
                ) : null}
              </dl>

              {rfq.applicationDescription || rfq.loadDescription ? (
                <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
                  {rfq.loadDescription ?? rfq.applicationDescription}
                </p>
              ) : null}
            </section>

            {/* site */}
            <section className="border-b border-ink-800">
              {rfq.siteLatitude !== null && rfq.siteLongitude !== null ? (
                <SiteMap
                  latitude={rfq.siteLatitude}
                  longitude={rfq.siteLongitude}
                  label={`Map of ${rfq.siteLocation}`}
                  className="h-[140px]"
                />
              ) : (
                <div className="flex h-[92px] items-center justify-center bg-ink-950">
                  <MapPin className="size-5 text-slate-600" aria-hidden />
                </div>
              )}
              <div className="px-4 py-3">
                <SectionLabel>Site</SectionLabel>
                <p className="mt-1.5 text-[14px] text-slate-700">
                  {rfq.siteState
                    ? `${cityOf(rfq)}, ${titleCase(rfq.siteState.name)}`
                    : cityOf(rfq)}
                </p>
                <p className="mt-0.5 text-[12px] text-slate-500 tabular-nums">
                  {rfq.sitePincode ?? "No pincode"}
                </p>
                {rfq.siteLocationUnverified ? (
                  <p className="mt-1 text-[12px] text-amber-600">
                    Location unverified — distances are unavailable.
                  </p>
                ) : null}
                {mismatch ? (
                  <p
                    className="mt-1 text-[12px] text-slate-500"
                    title={`${rfq.sitePincode} is a ${mismatch.expected} pincode, but the state is ${
                      rfq.siteState?.name ?? rfq.siteStateCode
                    }.`}
                  >
                    Check state: pincode suggests {mismatch.expected}.
                  </p>
                ) : null}
              </div>
            </section>

            {/* vendors */}
            <section className="border-b border-ink-800 px-4 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <SectionLabel>Vendors ({recipients.length})</SectionLabel>
                {channels.length > 0 ? (
                  <span className="flex items-center gap-2 text-slate-500">
                    {channels.includes("EMAIL") ? (
                      <Mail className="size-3.5" aria-label="Sent by email" />
                    ) : null}
                    {channels.includes("WHATSAPP") ? (
                      <MessageCircle className="size-3.5" aria-label="Sent by WhatsApp" />
                    ) : null}
                  </span>
                ) : null}
              </div>

              {recipients.length === 0 ? (
                <p className="mt-2 text-[13px] text-slate-500">
                  No vendors chosen yet.
                </p>
              ) : (
                <ul className="mt-1 divide-y divide-ink-800">
                  {recipients.map((recipient) => (
                    <RecipientLine
                      key={recipient.recipientId}
                      recipient={recipient}
                      canRemind={rfq.status === "SENT" && recipient.responseStatus === "PENDING"}
                      busy={busy === recipient.recipientId}
                      onRemind={() => void remind(recipient.recipientId)}
                    />
                  ))}
                </ul>
              )}

              {pending.length > 1 && rfq.status === "SENT" ? (
                <button
                  type="button"
                  onClick={() => void remind()}
                  disabled={busy !== null}
                  className="mt-3 inline-flex items-center gap-2 text-[13px] font-medium text-accent-400 transition-colors hover:text-accent-300 disabled:opacity-60"
                >
                  {busy === "all" ? <Spinner /> : <Bell className="size-3.5" aria-hidden />}
                  Remind all {pending.length} pending
                </button>
              ) : null}
            </section>

            {/* quotes */}
            <section className="border-b border-ink-800 px-4 py-4">
              <SectionLabel>Quotes ({quotations.length})</SectionLabel>
              {quotations.length === 0 ? (
                <p className="mt-2 text-[13px] text-slate-500">
                  {rfq.status === "SENT"
                    ? "Nothing has come back yet."
                    : "No quotations on this RFQ."}
                </p>
              ) : (
                <ul className="mt-1 divide-y divide-ink-800">
                  {[...quotations]
                    .sort((a, b) => a.totalQuotedValue - b.totalQuotedValue)
                    .map((quotation) => (
                      <li key={quotation.quotationId} className="py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="min-w-0 truncate text-[13px] text-slate-700">
                            {quotation.vendorName}
                          </p>
                          <p className="shrink-0 text-[13px] font-medium text-white tabular-nums">
                            {formatInr(quotation.totalQuotedValue, 0)}
                          </p>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-slate-500">
                          <span>Valid to {formatCalendarDate(quotation.validityDate)}</span>
                          {quotation.totalQuotedValue === lowest ? (
                            <span className="text-emerald-600">Lowest</span>
                          ) : null}
                        </div>
                        {quotation.craneDescription ? (
                          <p className="mt-0.5 truncate text-[12px] text-slate-500">
                            {quotation.craneDescription}
                          </p>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
              {quotations.length > 0 ? (
                <Link
                  to="/app/rfqs/$rfqId"
                  params={{ rfqId }}
                  search={{ tab: "quotations" }}
                  className="mt-2 inline-flex items-center gap-1 text-[13px] text-slate-500 transition-colors hover:text-white"
                >
                  Compare quotes
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </section>

            {/* contact */}
            {rfq.smlContactName || rfq.smlContactMobile || rfq.smlContactEmail ? (
              <section className="border-b border-ink-800 px-4 py-4">
                <SectionLabel>SML contact</SectionLabel>
                <p className="mt-1.5 text-[13px] text-slate-700">
                  {rfq.smlContactName ?? "—"}
                </p>
                <p className="mt-0.5 text-[12px] text-slate-500 tabular-nums">
                  {[rfq.smlContactMobile, rfq.smlContactEmail].filter(Boolean).join(" · ")}
                </p>
              </section>
            ) : null}

            {notice ? (
              <div className="px-4 pt-4">
                <Alert tone="success">{notice}</Alert>
              </div>
            ) : null}
            {error ? (
              <div className="px-4 pt-4">
                <Alert tone="error">{error}</Alert>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* pinned action */}
      {rfq ? (
        <div className="shrink-0 border-t border-ink-800 p-4">
          {rfq.status === "DRAFT" ? (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId }}
              search={{ tab: "vendors" }}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              Choose vendors
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : rfq.status === "SENT" && pending.length > 0 ? (
            <button
              type="button"
              onClick={() => void remind()}
              disabled={busy !== null}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
            >
              {busy === "all" ? <Spinner /> : <Bell className="size-4" aria-hidden />}
              Remind {pending.length} pending
            </button>
          ) : rfq.status === "SENT" && quotations.length > 0 ? (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId }}
              search={{ tab: "quotations" }}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-600"
            >
              Compare quotes
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <Link
              {...fullHref}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-ink-800 px-4 py-2.5 text-[13px] font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
            >
              Open full page
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function RecipientLine({
  recipient,
  canRemind,
  busy,
  onRemind,
}: {
  recipient: RfqRecipient;
  canRemind: boolean;
  busy: boolean;
  onRemind: () => void;
}) {
  const failed =
    recipient.emailDeliveryStatus === "FAILED" ||
    recipient.whatsappDeliveryStatus === "FAILED";

  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-white">
            {recipient.vendorName}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  RESPONSE_TONE[recipient.responseStatus] ?? "bg-ink-700",
                )}
                aria-hidden
              />
              {RESPONSE_LABELS[recipient.responseStatus] ?? recipient.responseStatus}
            </span>
            <span aria-hidden>·</span>
            <span>
              {recipient.firstViewedAt
                ? `seen ${shortMoment(recipient.firstViewedAt)}`
                : "not viewed"}
            </span>
            {recipient.reminderCount > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  {recipient.reminderCount}{" "}
                  {recipient.reminderCount === 1 ? "reminder" : "reminders"}
                </span>
              </>
            ) : null}
          </p>
          {failed ? (
            <p className="mt-0.5 text-[12px] text-red-600">
              {recipient.emailDeliveryStatus === "FAILED" ? "Email" : "WhatsApp"} delivery
              failed
            </p>
          ) : null}
        </div>

        {canRemind ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemind();
            }}
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-slate-500 transition-colors hover:bg-ink-850 hover:text-white disabled:opacity-60"
          >
            {busy ? <Spinner className="size-3" /> : <Bell className="size-3" aria-hidden />}
            Remind
          </button>
        ) : null}
      </div>
    </li>
  );
}

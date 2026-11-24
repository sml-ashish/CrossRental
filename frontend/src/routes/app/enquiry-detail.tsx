import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Compass,
  ListPlus,
  Pencil,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  cancelLine,
  createRfqFromLine,
  getEnquiry,
  LINE_STATUS_TONES,
  lineStatusOf,
  type EnquiryDetail,
  type EnquiryLine,
} from "@/lib/enquiries";
import { getBookingCalendar, type CalendarCrane } from "@/lib/calendar";
import { listRfqs } from "@/lib/rfqs";
import { classifyRange } from "@/lib/availability";
import {
  addDays,
  formatLongDate,
  liftSummary,
  lineActions,
  lineFacts,
  lineRfqFacts,
  lineShort,
  lineStage,
  lineTitle,
  lineUrgency,
  lineWindow,
  plural,
  requirementGroups,
  rfqSentence,
  siteCity,
  summariseRfqs,
  todayDay,
  type LineActionDescriptor,
  type LineRfqSummary,
} from "@/lib/enquiryDetail";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EnquiryBulkLines } from "@/components/enquiry-bulk-lines";
import { Alert } from "@/components/ui/alert";
import { PageBackButton } from "@/components/ui/page-back-button";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { EmptyState } from "@/components/ui/empty-state";
import { Menu } from "@/components/ui/menu";
import { StatusPill } from "@/components/ui/status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/lib/theme";

/**
 * Enquiry detail (P1).
 *
 * One internal screen answers two questions: where is this job, and what is the
 * single next action on each crane requirement. The state machine is folded in
 * `lib/enquiryDetail.ts`; this file is the layout, the two mutations and the
 * controls that open them.
 *
 * The ship-to city and state are shown here. When an RFQ is raised, the
 * deadline and the fields ticked in the picker are sent; the backend still owns
 * the allow-list and copies the core requirement onto the RFQ.
 */

function defaultDeadline(): string {
  return addDays(todayDay(), 7);
}

function discoverySearch(enquiry: EnquiryDetail, line: EnquiryLine) {
  const window = lineWindow(line);
  return {
    line: line.id,
    siteLocation: enquiry.shipToCity,
    ...(line.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
    ...(line.capacityT !== null
      ? { capacityT: line.capacityT, capacityRule: "AT_LEAST" }
      : {}),
    ...(window ? { availableFrom: window.from, availableTo: window.to } : {}),
  };
}

function availabilitySearch(enquiry: EnquiryDetail, line: EnquiryLine) {
  const window = lineWindow(line);
  const from = window?.from ?? todayDay();
  return {
    from,
    to: window?.to ?? addDays(from, 29),
    ...(line.craneTypeCode ? { type: line.craneTypeCode } : {}),
    ...(line.capacityT !== null ? { min: line.capacityT } : {}),
    ...(enquiry.siteStateCode ? { state: enquiry.siteStateCode } : {}),
  };
}

export function EnquiryDetailPage() {
  const params = useParams({ strict: false }) as { enquiryId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme } = useTheme();

  const enquiry = useQuery({
    queryKey: ["enquiry", params.enquiryId],
    queryFn: () => getEnquiry(params.enquiryId),
  });

  // The same unfiltered read the RFQ tracking screen uses. Matching on
  // `enquiryLineId` is what lets each line say "3 vendors · 1 replied".
  const rfqQuery = useQuery({
    queryKey: ["rfqs", "summary"],
    queryFn: () => listRfqs({}),
  });

  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rfqFor, setRfqFor] = useState<string | null>(null);
  const [rfqDeadline, setRfqDeadline] = useState(defaultDeadline);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
    await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
    await queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
  }

  async function raiseRfq(lineId: string, fields: RfqLineFieldKey[], remark?: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createRfqFromLine(lineId, rfqDeadline, fields, remark);
      await refresh();
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: created.rfq.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not raise the RFQ.");
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      setCancelFor(null);
      setReason("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  function openRaise(lineId: string) {
    setRfqFor(lineId);
    setRfqDeadline(defaultDeadline());
    setCancelFor(null);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => {
      document.getElementById(`line-${lineId}`)?.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "center",
      });
      document.getElementById(`rfq-deadline-${lineId}`)?.focus({ preventScroll: true });
    });
  }

  const lines = enquiry.data?.enquiry.lines ?? [];
  const rfqRows = rfqQuery.data?.rfqs ?? [];

  const summaries = useMemo(() => {
    const map: Record<string, LineRfqSummary | undefined> = {};
    for (const line of lines) map[line.id] = summariseRfqs(line.id, rfqRows);
    return map;
  }, [lines, rfqRows]);

  const hintLines = useMemo(
    () =>
      lines.filter((line) => {
        const facts = lineRfqFacts(line, summaries[line.id]);
        return !line.cancelledAt && !facts.hasRfq && Boolean(line.requiredStartDate);
      }),
    [lines, summaries],
  );

  const hintKey = hintLines
    .map((line) => {
      const window = lineWindow(line);
      return `${line.id}:${window?.from ?? ""}:${window?.to ?? ""}`;
    })
    .join("|");

  const hints = useQuery({
    queryKey: ["enquiry-availability", params.enquiryId, hintKey],
    enabled: hintLines.length > 0,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const result: Record<string, number> = {};
      for (const line of hintLines) {
        const window = lineWindow(line);
        if (!window) continue;
        const byId = new Map<string, CalendarCrane>();
        let from = window.from;
        while (from <= window.to) {
          const chunkEnd = addDays(from, 91);
          const to = chunkEnd < window.to ? chunkEnd : window.to;
          const { calendar } = await getBookingCalendar({
            from,
            to,
            ...(line.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
          });
          for (const crane of calendar.cranes) byId.set(crane.craneId, crane);
          from = addDays(to, 1);
        }
        result[line.id] = [...byId.values()].filter((crane) => {
          if (line.craneTypeCode && crane.craneTypeCode !== line.craneTypeCode) return false;
          if (line.capacityT !== null && crane.capacityT < line.capacityT) return false;
          return classifyRange(crane, window.from, window.to).kind === "whole";
        }).length;
      }
      return result;
    },
  });

  if (enquiry.isPending) {
    return <LoadingPage />;
  }

  if (enquiry.isError) {
    return (
      <div className="space-y-3">
        <Alert tone="error" title="Could not load this enquiry">
          The enquiry did not come back. Check the connection and try again.
        </Alert>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void enquiry.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const data = enquiry.data.enquiry;
  const city = siteCity(data);

  return (
    <div className={pageClass(theme)}>
      {/* ------------------------------------------------ slim header */}
      <header className="border-b border-ink-800 bg-ink-900 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3">
          <PageBackButton className="text-slate-400 hover:text-white" />
          <Link
            to="/app/enquiries/$enquiryId/edit"
            params={{ enquiryId: data.id }}
            className="btn-secondary !py-1.5 !text-[13px]"
          >
            <Pencil className="size-4" aria-hidden />
            Edit enquiry
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-5 sm:px-6">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {/* =========================================== requirements */}
        <div className="space-y-4">
            <section
              className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900"
              aria-label="Crane requirements"
            >
              {data.lines.length === 0 ? (
                <EmptyState
                  icon={<ListPlus className="size-4" aria-hidden />}
                  title="No lines yet"
                  description="Add the cranes this enquiry needs, then raise an RFQ from each line."
                  action={
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Link
                        to="/app/enquiries/$enquiryId/lines/new"
                        params={{ enquiryId: data.id }}
                        className="btn-primary"
                      >
                        <Plus className="size-4" aria-hidden />
                        Add line
                      </Link>
                      <EnquiryBulkLines enquiryId={data.id} enquiryNo={data.enquiryNo} />
                    </div>
                  }
                />
              ) : (
                <div className="divide-y divide-ink-800">
                  {data.lines.map((line) => {
                    const summary = summaries[line.id];
                    const facts = lineRfqFacts(line, summary);
                    const stage = lineStage(line);
                    const status = lineStatusOf(line);
                    const actions = lineActions(line, facts);
                    const urgency = lineUrgency(line, facts.hasRfq);
                    const sentence = rfqSentence(facts);
                    const lift = liftSummary(line);
                    const groups = requirementGroups(line);
                    const window = lineWindow(line);
                    const hint = hints.data?.[line.id];

                    return (
                      <article
                        key={line.id}
                        id={`line-${line.id}`}
                        aria-labelledby={`line-title-${line.id}`}
                        className={cn("scroll-mt-40", stage.cancelled && "opacity-60")}
                      >
                        <div className="px-5 pt-4 pb-4 sm:px-6">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-0.5">
                              <h3
                                id={`line-title-${line.id}`}
                                className="text-[15px] leading-snug font-semibold text-white"
                              >
                                {lineTitle(line)}
                              </h3>
                              <p className="text-[13px] text-slate-600">{lineFacts(line, city)}</p>
                              {lift ? <p className="text-[13px] text-slate-600">{lift}</p> : null}
                              {urgency ? (
                                <p
                                  className={cn(
                                    "inline-flex items-center gap-1 text-[13px] font-medium",
                                    urgency.tone === "amber"
                                      ? "text-amber-600"
                                      : urgency.tone === "red"
                                        ? "text-red-600"
                                        : "text-slate-500",
                                  )}
                                >
                                  {urgency.tone !== "muted" ? (
                                    <TriangleAlert className="size-3.5" aria-hidden />
                                  ) : null}
                                  {urgency.text}
                                </p>
                              ) : null}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <StatusPill tone={LINE_STATUS_TONES[status]}>{status}</StatusPill>
                              {!stage.cancelled && status !== "Booked" ? (
                              <Menu
                                label={`Actions for Line ${line.lineNo}`}
                                items={[
                                  {
                                    label: "Edit line",
                                    icon: <Pencil className="size-4" aria-hidden />,
                                    onSelect: () =>
                                      void navigate({
                                        to: "/app/enquiries/lines/$lineId/edit",
                                        params: { lineId: line.id },
                                      }),
                                  },
                                  {
                                    label: "Cancel line",
                                    icon: <X className="size-4" aria-hidden />,
                                    tone: "danger",
                                    onSelect: () => {
                                      setCancelFor(line.id);
                                      setReason("");
                                      setRfqFor(null);
                                    },
                                  },
                                ]}
                              />
                            ) : null}
                            </div>
                          </div>

                          {line.applicationDescription ? (
                            <p
                              className="mt-2 max-w-2xl truncate text-[13px] text-slate-700"
                              title={line.applicationDescription}
                            >
                              {line.applicationDescription}
                            </p>
                          ) : null}

                          {hint !== undefined && window ? (
                            <p className="mt-2 text-[13px] text-slate-600">
                              {hint > 0
                                ? `${hint} ${plural(hint, "crane")} match and ${
                                    hint === 1 ? "is" : "are"
                                  } free from ${formatLongDate(window.from)}`
                                : `No matching cranes are free from ${formatLongDate(window.from)}`}
                              {" · "}
                              <Link
                                to="/app/bookings"
                                search={availabilitySearch(data, line)}
                                className="font-medium text-accent-400 transition-colors hover:text-accent-300"
                              >
                                Check availability
                              </Link>
                            </p>
                          ) : null}

                          {stage.cancelled ? (
                            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-slate-600">
                              <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              <span>
                                Cancelled on {formatLongDate(line.cancelledAt)}
                                {line.cancelReason ? `: ${line.cancelReason}` : ""}
                              </span>
                            </p>
                          ) : null}

                          {cancelFor === line.id ? (
                            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                              <label htmlFor={`reason-${line.id}`} className="field-label">
                                Why is this line being cancelled?
                              </label>
                              <textarea
                                id={`reason-${line.id}`}
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                                rows={2}
                                className="field-input mt-1 resize-y"
                              />
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="btn-primary !py-1.5 !text-[13px]"
                                  disabled={busy || reason.trim().length < 3}
                                  onClick={() => void run(() => cancelLine(line.id, reason.trim()))}
                                >
                                  Cancel line
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary !py-1.5 !text-[13px]"
                                  onClick={() => setCancelFor(null)}
                                >
                                  Keep line
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {groups.length > 0 ? (
                            <details className="group mt-3">
                              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
                                <ChevronDown
                                  className="size-3.5 transition-transform group-open:rotate-180"
                                  aria-hidden
                                />
                                All requirements
                              </summary>
                              <div className="mt-3 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                {groups.map((group) => (
                                  <section key={group.title}>
                                    <h4 className="text-[12px] font-semibold tracking-wide text-slate-600 uppercase">
                                      {group.title}
                                    </h4>
                                    <dl className="mt-2 space-y-2">
                                      {group.items.map((item) => (
                                        <div key={item.label}>
                                          <dt className="text-[12px] text-slate-500">
                                            {item.label}
                                            {item.internal ? (
                                              <span className="ml-1.5 rounded border border-ink-700 px-1 py-px text-[11px] tracking-wide text-slate-500 uppercase">
                                                Internal
                                              </span>
                                            ) : null}
                                          </dt>
                                          <dd className="mt-0.5 text-[13px] whitespace-pre-wrap text-slate-800">
                                            {item.value}
                                          </dd>
                                        </div>
                                      ))}
                                    </dl>
                                  </section>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>

                        {/* row toolbar: where the RFQ stands, and what to do next */}
                        {stage.cancelled ? null : (
                          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ink-800 bg-ink-950 px-5 py-2.5 sm:px-6">
                            <p className="min-w-0 text-[13px] text-slate-600">
                              {sentence ? (
                                <>
                                  {sentence.count > 1 ? `${sentence.count} RFQs raised · ` : null}
                                  {sentence.rfqId ? (
                                    <Link
                                      to="/app/rfqs/$rfqId"
                                      params={{ rfqId: sentence.rfqId }}
                                      className="font-medium text-slate-800 underline decoration-ink-700 underline-offset-2 transition-colors hover:text-white"
                                    >
                                      {sentence.number ?? "Open RFQ"}
                                    </Link>
                                  ) : (
                                    sentence.number
                                  )}
                                  {sentence.status ? ` ${sentence.status}` : ""}
                                  {sentence.detail ? ` · ${sentence.detail}` : ""}
                                  {sentence.count > 1 ? (
                                    <>
                                      {" · "}
                                      <Link
                                        to="/app/rfqs"
                                        search={{ q: data.enquiryNo }}
                                        className="font-medium text-accent-400 transition-colors hover:text-accent-300"
                                      >
                                        All RFQs
                                      </Link>
                                    </>
                                  ) : null}
                                </>
                              ) : (
                                "No RFQ yet"
                              )}
                            </p>

                            {actions.primary || actions.secondary.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-2">
                                {actions.secondary.map((action) => (
                                  <LineActionButton
                                    key={action.kind}
                                    action={action}
                                    line={line}
                                    enquiry={data}
                                    onRaise={openRaise}
                                    variant="secondary"
                                  />
                                ))}
                                {actions.primary ? (
                                  <LineActionButton
                                    action={actions.primary}
                                    line={line}
                                    enquiry={data}
                                    onRaise={openRaise}
                                  />
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        )}

                        {stage.cancelled ? null : (
                          <RfqFieldsScreen
                            open={rfqFor === line.id}
                            line={line}
                            title="Raise RFQ"
                            lineLabel={lineShort(line)}
                            deadline={rfqDeadline}
                            onDeadline={setRfqDeadline}
                            pending={busy}
                            error={rfqFor === line.id ? error : null}
                            onConfirm={(keys, remark) => void raiseRfq(line.id, keys, remark)}
                            onClose={() => setRfqFor(null)}
                          />
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function pageClass(theme: string): string {
  return cn(
    "enq enq-fiori -mx-4 -my-6 min-h-[calc(100dvh-49px)] bg-ink-950 text-neutral-200 sm:-mx-6",
    theme === "light" ? "theme-light" : "theme-dark",
  );
}

function LineActionButton({
  action,
  line,
  enquiry,
  onRaise,
  variant = "primary",
  className,
}: {
  action: LineActionDescriptor;
  line: EnquiryLine;
  enquiry: EnquiryDetail;
  onRaise: (lineId: string) => void;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const classes = cn(
    variant === "primary" ? "btn-primary" : "btn-secondary",
    "!py-1.5 !text-[13px]",
    className,
  );

  if (action.kind === "raise") {
    return (
      <button type="button" className={classes} onClick={() => onRaise(line.id)}>
        {action.label}
      </button>
    );
  }

  if (action.kind === "open" && action.rfqId) {
    return (
      <Link to="/app/rfqs/$rfqId" params={{ rfqId: action.rfqId }} className={classes}>
        {action.label}
      </Link>
    );
  }

  if (action.kind === "find") {
    return (
      <Link to="/app/discovery" search={discoverySearch(enquiry, line)} className={classes}>
        <Compass className="size-3.5" aria-hidden />
        {action.label}
      </Link>
    );
  }

  if (action.kind === "availability") {
    return (
      <Link to="/app/bookings" search={availabilitySearch(enquiry, line)} className={classes}>
        {action.label}
      </Link>
    );
  }

  return null;
}

function LoadingPage() {
  const { theme } = useTheme();
  return (
    <div className={pageClass(theme)} role="status" aria-live="polite">
      <span className="sr-only">Loading enquiry</span>

      <div className="flex items-center justify-between border-b border-ink-800 bg-ink-900 px-4 py-3 sm:px-6">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-7 w-24" />
      </div>

      <div className="space-y-3 px-4 py-5 sm:px-6">
        {[0, 1].map((row) => (
          <div
            key={row}
            className="space-y-3 rounded-lg border border-ink-800 bg-ink-900 p-5"
          >
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-3 w-80" />
            <Skeleton className="h-5 w-full max-w-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ClipboardCopy,
  Compass,
  Copy,
  ExternalLink,
  History,
  ListPlus,
  Mail,
  MapPin,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import {
  ENQUIRY_STATUS_LABELS,
  cancelLine,
  createRfqFromLine,
  getEnquiry,
  type EnquiryDetail,
  type EnquiryLine,
} from "@/lib/enquiries";
import { getEnquiryHistory } from "@/lib/enquiryHistory";
import { getBookingCalendar, type CalendarCrane } from "@/lib/calendar";
import { listRfqs } from "@/lib/rfqs";
import { classifyRange } from "@/lib/availability";
import {
  LINE_STEPS,
  addDays,
  daysUntil,
  enquirySummaryText,
  formatLongDate,
  formatShortDate,
  liftSummary,
  lineActions,
  lineFacts,
  lineRfqFacts,
  lineShort,
  lineStage,
  lineStatusWord,
  lineTitle,
  lineUrgency,
  lineWindow,
  mapActivity,
  pickNextStep,
  plural,
  requirementGroups,
  rfqSentence,
  siteCity,
  siteLine,
  summariseRfqs,
  todayDay,
  type LineActionDescriptor,
  type LineRfqSummary,
  type NextStep,
} from "@/lib/enquiryDetail";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SiteMap } from "@/components/site-map";
import { EnquiryBulkLines } from "@/components/enquiry-bulk-lines";
import { Alert } from "@/components/ui/alert";
import {
  RfqLineFieldPicker,
  useRfqLineFieldSelection,
} from "@/components/rfq-line-field-picker";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextInput } from "@/components/ui/form";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

/**
 * Enquiry detail (P1).
 *
 * One internal screen answers two questions: where is this job, and what is the
 * single next action on each crane requirement. The state machine is folded in
 * `lib/enquiryDetail.ts`; this file is the layout, the two mutations and the
 * controls that open them.
 *
 * The customer block and the rental budget are internal and are shown here.
 * When an RFQ is raised, the deadline and the fields ticked in the picker are
 * sent; the backend still owns the allow-list and copies the core requirement.
 */

function defaultDeadline(): string {
  return addDays(todayDay(), 7);
}

function useIsWide(): boolean {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return wide;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function mapsHref(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

function statusDot(status: EnquiryDetail["overallStatus"]): string {
  switch (status) {
    case "FULLY_FINALISED":
    case "CLOSED":
      return "bg-emerald-500";
    case "PARTIALLY_FINALISED":
      return "bg-accent-500";
    case "PARTIALLY_QUOTED":
      return "bg-blue-500";
    default:
      return "bg-slate-400";
  }
}

function discoverySearch(enquiry: EnquiryDetail, line: EnquiryLine) {
  const window = lineWindow(line);
  return {
    line: line.id,
    siteLocation: enquiry.siteLocation,
    ...(line.craneTypeCode ? { craneType: line.craneTypeCode } : {}),
    ...(line.capacityT !== null
      ? { capacityT: line.capacityT, capacityRule: line.capacityRule }
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
  const wide = useIsWide();

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

  // The audit trail already powers the Sourcing history screen; this reads the
  // same endpoint for the last few meaningful events.
  const historyQuery = useQuery({
    queryKey: ["enquiry-history", params.enquiryId],
    queryFn: () => getEnquiryHistory(params.enquiryId),
    staleTime: 30_000,
  });

  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rfqFor, setRfqFor] = useState<string | null>(null);
  const [rfqDeadline, setRfqDeadline] = useState(defaultDeadline);
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // This screen already has the full line, so the picker needs no extra fetch.
  const rfqLine =
    enquiry.data?.enquiry.lines.find((line) => line.id === rfqFor) ?? null;
  const rfqFields = useRfqLineFieldSelection({ line: rfqLine, enabled: Boolean(rfqFor) });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
    await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
    await queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
  }

  async function raiseRfq(lineId: string) {
    if (!rfqFields.ready || rfqFields.error) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createRfqFromLine(lineId, rfqDeadline, rfqFields.keys);
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
    rfqFields.reset();
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

  const nextStep = useMemo(
    () =>
      enquiry.data
        ? pickNextStep(enquiry.data.enquiry.lines, summaries)
        : null,
    [enquiry.data, summaries],
  );

  const activity = useMemo(() => {
    if (!enquiry.data || !historyQuery.data) return [];
    return mapActivity(
      historyQuery.data.history.entries,
      enquiry.data.enquiry.lines,
      rfqRows,
    );
  }, [enquiry.data, historyQuery.data, rfqRows]);

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
          if (line.capacityT !== null) {
            const fits =
              line.capacityRule === "EXACT"
                ? crane.capacityT === line.capacityT
                : crane.capacityT >= line.capacityT;
            if (!fits) return false;
          }
          return classifyRange(crane, window.from, window.to).kind === "whole";
        }).length;
      }
      return result;
    },
  });

  async function copySummary() {
    if (!enquiry.data) return;
    const ok = await writeClipboard(enquirySummaryText(enquiry.data.enquiry));
    setCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setCopyState(null), 2200);
  }

  if (enquiry.isPending) {
    return <LoadingPage wide={wide} />;
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
  const site = siteLine(data);
  const liveLines = data.lines.filter((line) => !line.cancelledAt);
  const sourcedCount = data.summary.finalised;
  const hasPin = data.siteLatitude !== null && data.siteLongitude !== null;

  const headerMenu: MenuItem[] = [
    {
      label: "Sourcing history",
      icon: <History className="size-4" aria-hidden />,
      onSelect: () =>
        void navigate({
          to: "/app/enquiries/$enquiryId/history",
          params: { enquiryId: data.id },
        }),
    },
    {
      label: "Communication history",
      icon: <Mail className="size-4" aria-hidden />,
      onSelect: () =>
        void navigate({ to: "/app/communications", search: { enquiryId: data.id } }),
    },
    {
      label: "Add lines in bulk",
      icon: <ListPlus className="size-4" aria-hidden />,
      onSelect: () => setBulkOpen(true),
    },
    {
      label: "Copy summary",
      icon: <ClipboardCopy className="size-4" aria-hidden />,
      onSelect: () => void copySummary(),
    },
  ];

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Link
          to="/app/enquiries"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          All enquiries
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[14px] text-slate-500">{data.enquiryNo}</p>
            <h1 className="mt-0.5 text-[28px] leading-tight font-semibold tracking-tight text-slate-900">
              {data.customerName}
            </h1>
            <p className="mt-1 text-sm text-slate-500">{site}</p>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn("size-2 rounded-full", statusDot(data.overallStatus))}
                  aria-hidden
                />
                <span className="text-slate-800">
                  {ENQUIRY_STATUS_LABELS[data.overallStatus]}
                </span>
              </span>
              <span aria-hidden>·</span>
              <span>
                {sourcedCount} of {liveLines.length} lines sourced
              </span>
              <span aria-hidden>·</span>
              <span>Raised {formatLongDate(data.enquiryDate)}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/app/enquiries/$enquiryId/edit"
              params={{ enquiryId: data.id }}
              className="btn-secondary"
            >
              <Pencil className="size-4" aria-hidden />
              Edit
            </Link>
            <Link
              to="/app/enquiries/$enquiryId/lines/new"
              params={{ enquiryId: data.id }}
              className="btn-secondary"
            >
              <Plus className="size-4" aria-hidden />
              Add line
            </Link>
            <Menu label="More actions" items={headerMenu} />
            {copyState ? (
              <span
                role="status"
                className={cn(
                  "text-[14px]",
                  copyState === "copied" ? "text-emerald-600" : "text-red-600",
                )}
              >
                {copyState === "copied" ? "Copied" : "Copy failed"}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <NextStepBanner
        step={nextStep}
        enquiry={data}
        onRaise={openRaise}
      />

      {!wide ? (
        <section className="card overflow-hidden" aria-label="Job details">
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls="job-details-mobile"
            onClick={() => setDetailsOpen((value) => !value)}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-sm font-semibold text-slate-900">Job details</span>
            <ChevronDown
              className={cn(
                "size-4 text-slate-500 transition-transform",
                detailsOpen && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          {detailsOpen ? (
            <div id="job-details-mobile" className="border-t border-ink-800 p-4">
              <JobDetails data={data} site={site} hasPin={hasPin} />
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="min-w-0 space-y-5">
          <section className="card overflow-hidden" aria-labelledby="requirements-heading">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 px-5 py-3">
              <h2
                id="requirements-heading"
                className="text-sm font-semibold text-slate-900"
              >
                Crane requirements{" "}
                <span className="font-normal text-slate-500">({data.lines.length})</span>
              </h2>
            </div>

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
                      className={cn(
                        "scroll-mt-24 p-5",
                        stage.cancelled && "opacity-60",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3
                            id={`line-title-${line.id}`}
                            className="text-[17px] leading-snug font-semibold text-slate-900"
                          >
                            {lineTitle(line)}
                          </h3>
                          <p className="mt-1 text-[15px] text-slate-500">
                            {lineFacts(line, city)}
                            {urgency ? (
                              <span
                                className={cn(
                                  "font-medium",
                                  urgency.tone === "amber"
                                    ? "text-amber-600"
                                    : urgency.tone === "red"
                                      ? "text-red-600"
                                      : "text-slate-500",
                                )}
                              >
                                {" · "}
                                {urgency.text}
                              </span>
                            ) : null}
                          </p>
                        </div>

                        {!stage.cancelled &&
                        !["CLOSED", "FULFILLED_INTERNALLY"].includes(line.trailStatus) ? (
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

                      {hint !== undefined && window ? (
                        <p className="mt-1 text-[14px] text-slate-500">
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

                      {line.applicationDescription || lift ? (
                        <div className="mt-2">
                          {line.applicationDescription ? (
                            <p
                              className="max-w-2xl truncate text-sm text-slate-600"
                              title={line.applicationDescription}
                            >
                              {line.applicationDescription}
                            </p>
                          ) : null}
                          {lift ? (
                            <p className="mt-0.5 text-[15px] text-slate-500">{lift}</p>
                          ) : null}
                        </div>
                      ) : null}

                      {stage.cancelled ? (
                        <p className="mt-3 flex items-start gap-1.5 text-[15px] text-slate-500">
                          <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          <span>
                            Cancelled on {formatLongDate(line.cancelledAt)}
                            {line.cancelReason ? `: ${line.cancelReason}` : ""}
                          </span>
                        </p>
                      ) : (
                        <>
                          <StageTrail line={line} />

                          <p className="mt-2 text-[15px] text-slate-500">
                            {sentence ? (
                              <>
                                {sentence.count > 1
                                  ? `${sentence.count} RFQs raised · `
                                  : null}
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
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                              {actions.primary ? (
                                <LineActionButton
                                  action={actions.primary}
                                  line={line}
                                  enquiry={data}
                                  onRaise={openRaise}
                                  className="w-full justify-center sm:w-auto"
                                />
                              ) : null}
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
                            </div>
                          ) : null}

                          {rfqFor === line.id ? (
                            <div className="mt-4 rounded-lg border border-ink-800 bg-ink-900 p-4">
                              <p className="text-[15px] font-medium text-slate-900">
                                Raise an RFQ for {lineShort(line)}
                              </p>
                              <p className="mt-1 text-[14px] text-slate-500">
                                Choose which optional fields to copy. The customer name,
                                address and internal budget are never sent.
                              </p>

                              <details className="mt-3 rounded-lg border border-ink-800 bg-ink-850/40">
                                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[14px] font-medium text-slate-600 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
                                  <span>Choose which line fields to send</span>
                                  <span className="text-[13px] text-slate-500 tabular-nums">
                                    {rfqFields.keys.length} selected
                                  </span>
                                </summary>
                                <div className="max-h-72 overflow-y-auto border-t border-ink-800 p-2.5">
                                  <RfqLineFieldPicker
                                    line={rfqFields.line}
                                    selected={rfqFields.keys}
                                    onToggle={rfqFields.toggle}
                                    loading={rfqFields.loading}
                                    error={rfqFields.error}
                                    onRetry={rfqFields.retry}
                                    variant="plain"
                                  />
                                </div>
                              </details>

                              <div className="mt-3 flex flex-wrap items-end gap-2">
                                <Field
                                  label="Submission deadline"
                                  htmlFor={`rfq-deadline-${line.id}`}
                                >
                                  <TextInput
                                    id={`rfq-deadline-${line.id}`}
                                    type="date"
                                    value={rfqDeadline}
                                    onChange={setRfqDeadline}
                                  />
                                </Field>
                                <div className="flex gap-1.5">
                                  {[3, 7, 14].map((days) => (
                                    <button
                                      key={days}
                                      type="button"
                                      onClick={() =>
                                        setRfqDeadline(addDays(todayDay(), days))
                                      }
                                      className={cn(
                                        "rounded-lg border px-2.5 py-2 text-[14px] font-medium transition-colors",
                                        rfqDeadline === addDays(todayDay(), days)
                                          ? "border-accent-500 bg-accent-500/10 text-accent-400"
                                          : "border-ink-800 bg-ink-850 text-slate-500 hover:border-ink-700 hover:text-slate-800",
                                      )}
                                    >
                                      +{days} days
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <p className="mt-2 text-[14px] text-slate-500">
                                {Math.max(0, daysUntil(rfqDeadline))}{" "}
                                {plural(Math.max(0, daysUntil(rfqDeadline)), "day")} to
                                respond
                              </p>

                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="btn-primary"
                                  disabled={busy || !rfqFields.ready || rfqFields.error}
                                  onClick={() => void raiseRfq(line.id)}
                                >
                                  {busy ? <Spinner /> : null}
                                  Raise RFQ
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  disabled={busy}
                                  onClick={() => setRfqFor(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {cancelFor === line.id ? (
                            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                              <label
                                htmlFor={`reason-${line.id}`}
                                className="field-label"
                              >
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
                                  className="btn-primary"
                                  disabled={busy || reason.trim().length < 3}
                                  onClick={() =>
                                    void run(() => cancelLine(line.id, reason.trim()))
                                  }
                                >
                                  Cancel line
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={() => setCancelFor(null)}
                                >
                                  Keep line
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {groups.length > 0 ? (
                            <details className="group mt-3 border-t border-ink-800 pt-3">
                              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[15px] font-medium text-slate-500 transition-colors hover:text-slate-800 [&::-webkit-details-marker]:hidden">
                                <ChevronDown
                                  className="size-3.5 transition-transform group-open:rotate-180"
                                  aria-hidden
                                />
                                All requirements
                              </summary>
                              <div className="mt-3 grid gap-5 sm:grid-cols-2">
                                {groups.map((group) => (
                                  <section key={group.title}>
                                    <h4 className="text-[14px] font-medium tracking-wide text-slate-500 uppercase">
                                      {group.title}
                                    </h4>
                                    <dl className="mt-2 space-y-2">
                                      {group.items.map((item) => (
                                        <div key={item.label}>
                                          <dt className="text-[14px] text-slate-500">
                                            {item.label}
                                            {item.internal ? (
                                              <span className="ml-1.5 rounded border border-ink-700 px-1 py-px text-[14px] tracking-wide text-slate-400 uppercase">
                                                Internal
                                              </span>
                                            ) : null}
                                          </dt>
                                          <dd className="mt-0.5 text-[15px] whitespace-pre-wrap text-slate-600">
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
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {activity.length > 0 ? (
            <section className="card px-5 py-4" aria-labelledby="activity-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="activity-heading"
                  className="text-sm font-semibold text-slate-900"
                >
                  Recent activity
                </h2>
                <Link
                  to="/app/enquiries/$enquiryId/history"
                  params={{ enquiryId: data.id }}
                  className="inline-flex items-center gap-1 text-[15px] font-medium text-accent-400 transition-colors hover:text-accent-300"
                >
                  View full history
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </div>
              <ul className="mt-2 divide-y divide-ink-800">
                {activity.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-[15px]"
                  >
                    <span className="w-14 shrink-0 text-slate-500">
                      {formatShortDate(item.at)}
                    </span>
                    <span className="text-slate-600">{item.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {wide ? (
          <aside className="lg:sticky lg:top-4" aria-label="Job details">
            <div className="card p-4">
              <h2 className="text-sm font-semibold text-slate-900">Job details</h2>
              <div className="mt-3">
                <JobDetails data={data} site={site} hasPin={hasPin} />
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      <EnquiryBulkLines
        enquiryId={data.id}
        enquiryNo={data.enquiryNo}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        showTrigger={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function NextStepBanner({
  step,
  enquiry,
  onRaise,
}: {
  step: NextStep | null;
  enquiry: EnquiryDetail;
  onRaise: (lineId: string) => void;
}) {
  if (!step) return null;

  if (step.muted) {
    return <p className="text-[15px] text-slate-500">{step.text}</p>;
  }

  return (
    <section
      aria-label="Next step"
      className="card flex flex-wrap items-center justify-between gap-3 border-accent-500/30 bg-accent-500/[0.04] px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-500/10 text-accent-400">
          <ArrowRight className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium tracking-wide text-accent-400 uppercase">
            Next step
          </p>
          <p className="mt-0.5 text-sm text-slate-800">{step.text}</p>
        </div>
      </div>
      {step.action && step.line ? (
        <LineActionButton
          action={step.action}
          line={step.line}
          enquiry={enquiry}
          onRaise={onRaise}
          className="w-full justify-center sm:w-auto"
        />
      ) : null}
    </section>
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
    variant === "primary" ? "btn-primary" : "btn-secondary px-3 py-2 text-[15px]",
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
      <Link
        to="/app/rfqs/$rfqId"
        params={{ rfqId: action.rfqId }}
        className={classes}
      >
        {action.label}
      </Link>
    );
  }

  if (action.kind === "compare") {
    return (
      <Link
        to="/app/enquiries/lines/$lineId/comparison"
        params={{ lineId: line.id }}
        className={classes}
      >
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
      <Link
        to="/app/bookings"
        search={availabilitySearch(enquiry, line)}
        className={classes}
      >
        {action.label}
      </Link>
    );
  }

  return null;
}

function StageTrail({ line }: { line: EnquiryLine }) {
  const stage = lineStage(line);
  if (stage.cancelled) return null;

  const currentLabel = stage.completed
    ? (stage.note ?? "Done")
    : (LINE_STEPS[stage.index] ?? "Requirement");

  return (
    <div className="mt-4">
      <p className="text-[15px] text-slate-500 sm:hidden">
        Step {stage.completed ? 5 : stage.index + 1} of 5:{" "}
        <span className="font-medium text-slate-900">{currentLabel}</span>
        {stage.completed && stage.note ? ` · ${stage.note}` : ""}
      </p>

      <ol
        className="hidden flex-wrap items-center gap-y-1 sm:flex"
        aria-label={`Progress for Line ${line.lineNo}`}
      >
        {LINE_STEPS.map((step, index) => {
          const done = stage.completed || index < stage.index;
          const current = !stage.completed && index === stage.index;
          return (
            <li
              key={step}
              aria-current={current ? "step" : undefined}
              className="flex items-center"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[14px] leading-none font-medium",
                  done
                    ? "border-emerald-300 bg-emerald-100 text-emerald-700"
                    : current
                      ? "border-accent-500 bg-accent-500/10 text-accent-400 ring-2 ring-accent-500/20"
                      : "border-ink-700 bg-ink-900 text-slate-500",
                )}
              >
                {done ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "ml-1.5 text-[14px]",
                  done
                    ? "text-emerald-600"
                    : current
                      ? "font-medium text-slate-900"
                      : "text-slate-500",
                )}
              >
                {step}
              </span>
              {index < LINE_STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "mx-2 h-px w-4",
                    done && stage.index > index + 1
                      ? "bg-emerald-300/60"
                      : "bg-ink-700",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[14px] text-slate-500">
        {stage.note ?? lineStatusWord(line)}
      </p>
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!value) return;
    if (await writeClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <span className="inline-flex items-start gap-1">
      <span className="min-w-0">{value || "—"}</span>
      {value ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="mt-0.5 shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </span>
  );
}

function JobDetails({
  data,
  site,
  hasPin,
}: {
  data: EnquiryDetail;
  site: string;
  hasPin: boolean;
}) {
  const latitude = data.siteLatitude;
  const longitude = data.siteLongitude;
  const href =
    latitude !== null && longitude !== null ? mapsHref(latitude, longitude) : null;

  return (
    <div className="space-y-3">
      {latitude !== null && longitude !== null ? (
        <SiteMap
          latitude={latitude}
          longitude={longitude}
          label={`Map of ${site}`}
          className="h-[180px] overflow-hidden rounded-lg"
          onOpen={href ? () => window.open(href, "_blank", "noopener,noreferrer") : undefined}
        />
      ) : (
        <div className="flex h-[180px] flex-col items-center justify-center gap-1.5 rounded-lg border border-ink-800 bg-ink-900 text-slate-500">
          <MapPin className="size-5" aria-hidden />
          <span className="text-[15px]">Location not pinned</span>
        </div>
      )}

      <dl className="space-y-3">
        <div>
          <dt className="text-[14px] text-slate-500">Customer</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">{data.customerName}</dd>
        </div>
        <div>
          <dt className="text-[14px] text-slate-500">Customer address</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">
            <CopyValue value={data.customerAddress} label="Customer address" />
          </dd>
        </div>
        <div>
          <dt className="text-[14px] text-slate-500">Site</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">
            <CopyValue value={site} label="Site" />
          </dd>
        </div>
        <div>
          <dt className="text-[14px] text-slate-500">Pincode</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">
            {data.sitePincode || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[14px] text-slate-500">Region</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">
            {data.region || data.siteStateName || data.siteStateCode || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[14px] text-slate-500">Enquiry date</dt>
          <dd className="mt-0.5 text-[15px] text-slate-800">
            {formatLongDate(data.enquiryDate)}
          </dd>
        </div>
      </dl>

      {href && hasPin ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[15px] font-medium text-accent-400 transition-colors hover:text-accent-300"
        >
          Open in Maps
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

function LoadingPage({ wide }: { wide: boolean }) {
  return (
    <div className="space-y-5" role="status" aria-live="polite">
      <span className="sr-only">Loading enquiry</span>

      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-80" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="space-y-3">
          {[0, 1].map((row) => (
            <div key={row} className="card space-y-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-64" />
                  <Skeleton className="h-3 w-80" />
                </div>
                <Skeleton className="size-10 shrink-0" />
              </div>
              <Skeleton className="h-3 w-52" />
              <Skeleton className="h-6 w-full max-w-md" />
              <Skeleton className="h-3 w-56" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-36" />
                <Skeleton className="h-10 w-28" />
              </div>
            </div>
          ))}
        </div>

        {wide ? (
          <div className="card space-y-3 p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-[180px] w-full" />
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}


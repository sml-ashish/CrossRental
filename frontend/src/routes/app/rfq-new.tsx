import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Clock,
  Inbox,
  MapPin,
  Send,
  X,
} from "lucide-react";
import {
  createRfqFromLine,
  formatDate,
  listRaisableLines,
  type RaisableLine,
} from "@/lib/enquiries";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonRow } from "@/components/ui/skeleton";
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

/**
 * Raise an RFQ against an enquiry line (P1 section 2, brief 6.7).
 *
 * The screen exists so there is exactly one way to create an RFQ: choose the
 * line first. The old free-form create asked for an enquiry number and a line
 * number by hand, which let an RFQ claim a line it did not belong to and left
 * the line's trail untouched. Here the line is the input, and the backend
 * prefills the requirement from its vendor-safe subset and derives the
 * enquiry/line reference from the line itself.
 *
 * Raising a draft is not sending. The RFQ detail screen picks vendors and
 * dispatches, which is where the customer-safe snapshot is frozen. The right-hand
 * pane is that promise made visible: it shows the vendor-safe subset, states what
 * is deliberately not copied, and only then creates the draft.
 */

const DAY = 86_400_000;

/** The value a `type="date"` input wants, `n` days from today. */
function deadlineInDays(days: number): string {
  const date = new Date(Date.now() + days * DAY);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whole days between today and a `YYYY-MM-DD` value, read as a calendar day. */
function daysToRespond(deadline: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY);
}

function respondLabel(days: number | null): string {
  if (days === null) return "Choose a submission deadline";
  if (days < 0) return "That deadline has already passed";
  if (days === 0) return "Vendors must quote today";
  return `${days} day${days === 1 ? "" : "s"} to respond`;
}

/** Same six states the enquiry panel uses, folded from the eleven-step trail. */
function trailPill(status: RaisableLine["trailStatus"]): { label: string; tone: StatusPillTone } {
  switch (status) {
    case "NEW":
      return { label: "New", tone: "neutral" };
    case "AVAILABILITY_CHECK":
    case "VENDOR_SHORTLISTED":
      return { label: "Availability check", tone: "blue" };
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
      return { label: "RFQ sent", tone: "blue" };
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return { label: "Quotes in", tone: "amber" };
    case "VENDOR_FINALISED":
    case "BOOKED":
    case "FULFILLED_INTERNALLY":
      return { label: "Awarded", tone: "emerald" };
    default:
      return { label: "Closed", tone: "muted" };
  }
}

function capacityLabel(line: RaisableLine): string {
  if (line.capacityT === null) return "TBC";
  return `${line.capacityT} t${line.capacityRule === "AT_LEAST" ? "+" : ""}`;
}

/** `siteLocation` often already ends in the state; do not print it twice. */
function placeOf(line: RaisableLine): string {
  const state = line.siteStateName;
  if (!state || line.siteLocation.toLowerCase().includes(state.toLowerCase())) {
    return line.siteLocation;
  }
  return `${line.siteLocation}, ${state}`;
}

/** Non-blocking reasons to pause before creating a draft. */
function lineWarnings(line: RaisableLine | null): string[] {
  if (!line) return [];
  const warnings: string[] = [];
  if (line.rfqCount > 0) {
    warnings.push(
      `This line already has ${line.rfqCount} RFQ${line.rfqCount === 1 ? "" : "s"}. Creating another starts a parallel tender against the same line.`,
    );
  }
  if (line.startDateTbc) {
    warnings.push(
      "The required start date is still to be confirmed, so vendors are told why rather than asked to confirm availability.",
    );
  } else if (line.requiredStartDate) {
    const start = new Date(line.requiredStartDate).getTime();
    const days = Math.ceil((start - Date.now()) / DAY);
    if (!Number.isNaN(days) && days >= 0 && days <= 14) {
      warnings.push(
        days === 0
          ? "The required start is today. Vendors may not have time to respond."
          : `The required start is in ${days} day${days === 1 ? "" : "s"}. Vendors may not have time to respond.`,
      );
    }
  }
  return warnings;
}

export function RfqNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [deadline, setDeadline] = useState(() => deadlineInDays(7));
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("");
  const [tbcOnly, setTbcOnly] = useState(false);
  const [hasRfqOnly, setHasRfqOnly] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const lines = useQuery({
    queryKey: ["raisable-lines", search],
    queryFn: () => listRaisableLines(search),
  });

  const raise = useMutation({
    mutationFn: (line: RaisableLine) => createRfqFromLine(line.id, deadline),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
      void queryClient.invalidateQueries({ queryKey: ["enquiries"] });
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: created.rfq.id } });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not raise the RFQ.");
    },
  });

  // Typing should not fire a request per keystroke; the list screen behaves the
  // same way, so the two pickers feel like one product.
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  useEffect(() => {
    if (!sheetOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSheetOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const allRows = lines.data?.lines ?? [];

  const states = useMemo(
    () =>
      [...new Set(allRows.map((line) => line.siteStateName).filter((s): s is string => Boolean(s)))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [allRows],
  );

  const rows = useMemo(
    () =>
      allRows.filter(
        (line) =>
          (!stateFilter || line.siteStateName === stateFilter) &&
          (!tbcOnly || line.startDateTbc) &&
          (!hasRfqOnly || line.rfqCount > 0),
      ),
    [allRows, stateFilter, tbcOnly, hasRfqOnly],
  );

  // Keep a live selection: the first row when nothing is chosen, and the nearest
  // row when the current one is filtered out.
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((line) => line.id === selectedId)) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [rows, selectedId]);

  const selected = rows.find((line) => line.id === selectedId) ?? null;
  const warnings = lineWarnings(selected);
  const days = daysToRespond(deadline);
  const filtersOn = Boolean(stateFilter || tbcOnly || hasRfqOnly);

  function clearFilters() {
    setStateFilter("");
    setTbcOnly(false);
    setHasRfqOnly(false);
  }

  function startRaise() {
    if (!selected) return;
    setError(null);
    raise.mutate(selected);
  }

  const listKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    if (rows.length === 0) return;
    const index = rows.findIndex((line) => line.id === selectedId);

    if (event.key === "Enter") {
      event.preventDefault();
      if (window.matchMedia("(max-width: 1023px)").matches) setSheetOpen(true);
      return;
    }

    event.preventDefault();
    const next =
      event.key === "ArrowDown"
        ? rows[Math.min(index + 1, rows.length - 1)]
        : rows[Math.max(index - 1, 0)];
    if (!next) return;
    setSelectedId(next.id);
    document.getElementById(`raisable-line-${next.id}`)?.scrollIntoView({ block: "nearest" });
  };

  const preview = (
    <DraftPreview
      line={selected}
      deadline={deadline}
      onDeadline={setDeadline}
      days={days}
      warnings={warnings}
      error={error}
      pending={raise.isPending}
      onCreate={startRaise}
    />
  );

  return (
    <div className="theme-dark -mx-4 -my-6 flex h-[calc(100dvh-49px)] overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6">
      {/* ------------------------------------------------------------- picker */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-ink-800 px-6 pt-5 pb-4">
          <PageHeader
            back={{ to: "/app/rfqs", label: "All RFQs" }}
            title="Raise an RFQ"
            description="Every RFQ belongs to one enquiry line item. Pick the line, review what the vendor will see, then create the draft."
          />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Enquiry number or crane type"
                aria-label="Search enquiry lines"
                className="field-input h-9 py-0 text-[15px]"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-white"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>

            <label className="sr-only" htmlFor="raisable-state">
              Filter by state
            </label>
            <select
              id="raisable-state"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
              className="field-input h-9 w-auto py-0 pr-8 text-[15px]"
            >
              <option value="">All states</option>
              {states.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <FilterChip active={!filtersOn} onClick={clearFilters}>
              All lines
            </FilterChip>
            <FilterChip active={tbcOnly} onClick={() => setTbcOnly((value) => !value)}>
              Start TBC
            </FilterChip>
            <FilterChip active={hasRfqOnly} onClick={() => setHasRfqOnly((value) => !value)}>
              Has RFQs
            </FilterChip>
            <span className="ml-auto text-[13px] text-slate-500 tabular-nums">
              {rows.length} {rows.length === 1 ? "line" : "lines"}
            </span>
          </div>
        </div>

        <div
          role="list"
          aria-label="Enquiry lines ready for an RFQ"
          tabIndex={0}
          onKeyDown={listKeyDown}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4 focus:outline-none"
        >
          {lines.isPending ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : lines.isError ? (
            <div className="rounded-[14px] border border-ink-800 bg-ink-900 p-4">
              <Alert tone="error">
                {lines.error instanceof Error ? lines.error.message : "Could not load enquiry lines."}
              </Alert>
              <button
                type="button"
                onClick={() => void lines.refetch()}
                className="btn-secondary mt-3 py-1.5 text-[15px]"
              >
                Retry
              </button>
            </div>
          ) : allRows.length === 0 ? (
            <div className="rounded-[14px] border border-ink-800 bg-ink-900">
              <EmptyState
                icon={<Inbox className="size-5" aria-hidden />}
                title="No lines are ready for an RFQ"
                description={
                  search
                    ? "No open line matches that search. Clear it or check the enquiry for a line still in sourcing."
                    : "A line needs a crane type and capacity before an RFQ can be raised from it. Add the line to an enquiry first."
                }
                action={
                  <Link to="/app/enquiries" className="btn-primary py-1.5 text-[15px]">
                    <ArrowLeft className="size-4" aria-hidden />
                    Go to enquiries
                  </Link>
                }
              />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-[14px] border border-ink-800 bg-ink-900 px-5 py-10 text-center">
              <Inbox className="mx-auto size-6 text-slate-500" aria-hidden />
              <p className="mt-2 text-sm font-medium text-white">No lines match these filters</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                Clear the search, state or line filters to see every line still open for sourcing.
              </p>
              <button type="button" onClick={clearFilters} className="btn-secondary mt-4 py-1.5 text-[15px]">
                Clear filters
              </button>
            </div>
          ) : (
            rows.map((line) => (
              <RaisableLineCard
                key={line.id}
                line={line}
                selected={line.id === selectedId}
                onSelect={() => {
                  setSelectedId(line.id);
                  setError(null);
                  setSheetOpen(true);
                }}
              />
            ))
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------ preview */}
      <aside
        aria-label="Draft RFQ preview"
        className="hidden w-[400px] shrink-0 flex-col overflow-hidden border-l border-ink-800 bg-ink-900 lg:flex"
      >
        {preview}
      </aside>

      {/* Below lg the preview is a bottom sheet opened by tapping a card. */}
      {sheetOpen && selected ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close draft preview"
            className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setSheetOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Draft RFQ preview"
            className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl border-t border-ink-800 bg-ink-900"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-4 py-3">
              <p className="text-sm font-medium text-white">Review the draft</p>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close draft preview"
                className="rounded-md p-1 text-slate-500 hover:bg-ink-850 hover:text-white"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{preview}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors duration-150",
        active
          ? "bg-white text-ink-950"
          : "border border-ink-800 text-slate-500 hover:border-ink-700 hover:bg-ink-850 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function RaisableLineCard({
  line,
  selected,
  onSelect,
}: {
  line: RaisableLine;
  selected: boolean;
  onSelect: () => void;
}) {
  const trail = trailPill(line.trailStatus);
  const start = line.startDateTbc
    ? "Start TBC"
    : line.requiredStartDate
      ? formatDate(line.requiredStartDate)
      : "Start not set";

  return (
    <div
      id={`raisable-line-${line.id}`}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group relative rounded-[14px] border px-4 py-3.5 transition-all duration-150",
        selected
          ? "border-accent-500/70 bg-ink-850 shadow-[0_0_0_1px_rgba(196,68,63,0.25),0_0_24px_rgba(196,68,63,0.10)]"
          : "border-ink-800 bg-ink-900 hover:border-ink-700 hover:bg-ink-850",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${line.enquiryNo} line ${line.lineNo}: ${line.craneTypeName ?? line.craneTypeCode ?? "crane"}, ${capacityLabel(line)}`}
        className="absolute inset-0 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      />

      <div className="pointer-events-none relative flex items-start gap-3">
        <div className="flex w-[68px] shrink-0 flex-col items-center rounded-lg border border-ink-800 bg-ink-850 px-2 py-1.5">
          <span className="text-sm font-semibold tabular-nums text-white">{capacityLabel(line)}</span>
          <span className="mt-0.5 text-[12px] text-slate-500 tabular-nums">qty {line.quantity}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-mono text-[12px] tracking-[0.08em] text-slate-500 uppercase">
              {line.enquiryNo} / line {line.lineNo}
            </p>
            <StatusPill tone={trail.tone} className="shrink-0">
              {trail.label}
            </StatusPill>
          </div>

          <p className="mt-1 truncate text-[17px] font-semibold text-white">
            {line.craneTypeName ?? line.craneTypeCode ?? "No crane type"}
          </p>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-slate-500">
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{placeOf(line)}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3 shrink-0" aria-hidden />
              {start}
            </span>
            {line.rfqCount > 0 ? (
              <span className="text-amber-600">
                {line.rfqCount} RFQ{line.rfqCount === 1 ? "" : "s"} already
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftPreview({
  line,
  deadline,
  onDeadline,
  days,
  warnings,
  error,
  pending,
  onCreate,
}: {
  line: RaisableLine | null;
  deadline: string;
  onDeadline: (value: string) => void;
  days: number | null;
  warnings: string[];
  error: string | null;
  pending: boolean;
  onCreate: () => void;
}) {
  if (!line) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <Send className="size-6 text-slate-500" aria-hidden />
        <p className="mt-2 text-sm font-medium text-white">Nothing selected</p>
        <p className="mt-1 text-xs text-slate-500">
          Pick an enquiry line to see exactly what the vendor will be sent.
        </p>
      </div>
    );
  }

  const trail = trailPill(line.trailStatus);
  const presets = [3, 7, 14] as const;
  const start = line.startDateTbc
    ? "To be confirmed"
    : line.requiredStartDate
      ? formatDate(line.requiredStartDate)
      : "—";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-ink-800 px-5 py-4">
        <p className="text-[12px] font-medium tracking-[0.14em] text-slate-500 uppercase">
          Draft preview · what the vendor sees
        </p>
        <h2 className="mt-1 text-lg leading-tight font-semibold text-white">
          {line.quantity} × {line.craneTypeName ?? line.craneTypeCode ?? "Crane"} ·{" "}
          {capacityLabel(line)}
        </h2>
        <p className="mt-0.5 font-mono text-[13px] text-slate-500">
          {line.enquiryNo} / line {line.lineNo}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StatusPill tone={trail.tone}>{trail.label}</StatusPill>
          <span className="inline-flex items-center gap-1 rounded-full border border-ink-800 bg-ink-850 px-2 py-0.5 text-[13px] text-slate-600">
            <MapPin className="size-3 text-accent-400" aria-hidden />
            {placeOf(line)}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <PreviewFact label="Crane type" value={line.craneTypeName ?? line.craneTypeCode ?? "—"} />
          <PreviewFact label="Capacity" value={capacityLabel(line)} />
          <PreviewFact label="Quantity" value={String(line.quantity)} />
          <PreviewFact label="Required start" value={start} mono={!line.startDateTbc && Boolean(line.requiredStartDate)} />
          <PreviewFact label="Site" value={placeOf(line)} />
          <PreviewFact
            label="State / pincode"
            value={[line.siteStateName, line.sitePincode].filter(Boolean).join(" · ") || "—"}
            mono={Boolean(line.sitePincode)}
          />
        </dl>

        <p className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2 text-[13px] leading-relaxed text-slate-500">
          The draft is prefilled from the line. Customer name and address, the rental budget,
          internal notes and the Sales Partner&rsquo;s name are never copied into an RFQ.
        </p>

        <div className="rounded-xl border border-ink-800 bg-ink-850/60 p-3">
          <label
            htmlFor="rfq-new-deadline"
            className="text-[12px] font-medium tracking-[0.12em] text-slate-500 uppercase"
          >
            Submission deadline
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id="rfq-new-deadline"
              type="date"
              value={deadline}
              onChange={(event) => onDeadline(event.target.value)}
              className="field-input h-9 flex-1 py-0 text-[15px]"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {presets.map((preset) => {
              const value = deadlineInDays(preset);
              const active = deadline === value;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onDeadline(value)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors duration-150",
                    active
                      ? "bg-white text-ink-950"
                      : "border border-ink-700 text-slate-500 hover:bg-ink-800 hover:text-white",
                  )}
                >
                  +{preset}d
                </button>
              );
            })}
          </div>
          <p
            className={cn(
              "mt-2 flex items-center gap-1.5 text-[13px] tabular-nums",
              days !== null && days < 0
                ? "text-red-600"
                : days !== null && days <= 3
                  ? "text-amber-600"
                  : "text-slate-500",
            )}
          >
            <Clock className="size-3" aria-hidden />
            {respondLabel(days)}
          </p>
        </div>

        {warnings.length > 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-amber-600">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Worth checking first
            </p>
            <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-amber-700">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>

      <div className="sticky bottom-0 shrink-0 border-t border-ink-800 bg-ink-900 px-5 py-4">
        <button
          type="button"
          onClick={onCreate}
          disabled={pending || deadline === ""}
          className="btn-primary w-full py-2 text-[15px]"
        >
          {pending ? <Spinner /> : <Send className="size-4" aria-hidden />}
          {pending ? "Creating the draft" : "Create draft RFQ"}
        </button>
        <p className="mt-2 text-center text-[13px] text-slate-500">
          Creates a draft. Vendors are not emailed until you choose them and send.
        </p>
      </div>
    </div>
  );
}

function PreviewFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium tracking-[0.1em] text-slate-500 uppercase">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-[15px] text-slate-800",
          mono && "font-mono text-xs",
        )}
        title={value}
      >
        {value || "—"}
      </dd>
    </div>
  );
}


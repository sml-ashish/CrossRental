import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Mail,
  MapPin,
  Plus,
  Ruler,
  Send,
  Sparkles,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { Badge } from "@/components/ui/badge";
import { CountdownChip } from "@/components/ui/countdown-chip";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill";
import { cn } from "@/lib/cn";
import {
  createRfqFromLine,
  listRaisableLines,
  type RaisableLine,
} from "@/lib/enquiries";
import { craneTypeLabel, siteLabel } from "@/lib/format";
import {
  listApprovedVendors,
  listRfqs,
  sendRfq,
  type RfqListRecipient,
  type RfqListRow,
  type ResponseStatus,
} from "@/lib/rfqs";
import {
  deadlineCountdown,
  durationLabel,
  formatDeadlineDate,
  formatStartShort,
} from "@/lib/rfq-display";
import {
  matchLine,
  matchRfq,
  sortByFit,
  type CraneMatch,
  type FreeWindow,
  type MatchLevel,
  type MatchReason,
  type MatchCrane,
} from "@/lib/craneRfqMatch";
import { todayKey } from "@/lib/availability";

/**
 * "Request this crane" and "Start an RFQ" open this one window.
 *
 * The crane is already found, so the only useful question left is which live
 * requirement it can be offered against. Every row is an RFQ that has not sent
 * yet or a line with no RFQ, sorted by how well this crane fits and explained in
 * plain words. Fit is a hint, never a gate — the server still owns every rule
 * about what may be sent.
 *
 * Vendor-safe fields only: enquiry number/line, crane type and capacity, site
 * city and state, required start, duration and the quote deadline. The optional
 * line fields are chosen in the picker on each line card; the customer, the
 * address, the budget and the Sales Partner never enter this component.
 */

export type RequestCraneTarget = MatchCrane;

export interface RequestCraneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  crane: RequestCraneTarget;
  /** Calendar only: the free run for this crane inside the period on screen. */
  freeWindow?: FreeWindow;
  /**
   * Calendar only: what is in the way when the crane has no free day in the
   * period at all. Without it the header would claim availability is merely
   * "not recorded", which is a different and misleading thing.
   */
  availabilityNote?: string;
}

type RfqRow = {
  kind: "rfq";
  key: string;
  rfq: RfqListRow;
  match: CraneMatch;
  requiredStartDate: string | null;
  invited: RfqListRecipient | null;
};

type LineRow = {
  kind: "line";
  key: string;
  line: RaisableLine;
  match: CraneMatch;
  requiredStartDate: string | null;
};

const DAY = 86_400_000;
const PRESETS = [5, 7, 10] as const;

function deadlineInDays(days: number): string {
  const date = new Date(Date.now() + days * DAY);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function invitedFor(rfq: RfqListRow, vendorName: string): RfqListRecipient | null {
  const key = normalise(vendorName);
  return rfq.recipients.find((recipient) => normalise(recipient.vendorName) === key) ?? null;
}

const RESPONSE_ROW_LABEL: Record<ResponseStatus, string> = {
  PENDING: "Invited",
  QUOTED: "Quoted",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  FINALISED: "Finalised",
};

const RESPONSE_TONE: Record<ResponseStatus, StatusPillTone> = {
  PENDING: "blue",
  QUOTED: "emerald",
  DECLINED: "red",
  EXPIRED: "muted",
  FINALISED: "muted",
};

const LEVEL_LABEL: Record<MatchLevel, string> = {
  best: "Best match",
  possible: "Possible match",
  check: "Check fit",
};

const LEVEL_TONE = {
  best: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
  possible: "border-blue-500/30 bg-blue-500/10 text-blue-600",
  check: "border-amber-500/30 bg-amber-500/10 text-amber-600",
} as const;

function FitBadge({ level }: { level: MatchLevel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-semibold tracking-wide uppercase",
        LEVEL_TONE[level],
      )}
    >
      {level === "best" ? <Sparkles className="size-2.5" aria-hidden /> : null}
      {LEVEL_LABEL[level]}
    </span>
  );
}

function ReasonItem({ reason }: { reason: MatchReason }) {
  return (
    <li className="flex items-start gap-1.5 text-[13px] leading-4">
      {reason.ok ? (
        <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" aria-hidden />
      )}
      <span className={reason.ok ? "text-slate-500" : "text-amber-600"}>{reason.text}</span>
    </li>
  );
}

function ReasonList({ match }: { match: CraneMatch }) {
  const shown = match.reasons.slice(0, 3);
  const rest = match.reasons.slice(3);
  if (match.reasons.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {shown.map((reason, index) => (
        <ReasonItem key={`${index}-${reason.text}`} reason={reason} />
      ))}
      {rest.length > 0 ? (
        <li>
          <details className="group">
            <summary className="list-none text-[13px] text-slate-500 transition-colors hover:text-slate-300 [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1">
                <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
                {rest.length} more check{rest.length === 1 ? "" : "s"}
              </span>
            </summary>
            <ul className="mt-1 space-y-1 border-l border-ink-800 pl-2.5">
              {rest.map((reason, index) => (
                <ReasonItem key={`${index}-${reason.text}`} reason={reason} />
              ))}
            </ul>
          </details>
        </li>
      ) : null}
    </ul>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</dt>
      <dd className="truncate text-[14px] text-slate-700">{value}</dd>
    </div>
  );
}

function RowShell({
  match,
  children,
  header,
}: {
  match: CraneMatch;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article
      className={cn(
        "rounded-xl border bg-ink-850/60 p-3",
        match.level === "check" ? "border-amber-500/25" : "border-ink-800",
      )}
    >
      {header}
      <ReasonList match={match} />
      {children}
    </article>
  );
}

function RfqCard({
  row,
  vendorName,
  vendorBlocked,
  confirming,
  sendPending,
  sentNumber,
  error,
  onOpen,
  onConfirmStart,
  onConfirmCancel,
  onConfirmSend,
}: {
  row: RfqRow;
  vendorName: string;
  vendorBlocked: boolean;
  confirming: boolean;
  sendPending: boolean;
  sentNumber?: string;
  error?: string;
  onOpen: () => void;
  onConfirmStart: () => void;
  onConfirmCancel: () => void;
  onConfirmSend: () => void;
}) {
  const { rfq, match, invited } = row;
  const countdown = deadlineCountdown(rfq.submissionDeadline, rfq.status);
  const disabledReason = vendorBlocked
    ? "This vendor is not approved or is inactive."
    : rfq.status === "DRAFT"
      ? "Open the draft with this vendor selected."
      : `Send this RFQ to ${vendorName}.`;

  return (
    <RowShell
      match={match}
      header={
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[14px] font-medium text-slate-800">{rfq.rfqNumber}</span>
              <StatusPill tone={rfq.status === "DRAFT" ? "neutral" : "blue"}>
                {rfq.status === "DRAFT" ? "Draft" : "Sent"}
              </StatusPill>
              {invited ? (
                <StatusPill tone={RESPONSE_TONE[invited.responseStatus]}>
                  {RESPONSE_ROW_LABEL[invited.responseStatus]}
                </StatusPill>
              ) : null}
              <FitBadge level={match.level} />
            </div>
            <p className="mt-1 truncate text-[14px] text-slate-500">
              {rfq.enquiryNo} · line {rfq.lineNo}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <CountdownChip
              label={countdown.label}
              tone={countdown.tone}
              urgent={countdown.tone === "soon"}
            />
            <span className="text-[13px] text-slate-500" title={formatDeadlineDate(rfq.submissionDeadline)}>
              due {formatDeadlineDate(rfq.submissionDeadline)}
            </span>
          </div>
        </div>
      }
    >
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Fact
          label="Crane"
          value={`${craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} · ${rfq.capacityT} t`}
        />
        <Fact label="Site" value={siteLabel(rfq)} />
        <Fact
          label="Required start"
          value={rfq.startDateTbc ? "TBC" : formatStartShort(rfq.requiredStartDate)}
        />
        <Fact label="Duration" value={durationLabel(rfq.durationValue, rfq.durationUnit)} />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {sentNumber ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[14px] text-emerald-600">
            <Check className="size-3.5 shrink-0" aria-hidden />
            <span>Sent to {vendorName}.</span>
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: rfq.id }}
              search={{ tab: "vendors" }}
              className="font-medium underline underline-offset-2 hover:text-emerald-500"
            >
              Open {sentNumber}
            </Link>
          </div>
        ) : invited ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-slate-500">
            <Check className="size-3.5" aria-hidden />
            Already invited · {RESPONSE_ROW_LABEL[invited.responseStatus].toLowerCase()}
          </span>
        ) : rfq.status === "DRAFT" ? (
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={onOpen}
            disabled={vendorBlocked}
            title={disabledReason}
          >
            <Plus className="size-3.5" aria-hidden />
            Add vendor and open RFQ
          </button>
        ) : confirming ? (
          <div className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
            <p className="text-[14px] text-amber-700">Send this RFQ to {vendorName} now?</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                autoFocus
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={onConfirmSend}
                disabled={sendPending}
              >
                {sendPending ? <Spinner /> : <Send className="size-3.5" aria-hidden />}
                {sendPending ? "Sending…" : "Confirm send"}
              </button>
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={onConfirmCancel}
                disabled={sendPending}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={onConfirmStart}
            disabled={vendorBlocked}
            title={disabledReason}
          >
            <Mail className="size-3.5" aria-hidden />
            Send to {vendorName}
          </button>
        )}
      </div>

      {error ? (
        <div className="mt-2">
          <Alert title="The RFQ was not sent">{error}</Alert>
        </div>
      ) : null}
    </RowShell>
  );
}

function LineCard({
  row,
  vendorName,
  vendorBlocked,
  pending,
  deadline,
  error,
  onDeadline,
  onCreate,
}: {
  row: LineRow;
  vendorName: string;
  vendorBlocked: boolean;
  pending: boolean;
  deadline: string;
  error?: string;
  onDeadline: (value: string) => void;
  onCreate: (fields: RfqLineFieldKey[], remark?: string) => void;
}) {
  const { line, match } = row;
  const today = todayKey();
  const [fieldsOpen, setFieldsOpen] = useState(false);

  return (
    <RowShell
      match={match}
      header={
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[14px] font-medium text-slate-800">
                {line.enquiryNo} · line {line.lineNo}
              </span>
              <FitBadge level={match.level} />
              {line.rfqCount > 0 ? (
                <Badge tone="purple">
                  Re-tender · {line.rfqCount} RFQ{line.rfqCount === 1 ? "" : "s"} already
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[14px] text-slate-500">No RFQ raised on this line yet</p>
          </div>
        </div>
      }
    >
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Fact
          label="Crane"
          value={`${craneTypeLabel(line.craneTypeName)} · ${line.capacityT === null ? "—" : `${line.capacityT} t`}`}
        />
        <Fact
          label="Site"
          value={siteLabel({
            siteLocation: line.siteLocation,
            siteState: line.siteStateName ? { name: line.siteStateName } : null,
          })}
        />
        <Fact
          label="Required start"
          value={line.startDateTbc ? "TBC" : formatStartShort(line.requiredStartDate)}
        />
        <Fact label="Quantity" value={String(line.quantity)} />
      </dl>

      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Quotes due
          </span>
          <input
            type="date"
            value={deadline}
            min={today}
            onChange={(event) => onDeadline(event.target.value)}
            className="field-input h-8 w-[9.5rem] px-2 py-0 text-[14px]"
            aria-label={`Submission deadline for ${line.enquiryNo} line ${line.lineNo}`}
          />
        </label>

        <div className="flex flex-wrap gap-1" aria-label="Deadline presets">
          {PRESETS.map((preset) => {
            const value = deadlineInDays(preset);
            const active = deadline === value;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                onClick={() => onDeadline(value)}
                className={cn(
                  "rounded-full px-2 py-1 text-[13px] font-medium transition-colors",
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

        <button
          type="button"
          className="btn-primary ml-auto px-3 py-1.5 text-xs"
          onClick={() => setFieldsOpen(true)}
          disabled={vendorBlocked || pending || deadline === "" || deadline < today}
          title={
            vendorBlocked
              ? "This vendor is not approved or is inactive."
              : "Choose the line fields, then create the RFQ with this vendor selected."
          }
        >
          {pending ? <Spinner /> : <Plus className="size-3.5" aria-hidden />}
          {pending ? "Creating…" : `Create RFQ and invite ${vendorName}`}
        </button>
      </div>

      {error ? (
        <div className="mt-2">
          <Alert title="The RFQ was not created">{error}</Alert>
        </div>
      ) : null}

      <RfqFieldsScreen
        open={fieldsOpen}
        lineId={line.id}
        title={`Create RFQ and invite ${vendorName}`}
        lineLabel={`${line.enquiryNo} · line ${line.lineNo} · ${craneTypeLabel(line.craneTypeName)}${
          line.capacityT === null ? "" : ` · ${line.capacityT} t`
        }`}
        deadline={deadline}
        onDeadline={onDeadline}
        confirmLabel="Create RFQ and invite"
        pending={pending}
        error={error ?? null}
        onConfirm={(keys, remark) => {
          setFieldsOpen(false);
          onCreate(keys, remark);
        }}
        onClose={() => setFieldsOpen(false)}
      />
    </RowShell>
  );
}

function SectionHeading({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="min-w-0">
        <h3 id={id} className="text-[15px] font-semibold tracking-tight text-slate-900">
          {title}
        </h3>
        {children ? <p className="mt-0.5 text-[13px] leading-4 text-slate-500">{children}</p> : null}
      </div>
      <span className="rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[12px] font-medium text-slate-500 tabular-nums">
        {count}
      </span>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-xl border border-ink-800 bg-ink-850/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="mt-2 h-2.5 w-40" />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-full" />
          </div>
          <Skeleton className="mt-3 h-7 w-36" />
        </div>
      ))}
    </div>
  );
}

function availabilityText(
  crane: RequestCraneTarget,
  freeWindow?: FreeWindow,
  availabilityNote?: string,
): string {
  if (availabilityNote) return availabilityNote;
  if (freeWindow) {
    return freeWindow.to
      ? `Free ${formatStartShort(freeWindow.from)} – ${formatStartShort(freeWindow.to)}`
      : `Free from ${formatStartShort(freeWindow.from)}`;
  }
  if (crane.availableFrom) return `Free from ${formatStartShort(crane.availableFrom)}`;
  return "Availability not recorded";
}

export function RequestCraneDialog({
  open,
  onOpenChange,
  crane,
  freeWindow,
  availabilityNote,
}: RequestCraneDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmingRfqId, setConfirmingRfqId] = useState<string | null>(null);
  const [sentByRfq, setSentByRfq] = useState<Record<string, string>>({});
  const [sendError, setSendError] = useState<Record<string, string>>({});
  const [deadlines, setDeadlines] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<Record<string, string>>({});

  // The discovery card is reused when a different crane is selected, so no
  // transient state may follow the window from one crane to the next: a "Sent"
  // confirmation belongs to the vendor it was sent to, and a chosen deadline to
  // the line it was chosen for.
  useEffect(() => {
    setConfirmingRfqId(null);
    setSentByRfq({});
    setSendError({});
    setDeadlines({});
    setCreateError({});
  }, [crane.craneId, crane.vendorId]);

  // The same unfiltered read the tracking screen and the vendor picker use, so
  // opening this window never adds a request of its own.
  const rfqsQuery = useQuery({
    queryKey: ["rfqs", "summary"],
    queryFn: () => listRfqs({}),
    enabled: open,
  });

  const linesQuery = useQuery({
    queryKey: ["raisable-lines", "request-crane"],
    queryFn: () => listRaisableLines(),
    enabled: open,
  });

  // The same approved list the RFQ picker reads. If this vendor is missing from
  // it, the server would refuse every send anyway, so the dialog says so once
  // and disables the actions rather than letting each row fail separately.
  const approvedQuery = useQuery({
    queryKey: ["rfq-approved-vendors", ""],
    queryFn: () => listApprovedVendors(),
    enabled: open,
  });

  const vendorBlocked =
    approvedQuery.isSuccess &&
    !approvedQuery.data.vendors.some((vendor) => vendor.id === crane.vendorId);

  const rows = useMemo(() => {
    const now = Date.now();
    const rfqs = (rfqsQuery.data?.rfqs ?? []).filter(
      (rfq) =>
        (rfq.status === "DRAFT" || rfq.status === "SENT") &&
        new Date(rfq.submissionDeadline).getTime() > now,
    );

    const rfqRows: RfqRow[] = rfqs.map((rfq) => ({
      kind: "rfq",
      key: `rfq-${rfq.id}`,
      rfq,
      match: matchRfq(crane, rfq, freeWindow),
      requiredStartDate: rfq.startDateTbc ? null : rfq.requiredStartDate,
      invited: invitedFor(rfq, crane.vendorName),
    }));

    // A line already backing one of those RFQs is not offered again. Re-tenders
    // (rfqCount > 0 on a closed line) still are, and say so on the row. Older
    // RFQs can lack `enquiryLineId`, so the enquiry number and line are matched
    // too.
    const lineIdsWithRfq = new Set(
      rfqs.map((rfq) => rfq.enquiryLineId).filter((id): id is string => Boolean(id)),
    );
    const enquiryLinesWithRfq = new Set(rfqs.map((rfq) => `${rfq.enquiryNo}|${rfq.lineNo}`));

    const lineRows: LineRow[] = (linesQuery.data?.lines ?? [])
      .filter(
        (line) =>
          !lineIdsWithRfq.has(line.id) &&
          !enquiryLinesWithRfq.has(`${line.enquiryNo}|${line.lineNo}`),
      )
      .map((line) => ({
        kind: "line",
        key: `line-${line.id}`,
        line,
        match: matchLine(crane, line, freeWindow),
        requiredStartDate: line.startDateTbc ? null : line.requiredStartDate,
      }));

    return {
      openRfqs: sortByFit(rfqRows.filter((row) => row.match.level !== "check")),
      lines: sortByFit(lineRows.filter((row) => row.match.level !== "check")),
      notFit: sortByFit(
        [...rfqRows, ...lineRows].filter((row) => row.match.level === "check"),
      ),
    };
  }, [crane, freeWindow, linesQuery.data, rfqsQuery.data]);

  const send = useMutation({
    mutationFn: (rfq: RfqListRow) => sendRfq(rfq.id, [crane.vendorId], ["EMAIL"]),
    onSuccess: (response, rfq) => {
      const result = response.result;
      if (result.sent > 0) {
        setSentByRfq((previous) => ({ ...previous, [rfq.id]: rfq.rfqNumber }));
        setSendError((previous) => {
          const next = { ...previous };
          delete next[rfq.id];
          return next;
        });
      } else {
        const failure =
          result.results.find((entry) => entry.error)?.error ??
          "The message could not be delivered. Check the vendor's email address.";
        setSendError((previous) => ({ ...previous, [rfq.id]: failure }));
      }
      setConfirmingRfqId(null);
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
    },
    onError: (error, rfq) => {
      setSendError((previous) => ({
        ...previous,
        [rfq.id]: error instanceof Error ? error.message : "The RFQ could not be sent.",
      }));
      setConfirmingRfqId(null);
    },
  });

  const raise = useMutation({
    mutationFn: ({
      line,
      deadline,
      fields,
      remark,
    }: {
      line: RaisableLine;
      deadline: string;
      fields: RfqLineFieldKey[];
      remark?: string;
    }) => createRfqFromLine(line.id, deadline, fields, remark),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
      void queryClient.invalidateQueries({ queryKey: ["enquiries"] });
      onOpenChange(false);
      void navigate({
        to: "/app/rfqs/$rfqId",
        params: { rfqId: created.rfq.id },
        search: { vendor: crane.vendorId },
      });
    },
    onError: (error, variables) => {
      setCreateError((previous) => ({
        ...previous,
        [variables.line.id]:
          error instanceof Error ? error.message : "The RFQ could not be created.",
      }));
    },
  });

  function openDraft(rfqId: string) {
    onOpenChange(false);
    void navigate({
      to: "/app/rfqs/$rfqId",
      params: { rfqId },
      search: { vendor: crane.vendorId },
    });
  }

  const loading = rfqsQuery.isLoading || linesQuery.isLoading;
  const nothingToDo =
    rfqsQuery.isSuccess &&
    linesQuery.isSuccess &&
    rows.openRfqs.length === 0 &&
    rows.lines.length === 0 &&
    rows.notFit.length === 0;
  const blockedReason = vendorBlocked
    ? "This vendor is not approved or is inactive, so no RFQ can be sent."
    : null;

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link
        to="/app/enquiries/new"
        onClick={() => onOpenChange(false)}
        className="inline-flex items-center gap-1.5 text-[14px] font-medium text-slate-600 transition-colors hover:text-white"
      >
        <Plus className="size-3.5" aria-hidden />
        Raise a new enquiry
      </Link>
      <Link
        to="/app/cranes/$craneId"
        params={{ craneId: crane.craneId }}
        onClick={() => onOpenChange(false)}
        className="btn-secondary px-3 py-1.5 text-xs"
      >
        <ArrowUpRight className="size-3.5" aria-hidden />
        Open crane
      </Link>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${crane.typeOfCraneName} · ${
        Number.isInteger(crane.capacityT) ? crane.capacityT : crane.capacityT.toFixed(1)
      } t`}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>{crane.vendorName}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" aria-hidden />
            {crane.currentLocation}, {crane.stateName}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Ruler className="size-3" aria-hidden />
            {crane.mainBoomM === null ? "boom not recorded" : `${crane.mainBoomM} m main boom`}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" aria-hidden />
            {availabilityText(crane, freeWindow, availabilityNote)}
          </span>
        </span>
      }
      footer={footer}
      closeLabel="Close request window"
    >
      <div className="space-y-4">
        {vendorBlocked ? (
          <Alert title="This vendor cannot be invited">
            The crane&rsquo;s vendor is not approved or is inactive. Approve or reinstate the vendor
            before sending an RFQ to it. The rows below still show how the crane fits.
          </Alert>
        ) : null}

        {rfqsQuery.isError ? (
          <Alert title="Could not load open RFQs">
            {(rfqsQuery.error as Error).message}
          </Alert>
        ) : null}
        {linesQuery.isError ? (
          <Alert title="Could not load enquiry lines">
            {(linesQuery.error as Error).message}
          </Alert>
        ) : null}

        {loading ? (
          <RowsSkeleton />
        ) : nothingToDo ? (
          <EmptyState
            icon={<Mail className="size-5" aria-hidden />}
            title="Nothing to send this crane to yet"
            description="There are no open RFQs and no enquiry lines waiting for an RFQ. Raise a new enquiry, or open the crane's own screen."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link
                  to="/app/enquiries/new"
                  onClick={() => onOpenChange(false)}
                  className="btn-primary px-3 py-1.5 text-xs"
                >
                  <Plus className="size-3.5" aria-hidden />
                  Raise a new enquiry
                </Link>
                <Link
                  to="/app/cranes/$craneId"
                  params={{ craneId: crane.craneId }}
                  onClick={() => onOpenChange(false)}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  <ArrowUpRight className="size-3.5" aria-hidden />
                  Open crane
                </Link>
              </div>
            }
          />
        ) : (
          <>
            <section aria-labelledby="request-open-rfqs">
              <SectionHeading
                id="request-open-rfqs"
                title="Open RFQs"
                count={rows.openRfqs.length}
              >
                Drafts you can add this vendor to, and sent RFQs you can add them to.
              </SectionHeading>
              <div className="mt-2 space-y-2">
                {rows.openRfqs.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-ink-800 px-3 py-4 text-[14px] text-slate-500">
                    No open RFQ is a good fit for this crane. The mismatches are under “Not a fit”.
                  </p>
                ) : (
                  rows.openRfqs.map((row) => (
                    <RfqCard
                      key={row.key}
                      row={row}
                      vendorName={crane.vendorName}
                      vendorBlocked={vendorBlocked}
                      confirming={confirmingRfqId === row.rfq.id}
                      sendPending={send.isPending && send.variables?.id === row.rfq.id}
                      sentNumber={sentByRfq[row.rfq.id]}
                      error={sendError[row.rfq.id]}
                      onOpen={() => openDraft(row.rfq.id)}
                      onConfirmStart={() => setConfirmingRfqId(row.rfq.id)}
                      onConfirmCancel={() => setConfirmingRfqId(null)}
                      onConfirmSend={() => send.mutate(row.rfq)}
                    />
                  ))
                )}
              </div>
            </section>

            <section aria-labelledby="request-lines">
              <SectionHeading
                id="request-lines"
                title="Lines that need an RFQ"
                count={rows.lines.length}
              >
                Raising a draft does not email the vendor; you send it from the RFQ. The draft opens
                with this vendor selected.
              </SectionHeading>
              <div className="mt-2 space-y-2">
                {rows.lines.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-ink-800 px-3 py-4 text-[14px] text-slate-500">
                    No enquiry line without an RFQ is a good fit. The mismatches are under “Not a
                    fit”.
                  </p>
                ) : (
                  rows.lines.map((row) => {
                    const deadline = deadlines[row.line.id] ?? deadlineInDays(5);
                    return (
                      <LineCard
                        key={row.key}
                        row={row}
                        vendorName={crane.vendorName}
                        vendorBlocked={vendorBlocked}
                        pending={raise.isPending && raise.variables?.line.id === row.line.id}
                        deadline={deadline}
                        error={createError[row.line.id]}
                        onDeadline={(value) =>
                          setDeadlines((previous) => ({ ...previous, [row.line.id]: value }))
                        }
                        onCreate={(fields, remark) =>
                          raise.mutate({ line: row.line, deadline, fields, remark })
                        }
                      />
                    );
                  })
                )}
              </div>
            </section>

            <details className="rounded-xl border border-ink-800 bg-ink-850/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-[14px] font-medium text-slate-600 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2">
                  <AlertTriangle className="size-3.5 text-amber-500" aria-hidden />
                  Not a fit
                </span>
                <span className="text-[13px] text-slate-500 tabular-nums">
                  {rows.notFit.length} check{rows.notFit.length === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="space-y-2 border-t border-ink-800 p-2.5">
                {rows.notFit.length === 0 ? (
                  <p className="px-1 py-2 text-[14px] text-slate-500">
                    No crane type or capacity mismatch. Every live row is above.
                  </p>
                ) : (
                  rows.notFit.map((row) =>
                    row.kind === "rfq" ? (
                      <RfqCard
                        key={row.key}
                        row={row}
                        vendorName={crane.vendorName}
                        vendorBlocked={vendorBlocked}
                        confirming={confirmingRfqId === row.rfq.id}
                        sendPending={send.isPending && send.variables?.id === row.rfq.id}
                        sentNumber={sentByRfq[row.rfq.id]}
                        error={sendError[row.rfq.id]}
                        onOpen={() => openDraft(row.rfq.id)}
                        onConfirmStart={() => setConfirmingRfqId(row.rfq.id)}
                        onConfirmCancel={() => setConfirmingRfqId(null)}
                        onConfirmSend={() => send.mutate(row.rfq)}
                      />
                    ) : (
                      <LineCard
                        key={row.key}
                        row={row}
                        vendorName={crane.vendorName}
                        vendorBlocked={vendorBlocked}
                        pending={raise.isPending && raise.variables?.line.id === row.line.id}
                        deadline={deadlines[row.line.id] ?? deadlineInDays(5)}
                        error={createError[row.line.id]}
                        onDeadline={(value) =>
                          setDeadlines((previous) => ({ ...previous, [row.line.id]: value }))
                        }
                        onCreate={(fields, remark) =>
                          raise.mutate({
                            line: row.line,
                            deadline: deadlines[row.line.id] ?? deadlineInDays(5),
                            fields,
                            remark,
                          })
                        }
                      />
                    ),
                  )
                )}
              </div>
            </details>

            {blockedReason ? <p className="text-[13px] text-slate-500">{blockedReason}</p> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}


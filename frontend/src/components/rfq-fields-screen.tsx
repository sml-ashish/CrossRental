import { useId, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, Check, EyeOff } from "lucide-react";
import {
  RFQ_LINE_FIELD_KEYS,
  groupRfqLineFields,
  rfqLineFieldOptions,
  type RfqLineFieldKey,
} from "@/lib/rfqLineFields";
import { useRfqLineFieldSelection } from "@/components/rfq-line-field-picker";
import type { EnquiryLine } from "@/lib/enquiries";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { addDays } from "@/lib/enquiryDetail";
import { craneTypeLabel, formatCalendarDate } from "@/lib/format";
import { durationLabel } from "@/lib/rfq-display";
import { cn } from "@/lib/cn";

/**
 * The "choose what goes into the RFQ" screen.
 *
 * Every path that raises an RFQ from an enquiry line opens this first. It lists
 * each field the line has filled in as a ticked checkbox (all ticked to start),
 * with a running count and Select all / Clear. It says plainly which facts are
 * always sent and that the customer, address and budget never are. Where the
 * path carries a submission deadline, that is set on this same screen, so one
 * confirmation raises the RFQ.
 *
 * Only the ticked keys are handed to `onConfirm`; the backend still owns the
 * allow-list and re-checks them.
 */

export interface RfqFieldsScreenProps {
  open: boolean;
  onClose: () => void;
  /**
   * The ticked field keys, in the canonical field order, and the optional
   * remark (trimmed; `undefined` when left empty).
   */
  onConfirm: (keys: RfqLineFieldKey[], remark?: string) => void;
  title: string;
  /** One line naming the enquiry line, shown under the title. */
  lineLabel?: string;
  /** A full line when the caller already has it; otherwise `lineId` is fetched. */
  line?: EnquiryLine | null;
  lineId?: string | null;
  /** `YYYY-MM-DD`. Omit `onDeadline` for a path that has no deadline. */
  deadline?: string;
  onDeadline?: (day: string) => void;
  confirmLabel?: string;
  pending?: boolean;
  error?: string | null;
  /** Heading for `error`; defaults to "The RFQ was not created". */
  errorTitle?: string;
  /** Extra settings above the deadline, in the left pane (e.g. who it goes to). */
  extra?: ReactNode;
  /** Freezes every input once the RFQ exists, so a retry cannot change it. */
  locked?: boolean;
  /** Blocks the confirm button for a reason the caller owns. */
  confirmDisabled?: boolean;
  /**
   * Replaces the whole body once the RFQ has been sent, with `outcomeFooter`
   * as its footer, so the result appears in this same window.
   */
  outcome?: ReactNode;
  outcomeFooter?: ReactNode;
}

const DEADLINE_PRESETS = [3, 7, 14] as const;
const DAY_MS = 86_400_000;
const REMARK_MAX = 1000;

/** Today's calendar day in the user's own time zone, as `YYYY-MM-DD`. */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function deadlineStatus(deadline: string, today: string): { text: string; bad: boolean } {
  if (!isDay(deadline)) return { text: "Choose a submission deadline.", bad: true };
  const days = daysBetween(today, deadline);
  if (days < 0) return { text: "That date has already passed.", bad: true };
  if (days === 0) return { text: `Today · ${longDay(deadline)}`, bad: false };
  if (days === 1) return { text: `Tomorrow · ${longDay(deadline)}`, bad: false };
  return { text: `In ${days} days · ${longDay(deadline)}`, bad: false };
}

/** The core facts every RFQ carries. Values are shown only when the line has them. */
function alwaysSent(line: EnquiryLine | null): Array<{ label: string; value?: string }> {
  return [
    { label: "Crane type", value: line ? craneTypeLabel(line.craneTypeName) : undefined },
    {
      label: "Capacity",
      value: line && line.capacityT !== null ? `${line.capacityT} t` : undefined,
    },
    { label: "Quantity", value: line ? String(line.quantity) : undefined },
    { label: "Site" },
    {
      label: "Start date",
      value: line?.requiredStartDate ? formatCalendarDate(line.requiredStartDate) : undefined,
    },
    {
      label: "Duration",
      value:
        line && line.durationValue !== null && line.durationUnit
          ? durationLabel(line.durationValue, line.durationUnit)
          : undefined,
    },
  ];
}

export function RfqFieldsScreen({
  open,
  onClose,
  onConfirm,
  title,
  lineLabel,
  line: providedLine,
  lineId,
  deadline,
  onDeadline,
  confirmLabel = "Create RFQ",
  pending = false,
  error = null,
  errorTitle = "The RFQ was not created",
  extra,
  locked = false,
  confirmDisabled = false,
  outcome,
  outcomeFooter,
}: RfqFieldsScreenProps) {
  // Each time the screen opens it starts again from "every field ticked". The
  // session number is bumped during render (not in an effect) so the first
  // painted frame already has the fresh defaults.
  const [wasOpen, setWasOpen] = useState(open);
  const [session, setSession] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((value) => value + 1);
  }

  const selection = useRfqLineFieldSelection({
    lineId,
    line: providedLine,
    enabled: open,
    resetKey: String(session),
  });
  const { line, keys, toggle, reset } = selection;

  const options = useMemo(() => (line ? rfqLineFieldOptions(line) : []), [line]);
  const groups = useMemo(() => groupRfqLineFields(options), [options]);
  const total = options.length;
  const selectedSet = useMemo(() => new Set(keys), [keys]);
  const selectedCount = options.filter((field) => selectedSet.has(field.key)).length;

  const today = localToday();
  const hasDeadline = deadline !== undefined && onDeadline !== undefined;
  const status = hasDeadline ? deadlineStatus(deadline, today) : null;

  const ready = selection.ready && !selection.loading && !selection.error;
  const frozen = pending || locked;
  const canConfirm = ready && !pending && !confirmDisabled && !(status?.bad ?? false);

  // Cleared with the rest of the selection each time the screen opens.
  const [remarkState, setRemarkState] = useState({ session: -1, text: "" });
  const remark = remarkState.session === session ? remarkState.text : "";
  const remarkId = useId();

  const deadlineId = useId();
  const deadlineHintId = `${deadlineId}-hint`;

  function clearAll() {
    // `toggle` is a functional update, so clearing one-by-one is safe in a batch.
    for (const key of keys) toggle(key);
  }

  function confirm() {
    if (!canConfirm) return;
    const picked = new Set(keys);
    const note = remark.trim();
    onConfirm(RFQ_LINE_FIELD_KEYS.filter((key) => picked.has(key)), note || undefined);
  }

  /** Tick or untick a whole group at once (the group header checkbox). */
  function toggleGroup(fields: Array<{ key: RfqLineFieldKey }>) {
    const allOn = fields.every((field) => selectedSet.has(field.key));
    for (const field of fields) {
      if (allOn || !selectedSet.has(field.key)) toggle(field.key);
    }
  }

  const sectionTitle = "text-[12px] font-semibold text-slate-600";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title={title}
      description={lineLabel}
      className="sm:h-[min(780px,90vh)] sm:max-w-[980px] sm:rounded-lg"
      bodyClassName="overflow-hidden p-0 sm:p-0"
      footer={
        outcome ? (
          outcomeFooter
        ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-slate-600" aria-live="polite">
            {ready
              ? total === 0
                ? "Only the core requirement will be sent."
                : selectedCount === 0
                  ? "No optional fields ticked — only the core requirement will be sent."
                  : `${selectedCount} optional field${selectedCount === 1 ? "" : "s"} will be sent.`
              : ""}
          </p>
          <div className="flex gap-2 sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="btn-secondary flex-1 !py-1.5 !text-[13px] sm:flex-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!canConfirm}
              className="btn-primary flex-1 !py-1.5 !text-[13px] sm:flex-none"
            >
              {pending ? <Spinner /> : null}
              {pending ? "Creating…" : confirmLabel}
            </button>
          </div>
        </div>
        )
      }
    >
      {/* Two panes on a desktop: the RFQ's own settings on the left, the field
          table on the right, each scrolling on its own. One column on a phone. */}
      {outcome ? (
        <div className="h-full overflow-y-auto px-4 py-4 sm:px-6">{outcome}</div>
      ) : (
      <div className="h-full overflow-y-auto lg:overflow-hidden">
        <div className="grid lg:h-full lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* ------------------------------------------------ settings pane */}
          <div className="space-y-5 border-b border-ink-800 bg-ink-950 px-4 py-4 sm:px-6 lg:overflow-y-auto lg:border-r lg:border-b-0">
            {error ? <Alert title={errorTitle}>{error}</Alert> : null}

            {extra}

            {hasDeadline && status ? (
              <section aria-label="Submission deadline">
                <label htmlFor={deadlineId} className={cn(sectionTitle, "flex items-center gap-1.5")}>
                  <CalendarClock className="size-3.5" aria-hidden />
                  Submission deadline
                </label>
                <input
                  id={deadlineId}
                  type="date"
                  value={deadline}
                  min={today}
                  disabled={frozen}
                  aria-invalid={status.bad}
                  aria-describedby={deadlineHintId}
                  onChange={(event) => onDeadline(event.target.value)}
                  className="field-input mt-1.5 h-9 py-0 text-[13px]"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {DEADLINE_PRESETS.map((days) => {
                    const value = addDays(today, days);
                    const active = deadline === value;
                    return (
                      <button
                        key={days}
                        type="button"
                        aria-pressed={active}
                        disabled={frozen}
                        onClick={() => onDeadline(value)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50",
                          active
                            ? "border-accent-500 bg-accent-500/10 text-accent-400"
                            : "border-ink-800 bg-ink-900 text-slate-600 hover:border-ink-700 hover:text-white",
                        )}
                      >
                        +{days} days
                      </button>
                    );
                  })}
                </div>
                <p
                  id={deadlineHintId}
                  className={cn("mt-1.5 text-[12px]", status.bad ? "text-red-500" : "text-slate-600")}
                >
                  {status.text}
                </p>
              </section>
            ) : null}

            <section aria-label="Remark" className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={remarkId} className={sectionTitle}>
                  Remark <span className="font-normal">(optional)</span>
                </label>
                <span className="text-[12px] text-slate-500 tabular-nums">
                  {remark.length}/{REMARK_MAX}
                </span>
              </div>
              <textarea
                id={remarkId}
                value={remark}
                rows={3}
                maxLength={REMARK_MAX}
                disabled={frozen}
                placeholder="Anything else the vendors should know"
                onChange={(event) => setRemarkState({ session, text: event.target.value })}
                className="field-input mt-1.5 resize-y text-[13px]"
              />
              <p className="mt-1 text-[12px] text-slate-500">
                Shown to vendors. Don&rsquo;t include the customer&rsquo;s name, address or budget.
              </p>
            </section>

            <section aria-label="Always sent">
              <h3 className={sectionTitle}>Always sent</h3>
              <ul className="mt-1.5 space-y-1">
                {alwaysSent(line).map((item) => (
                  <li key={item.label} className="flex items-start gap-2 text-[13px]">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
                    <span className="min-w-0 break-words text-slate-800">
                      {item.label}
                      {item.value ? <span className="text-slate-500"> · {item.value}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Never sent">
              <h3 className={sectionTitle}>Never sent</h3>
              <ul className="mt-1.5 space-y-1">
                {["Customer name", "Customer address", "Rental budget"].map((label) => (
                  <li key={label} className="flex items-start gap-2 text-[13px]">
                    <EyeOff className="mt-0.5 size-3.5 shrink-0 text-slate-500" aria-hidden />
                    <span className="text-slate-800">{label}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
                These stay on the enquiry whatever you tick.
              </p>
            </section>
          </div>

          {/* ------------------------------------------------ field table */}
          <section
            aria-label="Fields to send in the RFQ"
            className="min-w-0 bg-ink-900 lg:overflow-y-auto"
          >
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 bg-ink-900 px-4 py-2.5 sm:px-6">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-semibold text-white">Fields to send</h3>
                {ready && total > 0 ? (
                  <span
                    className="rounded-full bg-ink-800 px-2 py-px text-[12px] font-medium text-slate-600 tabular-nums"
                    aria-live="polite"
                  >
                    {selectedCount} of {total}
                  </span>
                ) : null}
              </div>
              {ready && total > 0 ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={reset}
                    disabled={frozen || selectedCount === total}
                    className="rounded-md px-2 py-1 text-[13px] font-medium text-accent-400 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={frozen || selectedCount === 0}
                    className="rounded-md px-2 py-1 text-[13px] font-medium text-accent-400 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Clear
                  </button>
                </div>
              ) : null}
            </div>

            {selection.error ? (
              <div className="p-4 sm:px-6">
                <Alert title="Could not load this line">
                  Check your connection and try again.
                  <button
                    type="button"
                    onClick={selection.retry}
                    className="mt-1 block font-medium underline underline-offset-2"
                  >
                    Retry
                  </button>
                </Alert>
              </div>
            ) : selection.loading ? (
              <p className="flex items-center gap-2 px-6 py-6 text-[13px] text-slate-600" role="status">
                <Spinner /> Loading the line&rsquo;s fields…
              </p>
            ) : !line ? (
              <p className="px-6 py-6 text-[13px] text-slate-600">Choose a line to see its fields.</p>
            ) : total === 0 ? (
              <p className="px-6 py-6 text-[13px] text-slate-600">
                This line has no optional fields filled in, so only the core requirement will be
                sent.
              </p>
            ) : (
              <>
                <p className="px-4 pt-3 text-[12px] text-slate-500 sm:px-6">
                  Only the fields you tick are copied into the RFQ and shown to vendors.
                </p>
                <div className="pb-2">
                  {groups.map((group) => {
                    const groupSelected = group.fields.filter((f) => selectedSet.has(f.key)).length;
                    const allOn = groupSelected === group.fields.length;
                    return (
                      <div key={group.group} role="group" aria-label={group.group}>
                        <label className="mt-2 flex cursor-pointer items-center gap-3 border-y border-ink-800 bg-ink-950 px-4 py-1.5 sm:px-6">
                          <input
                            type="checkbox"
                            checked={allOn}
                            ref={(el) => {
                              if (el) el.indeterminate = groupSelected > 0 && !allOn;
                            }}
                            disabled={frozen}
                            onChange={() => toggleGroup(group.fields)}
                            aria-label={`Select every field in ${group.group}`}
                            className="size-4 shrink-0 accent-accent-500"
                          />
                          <span className="flex-1 text-[12px] font-semibold text-slate-700">
                            {group.group}
                          </span>
                          <span className="text-[12px] text-slate-500 tabular-nums">
                            {groupSelected}/{group.fields.length}
                          </span>
                        </label>
                        <div className="divide-y divide-ink-800">
                          {group.fields.map((field) => {
                            const checked = selectedSet.has(field.key);
                            return (
                              <label
                                key={field.key}
                                className={cn(
                                  "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] transition-colors hover:bg-ink-850 sm:grid-cols-[auto_200px_minmax(0,1fr)] sm:px-6",
                                  checked && "bg-accent-500/[0.05]",
                                  frozen && "cursor-not-allowed opacity-60",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={frozen}
                                  onChange={() => toggle(field.key)}
                                  className="mt-0.5 size-4 shrink-0 accent-accent-500"
                                />
                                <span className="font-medium text-slate-800">{field.label}</span>
                                <span className="col-start-2 break-words whitespace-pre-line text-slate-600 sm:col-start-3">
                                  {field.value}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
      )}
    </Dialog>
  );
}

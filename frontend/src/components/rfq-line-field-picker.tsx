import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  defaultRfqLineFields,
  groupRfqLineFields,
  rfqLineFieldOptions,
  type RfqLineFieldKey,
} from "@/lib/rfqLineFields";
import { getLine, type EnquiryLine } from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

export type { RfqLineFieldKey } from "@/lib/rfqLineFields";

/**
 * Shared field picker for every path that raises an RFQ from an enquiry line.
 *
 * The backend owns the allow-list; this component only offers the populated
 * fields from that list. Core sourcing facts (crane, capacity, quantity, site
 * and dates) are always sent and are therefore not checkboxes here. The customer,
 * address and budget never appear, on any raise path.
 */

export interface UseRfqLineFieldSelectionOptions {
  /** Fetch this line when `line` is not already in the caller's payload. */
  lineId?: string | null;
  /** A full line from an enquiry detail payload, when the caller already has it. */
  line?: EnquiryLine | null;
  /** Shortcut dialogs pass `open` so a closed dialog does not fetch. */
  enabled?: boolean;
  /** Changing this re-defaults the selection (for example, reopening a dialog). */
  resetKey?: string | null;
}

export interface RfqLineFieldSelection {
  line: EnquiryLine | null;
  keys: RfqLineFieldKey[];
  ready: boolean;
  loading: boolean;
  error: boolean;
  toggle: (key: RfqLineFieldKey) => void;
  /** Restore "every populated field is selected" for the current line. */
  reset: () => void;
  retry: () => void;
}

export function useRfqLineFieldSelection({
  lineId,
  line: providedLine,
  enabled = true,
  resetKey,
}: UseRfqLineFieldSelectionOptions): RfqLineFieldSelection {
  const id = providedLine?.id ?? lineId ?? null;
  const needsFetch = enabled && !providedLine && Boolean(id);

  const query = useQuery({
    queryKey: ["enquiry-line", id],
    queryFn: () => getLine(id as string),
    enabled: needsFetch,
  });

  const fetchedLine = query.data?.line?.id === id ? query.data.line : null;
  const line = providedLine ?? fetchedLine;

  // A reset version is part of the key so reopening the same line re-defaults
  // the checkboxes without needing the caller to remount this hook.
  const [resetVersion, setResetVersion] = useState(0);
  const selectionKey = `${id ?? ""}|${resetKey ?? ""}|${resetVersion}`;
  const [selection, setSelection] = useState<{
    key: string;
    keys: RfqLineFieldKey[];
  } | null>(null);

  useEffect(() => {
    if (!line) return;
    setSelection((current) =>
      current?.key === selectionKey
        ? current
        : { key: selectionKey, keys: defaultRfqLineFields(line) },
    );
  }, [line, selectionKey]);

  const toggle = useCallback(
    (key: RfqLineFieldKey) => {
      setSelection((current) => {
        const keys = current?.key === selectionKey ? current.keys : [];
        return {
          key: selectionKey,
          keys: keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
        };
      });
    },
    [selectionKey],
  );

  const reset = useCallback(() => setResetVersion((version) => version + 1), []);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    line,
    keys: selection?.key === selectionKey ? selection.keys : [],
    ready: Boolean(line),
    loading: needsFetch && query.isPending,
    error: needsFetch && query.isError,
    toggle,
    reset,
    retry,
  };
}

export interface RfqLineFieldPickerProps {
  line: EnquiryLine | null;
  selected: readonly RfqLineFieldKey[];
  onToggle: (key: RfqLineFieldKey) => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** `card` for a full pane, `plain` for embedding in a dialog disclosure. */
  variant?: "card" | "plain";
  className?: string;
}

export function RfqLineFieldPicker({
  line,
  selected,
  onToggle,
  loading = false,
  error = false,
  onRetry,
  variant = "card",
  className,
}: RfqLineFieldPickerProps) {
  const options = useMemo(() => (line ? rfqLineFieldOptions(line) : []), [line]);
  const groups = useMemo(() => groupRfqLineFields(options), [options]);
  const total = options.length;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <section
      aria-label="Fields to send in the RFQ"
      className={cn(
        "min-w-0",
        variant === "card" && "rounded-xl border border-ink-800 bg-ink-850/60 p-3",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-medium tracking-[0.12em] text-slate-500 uppercase">
            Fields to send
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
            Only the fields you select are copied into the RFQ and shown to vendors. Crane,
            capacity, quantity, site and dates are always included.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-ink-700 px-2 py-0.5 text-[12px] text-slate-500 tabular-nums">
          {selected.length}/{total}
        </span>
      </div>

      {error ? (
        <div className="mt-3">
          <Alert tone="error" title="Could not load this line">
            Close and reopen this screen to retry before creating the RFQ.
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 block font-medium text-accent-400 underline underline-offset-2"
              >
                Retry
              </button>
            ) : null}
          </Alert>
        </div>
      ) : loading ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-slate-500">
          <Spinner /> Loading the line&rsquo;s fields…
        </p>
      ) : !line ? (
        <p className="mt-3 text-[13px] text-slate-500">Choose a line to see its fields.</p>
      ) : total === 0 ? (
        <p className="mt-3 text-[13px] text-slate-500">
          This line has no optional fields filled in. Only the core requirement will be sent.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {groups.map((group) => (
            <div key={group.group}>
              <p className="text-[12px] font-medium text-slate-500">{group.group}</p>
              <div className="mt-1.5 space-y-1">
                {group.fields.map((field) => {
                  const checked = selectedSet.has(field.key);
                  return (
                    <label
                      key={field.key}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[13px] transition-colors",
                        checked
                          ? "border-accent-500/40 bg-accent-500/10 text-slate-900"
                          : "border-ink-800 text-slate-500 hover:border-ink-700",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggle(field.key)}
                        className="mt-0.5 size-3.5 shrink-0 accent-accent-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{field.label}</span>
                        <span className="block break-words text-slate-500">{field.value}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

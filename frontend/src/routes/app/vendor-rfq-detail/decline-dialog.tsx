import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Field, TextArea } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { declineRfq } from "@/lib/quotations";

/**
 * Declining needs a reason, because the internal user sees why a vendor said no
 * and an empty box would tell them nothing. It is a quiet secondary action — a
 * dialog rather than a panel in the middle of the page — but still one click
 * from the summary bar.
 *
 * The suggestion list is only a `datalist`: the stored reason is free text, so a
 * coded value here would reach SML as a bare word like "NO_CAPACITY".
 */
export function DeclineDialog({
  rfqId,
  open,
  onOpenChange,
}: {
  rfqId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const decline = useMutation({
    mutationFn: () => declineRfq(rfqId, { reason, note: note || undefined }),
    onSuccess: () => {
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
      queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
    },
  });

  useEffect(() => {
    if (!open) return;
    reasonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !decline.isPending) onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, decline.isPending]);

  if (!open) return null;

  const error = decline.error as ApiError | null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-6 print:hidden">
      <button
        type="button"
        aria-label="Close decline dialog"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-[2px]"
        onClick={() => {
          if (!decline.isPending) onOpenChange(false);
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="decline-title"
        aria-describedby="decline-description"
        className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-ink-800 bg-ink-900 p-5 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="decline-title" className="text-base font-semibold text-slate-900">
              Decline this RFQ
            </h2>
            <p id="decline-description" className="mt-1 text-xs leading-relaxed text-slate-500">
              The reason is shared with the SML user who issued it. If this crane is not available,
              please use the note to list other cranes you can offer — with make, model, capacity,
              YOM, type and location — or contacts of other agencies who have the equipment.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-ink-850 hover:text-slate-900"
            onClick={() => onOpenChange(false)}
            disabled={decline.isPending}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {error ? <Alert>{error.message}</Alert> : null}

          <Field
            label="Reason"
            htmlFor="decline-reason"
            hint="Optional, but the SML user reads this. Suggestions are offered; you can write your own."
            error={error?.fieldError("reason")}
          >
            <input
              ref={reasonRef}
              id="decline-reason"
              list="decline-suggestions"
              className="field-input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="No capacity available for the required dates"
              aria-invalid={Boolean(error?.fieldError("reason")) || undefined}
            />
            <datalist id="decline-suggestions">
              {DECLINE_REASONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Note (optional)"
            htmlFor="decline-note"
            hint="What else you can offer: other cranes in your fleet, or contacts of agencies who have this equipment."
          >
            <TextArea
              id="decline-note"
              value={note}
              onChange={setNote}
              rows={3}
              placeholder="e.g. We can offer a 250 t crawler (Liebherr LTM 1250, 2019) from Pune, or contact XYZ Cranes on 98xxxxxx21."
            />
          </Field>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className="btn-primary min-h-11 px-4 text-sm"
              disabled={decline.isPending}
              onClick={() => decline.mutate()}
            >
              {decline.isPending ? "Declining…" : "Confirm decline"}
            </button>
            <button
              type="button"
              className="btn-secondary min-h-11 px-4 text-sm"
              onClick={() => onOpenChange(false)}
              disabled={decline.isPending}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Suggestions only. The stored `reason` is free text, so these are phrases a
 * vendor can accept or ignore — a coded value here would reach the internal user
 * as a bare word like "NO_CAPACITY" instead of something they can read.
 */
const DECLINE_REASONS = [
  "No capacity available for the required dates",
  "Site is too far from our cranes",
  "Duration is not suitable for us",
  "Commercial terms are not acceptable",
  "Crane is already committed elsewhere",
];

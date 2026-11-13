import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Where an RFQ is in its life: Draft → Sent → Quotes in → Awarded.
 *
 * The status pill says what the record *is*; the stepper says how far it has
 * travelled and what remains. It is deliberately not clickable — the steps are
 * not views, they are history — and the current step carries `aria-current`.
 *
 * Cancelled is terminal and fits none of the forward steps, so it replaces the
 * trail with a muted "Cancelled" marker rather than pretending the record is
 * still somewhere on the road.
 */
export interface LifecycleStep {
  key: string;
  label: string;
}

export function LifecycleStepper({
  steps,
  current,
  cancelled = false,
  className,
}: {
  steps: readonly LifecycleStep[];
  /** Index of the current step. Ignored when `cancelled`. */
  current: number;
  cancelled?: boolean;
  className?: string;
}) {
  return (
    <ol
      aria-label="RFQ lifecycle"
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto text-[11px] whitespace-nowrap",
        className,
      )}
    >
      {steps.map((step, index) => {
        const done = !cancelled && index < current;
        const active = !cancelled && index === current;
        return (
          <li key={step.key} className="flex shrink-0 items-center gap-1">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "mx-0.5 h-px w-5 shrink-0",
                  cancelled || index <= current ? "bg-ink-700" : "bg-ink-800",
                )}
              />
            ) : null}
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
                active && "bg-ink-800 text-white ring-1 ring-ink-700",
                done && "text-slate-600",
                !active && !done && "text-slate-500/70",
              )}
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border text-[9px] font-semibold",
                  cancelled
                    ? "border-slate-500/40 text-slate-500"
                    : done
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                      : active
                        ? "border-accent-500/70 bg-accent-500/20 text-accent-400"
                        : "border-ink-700 text-slate-500",
                )}
              >
                {done ? <Check className="size-2.5" aria-hidden /> : index + 1}
              </span>
              {step.label}
            </span>
          </li>
        );
      })}
      {cancelled ? (
        <li className="flex shrink-0 items-center gap-1">
          <span aria-hidden className="mx-0.5 h-px w-5 bg-ink-700" />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-red-600 ring-1 ring-red-500/30">
            <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
            Cancelled
          </span>
        </li>
      ) : null}
    </ol>
  );
}

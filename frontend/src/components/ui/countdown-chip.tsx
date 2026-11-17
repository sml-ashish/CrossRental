import { Clock } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * How long is left on a deadline.
 *
 * The label and tone come from the caller (the list screen's existing
 * `deadlineCountdown` owns that logic), so this file only decides how a countdown
 * looks. `urgent` is for the under-48-hours case: a stronger ring and a pulsing
 * dot, because a neutral chip with "2 days left" on a screen of forty rows is
 * the one that gets missed. The pulse stops under `prefers-reduced-motion`.
 */
export function CountdownChip({
  label,
  tone = "neutral",
  urgent = false,
  className,
}: {
  label: string;
  tone?: "neutral" | "soon" | "overdue";
  urgent?: boolean;
  className?: string;
}) {
  const palette = {
    neutral: "border-ink-700 bg-ink-850 text-slate-600",
    soon: "border-amber-500/40 bg-amber-500/10 text-amber-600",
    overdue: "border-red-500/40 bg-red-500/10 text-red-600",
  }[tone];

  const dot = {
    neutral: "bg-slate-500",
    soon: "bg-amber-500",
    overdue: "bg-red-500",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[13px] font-medium whitespace-nowrap tabular-nums",
        palette,
        urgent && "ring-1 ring-amber-500/40",
        className,
      )}
    >
      <Clock className="size-3 shrink-0" aria-hidden />
      {urgent ? (
        <span
          className={cn("size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none", dot)}
          aria-hidden
        />
      ) : null}
      {label}
    </span>
  );
}


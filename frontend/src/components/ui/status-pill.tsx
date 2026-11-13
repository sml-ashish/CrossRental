import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A status pill: tinted background, hairline ring and a leading dot.
 *
 * `Badge` is the neutral chip used across forms and tables. A *status* is a
 * different job: it is the one word a person scans a queue for, so it gets the
 * same dot-plus-word treatment everywhere and never relies on colour alone.
 *
 * Tones follow the portal's status palette: drafts are grey, sent/awaiting are
 * blue, quotes received amber, finalised green, cancelled a muted red-grey and a
 * failed delivery the only full red. The word is always supplied by the caller so
 * a pill can never disagree with the badge beside it.
 */
export type StatusPillTone = "neutral" | "blue" | "amber" | "emerald" | "red" | "muted";

const TONES: Record<StatusPillTone, { wrap: string; dot: string }> = {
  neutral: {
    wrap: "border-ink-700 bg-ink-800 text-slate-600",
    dot: "bg-slate-400",
  },
  blue: {
    wrap: "border-blue-500/30 bg-blue-500/10 text-blue-600",
    dot: "bg-blue-500",
  },
  amber: {
    wrap: "border-amber-500/30 bg-amber-500/10 text-amber-600",
    dot: "bg-amber-500",
  },
  emerald: {
    wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
    dot: "bg-emerald-500",
  },
  red: {
    wrap: "border-red-500/30 bg-red-500/10 text-red-600",
    dot: "bg-red-500",
  },
  muted: {
    wrap: "border-slate-500/20 bg-slate-500/10 text-slate-500",
    dot: "bg-slate-500",
  },
};

export function StatusPill({
  tone = "neutral",
  children,
  icon,
  className,
}: {
  tone?: StatusPillTone;
  children: ReactNode;
  /** Optional leading icon, for a failed delivery or a warning. */
  icon?: ReactNode;
  className?: string;
}) {
  const { wrap, dot } = TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        wrap,
        className,
      )}
    >
      {icon ?? <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />}
      {children}
    </span>
  );
}

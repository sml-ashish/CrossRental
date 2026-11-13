import { AlertOctagon, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one-line answer to "is anything wrong?".
 *
 * Tone is never the message: every state carries an icon and a word, so the
 * header reads the same to someone who cannot tell red from amber. `role=status`
 * means a refresh that changes the state is announced once, rather than the
 * whole page re-reading.
 */
export type HealthTone = "clear" | "watch" | "action" | "checking";

const TONE: Record<
  HealthTone,
  { wrap: string; icon: typeof CheckCircle2; iconClass: string }
> = {
  clear: {
    wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
    icon: CheckCircle2,
    iconClass: "",
  },
  watch: {
    wrap: "border-amber-500/30 bg-amber-500/10 text-amber-600",
    icon: AlertTriangle,
    iconClass: "",
  },
  action: {
    wrap: "border-red-500/30 bg-red-500/10 text-red-600",
    icon: AlertOctagon,
    iconClass: "",
  },
  checking: {
    wrap: "border-ink-700 bg-ink-850 text-slate-500",
    icon: Loader2,
    iconClass: "animate-spin motion-reduce:animate-none",
  },
};

export function HealthPill({
  tone,
  label,
  detail,
}: {
  tone: HealthTone;
  label: string;
  detail?: string;
}) {
  const { wrap, icon: Icon, iconClass } = TONE[tone];

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
          wrap,
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", iconClass)} aria-hidden />
        {label}
      </span>
      {detail ? <span className="text-[11px] text-slate-500">{detail}</span> : null}
    </span>
  );
}

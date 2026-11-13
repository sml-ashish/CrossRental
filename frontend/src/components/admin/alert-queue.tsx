import { Link } from "@tanstack/react-router";
import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Info } from "lucide-react";
import type { AlertItem } from "@/lib/internalDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/**
 * The operations queue.
 *
 * `AlertList` (shared with the sales dashboard) renders each alert as a coloured
 * box; here the queue is the primary work surface, so it is a dense, scannable
 * list ordered by severity — errors first, then warnings, then information —
 * with the link spanning the whole row rather than a small "Open" word.
 *
 * The server decides what is in the list and where each row leads; this
 * component only orders and renders it.
 */
const TONE = {
  error: {
    ring: "border-red-500/25 hover:border-red-500/50 hover:bg-red-500/[0.06]",
    iconWrap: "border-red-500/30 bg-red-500/10 text-red-600",
    icon: AlertOctagon,
    label: "Critical",
  },
  warning: {
    ring: "border-amber-500/25 hover:border-amber-500/50 hover:bg-amber-500/[0.06]",
    iconWrap: "border-amber-500/30 bg-amber-500/10 text-amber-600",
    icon: AlertTriangle,
    label: "Warning",
  },
  info: {
    ring: "border-blue-500/25 hover:border-blue-500/50 hover:bg-blue-500/[0.06]",
    iconWrap: "border-blue-500/30 bg-blue-500/10 text-blue-600",
    icon: Info,
    label: "Information",
  },
} as const;

const RANK: Record<AlertItem["tone"], number> = { error: 0, warning: 1, info: 2 };

export function AdminAlertQueue({ alerts, loading }: { alerts: AlertItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <ul className="space-y-2" aria-hidden>
        {[0, 1, 2].map((index) => (
          <li key={index} className="rounded-xl border border-ink-800 bg-ink-900 p-3">
            <div className="flex items-start gap-3">
              <Skeleton className="size-7 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-52" />
                <Skeleton className="h-2.5 w-72 max-w-full" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600">
          <CheckCircle2 className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">Nothing needs attention</p>
          <p className="mt-0.5 text-xs text-slate-500">
            No overdue RFQs, expiring quotations or unanswered lines right now.
          </p>
        </div>
      </div>
    );
  }

  const ordered = [...alerts].sort((a, b) => RANK[a.tone] - RANK[b.tone]);

  return (
    <ul aria-label="Alert queue" className="space-y-2">
      {ordered.map((alert) => {
        const tone = TONE[alert.tone];
        const Icon = tone.icon;
        return (
          <li key={alert.id}>
            <Link
              to={alert.to as never}
              aria-label={`${tone.label}: ${alert.title}. ${alert.detail} Open`}
              className={cn(
                "group flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                tone.ring,
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                  tone.iconWrap,
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-white">{alert.title}</span>
                  {typeof alert.count === "number" ? (
                    <span className="rounded-full border border-ink-700 bg-ink-800 px-1.5 py-px text-[10px] font-medium tabular-nums text-slate-600">
                      {alert.count}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                  {alert.detail}
                </span>
              </span>

              <span className="mt-1 flex shrink-0 items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors group-hover:text-white">
                <span className="hidden sm:inline">Open</span>
                <ArrowRight className="size-3.5" aria-hidden />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

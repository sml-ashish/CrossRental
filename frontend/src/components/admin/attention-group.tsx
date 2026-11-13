import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/**
 * One themed column of counters inside "Needs attention".
 *
 * The old dashboard was a flat eight-tile grid, so a stale crane sat next to a
 * failed registration with no relationship between them. Grouping keeps the
 * numbers that share an owner adjacent, and each group carries its own total so
 * a person can skip a group that is at zero.
 *
 * A counter links only when the destination filters to exactly that set. The
 * derived fleet total does not link, because no single list shows it.
 */
export type CounterTone = "neutral" | "red" | "amber" | "blue" | "emerald";

export interface AttentionCounter {
  key: string;
  label: string;
  value: number;
  hint?: string;
  tone?: CounterTone;
  /** Route the counter opens, when one list shows exactly this set. */
  to?: string;
  /** Search params for that route. */
  search?: Record<string, string>;
}

const VALUE_TONE: Record<CounterTone, string> = {
  neutral: "text-white",
  red: "text-red-600",
  amber: "text-amber-600",
  blue: "text-blue-600",
  emerald: "text-emerald-600",
};

const DOT_TONE: Record<CounterTone, string> = {
  neutral: "bg-slate-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
};

function CounterRow({ counter }: { counter: AttentionCounter }) {
  const tone = counter.tone ?? "neutral";
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-2">
        <span
          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT_TONE[tone])}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="block text-[13px] leading-5 text-slate-700">{counter.label}</span>
          {counter.hint ? (
            <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
              {counter.hint}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            "text-xl font-semibold tabular-nums",
            counter.value === 0 ? "text-slate-500" : VALUE_TONE[tone],
          )}
        >
          {counter.value}
        </span>
        {counter.to ? (
          <ArrowUpRight
            className="size-3.5 text-slate-600 transition-colors group-hover:text-white"
            aria-hidden
          />
        ) : null}
      </span>
    </>
  );

  if (counter.to) {
    return (
      <Link
        to={counter.to as never}
        search={counter.search as never}
        aria-label={`${counter.label}: ${counter.value}${counter.hint ? `. ${counter.hint}` : ""}`}
        className="group -mx-2 flex min-h-[44px] items-start justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        {body}
      </Link>
    );
  }

  return <div className="flex min-h-[44px] items-start justify-between gap-3 py-2">{body}</div>;
}

export function AttentionGroup({
  title,
  description,
  counters,
  loading,
}: {
  title: string;
  description?: string;
  counters: AttentionCounter[];
  loading?: boolean;
}) {
  const total = counters.reduce((sum, counter) => sum + counter.value, 0);

  return (
    <section
      aria-label={title}
      className="rounded-xl border border-ink-800 bg-ink-900 p-3"
    >
      <header className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-mono text-[10px] tracking-[0.1em] text-slate-500 uppercase">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{description}</p>
          ) : null}
        </div>
        {loading ? (
          <Skeleton className="h-3 w-6" />
        ) : (
          <span
            className={cn(
              "text-[11px] font-medium tabular-nums",
              total > 0 ? "text-slate-600" : "text-slate-500",
            )}
          >
            {total}
          </span>
        )}
      </header>

      <ul className="mt-1 divide-y divide-ink-800">
        {loading
          ? counters.map((counter) => (
              <li key={counter.key} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-5 w-7" />
                </div>
                <Skeleton className="mt-1.5 h-2.5 w-40" />
              </li>
            ))
          : counters.map((counter) => (
              <li key={counter.key}>
                <CounterRow counter={counter} />
              </li>
            ))}
      </ul>
    </section>
  );
}

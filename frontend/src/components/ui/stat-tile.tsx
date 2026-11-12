import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A counter tile.
 *
 * The dashboards all hand-rolled a bordered box with a number in it, at four
 * different sizes. One tile keeps the label, the number and the caption in the
 * same relationship everywhere, and lets a tile carry a colour dot so it can
 * match a calendar state or a status badge.
 */
export function StatTile({
  label,
  value,
  hint,
  dot,
  icon,
  tone = "neutral",
  href,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Tailwind background class for the state dot, e.g. `bg-emerald-500`. */
  dot?: string;
  icon?: ReactNode;
  tone?: "neutral" | "brand" | "amber" | "red" | "emerald" | "blue";
  href?: string;
  className?: string;
}) {
  const valueTone = {
    neutral: "text-slate-900",
    brand: "text-brand-700",
    amber: "text-amber-700",
    red: "text-red-700",
    emerald: "text-emerald-700",
    blue: "text-blue-700",
  }[tone];

  const body = (
    <>
      <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        {dot ? <span className={cn("size-1.5 rounded-full", dot)} aria-hidden /> : null}
        {icon}
        {label}
      </p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", valueTone)}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={cn(
          "card px-4 py-3 transition-colors hover:border-slate-300 hover:bg-slate-50/60",
          className,
        )}
      >
        {body}
      </a>
    );
  }

  return <div className={cn("card px-4 py-3", className)}>{body}</div>;
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", className)}
    >
      {children}
    </section>
  );
}

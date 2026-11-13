import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A counter tile.
 *
 * The dashboards all hand-rolled a bordered box with a number in it, at four
 * different sizes. One tile keeps the label, the number and the caption in the
 * same relationship everywhere, and lets a tile carry a colour dot so it can
 * match a calendar state or a status badge.
 *
 * A tile is also a filter in some places, so it can be a button with an active
 * state. That is deliberately one prop (`onClick`) rather than every caller
 * re-creating the button wrapper — the pressed styling then matches everywhere.
 */
export function StatTile({
  label,
  value,
  hint,
  dot,
  icon,
  tone = "neutral",
  href,
  onClick,
  active,
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
  /** Makes the tile a filter button. */
  onClick?: () => void;
  /** Pressed state for an `onClick` tile. */
  active?: boolean;
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
      <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        {dot ? <span className={cn("size-1.5 rounded-full", dot)} aria-hidden /> : null}
        {icon}
        {label}
      </span>
      <span className={cn("mt-1 block text-2xl font-semibold tabular-nums", valueTone)}>
        {value}
      </span>
      {hint ? <span className="mt-0.5 block text-[11px] text-slate-500">{hint}</span> : null}
    </>
  );

  const shell = "card block px-4 py-3 text-left transition-colors duration-150";

  if (href) {
    return (
      <a href={href} className={cn(shell, "hover:border-slate-300 hover:bg-ink-800/60", className)}>
        {body}
      </a>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          shell,
          "hover:border-ink-700 hover:bg-ink-800/60",
          active && "border-accent-500/60 bg-ink-800/80 ring-1 ring-accent-500/40",
          className,
        )}
      >
        {body}
      </button>
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

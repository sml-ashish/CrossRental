import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Table primitives.
 *
 * The app has ~20 hand-written tables, each with its own padding, border
 * colour and header treatment. These keep the dense, bordered look of the
 * booking calendar: hairline dividers, a muted uppercase head, a hover row and
 * a horizontal scroll that never widens the page.
 *
 * Cells stay arbitrary markup — these are styled wrappers, not a column
 * config — because half the tables carry two-line cells and inline actions.
 */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-slate-200 bg-slate-50/80">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      className={cn("transition-colors hover:bg-slate-50/80", onClick && "cursor-pointer", className)}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

export function TH({
  children,
  align = "left",
  className,
  sticky,
}: {
  children?: ReactNode;
  align?: keyof typeof ALIGN;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2.5 text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-slate-500 uppercase",
        ALIGN[align],
        sticky && "sticky top-0 z-10 border-b border-slate-200 bg-slate-50",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = "left",
  className,
  title,
}: {
  children?: ReactNode;
  align?: keyof typeof ALIGN;
  className?: string;
  title?: string;
}) {
  return (
    <td title={title} className={cn("px-4 py-2.5 align-middle text-slate-700", ALIGN[align], className)}>
      {children}
    </td>
  );
}

/** A whole-table empty state, so the table chrome stays in place. */
export function TableEmpty({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={99} className="px-4 py-12 text-center text-sm text-slate-500">
        {children}
      </td>
    </tr>
  );
}

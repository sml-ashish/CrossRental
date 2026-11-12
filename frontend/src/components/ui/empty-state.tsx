import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * What a screen shows when it has nothing to show.
 *
 * Previously every empty list was a bare centred sentence inside a card, or —
 * worse — a blank table body with no explanation. An empty state says what the
 * screen would contain, why it is empty, and what to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-400">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs leading-relaxed text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={99} className="px-4 py-0">
        {children}
      </td>
    </tr>
  );
}

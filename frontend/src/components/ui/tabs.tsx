import { useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * In-page tabs with roving focus.
 *
 * The detail screen has four views of one RFQ, and a `Segmented` control would
 * be wrong here: these are panels, not filters, so the tablist/tab/tabpanel
 * relationship is real. Arrow keys move between tabs, Home/End jump to the ends,
 * and only the selected tab is in the tab order.
 *
 * The selected tab lives in the caller's URL state; this component is controlled
 * and keeps no state of its own.
 */
export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** A tabular count, e.g. the number of quotes. */
  count?: number;
  icon?: ReactNode;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  idPrefix = "tab",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: readonly TabOption<T>[];
  label: string;
  idPrefix?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.value === value);
    if (index === -1) return;

    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;

    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.value);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab="${target.value}"]`)
      ?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-ink-800 bg-ink-900 p-1",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab.value}`}
            data-tab={tab.value}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[15px] font-medium whitespace-nowrap transition-colors duration-150",
              active
                ? "bg-ink-800 text-white shadow-sm ring-1 ring-ink-700"
                : "text-slate-500 hover:bg-ink-850 hover:text-white",
            )}
          >
            {tab.icon}
            {tab.label}
            {typeof tab.count === "number" ? (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[12px] tabular-nums",
                  active ? "bg-ink-700 text-neutral-200" : "bg-ink-800 text-slate-500",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}


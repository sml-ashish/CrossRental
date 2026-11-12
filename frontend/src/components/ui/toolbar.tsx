import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The control strip above a list.
 *
 * Filters, search and view switches belong to one bar with one border, not to
 * three differently spaced rows. `Toolbar` supplies the card and the hairline
 * separation; `ToolbarFooter` is for the legend or a result count that belongs
 * to the same block.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "card flex flex-wrap items-end justify-between gap-3 px-4 py-3",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function ToolbarFooter({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 -mb-3 mt-1 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
      {children}
    </div>
  );
}

export function ToolbarField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase"
      >
        {label}
      </label>
      <div className="[&>input]:py-1.5 [&>select]:py-1.5">{children}</div>
    </div>
  );
}

/** Search field with the icon inset, used by every list screen. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="field-input pl-8"
      />
    </div>
  );
}

/** Segmented control for two or three mutually exclusive views. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

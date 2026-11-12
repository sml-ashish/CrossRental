import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one page header.
 *
 * Every screen used to spell out its own `<h1>` plus a subtitle plus an optional
 * action cluster, which is how 39 of them drifted apart. A page header is now a
 * single component: title, one line of context, and the actions that belong to
 * the whole page (create, export, refresh) — never to a row.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  mono,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  /** Small print under the title: counts, last updated, an owner. */
  meta?: ReactNode;
  /** Render the title as an identifier (RFQ number, crane serial, vendor code). */
  mono?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("space-y-2", className)}>
      {back ? (
        <Link
          to={back.to}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          {back.label}
        </Link>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className={cn(
              "text-xl font-semibold tracking-tight text-slate-900",
              mono && "font-mono text-lg",
            )}
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>
          ) : null}
          {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/**
 * A titled block inside a page. `Section` in ui/form is the form-flavoured
 * variant; this one carries an action slot in the header for list panels.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  bodyClassName,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Padding override for panels whose child manages its own edges (tables). */
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <section className={cn("card overflow-hidden", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(bodyClassName ?? "p-4")}>{children}</div>
    </section>
  );
}

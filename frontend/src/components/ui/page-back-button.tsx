import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { markBackTarget, previousHref } from "@/lib/navigationHistory";

/**
 * A page-level Back control.
 *
 * It reads the tab-local page memory kept by the app shell and falls back to
 * the user's role home. Pages that already have a fixed "Back to X" link keep
 * their own; everywhere else this gives a consistent way out without putting
 * navigation chrome in the top bar.
 */
export function PageBackButton({
  className,
  label = "Back",
}: {
  className?: string;
  label?: string;
}) {
  const { user } = useAuth();
  const href = useRouterState({ select: (state) => state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (!user) return null;

  const home = ROLE_HOME[user.role];
  const target = previousHref(href) ?? (pathname !== home ? home : null);
  if (!target) return null;

  return (
    <Link
      to={target}
      onClick={() => markBackTarget(target)}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800",
        className,
      )}
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      {label}
    </Link>
  );
}

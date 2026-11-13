import { ArrowRight, Clock, ShieldCheck, UserMinus } from "lucide-react";
import type { AdminUser } from "@/lib/admin";
import { StatusPill } from "@/components/ui/status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime, useNow } from "@/components/admin/hooks";
import { cn } from "@/lib/cn";

/**
 * Who runs the portal, at a glance.
 *
 * The user table below answers "who exactly?"; this card answers the questions
 * an admin asks before opening it — is the team whole, is anyone disabled, has
 * the newest account ever signed in? Everything is derived from the same users
 * query the table already loads, so the two can never disagree.
 */
const ROLES = [
  { key: "admin_user", label: "Admins", dot: "bg-accent-500", bar: "bg-accent-500" },
  { key: "sales_user", label: "Sales (CR team)", dot: "bg-blue-500", bar: "bg-blue-500" },
  { key: "management_viewer", label: "Management viewers", dot: "bg-slate-500", bar: "bg-slate-500" },
] as const;

function latestSignIn(users: AdminUser[]): number | null {
  let latest: number | null = null;
  for (const user of users) {
    if (!user.lastLoginAt) continue;
    const time = new Date(user.lastLoginAt).getTime();
    if (Number.isNaN(time)) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

export function TeamSnapshot({
  users,
  loading,
  error,
}: {
  users: AdminUser[] | undefined;
  loading: boolean;
  error?: Error | null;
}) {
  const now = useNow();

  if (loading) {
    return (
      <div className="space-y-4" aria-hidden>
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div className="space-y-2.5">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="h-2.5 w-28" />
              <Skeleton className="h-1.5 flex-1 rounded-full" />
              <Skeleton className="h-3 w-5" />
            </div>
          ))}
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5 text-xs text-red-600">
        {error.message}
      </p>
    );
  }

  const rows = users ?? [];
  const total = rows.length;
  const active = rows.filter((user) => user.isActive);
  const disabled = total - active.length;
  const neverSignedIn = active.filter((user) => !user.lastLoginAt).length;
  const lastSeen = latestSignIn(rows);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.1em] text-slate-500 uppercase">
            Active accounts
          </p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tabular-nums text-white">{active.length}</span>
            <span className="text-xs text-slate-500">of {total}</span>
          </p>
        </div>
        <StatusPill tone={disabled > 0 ? "amber" : "emerald"}>
          {disabled > 0 ? `${disabled} disabled` : "All enabled"}
        </StatusPill>
      </div>

      <div
        className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-ink-800"
        aria-hidden
      >
        <span
          className="h-full bg-emerald-500"
          style={{ width: total > 0 ? `${(active.length / total) * 100}%` : "0%" }}
        />
        <span
          className="h-full bg-slate-500/70"
          style={{ width: total > 0 ? `${(disabled / total) * 100}%` : "0%" }}
        />
      </div>

      <ul className="mt-3.5 space-y-2.5">
        {ROLES.map((role) => {
          const count = active.filter((user) => user.role === role.key).length;
          const percent = active.length > 0 ? (count / active.length) * 100 : 0;
          return (
            <li key={role.key} className="flex items-center gap-2.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", role.dot)} aria-hidden />
              <span className="w-32 shrink-0 text-xs text-slate-600">{role.label}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800" aria-hidden>
                <span
                  className={cn("block h-full rounded-full", role.bar)}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="w-5 shrink-0 text-right text-xs font-medium tabular-nums text-slate-700">
                {count}
              </span>
            </li>
          );
        })}
      </ul>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-[10px] tracking-[0.06em] text-slate-500 uppercase">
            <UserMinus className="size-3" aria-hidden />
            Never signed in
          </dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-white">{neverSignedIn}</dd>
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-[10px] tracking-[0.06em] text-slate-500 uppercase">
            <Clock className="size-3" aria-hidden />
            Last sign-in
          </dt>
          <dd
            className="mt-1 truncate text-sm font-medium text-white"
            title={
              lastSeen ? new Date(lastSeen).toLocaleString() : "No account has signed in yet"
            }
          >
            {lastSeen ? relativeTime(lastSeen, now) : "—"}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-800 pt-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
          <ShieldCheck className="size-3.5" aria-hidden />
          One-time-code sign-in, no passwords
        </span>
        <a
          href="#sml-users"
          className="group inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Manage accounts
          <ArrowRight
            className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
            aria-hidden
          />
        </a>
      </div>

      <p className="sr-only">
        {total} staff accounts: {active.length} active, {disabled} disabled.{" "}
        {neverSignedIn} active accounts have never signed in.
      </p>
    </div>
  );
}

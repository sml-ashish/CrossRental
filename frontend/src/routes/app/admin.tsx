import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, MessageSquare, RefreshCw, Send, Truck, ArrowUpRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Panel } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { useAuth } from "@/lib/auth";
import {
  loadAdminDashboard,
  loadAdminUsers,
  type AdminDashboard,
  type AdminDashboardCounts,
} from "@/lib/admin";
import { AttentionGroup, type AttentionCounter } from "@/components/admin/attention-group";
import { AdminAlertQueue } from "@/components/admin/alert-queue";
import { HealthPill, type HealthTone } from "@/components/admin/health-pill";
import { OperatingRules } from "@/components/admin/operating-rules";
import { TeamSnapshot } from "@/components/admin/team-snapshot";
import { UsersPanel } from "@/components/admin/users-panel";
import { relativeTime, useCountUpOnce, useNow } from "@/components/admin/hooks";
import { cn } from "@/lib/cn";

/**
 * Admin console (P0 B).
 *
 * Two audiences-in-one: the day's exceptions (B1) and the staff who run the
 * portal (B2). The page is ordered by what an admin does first — a health
 * verdict, then the four numbers that explain it, the full grouped inventory,
 * the operational queue, and finally the team.
 *
 * Every counter is derived from one `["admin", "dashboard"]` query; the team
 * views share the one `["admin", "users"]` query. No number on this page is
 * stored separately from the list it describes.
 *
 * Vendor suspension lives on the vendor detail screen, where the vendor is
 * already in view. Every call here is admin-gated on the server.
 */

const EMPTY_COUNTS: AdminDashboardCounts = {
  awaitingApproval: 0,
  rfqsWithFailures: 0,
  cranesStale: 0,
  cranesUnverified: 0,
  cranesLapsed: 0,
  fleetPendingValidation: 0,
  unmatchedQuotationResponses: 0,
  failedEmails: 0,
};

function greetingFor(name: string | undefined, hour: number): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return name?.trim() ? `Good ${part}, ${name.trim()}` : `Good ${part}`;
}

function openExceptions(counts: AdminDashboardCounts | undefined, fleetRequired: boolean): number {
  if (!counts) return 0;
  return (
    counts.awaitingApproval +
    counts.rfqsWithFailures +
    counts.cranesStale +
    counts.cranesUnverified +
    counts.cranesLapsed +
    (fleetRequired ? counts.fleetPendingValidation : 0) +
    counts.unmatchedQuotationResponses +
    counts.failedEmails
  );
}

function healthState(
  counts: AdminDashboardCounts | undefined,
  alerts: AdminDashboard["alerts"],
  loading: boolean,
  fleetRequired: boolean,
): { tone: HealthTone; label: string; detail: string } {
  if (loading || !counts) {
    return { tone: "checking", label: "Checking status", detail: "Loading today's exceptions" };
  }

  const critical = alerts.filter((alert) => alert.tone === "error").length;
  const warnings = alerts.filter((alert) => alert.tone === "warning").length;
  const open = openExceptions(counts, fleetRequired);

  if (critical > 0) {
    return {
      tone: "action",
      label: `${critical} critical alert${critical === 1 ? "" : "s"}`,
      detail: `${open} open exception${open === 1 ? "" : "s"}`,
    };
  }
  if (warnings > 0) {
    return {
      tone: "watch",
      label: `${warnings} warning${warnings === 1 ? "" : "s"}`,
      detail: `${open} open exception${open === 1 ? "" : "s"}`,
    };
  }
  if (open > 0) {
    return {
      tone: "watch",
      label: "Needs attention",
      detail: `${open} open exception${open === 1 ? "" : "s"}`,
    };
  }
  return { tone: "clear", label: "All clear", detail: "No open exceptions" };
}

// ---------------------------------------------------------------------------
// summary strip
// ---------------------------------------------------------------------------

interface SummaryCard {
  key: string;
  label: string;
  value: number;
  hint: string;
  icon: ReactNode;
  tone?: "accent" | "red" | "amber" | "blue";
  to?: string;
  search?: Record<string, string>;
}

const SUMMARY_TONE = {
  accent: "text-accent-400",
  red: "text-red-600",
  amber: "text-amber-600",
  blue: "text-blue-600",
  neutral: "text-white",
} as const;

function SummaryCardView({ card, loading }: { card: SummaryCard; loading: boolean }) {
  const shown = useCountUpOnce(card.value, 600, !loading);
  const valueTone = card.value > 0 ? SUMMARY_TONE[card.tone ?? "neutral"] : "text-white";

  const body = (
    <>
      <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] text-slate-500 uppercase">
        <span className="text-slate-500" aria-hidden>
          {card.icon}
        </span>
        {card.label}
      </span>

      {loading ? (
        <>
          <Skeleton className="mt-2 h-8 w-12" />
          <Skeleton className="mt-1.5 h-2.5 w-32" />
        </>
      ) : (
        <>
          <span
            className={cn("mt-1.5 block text-3xl leading-9 font-semibold tabular-nums", valueTone)}
          >
            {shown}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500">{card.hint}</span>
        </>
      )}

      {card.to ? (
        <ArrowUpRight
          className="absolute top-3 right-3 size-3.5 text-slate-600 transition-colors group-hover:text-white"
          aria-hidden
        />
      ) : null}
    </>
  );

  const shell = cn(
    "group relative block rounded-xl border border-ink-800 bg-ink-850 px-4 py-3.5",
    card.to &&
      "transition-colors duration-150 hover:border-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
  );

  if (loading) {
    return <div className={shell}>{body}</div>;
  }

  if (card.to) {
    return (
      <Link
        to={card.to as never}
        search={card.search as never}
        aria-label={`${card.label}: ${card.value}. ${card.hint}`}
        className={shell}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className={shell} role="group" aria-label={`${card.label}: ${card.value}. ${card.hint}`}>
      {body}
    </div>
  );
}

function SummaryStrip({
  counts,
  fleetRequired,
  loading,
}: {
  counts: AdminDashboardCounts | undefined;
  fleetRequired: boolean;
  loading: boolean;
}) {
  const cards: SummaryCard[] = [
    {
      key: "approvals",
      label: "Approvals waiting",
      value: counts?.awaitingApproval ?? 0,
      hint: "New vendor registrations",
      tone: "accent",
      icon: <Building2 className="size-3.5" />,
      to: "/app/approvals",
    },
    {
      key: "rfq-failures",
      label: "RFQ failures",
      value: counts?.rfqsWithFailures ?? 0,
      hint: "Dispatches that never left",
      tone: "red",
      icon: <Send className="size-3.5" />,
      to: "/app/rfqs",
      search: { delivery: "FAILED" },
    },
    {
      key: "replies",
      label: "Replies to validate",
      value: counts?.unmatchedQuotationResponses ?? 0,
      hint: "Vendor replies without a match",
      tone: "blue",
      icon: <MessageSquare className="size-3.5" />,
      to: "/app/admin/replies",
    },
    {
      key: "fleet",
      label: "Fleet flags",
      value:
        (counts?.cranesStale ?? 0) +
        (counts?.cranesUnverified ?? 0) +
        (counts?.cranesLapsed ?? 0) +
        (fleetRequired ? (counts?.fleetPendingValidation ?? 0) : 0),
      hint: "Stale, unmapped or overrun",
      tone: "amber",
      icon: <Truck className="size-3.5" />,
    },
  ];

  return (
    <section
      aria-label="Today at a glance"
      className="grid grid-cols-1 gap-3 min-[768px]:grid-cols-2 min-[1100px]:grid-cols-4"
    >
      {cards.map((card) => (
        <SummaryCardView key={card.key} card={card} loading={loading} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

interface MixGroup {
  key: string;
  label: string;
  total: number;
  dot: string;
  bar: string;
}

/**
 * The totals of the three groups as one proportion bar.
 *
 * The group cards each carry their own total; this footer answers "where is the
 * work?" in one glance and gives the left column the height it needs next to
 * the operating-rules card. The counts are repeated as text, so the bar is
 * never the only carrier of the number.
 */
function ExceptionMix({ groups }: { groups: MixGroup[] }) {
  const total = groups.reduce((sum, group) => sum + group.total, 0);

  if (total === 0) {
    return (
      <p className="mt-auto pt-4 text-[11px] text-slate-500">
        Nothing is queued across these groups.
      </p>
    );
  }

  return (
    <div className="mt-auto pt-4">
      <div
        role="img"
        aria-label={`Open exceptions by group: ${groups
          .map((group) => `${group.label} ${group.total}`)
          .join(", ")}`}
        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-ink-800"
      >
        {groups.map((group) =>
          group.total > 0 ? (
            <span
              key={group.key}
              className={cn("h-full", group.bar)}
              style={{ width: `${(group.total / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {groups.map((group) => (
          <li
            key={group.key}
            className="flex items-center gap-1.5 text-[11px] text-slate-500"
          >
            <span className={cn("size-1.5 rounded-full", group.dot)} aria-hidden />
            {group.label}
            <span
              className={cn(
                "font-medium tabular-nums",
                group.total > 0 ? "text-slate-600" : "text-slate-500",
              )}
            >
              {group.total}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdminPage() {
  const { user: me } = useAuth();
  const now = useNow(15_000);

  const dashboard = useQuery({ queryKey: ["admin", "dashboard"], queryFn: loadAdminDashboard });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: loadAdminUsers });

  const data = dashboard.data;
  const counts = data?.counts ?? EMPTY_COUNTS;
  const thresholds = data?.thresholds;
  const alerts = data?.alerts ?? [];
  const fleetRequired = thresholds?.fleetApprovalRequired ?? false;
  const loading = dashboard.isLoading;
  const refreshing = dashboard.isFetching || users.isFetching;

  const health = healthState(data?.counts, alerts, loading, fleetRequired);
  const openTotal = openExceptions(data?.counts, fleetRequired);
  const errorAlerts = alerts.filter((alert) => alert.tone === "error").length;
  const warningAlerts = alerts.filter((alert) => alert.tone === "warning").length;

  const groups: Array<{
    key: string;
    title: string;
    short: string;
    description: string;
    dot: string;
    bar: string;
    counters: AttentionCounter[];
  }> = [
    {
      key: "vendors",
      title: "Vendor records",
      short: "Vendor",
      description: "Onboarding and validation gates.",
      dot: "bg-blue-500",
      bar: "bg-blue-500",
      counters: [
        {
          key: "approvals",
          label: "Registrations awaiting approval",
          value: counts.awaitingApproval,
          hint: "Approve or reject a new vendor",
          tone: "blue",
          to: "/app/approvals",
        },
        ...(fleetRequired
          ? [
              {
                key: "fleet-validation",
                label: "Fleet records pending validation",
                value: counts.fleetPendingValidation,
                hint: "Vendor submissions not yet live",
                tone: "amber" as const,
              },
            ]
          : []),
      ],
    },
    {
      key: "rfqs",
      title: "RFQs & replies",
      short: "RFQs",
      description: "Dispatches to fix and replies to match.",
      dot: "bg-red-500",
      bar: "bg-red-500",
      counters: [
        {
          key: "rfq-failures",
          label: "RFQs with email delivery failures",
          value: counts.rfqsWithFailures,
          hint: "Resend or correct the recipient",
          tone: "red",
          to: "/app/rfqs",
          search: { delivery: "FAILED" },
        },
        {
          key: "replies",
          label: "Replies awaiting validation",
          value: counts.unmatchedQuotationResponses,
          hint: "Match the vendor, RFQ and crane, or dismiss it",
          tone: "blue",
          to: "/app/admin/replies",
        },
      ],
    },
    {
      key: "fleet",
      title: "Fleet & platform",
      short: "Fleet",
      description: "Crane records and email delivery.",
      dot: "bg-amber-500",
      bar: "bg-amber-500",
      counters: [
        {
          key: "stale",
          label: "Cranes stale",
          value: counts.cranesStale,
          hint: `No fleet update in ${thresholds?.staleFlagDays ?? 60}+ days`,
          tone: "amber",
        },
        {
          key: "unverified",
          label: "Cranes with no map location",
          value: counts.cranesUnverified,
          hint: "Pin the crane so it appears in discovery",
          tone: "amber",
        },
        {
          key: "lapsed",
          label: "Engaged cranes past their release date",
          value: counts.cranesLapsed,
          hint: "Check the booking or extend the engagement",
          tone: "red",
        },
        {
          key: "failed-emails",
          label: "Emails failed in the last 7 days",
          value: counts.failedEmails,
          hint: "Review the communications log",
          tone: "red",
        },
      ],
    },
  ];

  const meName = me?.fullName ?? me?.email.split("@")[0];

  const mix: MixGroup[] = groups.map((group) => ({
    key: group.key,
    label: group.short,
    total: group.counters.reduce((sum, counter) => sum + counter.value, 0),
    dot: group.dot,
    bar: group.bar,
  }));

  function refresh() {
    void dashboard.refetch();
    void users.refetch();
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.14em] text-accent-400 uppercase">
            Admin console
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
            {greetingFor(meName, new Date(now).getHours())}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            The day&rsquo;s exceptions and the SML staff who operate the portal.
          </p>
          <div className="mt-2.5">
            <HealthPill tone={health.tone} label={health.label} detail={health.detail} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="text-[11px] text-slate-500"
            title={
              dashboard.dataUpdatedAt
                ? new Date(dashboard.dataUpdatedAt).toLocaleString()
                : undefined
            }
          >
            {loading
              ? "Loading…"
              : `Updated ${relativeTime(dashboard.dataUpdatedAt || undefined, now)}`}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label="Refresh dashboard"
            className="btn-secondary h-9 px-3 py-0 text-[13px]"
          >
            <RefreshCw
              className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")}
              aria-hidden
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {dashboard.error ? (
        <Alert tone="error">{(dashboard.error as Error).message}</Alert>
      ) : null}

      {data || loading ? (
        <>
          <SummaryStrip counts={data?.counts} fleetRequired={fleetRequired} loading={loading} />

          <div className="grid grid-cols-1 gap-5 min-[1100px]:grid-cols-12">
            <Panel
              title="Needs attention"
              description="Grouped by the team that owns the fix."
              actions={
                <span className="text-[11px] tabular-nums text-slate-500">
                  {openTotal} open
                </span>
              }
              className="flex flex-col min-[1100px]:col-span-8"
              bodyClassName="flex min-h-0 flex-1 flex-col p-4"
            >
              <div className="grid grid-cols-1 gap-3 min-[768px]:grid-cols-3">
                {groups.map((group) => (
                  <AttentionGroup
                    key={group.key}
                    title={group.title}
                    description={group.description}
                    counters={group.counters}
                    loading={loading}
                  />
                ))}
              </div>
              {loading ? null : <ExceptionMix groups={mix} />}
            </Panel>

            <div className="min-[1100px]:col-span-4">
              <OperatingRules thresholds={thresholds} loading={loading} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 min-[1100px]:grid-cols-12">
            <Panel
              title="Alert queue"
              description="Server-ranked operations queue."
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  {errorAlerts > 0 ? (
                    <StatusPill tone="red">
                      {errorAlerts} critical
                    </StatusPill>
                  ) : null}
                  {warningAlerts > 0 ? (
                    <StatusPill tone="amber">
                      {warningAlerts} warning{warningAlerts === 1 ? "" : "s"}
                    </StatusPill>
                  ) : null}
                  {errorAlerts === 0 && warningAlerts === 0 && !loading ? (
                    <StatusPill tone="emerald">Clear</StatusPill>
                  ) : null}
                </div>
              }
              className="min-[1100px]:col-span-7"
            >
              <AdminAlertQueue alerts={alerts} loading={loading} />
            </Panel>

            <Panel
              title="Team snapshot"
              description="Derived from the SML users below."
              className="min-[1100px]:col-span-5"
            >
              <TeamSnapshot
                users={users.data}
                loading={users.isLoading}
                error={users.error as Error | null}
              />
            </Panel>
          </div>
        </>
      ) : (
        <Panel title="Team snapshot" description="Derived from the SML users below.">
          <TeamSnapshot
            users={users.data}
            loading={users.isLoading}
            error={users.error as Error | null}
          />
        </Panel>
      )}

      <div id="sml-users" className="scroll-mt-16">
        <UsersPanel
          users={users.data}
          loading={users.isLoading}
          error={users.error as Error | null}
          meId={me?.id}
        />
      </div>
    </div>
  );
}

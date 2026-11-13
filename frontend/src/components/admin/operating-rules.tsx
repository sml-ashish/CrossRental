import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Panel } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminDashboard } from "@/lib/admin";

/**
 * The thresholds the dashboard's alerts are computed from, shown as data.
 *
 * They used to be a sentence buried in the alerts panel description, where the
 * numbers were hard to find and impossible to scan. Here the same values are a
 * definition list, so "why is that RFQ flagged?" is answerable without leaving
 * the page, and the quick links cover the screens an admin opens from here.
 */
type Thresholds = AdminDashboard["thresholds"];

export function OperatingRules({
  thresholds,
  loading,
}: {
  thresholds: Thresholds | undefined;
  loading?: boolean;
}) {
  const rules: Array<{
    label: string;
    value: string;
    hint: string;
    pending?: boolean;
  }> = [
    {
      label: "Stale crane flag",
      value: `${thresholds?.staleFlagDays ?? 60} days`,
      hint: "Without a fleet update",
    },
    {
      label: "Fleet approval",
      value: thresholds?.fleetApprovalRequired ? "Required" : "Not required",
      hint: "New and edited fleet records",
      pending: thresholds?.fleetApprovalRequired,
    },
    {
      label: "RFQ response SLA",
      value: `${thresholds?.alertRfqSlaHours ?? 48} hours`,
      hint: "Before a sent RFQ is overdue",
    },
    {
      label: "Quotation expiry alert",
      value: `${thresholds?.alertQuotationExpiryDays ?? 3} days`,
      hint: "Before a quote expires",
    },
    {
      label: "Booking lead time",
      value: `${thresholds?.alertBookingLeadDays ?? 7} days`,
      hint: "Before a booking starts",
    },
  ];

  const links = [
    {
      label: "Vendor approvals",
      to: "/app/approvals",
      hint: "Registrations and fleet validation",
    },
    {
      label: "RFQ delivery failures",
      to: "/app/rfqs",
      search: { delivery: "FAILED" },
      hint: "Dispatches that never left",
    },
    {
      label: "Reply queue",
      to: "/app/admin/replies",
      hint: "Unmatched vendor replies",
    },
    {
      label: "Alert settings",
      to: "/app/settings",
      hint: "Thresholds and notification rules",
    },
  ];

  return (
    <Panel
      title="Operating rules"
      description="Thresholds the counters and alerts are measured against. Change them in Settings."
      className="h-full"
    >
      <dl className="divide-y divide-ink-800">
        {rules.map((rule) => (          <div key={rule.label} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <dt className="text-[13px] text-slate-700">{rule.label}</dt>
              <dd className="mt-0.5 text-[11px] text-slate-500">{rule.hint}</dd>
            </div>
            <dd className="shrink-0 text-right">
              {loading ? (
                <Skeleton className="h-4 w-16" />
              ) : rule.pending !== undefined ? (
                <StatusPill tone={rule.pending ? "amber" : "neutral"}>
                  {rule.value}
                </StatusPill>
              ) : (
                <span className="font-mono text-xs font-medium tabular-nums text-white">
                  {rule.value}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 border-t border-ink-800 pt-3">
        <p className="font-mono text-[10px] tracking-[0.1em] text-slate-500 uppercase">
          Quick links
        </p>
        <ul className="mt-1.5 grid grid-cols-1 gap-1 min-[420px]:grid-cols-2">
          {links.map((link) => (
            <li key={link.to + link.label}>
              <Link
                to={link.to as never}
                search={link.search as never}
                title={link.hint}
                className="group flex items-center justify-between gap-2 rounded-lg border border-ink-800 bg-ink-900 px-2.5 py-2 transition-colors hover:border-ink-700 hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                <span className="min-w-0 text-[12px] text-slate-700 group-hover:text-white">
                  {link.label}
                </span>
                <ArrowUpRight
                  className="size-3.5 shrink-0 text-slate-600 transition-colors group-hover:text-white"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

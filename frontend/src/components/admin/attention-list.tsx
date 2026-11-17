import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminDashboard, AdminDashboardCounts } from "@/lib/admin";
import type { ReviewKind } from "@/lib/admin-review";
import type { AlertItem } from "@/lib/internalDashboard";
import { cn } from "@/lib/cn";

/**
 * One list, built from both the counters and the server alerts.
 *
 * The dashboard used to show the same fact twice — a "cranes stale" counter and
 * a "3 cranes not updated in 60+ days" alert — in two different cards. Here the
 * alert wins when it covers a counter (it already carries the wording, severity
 * and destination), and the counter only stands in when the server did not send
 * an alert for it. Everything else is a single sentence, one line of what to do,
 * and one link.
 */

type Severity = "critical" | "warning" | "info";
type Thresholds = AdminDashboard["thresholds"];

export interface AttentionItem {
  id: string;
  severity: Severity;
  sentence: string;
  action: string;
  to: string;
  search?: Record<string, string>;
  order: number;
  /**
   * Set when Review opens the drawer on this page. Only checks whose rows
   * cannot be filtered elsewhere carry it; the rest stay plain links.
   */
  review?: ReviewKind;
}

export interface ClearCheck {
  id: string;
  label: string;
}

interface CounterCheck {
  key: keyof AdminDashboardCounts;
  order: number;
  severity: Severity;
  to: string;
  search?: Record<string, string>;
  /** The server alert that already says this same thing, when there is one. */
  alertKind?: AlertItem["kind"];
  sentence: (value: number, thresholds: Thresholds) => string;
  action: (value: number) => string;
  clearLabel: (thresholds: Thresholds) => string;
  /** Opens the dashboard drawer instead of following `to`. */
  review?: ReviewKind;
}

const COUNTER_CHECKS: CounterCheck[] = [
  {
    key: "unmatchedQuotationResponses",
    order: 10,
    severity: "critical",
    to: "/app/admin/replies",
    alertKind: "UNMATCHED_QUOTATION",
    sentence: (value) =>
      `${value} vendor ${value === 1 ? "reply is" : "replies are"} waiting to be matched`,
    action: (value) =>
      value === 1
        ? "Match it to its RFQ and crane, or dismiss it."
        : "Match each one to its RFQ and crane, or dismiss it.",
    clearLabel: () => "Vendor replies awaiting validation",
  },
  {
    key: "rfqsWithFailures",
    order: 20,
    severity: "critical",
    to: "/app/rfqs",
    search: { delivery: "FAILED" },
    sentence: (value) => `${value} RFQ${value === 1 ? "" : "s"} failed to send`,
    action: () => "Check the recipient address and resend.",
    clearLabel: () => "RFQ email failures",
  },
  {
    key: "failedEmails",
    order: 30,
    severity: "critical",
    to: "/app/communications",
    alertKind: "EMAIL_FAILURE",
    sentence: (value) =>
      `${value} email${value === 1 ? " has" : "s have"} failed in the last 7 days`,
    action: () => "Check the delivery log for the address that failed.",
    clearLabel: () => "Emails failed in the last 7 days",
  },
  {
    key: "cranesLapsed",
    order: 40,
    severity: "critical",
    to: "/app/bookings",
    review: "lapsed-engagements",
    sentence: (value) =>
      `${value} engaged crane${value === 1 ? " is" : "s are"} past ${
        value === 1 ? "its" : "their"
      } release date`,
    action: () => "Check the booking or extend the engagement.",
    clearLabel: () => "Engagements past their release date",
  },
  {
    key: "cranesStale",
    order: 60,
    severity: "warning",
    to: "/app/discovery",
    alertKind: "STALE_FLEET",
    review: "stale-cranes",
    sentence: (value, thresholds) =>
      `${value} crane${value === 1 ? " hasn't" : "s haven't"} been updated in ${
        thresholds.staleFlagDays
      }+ days`,
    action: () => "Vendors have been reminded; the fleet data may be out of date.",
    clearLabel: (thresholds) => `Cranes not updated in ${thresholds.staleFlagDays}+ days`,
  },
  {
    key: "cranesUnverified",
    order: 70,
    severity: "warning",
    to: "/app/discovery",
    review: "no-location",
    sentence: (value) => `${value} crane${value === 1 ? " has" : "s have"} no map location`,
    action: () => "Pin each crane so it shows up in Find cranes.",
    clearLabel: () => "Cranes without a map location",
  },
  {
    key: "fleetPendingValidation",
    order: 80,
    severity: "warning",
    to: "/app/approvals",
    review: "pending-fleet",
    sentence: (value) =>
      `${value} fleet record${value === 1 ? " is" : "s are"} waiting to be validated`,
    action: () => "Validate the submitted crane so it can go live.",
    clearLabel: () => "Fleet records pending validation",
  },
  {
    key: "awaitingApproval",
    order: 90,
    severity: "info",
    to: "/app/approvals",
    alertKind: "ONBOARDING_REQUEST",
    sentence: (value) =>
      `${value} vendor registration${value === 1 ? " is" : "s are"} waiting for approval`,
    action: () => "Review the registration and approve or reject it.",
    clearLabel: () => "Registrations awaiting approval",
  },
];

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Server alerts that describe the same rows as a drawer check. */
const REVIEW_BY_ALERT: Partial<Record<AlertItem["kind"], ReviewKind>> = {
  STALE_FLEET: "stale-cranes",
};

/** Kept by id as well, because the server's `to` for these still points away. */
const REVIEW_BY_ALERT_ID: Partial<Record<string, ReviewKind>> = {
  "stale-fleet": "stale-cranes",
  "unverified-fleet": "no-location",
  "lapsed-fleet": "lapsed-engagements",
};

const DEFAULTS: Thresholds = {
  staleFlagDays: 60,
  fleetApprovalRequired: false,
  alertRfqSlaHours: 48,
  alertQuotationExpiryDays: 3,
  alertBookingLeadDays: 7,
};

function severityFor(tone: AlertItem["tone"]): Severity {
  return tone === "error" ? "critical" : tone;
}

export function buildAttention(data: AdminDashboard | undefined): {
  items: AttentionItem[];
  clearChecks: ClearCheck[];
} {
  if (!data) return { items: [], clearChecks: [] };

  const { counts, thresholds, alerts } = data;
  const consumed = new Set<keyof AdminDashboardCounts>();
  const items: AttentionItem[] = [];

  for (const alert of alerts) {
    const check = COUNTER_CHECKS.find((candidate) => candidate.alertKind === alert.kind);
    if (check) consumed.add(check.key);

    items.push({
      id: alert.id,
      severity: severityFor(alert.tone),
      sentence: alert.title,
      action: alert.detail,
      // The server still points this alert at the dashboard itself; the log is
      // the only page that can show the failed messages.
      to: alert.kind === "EMAIL_FAILURE" ? "/app/communications" : alert.to,
      review: REVIEW_BY_ALERT[alert.kind] ?? REVIEW_BY_ALERT_ID[alert.id],
      order: check?.order ?? (alert.kind === "BOOKING_UNCONFIRMED" ? 50 : 55),
    });
  }

  const fleetRequired = thresholds.fleetApprovalRequired;

  for (const check of COUNTER_CHECKS) {
    if (check.key === "fleetPendingValidation" && !fleetRequired) continue;
    if (consumed.has(check.key)) continue;

    const value = counts[check.key];
    if (value <= 0) continue;

    items.push({
      id: `counter:${check.key}`,
      severity: check.severity,
      sentence: check.sentence(value, thresholds),
      action: check.action(value),
      to: check.to,
      search: check.search,
      review: check.review,
      order: check.order,
    });
  }

  items.sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      a.order - b.order ||
      a.sentence.localeCompare(b.sentence),
  );

  const clearChecks: ClearCheck[] = [];

  for (const check of COUNTER_CHECKS) {
    if (check.key === "fleetPendingValidation" && !fleetRequired) continue;
    if (consumed.has(check.key)) continue;
    if (counts[check.key] > 0) continue;

    clearChecks.push({
      id: check.key,
      label: check.clearLabel(thresholds),
    });
  }

  if (!alerts.some((alert) => alert.kind === "BOOKING_UNCONFIRMED")) {
    clearChecks.push({
      id: "booking-unconfirmed",
      label: "Bookings starting soon with unconfirmed availability",
    });
  }

  return { items, clearChecks };
}

export function AttentionList({
  items,
  clearChecks,
  thresholds,
  loading,
  onReview,
  activeReview,
}: {
  items: AttentionItem[];
  clearChecks: ClearCheck[];
  thresholds: Thresholds | undefined;
  loading: boolean;
  onReview: (kind: ReviewKind, title: string) => void;
  activeReview: ReviewKind | null;
}) {
  const resolved = thresholds ?? DEFAULTS;

  if (loading) {
    return (
      <ul className="divide-y divide-ink-800" aria-hidden>
        {[0, 1, 2].map((index) => (
          <li key={index} className="flex min-h-16 items-start gap-4 py-4">
            <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-64 max-w-full" />
              <Skeleton className="h-3 w-80 max-w-full" />
            </div>
            <Skeleton className="mt-1 h-3 w-14 shrink-0" />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      {items.length === 0 ? (
        <p className="py-6 text-[16px] leading-5 text-slate-600">
          All clear. Nothing needs your attention.
        </p>
      ) : (
        <ul aria-label="Needs attention" className="divide-y divide-ink-800">
          {items.map((item) => (
            <li key={item.id}>
              <AttentionRow
                item={item}
                onReview={onReview}
                active={item.review !== undefined && item.review === activeReview}
              />
            </li>
          ))}
        </ul>
      )}

      {clearChecks.length > 0 ? (
        <details className="group mt-5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-sm text-[15px] text-slate-500 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 [&::-webkit-details-marker]:hidden">
            <Check className="size-3.5 text-emerald-600" aria-hidden />
            <span>
              {clearChecks.length} other check{clearChecks.length === 1 ? " is" : "s are"} clear
            </span>
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
          </summary>
          <ul className="mt-3 space-y-2 pl-5">
            {clearChecks.map((check) => (
              <li key={check.id} className="flex items-center gap-2 text-[15px] text-slate-600">
                <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                {check.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-6 text-[15px] leading-5 text-slate-500">
        Alerts use your thresholds: fleet stale after {resolved.staleFlagDays} days, RFQ replies
        after {resolved.alertRfqSlaHours} h, quotations expiring within{" "}
        {resolved.alertQuotationExpiryDays} days, bookings starting within{" "}
        {resolved.alertBookingLeadDays} days. Change them in{" "}
        <Link
          to="/app/settings"
          className="underline decoration-slate-600 underline-offset-2 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Settings
        </Link>
        .
      </p>
    </>
  );
}

const SEVERITY = {
  critical: { dot: "bg-red-500", label: "Critical" },
  warning: { dot: "bg-amber-500", label: "Warning" },
  info: { dot: null, label: "Information" },
} as const;

function AttentionRow({
  item,
  onReview,
  active,
}: {
  item: AttentionItem;
  onReview: (kind: ReviewKind, title: string) => void;
  active: boolean;
}) {
  const severity = SEVERITY[item.severity];
  const review = item.review;
  const rowClass =
    "group flex min-h-16 flex-wrap items-start gap-x-4 gap-y-1 py-4 transition-colors hover:bg-ink-900/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500";

  const body = (
    <>
      <span className="mt-1.5 flex w-2 shrink-0 justify-center" aria-hidden>
        {severity.dot ? (
          <span className={cn("size-2 rounded-full", severity.dot)} />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-[16px] leading-5 text-slate-800">{item.sentence}</span>
        <span
          className="mt-1 line-clamp-1 block text-[15px] leading-5 text-slate-500"
          title={item.action}
        >
          {item.action}
        </span>
      </span>

      <span className="ml-auto inline-flex shrink-0 items-center gap-1 self-center text-[15px] font-medium text-slate-500 transition-colors group-hover:text-white">
        Review
        <ArrowRight className="size-3.5" aria-hidden />
      </span>
    </>
  );

  const label = `${severity.label}: ${item.sentence}. ${item.action} Review.`;

  if (review) {
    return (
      <button
        type="button"
        onClick={() => onReview(review, item.sentence)}
        aria-haspopup="dialog"
        aria-expanded={active}
        aria-label={label}
        className={cn(rowClass, "w-full text-left")}
      >
        {body}
      </button>
    );
  }

  return (
    <Link
      to={item.to as never}
      search={item.search as never}
      aria-label={label}
      className={rowClass}
    >
      {body}
    </Link>
  );
}


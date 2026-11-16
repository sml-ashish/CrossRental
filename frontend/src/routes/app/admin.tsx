import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AttentionList,
  buildAttention,
} from "@/components/admin/attention-list";
import { ReviewDrawer } from "@/components/admin/review-drawer";
import { StaffSection } from "@/components/admin/staff-section";
import { relativeTime, useNow } from "@/components/admin/hooks";
import { useAuth } from "@/lib/auth";
import { isReviewKind, reviewTitle, type ReviewKind } from "@/lib/admin-review";
import { loadAdminDashboard, loadAdminUsers } from "@/lib/admin";
import { cn } from "@/lib/cn";

/**
 * Admin console (P0 B).
 *
 * Two jobs only: what needs attention right now, and who has access. At wide
 * widths they sit side by side in one centred container — attention on the
 * left, staff on the right — so the page does not leave half the screen empty.
 * The attention list merges the counters and the server alerts so the same fact
 * is never printed twice, and staff management is a table plus a drawer rather
 * than a form that is always open.
 *
 * Every number comes from one `["admin", "dashboard"]` query; the team uses one
 * `["admin", "users"]` query. Vendor suspension stays on the vendor detail
 * screen, where the vendor is already in view. Every call here is admin-gated on
 * the server.
 */

function greetingFor(name: string | undefined, hour: number): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return name?.trim() ? `Good ${part}, ${name.trim()}` : `Good ${part}`;
}

export function AdminPage() {
  const { user: me } = useAuth();
  const now = useNow(15_000);

  const dashboard = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: loadAdminDashboard,
    refetchInterval: 60_000,
  });
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: loadAdminUsers,
    refetchInterval: 60_000,
  });

  const data = dashboard.data;
  const refreshing = dashboard.isFetching || users.isFetching;
  const { items, clearChecks } = useMemo(() => buildAttention(data), [data]);

  const search = useSearch({ strict: false }) as { review?: unknown };
  const navigate = useNavigate();
  const activeReview = isReviewKind(search.review) ? search.review : null;
  const reviewItem = activeReview
    ? items.find((item) => item.review === activeReview)
    : undefined;
  const reviewCounts: Record<ReviewKind, number> = {
    "stale-cranes": data?.counts.cranesStale ?? 0,
    "no-location": data?.counts.cranesUnverified ?? 0,
    "lapsed-engagements": data?.counts.cranesLapsed ?? 0,
    "pending-fleet": data?.counts.fleetPendingValidation ?? 0,
  };
  const drawerTitle =
    reviewItem?.sentence ??
    (activeReview && data
      ? reviewTitle(activeReview, reviewCounts[activeReview], data.thresholds.staleFlagDays)
      : "Review");

  function openReview(kind: ReviewKind) {
    void navigate({ to: "/app/admin", search: { review: kind } });
  }

  function closeReview() {
    void navigate({ to: "/app/admin", search: { review: undefined }, replace: true });
  }

  const status = useMemo(() => {
    if (dashboard.isLoading) {
      return { label: "Checking what needs attention…", dot: null };
    }
    if (!data) {
      return { label: "Status unavailable", dot: null };
    }
    if (items.length === 0) {
      return { label: "All clear", dot: "bg-emerald-500" };
    }
    const critical = items.some((item) => item.severity === "critical");
    return {
      label: `${items.length} ${items.length === 1 ? "thing needs" : "things need"} attention`,
      dot: critical ? "bg-red-500" : "bg-amber-500",
    };
  }, [dashboard.isLoading, data, items]);

  const meName = me?.fullName ?? me?.email.split("@")[0];
  const updatedLabel = dashboard.isLoading
    ? "Loading…"
    : dashboard.dataUpdatedAt
      ? `Updated ${relativeTime(dashboard.dataUpdatedAt, now)}`
      : "Not updated yet";

  function refresh() {
    void dashboard.refetch();
    void users.refetch();
  }

  return (
    <div className="mx-auto w-full max-w-[1360px] px-8 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
            {greetingFor(meName, new Date(now).getHours())}
          </h1>
          <p
            role="status"
            aria-live="polite"
            className="mt-1.5 flex items-center gap-2 text-[14px] leading-5 text-slate-600"
          >
            {status.dot ? (
              <span
                className={cn("size-2 shrink-0 rounded-full", status.dot)}
                aria-hidden
              />
            ) : null}
            <span>{status.label}</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-1">
          <span
            className="text-[13px] text-slate-500"
            title={
              dashboard.dataUpdatedAt
                ? new Date(dashboard.dataUpdatedAt).toLocaleString()
                : undefined
            }
          >
            {updatedLabel}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label="Refresh"
            title="Refresh"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
              aria-hidden
            />
          </button>
        </div>
      </header>

      <div className="mt-10 grid gap-y-12 min-[1200px]:grid-cols-12 min-[1200px]:gap-y-0">
        <section
          className="min-w-0 min-[1200px]:col-span-7 min-[1200px]:pr-10"
          aria-labelledby="attention-title"
        >
          <h2
            id="attention-title"
            className="text-[16px] leading-6 font-semibold text-slate-900"
          >
            Needs attention
          </h2>

          <div className="mt-4">
            {dashboard.error && !data ? (
              <div className="pb-4">
                <Alert tone="error">{(dashboard.error as Error).message}</Alert>
              </div>
            ) : (
              <AttentionList
                items={items}
                clearChecks={clearChecks}
                thresholds={data?.thresholds}
                loading={dashboard.isLoading}
                onReview={openReview}
                activeReview={activeReview}
              />
            )}
          </div>
        </section>

        <aside className="min-w-0 min-[1200px]:col-span-5 min-[1200px]:border-l min-[1200px]:border-ink-800 min-[1200px]:pl-10">
          <div className="min-[1200px]:sticky min-[1200px]:top-20 min-[1200px]:max-h-[calc(100vh-6rem)] min-[1200px]:overflow-y-auto min-[1200px]:overscroll-contain min-[1200px]:pr-1">
            <StaffSection
              users={users.data}
              loading={users.isLoading}
              error={users.error as Error | null}
              meId={me?.id}
            />
          </div>
        </aside>
      </div>

      {activeReview ? (
        <ReviewDrawer
          kind={activeReview}
          title={drawerTitle}
          expectedTotal={data ? reviewCounts[activeReview] : undefined}
          onClose={closeReview}
        />
      ) : null}
    </div>
  );
}

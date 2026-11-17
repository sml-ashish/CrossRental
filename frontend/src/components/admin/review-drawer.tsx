import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { loadAdminDashboardItems, type AdminDashboardItem } from "@/lib/admin";
import {
  REVIEW_DEFINITIONS,
  type ReviewDefinition,
  type ReviewKind,
} from "@/lib/admin-review";
import { CRANE_STATUS_LABELS, type CraneStatus } from "@/lib/fleet";
import { cn } from "@/lib/cn";

/**
 * The dashboard's one overlay: the exact rows behind a counter.
 *
 * Everything the admin decides is in the row — which crane, whose it is, why it
 * was flagged, and the one or two places to act. The list comes from the same
 * server query as the counter, so the number and the drawer cannot disagree.
 * Opening the drawer is a URL change (`?review=stale-cranes`), which makes it
 * deep-linkable and makes Back close it.
 */

const PAGE_SIZE = 25;

export function ReviewDrawer({
  kind,
  title,
  expectedTotal,
  onClose,
}: {
  kind: ReviewKind;
  title: string;
  /** The number the dashboard row showed, when it has loaded. */
  expectedTotal?: number;
  onClose: () => void;
}) {
  const definition = REVIEW_DEFINITIONS[kind];
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(PAGE_SIZE);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const items = useQuery({
    queryKey: ["admin", "fleet-items", definition.kind],
    queryFn: () => loadAdminDashboardItems(definition.kind),
    staleTime: 60_000,
  });

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [kind]);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, []);

  const data = items.data;
  const visible = data?.items.slice(0, limit) ?? [];
  const remaining = (data?.items.length ?? 0) - visible.length;
  const capped = data ? Math.max(0, data.total - data.items.length) : 0;
  const mismatch =
    data !== undefined && expectedTotal !== undefined && data.total !== expectedTotal;

  function recheck() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "dashboard"] });
    void items.refetch();
  }

  return (
    <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        aria-label="Close review"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-ink-800 bg-ink-900 shadow-2xl",
          "max-[1199.98px]:inset-x-0 max-[1199.98px]:top-auto max-[1199.98px]:bottom-0 max-[1199.98px]:max-h-[88vh] max-[1199.98px]:max-w-none max-[1199.98px]:rounded-t-2xl max-[1199.98px]:border-t max-[1199.98px]:border-l-0",
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-800 px-6 py-5">
          <div className="min-w-0">
            <h2
              id="review-title"
              className="text-[17px] leading-6 font-semibold text-slate-900"
            >
              {title}
            </h2>
            <p className="mt-1.5 text-[15px] leading-5 text-slate-500">
              {definition.explanation}
            </p>
          </div>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            aria-label="Close review"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
          {items.isLoading ? (
            <ReviewSkeleton />
          ) : items.isError ? (
            <div className="space-y-3 py-4">
              <Alert tone="error">{(items.error as Error).message}</Alert>
              <button
                type="button"
                onClick={() => void items.refetch()}
                className="btn-secondary h-9 px-3 py-0 text-[15px]"
              >
                Retry
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="py-8">
              <p className="text-[16px] leading-5 text-slate-600">
                Nothing to review. This was resolved.
              </p>
              <button
                type="button"
                onClick={recheck}
                className="btn-secondary mt-4 h-9 px-3 py-0 text-[15px]"
              >
                Check again
              </button>
            </div>
          ) : (
            <>
              {mismatch ? (
                <p className="pt-3 text-[14px] leading-5 text-slate-500">
                  The dashboard now counts {data?.total}. Refresh to update its number.
                </p>
              ) : null}

              {capped > 0 ? (
                <p className="pt-3 text-[14px] leading-5 text-slate-500">
                  Showing the first {data?.items.length} of {data?.total}.
                </p>
              ) : null}

              <ul className="divide-y divide-ink-800">
                {visible.map((item) => (
                  <ReviewRow key={item.craneId} item={item} kind={kind} />
                ))}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                <p className="text-[14px] tabular-nums text-slate-500">
                  {remaining > 0
                    ? `Showing ${visible.length} of ${data?.items.length}`
                    : `${data?.items.length ?? 0} item${
                        data?.items.length === 1 ? "" : "s"
                      }`}
                </p>
                {remaining > 0 ? (
                  <button
                    type="button"
                    onClick={() => setLimit((current) => current + PAGE_SIZE)}
                    className="btn-secondary h-9 px-3 py-0 text-[15px]"
                  >
                    Show {Math.min(PAGE_SIZE, remaining)} more
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-800 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary h-9 px-3 py-0 text-[15px]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ item, kind }: { item: AdminDashboardItem; kind: ReviewKind }) {
  const status =
    CRANE_STATUS_LABELS[item.currentStatus as CraneStatus] ?? item.currentStatus;
  const definition: ReviewDefinition = REVIEW_DEFINITIONS[kind];

  return (
    <li className="py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-[16px] leading-5 font-medium text-slate-900">
          {item.label}
        </p>
        <p className="shrink-0 text-[14px] tabular-nums text-slate-500">
          {item.capacityT} t
        </p>
      </div>
      <p className="mt-0.5 text-[15px] leading-5 text-slate-500">
        {item.make} {item.model}
      </p>

      <p className="mt-2 text-[15px] leading-5 text-slate-600">
        {whyFlagged(item, definition.kind, status)}
      </p>

      <p className="mt-1 text-[15px] leading-5 text-slate-500">
        Vendor:{" "}
        <Link
          to="/app/vendors/$vendorId"
          params={{ vendorId: item.vendorId }}
          className="text-slate-600 underline decoration-ink-700 underline-offset-2 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          {item.vendorName ?? "Unnamed vendor"}
        </Link>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[15px]">
        <Link
          to="/app/cranes/$craneId"
          params={{ craneId: item.craneId }}
          className={actionClass}
        >
          Open crane
        </Link>
        <Link
          to="/app/vendors/$vendorId"
          params={{ vendorId: item.vendorId }}
          className={actionClass}
        >
          Open vendor
        </Link>
        {definition.kind === "lapsed" ? (
          <Link to="/app/bookings" search={{ q: item.label }} className={actionClass}>
            Open booking calendar
          </Link>
        ) : null}
      </div>
    </li>
  );
}

const actionClass =
  "text-slate-600 underline decoration-ink-700 underline-offset-2 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

function whyFlagged(
  item: AdminDashboardItem,
  kind: ReviewDefinition["kind"],
  status: string,
): string {
  if (kind === "stale") {
    const days = item.daysSinceUpdate;
    return `Last updated ${
      days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`
    } · status ${status}`;
  }
  if (kind === "unverified") {
    return "No pin on file, so it can't appear in Find cranes.";
  }
  if (kind === "lapsed") {
    const date = calendarDay(item.availableFrom);
    const overdue = item.daysOverdue ?? 0;
    return `Engaged until ${date}. That date has passed${
      overdue > 0 ? ` by ${overdue} day${overdue === 1 ? "" : "s"}` : ""
    }.`;
  }
  return "New record. Approve or reject.";
}

function calendarDay(iso: string | null): string {
  if (!iso) return "an unrecorded date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unrecorded date";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function ReviewSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="space-y-2 border-b border-ink-800 py-4 last:border-b-0">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-64 max-w-full" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </div>
  );
}


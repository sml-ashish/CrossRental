import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CheckCircle2, Plus, X } from "lucide-react";
import {
  getVendorDashboard,
  type DashboardAwaitingRfq,
  type DashboardDueCrane,
  type VendorDashboard,
} from "@/lib/dashboard";
import {
  confirmCraneAccurate,
  CRANE_STATUS_LABELS,
  isSystemLocked,
  listCranes,
  quickUpdateCrane,
  VENDOR_STATUSES,
  type Crane,
} from "@/lib/fleet";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import {
  buildComingUp,
  craneRowName,
  craneSerial,
  deadlineInfo,
  dueReason,
  fleetStats,
  formatCapacity,
  getFoundItems,
  greetingFor,
  isFirstTime,
  placeLabel,
  quoteStatusText,
  requirementTitle,
  statusSentence,
  suggestCranes,
  type CraneSuggestion,
  type FleetStats,
} from "@/lib/vendor-dashboard";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";

/**
 * The vendor's landing screen (brief 7.5, M7).
 *
 * A vendor opens this screen to answer one question first: is there a job I can
 * still quote on? The RFQ cards lead; the fleet is next because a stale status
 * or a missing pin quietly removes a crane from SML's searches. Counters only
 * appear as sentences, and every action that already exists on another screen
 * is reachable from here without leaving it.
 *
 * The page reads the dashboard payload for its counts and rows, and reuses the
 * existing crane list for the details the payload does not carry (make, model,
 * load chart, map pin). It never guesses a fact that is not in either response:
 * a missing type code or capacity simply omits the suggestion line.
 */

interface VendorContactSummary {
  name: string;
  receivesRfqs: boolean;
}

interface VendorSummary {
  name: string;
  contacts: VendorContactSummary[];
}

const PRIMARY_BUTTON =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 sm:w-auto";

const PRIMARY_BUTTON_SMALL =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400";

const ROW_BUTTON =
  "btn-secondary px-3 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-60";

export function VendorDashboardPage() {
  const { user } = useAuth();
  const now = useMinuteTick();

  const dashboard = useQuery({
    queryKey: ["vendor-dashboard"],
    queryFn: getVendorDashboard,
  });

  // The same key the quote panel uses, so a status confirmed here refreshes
  // the crane picker there too.
  const cranes = useQuery({
    queryKey: ["cranes"],
    queryFn: () => listCranes(),
    staleTime: 60_000,
  });

  const vendor = useQuery({
    queryKey: ["vendors", "me"],
    queryFn: () =>
      api<{ vendor: VendorSummary }>("/vendors/me").then((response) => response.vendor),
    staleTime: 5 * 60_000,
  });

  const data = dashboard.data;
  const craneList = cranes.data?.cranes ?? null;

  const bookedCraneIds = useMemo(
    () => new Set((data?.fleet.bookings.cranes ?? []).map((booking) => booking.craneId)),
    [data],
  );
  const craneById = useMemo(
    () => new Map((craneList ?? []).map((crane) => [crane.id, crane])),
    [craneList],
  );

  if (dashboard.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading your dashboard
      </div>
    );
  }

  if (dashboard.error) {
    return (
      <Alert title="Could not load your dashboard">
        {(dashboard.error as Error).message}
      </Alert>
    );
  }

  if (!data) return null;

  const vendorName = vendor.data?.name ?? user?.vendorName;
  const firstTime = isFirstTime(data);

  return (
    <div className="mx-auto max-w-[1120px]">
      <DashboardHeader
        name={vendorName}
        status={firstTime ? null : statusSentence(data)}
        showAddCrane={!firstTime}
      />

      {firstTime ? (
        <div className="mt-6">
          <FirstTimeState
            data={data}
            cranes={craneList}
            contacts={vendor.data?.contacts ?? null}
          />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-10">
          <div className="contents lg:block lg:min-w-0 lg:space-y-8">
            <div className="order-1 lg:order-none">
              <WaitingSection data={data} cranes={craneList} bookedCraneIds={bookedCraneIds} now={now} />
            </div>

            <div className="order-2 lg:order-none">
              <CranesSection
                data={data}
                cranes={craneList}
                craneById={craneById}
                bookedCraneIds={bookedCraneIds}
              />
            </div>

            {data.quotations.awardedCount > 0 ? (
              <div className="order-5 lg:order-none">
                <WonSection count={data.quotations.awardedCount} />
              </div>
            ) : null}
          </div>

          <aside className="contents lg:block lg:min-w-0 lg:space-y-6">
            <div className="order-3 lg:order-none">
              <ComingUpSection data={data} now={now} />
            </div>

            <div className="order-4 lg:order-none">
              <HowDoingSection data={data} />
            </div>

            <div className="order-6 lg:order-none">
              <GetFoundSection
                cranes={craneList}
                contacts={vendor.data?.contacts ?? null}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** The countdowns must not go stale while the tab sits open. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function DashboardHeader({
  name,
  status,
  showAddCrane,
}: {
  name?: string;
  status: { text: string; tone: "amber" | "green" } | null;
  showAddCrane: boolean;
}) {
  const greeting = greetingFor();
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-slate-900">
          {greeting}, {name ?? "there"}
        </h1>
        {status ? (
          <p className="mt-1.5 flex items-center gap-2 text-sm text-slate-600">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status.tone === "green" ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
            <span>{status.text}</span>
          </p>
        ) : null}
      </div>

      {showAddCrane ? (
        <Link
          to="/app/fleet/new"
          search={{ duplicate: undefined, vendorId: undefined }}
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg px-1 py-1 text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
        >
          <Plus className="size-3.5" aria-hidden />
          Add a crane
        </Link>
      ) : null}
    </header>
  );
}

function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-slate-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

function WaitingSection({
  data,
  cranes,
  bookedCraneIds,
  now,
}: {
  data: VendorDashboard;
  cranes: Crane[] | null;
  bookedCraneIds: ReadonlySet<string>;
  now: number;
}) {
  const rows = [...data.rfqs.awaitingResponse].sort(
    (a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
  );
  const open = rows.filter((row) => !deadlineInfo(row.deadline, now).closed);
  const closed = rows.filter((row) => deadlineInfo(row.deadline, now).closed);

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Waiting for your quote"
        hint="Nearest deadline first."
        action={
          <Link
            to="/app/rfqs"
            className="text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900"
          >
            All RFQs
          </Link>
        }
      />

      {open.map((row) => (
        <RfqCard
          key={row.rfqId}
          row={row}
          cranes={cranes}
          bookedCraneIds={bookedCraneIds}
          now={now}
        />
      ))}

      {open.length === 0 && closed.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No RFQs waiting for you."
            description="We'll email you when one arrives."
            action={
              <Link to="/app/rfqs" className="btn-secondary py-[7px] text-[13px]">
                See all RFQs
              </Link>
            }
          />
        </div>
      ) : null}

      {closed.length > 0 ? (
        <div className="pt-1">
          <div className="flex items-center gap-3">
            <h3 className="text-[13px] font-medium text-slate-500">Closed</h3>
            <div className="h-px flex-1 bg-ink-800" />
          </div>
          <div className="mt-3 space-y-3">
            {closed.map((row) => (
              <RfqCard
                key={row.rfqId}
                row={row}
                cranes={cranes}
                bookedCraneIds={bookedCraneIds}
                now={now}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RfqCard({
  row,
  cranes,
  bookedCraneIds,
  now,
}: {
  row: DashboardAwaitingRfq;
  cranes: Crane[] | null;
  bookedCraneIds: ReadonlySet<string>;
  now: number;
}) {
  const deadline = deadlineInfo(row.deadline, now);
  const suggestion = suggestCranes(cranes, row, bookedCraneIds);
  const hasQuote = row.liveQuotationCount > 0 || row.responseStatus === "QUOTED";
  const canQuote =
    !deadline.closed &&
    (row.responseStatus === "PENDING" || row.responseStatus === "QUOTED");
  // The decline panel on the RFQ screen is only offered while the response is
  // still pending, so the link says "Can't do this" only when it can be honoured.
  const canDecline = !deadline.closed && row.responseStatus === "PENDING";

  return (
    <article className="card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-slate-900">
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: row.rfqId }}
              className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
            >
              {requirementTitle(row)}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {placeLabel(row.siteLocation, row.siteStateName)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{row.rfqNumber}</p>
        </div>

        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium",
            deadline.tone === "closed"
              ? "text-red-600"
              : deadline.tone === "soon"
                ? "text-amber-700"
                : "text-slate-600",
          )}
          title={deadline.full}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              deadline.tone === "closed"
                ? "bg-red-500"
                : deadline.tone === "soon"
                  ? "bg-amber-500"
                  : "bg-slate-500",
            )}
            aria-hidden
          />
          {deadline.label}
        </span>
      </div>

      <p className="mt-3 text-[13px] text-slate-600">{quoteStatusText(row)}</p>

      {suggestion && !deadline.closed ? (
        <p className="mt-1 text-[13px] text-slate-600">{suggestionText(suggestion)}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        {canQuote ? (
          <Link
            to="/app/rfqs/$rfqId"
            params={{ rfqId: row.rfqId }}
            className={PRIMARY_BUTTON}
          >
            {hasQuote ? "Edit quote" : "Send quote"}
          </Link>
        ) : null}

        <Link
          to="/app/rfqs/$rfqId"
          params={{ rfqId: row.rfqId }}
          className="inline-flex items-center justify-center rounded-lg px-1 py-1 text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
        >
          {canDecline ? "Can't do this" : "View RFQ"}
        </Link>
      </div>
    </article>
  );
}

function suggestionText(suggestion: CraneSuggestion): string {
  if (suggestion.cranes.length === 0) {
    return "None of your cranes are free right now. You can still quote.";
  }

  const label = (crane: { serial: string; capacityT: number }) =>
    `${crane.serial} (${formatCapacity(crane.capacityT)} t)`;

  if (suggestion.cranes.length === 1) {
    return `Your crane ${label(suggestion.cranes[0]!)} looks suitable.`;
  }

  const shown = suggestion.cranes.slice(0, 2).map(label);
  const extra = suggestion.cranes.length - shown.length;
  const suffix = extra > 0 ? ` and ${extra} more` : "";
  return `${suggestion.cranes.length} of your cranes look suitable: ${shown.join(", ")}${suffix}.`;
}

function CranesSection({
  data,
  cranes,
  craneById,
  bookedCraneIds,
}: {
  data: VendorDashboard;
  cranes: Crane[] | null;
  craneById: ReadonlyMap<string, Crane>;
  bookedCraneIds: ReadonlySet<string>;
}) {
  const stats = fleetStats(data, cranes);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Your cranes"
        hint="SML sales search by availability, so keep these current."
        action={
          <Link
            to="/app/fleet"
            className="text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900"
          >
            My fleet
          </Link>
        }
      />

      <FleetBar stats={stats} hasCranes={data.fleet.totalCranes > 0} />

      {notice ? (
        <p
          role="status"
          className="flex items-center gap-2 px-1 text-[13px] font-medium text-emerald-700"
        >
          <Check className="size-3.5 shrink-0" aria-hidden />
          {notice}
        </p>
      ) : null}

      {data.fleet.totalCranes === 0 ? null : data.fleet.dueForUpdate.length === 0 ? (
        <p className="flex items-center gap-2 px-1 text-sm text-slate-600">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />
          Every crane is up to date.
        </p>
      ) : (
        <div className="card divide-y divide-ink-800">
          {data.fleet.dueForUpdate.map((row) => (
            <QuickCheckRow
              key={row.craneId}
              row={row}
              crane={craneById.get(row.craneId)}
              booked={bookedCraneIds.has(row.craneId)}
              onResult={setNotice}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FleetBar({ stats, hasCranes }: { stats: FleetStats; hasCranes: boolean }) {
  const totalForBar = stats.segments.reduce((sum, segment) => sum + segment.count, 0);

  return (
    <div className="card p-4">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-800">
        {totalForBar > 0
          ? stats.segments.map((segment) => (
              <Link
                key={segment.key}
                to="/app/fleet"
                aria-hidden
                tabIndex={-1}
                title={`${segment.count} ${segment.label}`}
                className={cn("block h-full", segment.dot)}
                style={{ width: `${(segment.count / totalForBar) * 100}%` }}
              />
            ))
          : null}
      </div>

      {hasCranes ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate-600">
          <span>
            <span className="font-medium tabular-nums text-slate-900">{stats.total}</span>{" "}
            {stats.total === 1 ? "crane" : "cranes"}
          </span>

          {stats.segments.map((segment) => (
            <span key={segment.key} className="inline-flex items-center gap-2">
              <span className="text-slate-400" aria-hidden>
                ·
              </span>
              <Link
                to="/app/fleet"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-slate-900"
              >
                <span className={cn("size-1.5 rounded-full", segment.dot)} aria-hidden />
                <span className="font-medium tabular-nums text-slate-900">{segment.count}</span>{" "}
                {segment.label}
              </Link>
            </span>
          ))}

          {stats.needCheck > 0 ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-slate-400" aria-hidden>
                ·
              </span>
              <Link
                to="/app/fleet"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-slate-900"
              >
                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                <span className="font-medium tabular-nums text-slate-900">{stats.needCheck}</span>{" "}
                {stats.needCheck === 1 ? "needs" : "need"} a check
              </Link>
            </span>
          ) : null}
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-slate-600">
          No cranes yet.{" "}
          <Link to="/app/fleet/new" search={{ duplicate: undefined, vendorId: undefined }} className="font-medium text-slate-900 underline-offset-2 hover:underline">
            Add your first crane
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function QuickCheckRow({
  row,
  crane,
  booked,
  onResult,
}: {
  row: DashboardDueCrane;
  crane?: Crane;
  booked: boolean;
  onResult: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);

  const reason = dueReason(row);
  const name = craneRowName(row, crane);
  const serial = crane?.serialRegistrationNo ?? craneSerial(row.label);
  const locked = crane ? isSystemLocked(crane) || booked : booked;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["vendor-dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["cranes"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet"] });
  };

  const confirm = useMutation({
    mutationFn: () => confirmCraneAccurate(row.craneId),
    onSuccess: () => {
      setError(null);
      setUpdated(true);
      onResult(`${serial} is up to date.`);
      refresh();
    },
    onError: (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "That update could not be saved."),
  });

  useEffect(() => {
    if (!updated) return;
    const timer = window.setTimeout(() => setUpdated(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [updated]);

  return (
    <div className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-slate-900">{name}</p>
          <p className="mt-0.5 text-[13px] text-slate-600">
            {reason.lead}
            {reason.details.length > 0 ? ` ${reason.details.join(" ")}` : ""}
          </p>
          {error ? (
            <p role="alert" className="mt-1 text-[13px] text-red-600">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {updated ? (
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-700">
              <Check className="size-3.5" aria-hidden />
              Updated
            </span>
          ) : null}

          <button
            type="button"
            className={ROW_BUTTON}
            onClick={() => confirm.mutate()}
            disabled={confirm.isPending}
          >
            {confirm.isPending ? "Saving…" : "Still correct"}
          </button>

          {!locked && crane ? (
            <UpdatePopover
              crane={crane}
              onSaved={() => {
                setUpdated(true);
                onResult(`${serial} updated.`);
              }}
            />
          ) : null}

          {!crane ? (
            <Link
              to="/app/fleet/$craneId/edit"
              params={{ craneId: row.craneId }}
              className={ROW_BUTTON}
            >
              Open crane
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The date field starts empty when the stored date has already lapsed.
 *
 * These rows are here because that date lapsed; re-showing it invites a Save
 * that the backend will refuse. An empty field plus the inline rule says what
 * is actually needed.
 */
function initialAvailableFrom(crane: Crane): string {
  if (!crane.availableFrom) return "";
  const stored = crane.availableFrom.slice(0, 10);
  return stored >= localToday() ? stored : "";
}

function UpdatePopover({ crane, onSaved }: { crane: Crane; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>(() =>
    (VENDOR_STATUSES as readonly string[]).includes(crane.currentStatus)
      ? crane.currentStatus
      : "AVAILABLE",
  );
  const [availableFrom, setAvailableFrom] = useState(() => initialAvailableFrom(crane));
  const [error, setError] = useState<string | null>(null);
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const statusId = `crane-status-${crane.id}`;
  const availableId = `crane-available-${crane.id}`;

  const save = useMutation({
    mutationFn: () => {
      if (status === "ENGAGED" && !availableFrom) {
        throw new Error("Give the date this crane becomes available.");
      }
      return quickUpdateCrane(crane.id, {
        currentStatus: status,
        currentLocation: crane.currentLocation,
        stateCode: crane.stateCode,
        availableFrom: status === "ENGAGED" ? availableFrom : null,
      });
    },
    onSuccess: () => {
      setOpen(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["vendor-dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["cranes"] });
      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
      onSaved();
    },
    onError: (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "That update could not be saved."),
  });

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLSelectElement>("select")?.focus();
  }, [open]);

  const close = (returnFocus = true) => {
    setOpen(false);
    setError(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  const openPanel = () => {
    setStatus(
      (VENDOR_STATUSES as readonly string[]).includes(crane.currentStatus)
        ? crane.currentStatus
        : "AVAILABLE",
    );
    setAvailableFrom(initialAvailableFrom(crane));
    setError(null);

    // The rows sit low on the page, so a panel opened downward is usually cut
    // off by the viewport. Flip it above the button when there is more room
    // there; the mobile sheet ignores this because it is fixed to the bottom.
    const rect = triggerRef.current?.getBoundingClientRect();
    const below = rect ? window.innerHeight - rect.bottom : 0;
    const above = rect?.top ?? 0;
    setPlacement(below < 320 && above > below ? "top" : "bottom");
    setOpen(true);
  };

  // `aria-modal` promises the tab key stays inside; keep that promise.
  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={ROW_BUTTON}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openPanel())}
      >
        Update
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close update form"
            tabIndex={-1}
            className="fixed inset-0 z-[60] cursor-default bg-black/20 sm:bg-transparent"
            onClick={() => close()}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Update ${crane.serialRegistrationNo}`}
            onKeyDown={onPanelKeyDown}
            className={cn(
              "fixed inset-x-0 bottom-0 z-[70] max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-ink-800 bg-ink-900 p-4 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:w-80 sm:rounded-xl sm:border sm:p-4",
              placement === "top"
                ? "sm:top-auto sm:bottom-full sm:mb-2"
                : "sm:top-full sm:bottom-auto sm:mt-2",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                Update {crane.serialRegistrationNo}
              </p>
              <button
                type="button"
                onClick={() => close()}
                aria-label="Close update form"
                className="rounded-md p-1 text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div className="mt-3 space-y-3">
              <Field label="Status" htmlFor={statusId}>
                <Select
                  id={statusId}
                  value={status}
                  onChange={setStatus}
                  placeholder="Choose status"
                  options={VENDOR_STATUSES.map((value) => ({
                    value,
                    label: CRANE_STATUS_LABELS[value],
                  }))}
                />
              </Field>

              <Field
                label="Available from"
                htmlFor={availableId}
                hint="Required when the status is Engaged."
              >
                <input
                  id={availableId}
                  type="date"
                  className="field-input"
                  min={localToday()}
                  value={availableFrom}
                  onChange={(event) => setAvailableFrom(event.target.value)}
                />
              </Field>

              {error ? (
                <p role="alert" className="text-[13px] text-red-600">
                  {error}
                </p>
              ) : null}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="btn-secondary flex-1 px-3 py-2 text-[13px]"
                  onClick={() => close()}
                  disabled={save.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={cn(PRIMARY_BUTTON_SMALL, "flex-1")}
                  onClick={() => save.mutate()}
                  disabled={save.isPending}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ComingUpSection({ data, now }: { data: VendorDashboard; now: number }) {
  const { thisWeek, later } = buildComingUp(data, now);

  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Coming up</h2>
        <Link
          to="/app/calendar"
          className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900"
        >
          Open calendar
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      {thisWeek.length === 0 && later.length === 0 ? (
        <p className="mt-3 text-[13px] text-slate-500">
          Nothing scheduled in the next 30 days.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {thisWeek.length > 0 ? (
            <ComingUpGroup title="This week" items={thisWeek} />
          ) : null}
          {later.length > 0 ? <ComingUpGroup title="Later" items={later} /> : null}
        </div>
      )}
    </section>
  );
}

function ComingUpGroup({
  title,
  items,
}: {
  title: string;
  items: ReturnType<typeof buildComingUp>["thisWeek"];
}) {
  return (
    <div>
      <p className="text-[13px] font-medium text-slate-500">{title}</p>
      <ul className="mt-2 space-y-2.5">
        {items.map((item) => (
          <li key={item.key} className="flex gap-3">
            <span
              className="w-20 shrink-0 text-[13px] tabular-nums text-slate-500"
              title={item.full}
            >
              {item.dateLabel}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-slate-900">{item.label}</p>
              <p className="text-xs text-slate-500">
                {item.detail ? `${item.detail} · ` : ""}
                {item.note}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HowDoingSection({ data }: { data: VendorDashboard }) {
  const sent = data.quotations.submittedCount;
  const won = data.quotations.awardedCount;

  return (
    <section className="card p-4">
      <h2 className="text-base font-semibold text-slate-900">How you're doing</h2>
      <p className="mt-2 text-sm text-slate-600">
        {sent === 0 ? (
          "No quotes sent yet."
        ) : (
          <>
            <span className="font-medium tabular-nums text-slate-900">{sent}</span>{" "}
            {sent === 1 ? "quote" : "quotes"} sent ·{" "}
            {won === 0 ? (
              "none won yet"
            ) : (
              <>
                <span className="font-medium tabular-nums text-slate-900">{won}</span> won
              </>
            )}
          </>
        )}
      </p>
    </section>
  );
}

function GetFoundSection({
  cranes,
  contacts,
}: {
  cranes: Crane[] | null;
  contacts: { receivesRfqs: boolean }[] | null;
}) {
  const items = getFoundItems(cranes, contacts);
  if (items.length === 0) return null;

  return (
    <section className="card p-4">
      <h2 className="text-base font-semibold text-slate-900">Get found</h2>
      <p className="mt-0.5 text-[13px] text-slate-500">
        A few fixes that help SML match you to jobs.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              to={item.to}
              className="group flex items-start justify-between gap-3 text-sm text-slate-700 transition-colors hover:text-slate-900"
            >
              <span className="min-w-0">{item.text}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-slate-600 group-hover:text-slate-900">
                {item.linkLabel}
                <ArrowRight className="size-3.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WonSection({ count }: { count: number }) {
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />
          You've won {count} {count === 1 ? "job" : "jobs"}
        </p>
        <Link
          to="/app/quotes"
          className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900"
        >
          Quotations
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

function FirstTimeState({
  data,
  cranes,
  contacts,
}: {
  data: VendorDashboard;
  cranes: Crane[] | null;
  contacts: { receivesRfqs: boolean }[] | null;
}) {
  const locationsDone =
    data.fleet.totalCranes > 0 &&
    cranes !== null &&
    cranes.every((crane) => !crane.locationUnverified);
  const contactsDone = contacts !== null && contacts.some((contact) => contact.receivesRfqs);
  const fleetDone = data.fleet.totalCranes > 0;

  const steps = [
    {
      key: "fleet",
      title: "Add your fleet",
      description: "List the cranes you want SML to sell.",
      done: fleetDone,
      to: "/app/fleet/new",
      search: { duplicate: undefined, vendorId: undefined },
      linkLabel: "Add a crane",
    },
    {
      key: "locations",
      title: "Pin each crane's location",
      description: "A pin helps SML show your crane to nearby jobs.",
      done: locationsDone,
      to: "/app/fleet",
      search: undefined,
      linkLabel: "Open My fleet",
    },
    {
      key: "contacts",
      title: "Add RFQ contacts",
      description: "Ask SML to add who should receive new enquiries by email.",
      done: contactsDone,
      to: "/app/profile",
      search: undefined,
      linkLabel: "View contacts",
    },
  ];

  return (
    <section className="card p-6">
      <h2 className="text-base font-semibold text-slate-900">Let's get you found</h2>
      <p className="mt-1 max-w-lg text-sm text-slate-600">
        Three steps, and SML sales can start sending you work.
      </p>

      <ol className="mt-5 space-y-4">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3">
            <span className="mt-0.5 flex w-5 shrink-0 justify-center text-sm font-medium text-slate-500">
              {step.done ? (
                <Check className="size-4 text-emerald-600" aria-hidden />
              ) : (
                `${index + 1}.`
              )}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-slate-900">
                {step.title}
                {step.done ? (
                  <span className="text-[13px] font-medium text-emerald-700">Done</span>
                ) : null}
              </p>
              <p className="text-[13px] text-slate-500">{step.description}</p>
              {!step.done ? (
                <Link
                  to={step.to}
                  search={step.search}
                  className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-slate-900 underline-offset-2 hover:underline"
                >
                  {step.linkLabel}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-5 text-xs text-slate-500">
        Need a hand? Reply to the welcome email from SML.
      </p>
    </section>
  );
}

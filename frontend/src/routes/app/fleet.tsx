import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Filter,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import {
  confirmCraneAccurate,
  CRANE_STATUS_LABELS,
  deactivateCrane,
  downloadLoadChart,
  fetchReferenceData,
  isSystemLocked,
  listCranes,
  quickUpdateCrane,
  reactivateCrane,
  uploadLoadChart,
  VENDOR_STATUSES,
  type Crane,
  type CraneStatus,
  type QuickUpdate,
  type VendorCraneStatus,
} from "@/lib/fleet";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";

/**
 * The vendor's fleet (brief 7.4).
 *
 * One compact row per crane: what it is, what it is doing, where it is, and how
 * recent that answer is. The vendor's three allowed statuses are edited in
 * place; BOOKED and HIRED belong to SML and are shown read-only. Anything that
 * needs a form (add, edit, duplicate) goes to the crane form.
 *
 * The list is fetched with deactivated cranes included so the toggle can say
 * how many there are; the toggle itself is a client-side view filter.
 */

type StatusChip = "all" | VendorCraneStatus | "BOOKED_HIRED";
type SortKey = "attention" | "name" | "capacity" | "status";
type TodoFilter = "missing-chart" | "needs-check" | "no-pin" | null;

const STATUS_CHIPS: Array<{ value: StatusChip; label: string }> = [
  { value: "all", label: "All" },
  { value: "AVAILABLE", label: "Available" },
  { value: "ENGAGED", label: "Engaged" },
  { value: "UNDER_MAINTENANCE", label: "Maintenance" },
  { value: "BOOKED_HIRED", label: "Booked/Hired" },
];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "attention", label: "Needs attention first" },
  { value: "name", label: "Name" },
  { value: "capacity", label: "Capacity" },
  { value: "status", label: "Status" },
];

const STATUS_DOTS: Record<CraneStatus, string> = {
  AVAILABLE: "bg-emerald-400",
  ENGAGED: "bg-blue-400",
  UNDER_MAINTENANCE: "bg-amber-400",
  BOOKED: "bg-slate-400",
  HIRED: "bg-slate-400",
};

const ROW_GRID =
  "grid grid-cols-[minmax(0,2fr)_165px_165px_170px_140px_36px] items-center gap-3";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })}`;
}

function confirmedLabel(days: number): string {
  if (days <= 0) return "Confirmed today";
  return `Confirmed ${days} ${days === 1 ? "day" : "days"} ago`;
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) =>
      word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function craneName(crane: Crane): string {
  const name = `${crane.make} ${crane.model}`.trim();
  return name.length > 0 ? name : crane.serialRegistrationNo;
}

function detailLine(crane: Crane): string {
  const type = crane.typeOfCrane?.name ?? "Crane";
  return `${crane.capacityT} t · ${type} · ${crane.yom}`;
}

function availabilityPassed(crane: Crane): boolean {
  if (crane.currentStatus === "AVAILABLE" || !crane.availableFrom) return false;
  return crane.availableFrom.slice(0, 10) < todayKey();
}

/** Stale, due, or an availability date that has gone by while still engaged. */
function needsStatusCheck(crane: Crane): boolean {
  return (
    crane.isActive &&
    (crane.freshness.stale || crane.freshness.dueForUpdate || availabilityPassed(crane))
  );
}

function attentionScore(crane: Crane): number {
  let score = 0;
  if (needsStatusCheck(crane)) score += 4;
  if (!crane.loadChart) score += 2;
  if (crane.locationUnverified) score += 1;
  if (!crane.isActive) score += 1;
  return score;
}

function matchesTodo(crane: Crane, todo: TodoFilter): boolean {
  if (todo === null) return true;
  if (todo === "missing-chart") return crane.loadChart === null;
  if (todo === "needs-check") return needsStatusCheck(crane);
  return crane.locationUnverified;
}

function matchesStatusChip(crane: Crane, chip: StatusChip): boolean {
  if (chip === "all") return true;
  if (chip === "BOOKED_HIRED") {
    return crane.currentStatus === "BOOKED" || crane.currentStatus === "HIRED";
  }
  return crane.currentStatus === chip;
}

function sortCranes(cranes: Crane[], sort: SortKey): Crane[] {
  const sorted = [...cranes];
  sorted.sort((left, right) => {
    if (sort === "capacity") return right.capacityT - left.capacityT;
    if (sort === "status") {
      return (
        CRANE_STATUS_LABELS[left.currentStatus].localeCompare(
          CRANE_STATUS_LABELS[right.currentStatus],
        ) || craneName(left).localeCompare(craneName(right))
      );
    }
    if (sort === "attention") {
      return (
        attentionScore(right) - attentionScore(left) ||
        craneName(left).localeCompare(craneName(right))
      );
    }
    return craneName(left).localeCompare(craneName(right));
  });
  return sorted;
}

interface CraneActions {
  busy: boolean;
  onQuickUpdate: (crane: Crane, input: QuickUpdate) => Promise<void>;
  onConfirm: (crane: Crane) => void;
  onDuplicate: (crane: Crane) => void;
  onDeactivate: (crane: Crane) => void;
  onReactivate: (crane: Crane) => void;
  onUploadChart: (crane: Crane, file: File) => void;
  onDownloadChart: (crane: Crane) => void;
}

export function FleetPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { notice?: string };

  const [statusChip, setStatusChip] = useState<StatusChip>("all");
  const [typeOfCraneCode, setTypeOfCraneCode] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [todo, setTodo] = useState<TodoFilter>(null);
  const [sort, setSort] = useState<SortKey>("attention");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(search.notice ?? null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const reference = useQuery({
    queryKey: ["fleet", "reference-data"],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,
  });

  const serverStatus =
    statusChip === "all" || statusChip === "BOOKED_HIRED" ? "" : statusChip;

  const fleet = useQuery({
    queryKey: ["fleet", "list", serverStatus, typeOfCraneCode, stateCode, query, true],
    queryFn: () =>
      listCranes({
        status: serverStatus,
        typeOfCraneCode,
        stateCode,
        search: query,
        includeInactive: true,
      }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["fleet"] });

  const confirmAccurate = useRowAction({
    onDone: refresh,
    onError: setActionError,
    onSuccess: setNotice,
  });
  const deactivate = useRowAction({
    onDone: refresh,
    onError: setActionError,
    onSuccess: setNotice,
  });
  const reactivate = useRowAction({
    onDone: refresh,
    onError: setActionError,
    onSuccess: setNotice,
  });
  const quickUpdate = useMutation({
    mutationFn: ({ craneId, input }: { craneId: string; input: QuickUpdate }) =>
      quickUpdateCrane(craneId, input),
    onSuccess: () => {
      setActionError(null);
      void refresh();
    },
  });
  const uploadChart = useMutation({
    mutationFn: ({ craneId, file }: { craneId: string; file: File }) =>
      uploadLoadChart(craneId, file),
    onSuccess: () => {
      setActionError(null);
      setNotice("Load chart uploaded.");
      void refresh();
    },
    onError: (error: unknown) =>
      setActionError(error instanceof Error ? error.message : "The upload failed."),
  });

  const busy =
    confirmAccurate.isPending ||
    deactivate.isPending ||
    reactivate.isPending ||
    quickUpdate.isPending ||
    uploadChart.isPending ||
    confirmingAll;

  const allCranes = fleet.data?.cranes ?? [];
  const activeCranes = allCranes.filter((crane) => crane.isActive);
  const inactiveCount = allCranes.length - activeCranes.length;
  const shownCranes = showDeactivated ? allCranes : activeCranes;

  const needChartCount = activeCranes.filter((crane) => !crane.loadChart).length;
  const needCheckCranes = activeCranes.filter(needsStatusCheck);
  const noPinCount = activeCranes.filter((crane) => crane.locationUnverified).length;

  const availableCount = activeCranes.filter((c) => c.currentStatus === "AVAILABLE").length;
  const engagedCount = activeCranes.filter((c) => c.currentStatus === "ENGAGED").length;
  const maintenanceCount = activeCranes.filter(
    (c) => c.currentStatus === "UNDER_MAINTENANCE",
  ).length;

  const summary = `${activeCranes.length} ${
    activeCranes.length === 1 ? "crane" : "cranes"
  } · ${availableCount} available · ${engagedCount} engaged · ${maintenanceCount} under maintenance.`;

  const hasFilters =
    searchText.trim() !== "" ||
    statusChip !== "all" ||
    typeOfCraneCode !== "" ||
    stateCode !== "" ||
    todo !== null;

  const visibleCranes = sortCranes(
    shownCranes.filter(
      (crane) => matchesStatusChip(crane, statusChip) && matchesTodo(crane, todo),
    ),
    sort,
  );

  const clearFilters = () => {
    setSearchText("");
    setQuery("");
    setStatusChip("all");
    setTypeOfCraneCode("");
    setStateCode("");
    setTodo(null);
  };

  const confirmAll = async () => {
    if (needCheckCranes.length === 0) return;
    const count = needCheckCranes.length;
    if (
      !window.confirm(
        `Confirm that these ${count} cranes' status and location are correct?`,
      )
    ) {
      return;
    }

    setConfirmingAll(true);
    setActionError(null);
    const results = await Promise.allSettled(
      needCheckCranes.map((crane) => confirmCraneAccurate(crane.id)),
    );
    const failed: Crane[] = [];
    results.forEach((result, index) => {
      const crane = needCheckCranes[index];
      if (result.status === "rejected" && crane) failed.push(crane);
    });
    await refresh();
    if (failed.length === 0) setNotice(`${count} confirmed`);
    else setActionError(`Could not confirm ${failed.map((c) => c.serialRegistrationNo).join(", ")}.`);
    setConfirmingAll(false);
  };

  const actions: CraneActions = {
    busy,
    onQuickUpdate: (crane, input) =>
      quickUpdate.mutateAsync({ craneId: crane.id, input }).then(() => undefined),
    onConfirm: (crane) =>
      confirmAccurate.mutate({
        run: () => confirmCraneAccurate(crane.id),
        success: "Current status confirmed.",
      }),
    onDuplicate: (crane) =>
      void navigate({
        to: "/app/fleet/new",
        search: { duplicate: crane.id, vendorId: undefined },
      }),
    onDeactivate: (crane) =>
      deactivate.mutate({
        run: () => deactivateCrane(crane.id),
        success: "Crane deactivated.",
      }),
    onReactivate: (crane) =>
      reactivate.mutate({
        run: () => reactivateCrane(crane.id),
        success: "Crane reactivated.",
      }),
    onUploadChart: (crane, file) => uploadChart.mutate({ craneId: crane.id, file }),
    onDownloadChart: (crane) => {
      void downloadLoadChart(crane).catch((error: unknown) =>
        setActionError(
          error instanceof Error ? error.message : "The download failed.",
        ),
      );
    },
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6">
      <PageHeader
        title="My fleet"
        description="The cranes you offer SML. Keep them current so they appear when customers search."
        actions={
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            onClick={() =>
              void navigate({
                to: "/app/fleet/new",
                search: { duplicate: undefined, vendorId: undefined },
              })
            }
          >
            <Plus className="size-4" aria-hidden /> Add crane
          </button>
        }
      />

      {!fleet.isError ? (
        <p className="mt-4 text-[14px] text-slate-700">
          {fleet.isLoading ? "Loading your cranes…" : summary}
        </p>
      ) : null}

      {notice ? (
        <div className="mt-4 flex items-start justify-between gap-3 border-l-2 border-emerald-400/60 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-800">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="rounded text-emerald-700/80 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="mt-4 flex items-start justify-between gap-3 border-l-2 border-rose-400/60 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-100">
          <span>{actionError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setActionError(null)}
            className="rounded text-rose-200/80 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {!fleet.isLoading &&
      !fleet.isError &&
      activeCranes.length > 0 &&
      (needChartCount > 0 || needCheckCranes.length > 0 || noPinCount > 0) ? (
        <div className="mt-4 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible">
          {needChartCount > 0 ? (
            <TodoChip
              active={todo === "missing-chart"}
              onClick={() =>
                setTodo((current) => (current === "missing-chart" ? null : "missing-chart"))
              }
            >
              {needChartCount} {needChartCount === 1 ? "needs" : "need"} a load chart
            </TodoChip>
          ) : null}
          {needCheckCranes.length > 0 ? (
            <TodoChip
              active={todo === "needs-check"}
              onClick={() =>
                setTodo((current) => (current === "needs-check" ? null : "needs-check"))
              }
            >
              {needCheckCranes.length}{" "}
              {needCheckCranes.length === 1 ? "needs" : "need"} a status check
            </TodoChip>
          ) : null}
          {noPinCount > 0 ? (
            <TodoChip
              active={todo === "no-pin"}
              onClick={() => setTodo((current) => (current === "no-pin" ? null : "no-pin"))}
            >
              {noPinCount} {noPinCount === 1 ? "has" : "have"} no map pin
            </TodoChip>
          ) : null}

          {needCheckCranes.length > 0 ? (
            <button
              type="button"
              onClick={() => void confirmAll()}
              disabled={confirmingAll}
              className="shrink-0 rounded-full border border-white/15 px-3 py-1 text-[13px] whitespace-nowrap text-slate-700 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 disabled:text-slate-500"
            >
              {confirmingAll ? "Confirming…" : "Confirm all are up to date"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/10 pb-3">
        <SearchInput
          value={searchText}
          onChange={setSearchText}
          placeholder="Search by name, serial, make, model or place"
          label="Search cranes"
          className="w-full sm:w-72"
        />

        <div className="flex flex-wrap items-center gap-0.5">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={statusChip === chip.value}
              onClick={() => setStatusChip(chip.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40",
                statusChip === chip.value
                  ? "border-white/15 bg-white/10 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            onClick={() => setFiltersOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[13px] text-slate-700 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            <Filter className="size-3.5" aria-hidden /> Filters
          </button>
          {filtersOpen ? (
            <FilterPopover
              typeOfCraneCode={typeOfCraneCode}
              stateCode={stateCode}
              craneTypes={reference.data?.craneTypes ?? []}
              states={reference.data?.states ?? []}
              onTypeChange={setTypeOfCraneCode}
              onStateChange={setStateCode}
              onClose={() => setFiltersOpen(false)}
            />
          ) : null}
        </div>

        <button
          type="button"
          aria-pressed={showDeactivated}
          onClick={() => setShowDeactivated((show) => !show)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40",
            showDeactivated
              ? "border-white/15 bg-white/10 text-slate-900"
              : "border-transparent text-slate-500 hover:text-slate-800",
          )}
        >
          Deactivated{inactiveCount > 0 ? ` (${inactiveCount})` : ""}
        </button>

        <label className="ml-auto flex items-center gap-2 text-[13px] text-slate-500">
          <span className="sr-only">Sort cranes</span>
          <select
            aria-label="Sort cranes"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-[13px] text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4">
        {fleet.isLoading ? (
          <FleetSkeleton />
        ) : fleet.isError ? (
          <div className="py-10">
            <p className="text-[14px] text-slate-700">Could not load your fleet.</p>
            <button
              type="button"
              onClick={() => void fleet.refetch()}
              className="mt-3 rounded-md border border-rose-400/30 px-3 py-1.5 text-[13px] text-rose-200 hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
            >
              Retry
            </button>
          </div>
        ) : allCranes.length === 0 && !hasFilters ? (
          <div className="py-12 text-center">
            <p className="text-[14px] text-slate-700">
              Add your first crane so SML can offer it to customers.
            </p>
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={() =>
                void navigate({
                  to: "/app/fleet/new",
                  search: { duplicate: undefined, vendorId: undefined },
                })
              }
            >
              <Plus className="size-4" aria-hidden /> Add crane
            </button>
          </div>
        ) : visibleCranes.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-[14px] text-slate-700">No cranes match.</p>
            {hasFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 text-[13px] text-slate-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <FleetTable cranes={visibleCranes} actions={actions} />
            <MobileFleetList cranes={visibleCranes} actions={actions} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One row action, with the same success and failure handling for each.
 *
 * Kept as a hook rather than four copies of a mutation so a refusal — the 409
 * on a crane SML has booked, say — is reported the same way everywhere.
 */
function useRowAction({
  onDone,
  onSuccess,
  onError,
}: {
  onDone: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}) {
  return useMutation({
    mutationFn: (input: { run: () => Promise<unknown>; success: string }) =>
      input.run().then(() => input.success),
    onSuccess: (message: string) => {
      onError("");
      onSuccess(message);
      onDone();
    },
    onError: (error: unknown) => {
      onSuccess("");
      onError(
        error instanceof Error ? error.message : "That action could not be completed.",
      );
    },
  });
}

function TodoChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40",
        active
          ? "border-amber-400/50 bg-amber-500/20 text-amber-800"
          : "border-amber-400/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15",
      )}
    >
      {children}
    </button>
  );
}

function FilterPopover({
  typeOfCraneCode,
  stateCode,
  craneTypes,
  states,
  onTypeChange,
  onStateChange,
  onClose,
}: {
  typeOfCraneCode: string;
  stateCode: string;
  craneTypes: Array<{ code: string; name: string }>;
  states: Array<{ code: string; name: string }>;
  onTypeChange: (value: string) => void;
  onStateChange: (value: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-20" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-label="Filters"
        className="absolute top-full left-0 z-30 mt-2 w-72 rounded-lg border border-white/10 bg-ink-900 p-3 shadow-xl"
      >
        <p className="text-[12px] text-slate-500">Type</p>
        <Select
          id="fleet-filter-type"
          value={typeOfCraneCode}
          onChange={onTypeChange}
          ariaLabel="Crane type"
          options={craneTypes.map((type) => ({ value: type.code, label: type.name }))}
          placeholder="Any type"
        />
        <p className="mt-3 text-[12px] text-slate-500">State</p>
        <Select
          id="fleet-filter-state"
          value={stateCode}
          onChange={onStateChange}
          ariaLabel="State"
          options={states.map((state) => ({ value: state.code, label: state.name }))}
          placeholder="Any state"
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}

function LocationCell({ crane }: { crane: Crane }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[13px] text-slate-700">
        {crane.currentLocation}
        {crane.state ? `, ${titleCase(crane.state.name)}` : ""}
      </p>
      {crane.locationUnverified ? (
        <span className="text-[12px] text-amber-700">No map pin</span>
      ) : null}
    </div>
  );
}

function FreshnessCell({
  crane,
  busy,
  onConfirm,
}: {
  crane: Crane;
  busy: boolean;
  onConfirm: () => void;
}) {
  if (needsStatusCheck(crane)) {
    const days = crane.freshness.daysSinceUpdate;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="text-[13px] font-semibold text-amber-700">
          Not confirmed for {days} {days === 1 ? "day" : "days"}
        </span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="text-[12px] text-amber-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 disabled:text-slate-500"
        >
          Confirm
        </button>
      </div>
    );
  }

  return (
    <span className="text-[13px] text-slate-500">
      {confirmedLabel(crane.freshness.daysSinceUpdate)}
    </span>
  );
}

function LoadChartCell({
  crane,
  onUpload,
  onDownload,
}: {
  crane: Crane;
  onUpload: (file: File) => void;
  onDownload: () => void;
}) {
  if (crane.loadChart) {
    return (
      <button
        type="button"
        onClick={onDownload}
        title={`Download ${crane.loadChart.fileName}`}
        className="inline-flex items-center gap-1 text-[13px] text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
      >
        <Check className="size-3.5 text-emerald-700" aria-hidden /> Load chart
      </button>
    );
  }

  return (
    <label className="cursor-pointer text-[13px] text-slate-500 hover:text-slate-800 focus-within:outline-none focus-within:ring-2 focus-within:ring-rose-400/40">
      Add load chart
      <input
        type="file"
        className="sr-only"
        accept=".pdf,.png,.jpg,.jpeg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
          event.target.value = "";
        }}
      />
    </label>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none",
        danger ? "text-rose-200" : "text-slate-800",
      )}
    >
      {children}
    </button>
  );
}

function StatusControl({ crane, actions }: { crane: Crane; actions: CraneActions }) {
  const [open, setOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<VendorCraneStatus>("AVAILABLE");
  const [draftFrom, setDraftFrom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  if (isSystemLocked(crane)) {
    return (
      <div>
        <span
          tabIndex={0}
          title="Set by SML when a quotation is awarded"
          className="inline-flex items-center gap-1.5 text-[13px] text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
        >
          <Lock className="size-3.5 text-slate-500" aria-hidden />
          {CRANE_STATUS_LABELS[crane.currentStatus]}
        </span>
        {crane.availableFrom ? (
          <p className="mt-0.5 text-[12px] text-slate-500">
            From {formatDate(crane.availableFrom)}
          </p>
        ) : null}
      </div>
    );
  }

  const openEditor = () => {
    setDraftStatus(crane.currentStatus as VendorCraneStatus);
    setDraftFrom(crane.availableFrom ? crane.availableFrom.slice(0, 10) : "");
    setError(null);
    setUpdated(false);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await actions.onQuickUpdate(crane, {
        currentStatus: draftStatus,
        currentLocation: crane.currentLocation,
        stateCode: crane.stateCode,
        availableFrom: draftStatus === "AVAILABLE" ? null : draftFrom || null,
      });
      setUpdated(true);
      setOpen(false);
      triggerRef.current?.focus();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update the status.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : openEditor())}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-[13px] whitespace-nowrap text-slate-800 transition-colors hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
        >
          <span
            className={cn("size-1.5 rounded-full", STATUS_DOTS[crane.currentStatus])}
            aria-hidden
          />
          {CRANE_STATUS_LABELS[crane.currentStatus]}
          <ChevronDown className="size-3 text-slate-500" aria-hidden />
        </button>
        {updated && !open ? (
          <span className="text-[12px] text-emerald-700">Updated</span>
        ) : null}
      </div>

      {crane.availableFrom && crane.currentStatus !== "AVAILABLE" ? (
        <p className="mt-0.5 text-[12px] text-slate-500">
          From {formatDate(crane.availableFrom)}
        </p>
      ) : null}

      {open ? (
        <>
          <div className="fixed inset-0 z-20" aria-hidden onClick={close} />
          <div
            role="dialog"
            aria-label={`Update status for ${craneName(crane)}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            className="absolute top-full left-0 z-30 mt-2 w-64 rounded-lg border border-white/10 bg-ink-900 p-3 shadow-xl"
          >
            <p className="text-[12px] text-slate-500">Status</p>
            <div role="radiogroup" aria-label="Status" className="mt-1.5 space-y-0.5">
              {VENDOR_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="radio"
                  aria-checked={draftStatus === status}
                  autoFocus={draftStatus === status}
                  onClick={() => setDraftStatus(status)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40",
                    draftStatus === status
                      ? "bg-white/10 text-slate-900"
                      : "text-slate-700 hover:bg-white/5",
                  )}
                >
                  <span
                    className={cn("size-2 rounded-full", STATUS_DOTS[status])}
                    aria-hidden
                  />
                  {CRANE_STATUS_LABELS[status]}
                </button>
              ))}
            </div>

            {draftStatus !== "AVAILABLE" ? (
              <label className="mt-3 block text-[12px] text-slate-500">
                Available from
                <input
                  type="date"
                  value={draftFrom}
                  onChange={(event) => setDraftFrom(event.target.value)}
                  className="mt-1 w-full rounded-md border border-white/10 bg-transparent px-2 py-1 text-[13px] text-slate-800 [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
                />
              </label>
            ) : null}

            {error ? <p className="mt-2 text-[12px] text-rose-200">{error}</p> : null}

            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-md px-2 py-1 text-[13px] text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="btn-primary px-3 py-1 text-[13px]"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RowMenu({ crane, actions }: { crane: Crane; actions: CraneActions }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    }
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const run = (action: () => void) => {
    close(false);
    action();
  };

  return (
    <div className="relative flex justify-end">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${craneName(crane)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="rounded-md p-1.5 text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-20" aria-hidden onClick={() => close()} />
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${craneName(crane)}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const items = Array.from(
                  menuRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]',
                  ) ?? [],
                );
                if (items.length === 0) return;
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "ArrowDown"
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
                items[next]?.focus();
              }
            }}
            className="absolute top-full right-0 z-30 mt-1 w-52 rounded-lg border border-white/10 bg-ink-900 py-1 shadow-xl"
          >
            <MenuItem
              onClick={() =>
                run(() =>
                  void navigate({
                    to: "/app/fleet/$craneId/edit",
                    params: { craneId: crane.id },
                  }),
                )
              }
            >
              <Pencil className="size-3.5" aria-hidden /> Edit
            </MenuItem>
            <MenuItem onClick={() => run(() => actions.onDuplicate(crane))}>
              <Copy className="size-3.5" aria-hidden /> Duplicate
            </MenuItem>
            <MenuItem onClick={() => run(() => actions.onConfirm(crane))}>
              <Check className="size-3.5" aria-hidden /> Confirm current status
            </MenuItem>
            {crane.isActive ? (
              <MenuItem
                danger
                onClick={() =>
                  run(() => {
                    if (
                      window.confirm(
                        "Deactivate this crane? It stays in your records and can be reactivated later.",
                      )
                    ) {
                      actions.onDeactivate(crane);
                    }
                  })
                }
              >
                Deactivate
              </MenuItem>
            ) : (
              <MenuItem onClick={() => run(() => actions.onReactivate(crane))}>
                Reactivate
              </MenuItem>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function FleetRow({ crane, actions }: { crane: Crane; actions: CraneActions }) {
  return (
    <div
      className={cn(
        ROW_GRID,
        "border-t border-white/5 py-3 first:border-t-0",
        !crane.isActive && "opacity-60",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link
            to="/app/fleet/$craneId/edit"
            params={{ craneId: crane.id }}
            className="truncate text-[14px] font-medium text-slate-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          >
            {craneName(crane)}
          </Link>
          {!crane.isActive ? (
            <span className="shrink-0 rounded-full border border-white/10 px-1.5 py-0.5 text-[12px] text-slate-500">
              Deactivated
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[13px] text-slate-500">{detailLine(crane)}</p>
        <p className="truncate text-[12px] text-slate-500">
          {crane.serialRegistrationNo}
        </p>
      </div>

      <StatusControl crane={crane} actions={actions} />
      <LocationCell crane={crane} />
      <FreshnessCell
        crane={crane}
        busy={actions.busy}
        onConfirm={() => actions.onConfirm(crane)}
      />
      <LoadChartCell
        crane={crane}
        onUpload={(file) => actions.onUploadChart(crane, file)}
        onDownload={() => actions.onDownloadChart(crane)}
      />
      <RowMenu crane={crane} actions={actions} />
    </div>
  );
}

function FleetTable({
  cranes,
  actions,
}: {
  cranes: Crane[];
  actions: CraneActions;
}) {
  return (
    <div className="hidden md:block">
      <div
        className={cn(
          ROW_GRID,
          "border-b border-white/10 pb-2 text-[12px] text-slate-500",
        )}
      >
        <span>Crane</span>
        <span>Status</span>
        <span>Location</span>
        <span>Confirmed</span>
        <span>Load chart</span>
        <span />
      </div>
      <div className="border-b border-white/10">
        {cranes.map((crane) => (
          <FleetRow key={crane.id} crane={crane} actions={actions} />
        ))}
      </div>
    </div>
  );
}

function MobileFleetList({
  cranes,
  actions,
}: {
  cranes: Crane[];
  actions: CraneActions;
}) {
  return (
    <div className="divide-y divide-white/10 border-y border-white/10 md:hidden">
      {cranes.map((crane) => (
        <div
          key={crane.id}
          className={cn("py-4", !crane.isActive && "opacity-60")}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  to="/app/fleet/$craneId/edit"
                  params={{ craneId: crane.id }}
                  className="truncate text-[14px] font-medium text-slate-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
                >
                  {craneName(crane)}
                </Link>
                {!crane.isActive ? (
                  <span className="shrink-0 rounded-full border border-white/10 px-1.5 py-0.5 text-[12px] text-slate-500">
                    Deactivated
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-[13px] text-slate-500">{detailLine(crane)}</p>
              <p className="text-[12px] text-slate-500">{crane.serialRegistrationNo}</p>
            </div>
            <RowMenu crane={crane} actions={actions} />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <StatusControl crane={crane} actions={actions} />
            <LoadChartCell
              crane={crane}
              onUpload={(file) => actions.onUploadChart(crane, file)}
              onDownload={() => actions.onDownloadChart(crane)}
            />
          </div>

          <div className="mt-2">
            <LocationCell crane={crane} />
          </div>
          <div className="mt-1">
            <FreshnessCell
              crane={crane}
              busy={actions.busy}
              onConfirm={() => actions.onConfirm(crane)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function FleetSkeleton() {
  return (
    <div className="divide-y divide-white/10 border-y border-white/10">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 py-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-28" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="hidden h-3 w-32 md:block" />
          <Skeleton className="hidden h-3 w-24 md:block" />
          <Skeleton className="hidden h-3 w-20 md:block" />
        </div>
      ))}
    </div>
  );
}



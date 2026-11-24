import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  formatKm,
  lineRecommendations,
  cranesLocatedIn,
  orderedRecommendationCranes,
  refreshLineRecommendations,
  type LineRecommendations,
  type LineRecommendationsResponse,
  type RecommendationCrane,
  type RecommendationMode,
  type DistanceSort,
  DISTANCE_SORT_OPTIONS,
  RECOMMENDED_PAGE_SIZE,
  filterRecommended,
} from "@/lib/discovery";
import type { RaisableLine } from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CRANE_PATH, craneFill } from "@/components/crane-glyph";
import { capacityText, lineReference } from "@/components/discovery/line-panel";
import type { RouteSummary } from "@/components/discovery/route-card";
import { SendRfqDialog } from "@/components/discovery/send-rfq-dialog";
import { cn } from "@/lib/cn";

/**
 * Panel 2: the cranes recommended for one enquiry line.
 *
 * The server owns both lists. `technical` is the stored snapshot the recommendation
 * engine produced — the list sales actually acted on — and is never recomputed on
 * read. `distance` drops the tonnage filter, is computed live and is never stored:
 * it answers "what is physically nearest", not "what was decided".
 *
 * Ride-option cards because the person is comparing journeys: the route distance
 * and drive time are the largest thing on the row, and every number arrives from
 * the server. The card never measures, sorts or estimates locally.
 */

export function useLineRecommendations(lineId: string | null, mode: RecommendationMode) {
  return useQuery({
    queryKey: ["enquiries", "recommendations", lineId, mode],
    queryFn: () => lineRecommendations(lineId as string, mode),
    enabled: Boolean(lineId),
    staleTime: 30_000,
    // Keep the previous tab's rows on screen while the other list loads, so the
    // panel does not collapse to skeletons when someone compares the two views.
    placeholderData: (previous) => previous,
  });
}

function shortDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function evaluatedLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Evaluated just now";
  return `Evaluated ${date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function listDistanceLabel(crane: RecommendationCrane): string {
  const km = crane.distanceKm;
  if (km === null || !Number.isFinite(km) || km <= 0) return "Distance unavailable";
  return `~${formatKm(km)}`;
}

function listMethodLabel(crane: RecommendationCrane): string {
  return crane.distanceApproximate || crane.distanceMethod !== "road" ? "approx." : "road";
}

export interface RecommendationPanelProps {
  lineId: string;
  line: RaisableLine | null;
  mode: RecommendationMode;
  /** Order of the list: technical best fit, or by distance either way. */
  distanceSort: DistanceSort;
  onDistanceSortChange: (sort: DistanceSort) => void;
  recommendations: LineRecommendations | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  /** The selected crane's route contact, once the API answers. */
  route: RouteSummary | null;
  selectedCraneId: string | null;
  /** "From": only cranes located here are listed. */
  fromText: string;
  availableOnly: boolean;
  onAvailableOnlyChange: (value: boolean) => void;
  searchText: string;
  onSearchChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onSelect: (craneId: string) => void;
  /** Cranes ticked for an RFQ. The RFQ goes to their vendors only. */
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (craneId: string) => void;
  onSetChecked: (craneIds: string[]) => void;
  onModeChange: (mode: RecommendationMode) => void;
  /** Extra client-side filter (type, capacity, status, YOM, vendor, window). */
  extraFilter?: (crane: RecommendationCrane) => boolean;
  extraFilterActive?: boolean;
  onClearFilters?: () => void;
  onClear: () => void;
  onRetry: () => void;
}

export function RecommendationPanel({
  lineId,
  line,
  mode,
  distanceSort,
  onDistanceSortChange,
  recommendations,
  isPending,
  isError,
  error,
  route,
  selectedCraneId,
  fromText,
  availableOnly,
  onAvailableOnlyChange,
  searchText,
  onSearchChange,
  onFromChange,
  onSelect,
  checkedIds,
  onToggleChecked,
  onSetChecked,
  onModeChange,
  extraFilter,
  extraFilterActive = false,
  onClearFilters,
  onClear,
  onRetry,
}: RecommendationPanelProps) {
  const noticeId = useId();
  const [sendOpen, setSendOpen] = useState(false);
  const [sendAll, setSendAll] = useState(false);
  /** How many of the ranked cranes are revealed; the list opens on the best ten. */
  const [shown, setShown] = useState(RECOMMENDED_PAGE_SIZE);
  const allCranes = orderedRecommendationCranes(
    recommendations,
    mode,
    line?.capacityT,
    distanceSort,
  );
  const matching = filterRecommended(
    cranesLocatedIn(allCranes, fromText),
    availableOnly,
    searchText,
  ).filter((crane) => (extraFilter ? extraFilter(crane) : true));
  const cranes = matching.slice(0, shown);
  const total = cranes.length;
  const matchCount = matching.length;
  const hiddenCount = matchCount - total;
  const filteredOut = allCranes.length > 0 && matchCount === 0 && (Boolean(fromText.trim()) || availableOnly || Boolean(searchText.trim()) || extraFilterActive);
  // Only ticks that are still on the visible list count: a crane filtered out by
  // "From" must not silently receive an RFQ.
  const checkedCranes = matching.filter((crane) => checkedIds.has(crane.craneId));
  const checkedVendors = new Set(checkedCranes.map((crane) => crane.vendorId)).size;
  const allChecked = total > 0 && checkedCranes.length === total;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-ink-800 px-4 pt-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-[16px] leading-tight font-semibold text-white">
            <span className="sr-only">Recommendations for </span>
            {line ? lineReference(line) : "Selected line"}
          </h2>
          <button
            type="button"
            onClick={onClear}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[13px] text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        </div>
        {line ? (
          <p className="mt-0.5 truncate text-[13px] text-neutral-400">
            {line.craneTypeName ?? line.craneTypeCode ?? "Crane type not set"} · {capacityText(line)}
            {line.shipToCity ? ` · ${line.shipToCity}` : ""}
          </p>
        ) : null}

        <div
          role="group"
          aria-label="Sort recommended cranes"
          className="mt-2.5 flex rounded-lg bg-ink-850 p-0.5"
        >
          {DISTANCE_SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={distanceSort === option.value}
              onClick={() => onDistanceSortChange(option.value)}
              className={cn(
                "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[13px] font-medium transition-colors",
                distanceSort === option.value
                  ? "bg-ink-900 text-white shadow-sm ring-1 ring-ink-800"
                  : "text-neutral-400 hover:text-white",
              )}
            >
              {option.label}
              {option.value === "nearest" ? " ↑" : option.value === "farthest" ? " ↓" : ""}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {isError ? (
          <Alert tone="error" title="Could not load recommendations">
            <p>{error?.message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md border border-red-400/40 px-2 py-1 text-[14px] font-medium text-red-700 hover:bg-red-500/10"
            >
              Try again
            </button>
          </Alert>
        ) : isPending || !recommendations ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-[112px] w-full" />
            ))}
          </div>
        ) : (
          <>
            {recommendations.notice ? (
              <div id={noticeId} className="mb-3">
                <Alert tone="info" title="Check before you commit">
                  {recommendations.notice}
                </Alert>
              </div>
            ) : null}

            <div className="mb-4 flex items-center gap-3">
              <input
                type="search"
                value={searchText}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search make, model or vendor"
                className="min-w-0 flex-1 rounded-lg border border-ink-800 bg-ink-850 px-3 py-2 text-[15px] text-neutral-100 placeholder:text-neutral-500 focus:border-ink-700 focus:outline-none"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[14px] text-neutral-300">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(event) => onAvailableOnlyChange(event.target.checked)}
                  className="accent-accent-500"
                />
                Available only
              </label>
            </div>

            <div className="mb-3 flex items-start justify-between gap-3 px-0.5">
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-neutral-200">
                  {hiddenCount > 0 ? `${total} of ${matchCount}` : total} crane{matchCount === 1 ? "" : "s"}
                  {fromText.trim() ? ` in ${fromText.trim()}` : ""}
                  <span className="font-normal text-neutral-500">
                    {" · "}
                    {distanceSort === "nearest"
                      ? "nearest first"
                      : distanceSort === "farthest"
                        ? "farthest first"
                        : "smallest adequate first"}
                  </span>
                </p>
                <p className="mt-0.5 text-[13px] text-neutral-500" title={recommendations.capacityRule}>
                  {recommendations.evaluatedAt
                    ? recommendations.snapshotId
                      ? evaluatedLabel(recommendations.evaluatedAt)
                      : "Live evaluation"
                    : null}
                </p>
              </div>
              {mode === "technical" ? (
                <RefreshButton lineId={lineId} onModeChange={onModeChange} />
              ) : null}
            </div>

            {filteredOut ? (
              <EmptyState
                icon={<SlidersHorizontal className="size-4" aria-hidden />}
                title={fromText.trim() ? `No cranes in ${fromText.trim()}` : "No cranes match your filters"}
                description={
                  fromText.trim()
                    ? "None of the recommended cranes are located there. Try a nearby city or clear it."
                    : "None of the recommended cranes pass the filters. Widen them or clear them."
                }
                className="px-0 py-10 [&_p]:text-neutral-200 [&_p:last-child]:text-neutral-500"
                action={
                  <button
                    type="button"
                    onClick={() => {
                      onFromChange("");
                      onClearFilters?.();
                    }}
                    className="rounded-lg border border-ink-700 px-3 py-1.5 text-[14px] font-medium text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
                  >
                    {fromText.trim() && !extraFilterActive ? "Clear From" : "Clear filters"}
                  </button>
                }
              />
            ) : total === 0 ? (
              <EmptyState
                icon={<SlidersHorizontal className="size-4" aria-hidden />}
                title="No crane passes the technical check"
                description="Check the line's crane type and capacity, or press Refresh to re-run the evaluation."
                className="px-0 py-10 [&_p]:text-neutral-200 [&_p:last-child]:text-neutral-500"
              />
            ) : (
              <>
              <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 px-0.5 text-[14px] text-neutral-400">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    onSetChecked(allChecked ? [] : cranes.map((crane) => crane.craneId))
                  }
                  className="size-3.5 accent-accent-500"
                />
                Select all {total}{hiddenCount > 0 ? " shown" : ""} to send an RFQ
              </label>
              <ul className="space-y-2.5">
                {cranes.map((crane) => (
                  <RecommendationRow
                    key={crane.craneId}
                    crane={crane}
                    mode={mode}
                    checked={checkedIds.has(crane.craneId)}
                    onToggleChecked={onToggleChecked}
                    selected={crane.craneId === selectedCraneId}
                    route={route && route.craneId === crane.craneId ? route : null}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
              {hiddenCount > 0 ? (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShown((count) => count + RECOMMENDED_PAGE_SIZE)}
                    className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[14px] font-medium text-neutral-200 transition-colors hover:bg-ink-800 hover:text-white"
                  >
                    Show {Math.min(RECOMMENDED_PAGE_SIZE, hiddenCount)} more
                  </button>
                  {hiddenCount > RECOMMENDED_PAGE_SIZE ? (
                    <button
                      type="button"
                      onClick={() => setShown(matchCount)}
                      className="rounded-lg px-3 py-2 text-[14px] font-medium text-accent-400 transition-colors hover:text-white"
                    >
                      Show all {matchCount}
                    </button>
                  ) : null}
                </div>
              ) : null}
              </>
            )}
          </>
        )}
      </div>

      {checkedCranes.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-800 bg-ink-900 px-4 py-3">
          <p className="min-w-0 text-[14px] text-neutral-400">
            <span className="font-semibold text-white tabular-nums">{checkedCranes.length}</span>{" "}
            crane{checkedCranes.length === 1 ? "" : "s"} ·{" "}
            <span className="font-semibold text-white tabular-nums">{checkedVendors}</span> vendor
            {checkedVendors === 1 ? "" : "s"}
            <button
              type="button"
              onClick={() => onSetChecked([])}
              className="ml-2 text-neutral-500 underline-offset-2 hover:text-white hover:underline"
            >
              Clear
            </button>
          </p>
          <button
            type="button"
            onClick={() => {
              setSendAll(false);
              setSendOpen(true);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-2 text-[14px] font-semibold text-[#fff] transition-colors hover:bg-accent-600"
          >
            <Mail className="size-3.5" aria-hidden />
            Email {checkedVendors} vendor{checkedVendors === 1 ? "" : "s"}
          </button>
        </div>
      ) : recommendations ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-800 bg-ink-900 px-4 py-3">
          <p className="min-w-0 text-[14px] text-neutral-400">Tick cranes to email their vendors</p>
          <button
            type="button"
            onClick={() => {
              setSendAll(true);
              setSendOpen(true);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-2 text-[14px] font-semibold text-[#fff] transition-colors hover:bg-accent-600"
          >
            <Mail className="size-3.5" aria-hidden />
            Email all vendors
          </button>
        </div>
      ) : null}

      <SendRfqDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        lineId={lineId}
        lineLabel={line ? lineReference(line) : "Selected line"}
        cranes={checkedCranes}
        startWithAll={sendAll}
        onSent={() => onSetChecked([])}
      />
    </div>
  );
}

/**
 * One crane. The happy path is quiet — "Available in time" is a small green
 * dot with text, not a pill — and only the exceptions (engaged, below capacity,
 * location unverified, stale) are drawn as badges, so a list full of good
 * options reads calmly and the ones that need a second look stand out.
 *
 * The crane type is not repeated per row: the header already says what the line
 * asked for. Vendor and place share one line.
 */
function RecommendationRow({
  crane,
  mode,
  checked,
  onToggleChecked,
  selected,
  route,
  onSelect,
}: {
  crane: RecommendationCrane;
  mode: RecommendationMode;
  checked: boolean;
  onToggleChecked: (craneId: string) => void;
  selected: boolean;
  /** Only the selected crane has a fetched route. */
  route: RouteSummary | null;
  onSelect: (craneId: string) => void;
}) {
  const engagedUntil = crane.availableInTime ? null : shortDay(crane.availableFrom);
  const place = `${crane.currentLocation}${crane.stateName ? `, ${crane.stateName}` : ""}`;
  const hasExceptions =
    (mode === "distance" && crane.belowRequiredCapacity) ||
    !crane.availableInTime ||
    crane.locationUnverified ||
    crane.stale;

  return (
    <li id={`crane-row-${crane.craneId}`} className="flex items-stretch gap-2">
      <label
        className="flex shrink-0 cursor-pointer items-start pt-4 pl-0.5"
        title="Include this crane's vendor in the RFQ"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleChecked(crane.craneId)}
          aria-label={`Send RFQ to ${crane.vendorName} for ${crane.make} ${crane.model}`}
          className="size-4 accent-accent-500"
        />
      </label>
      <button
        type="button"
        onClick={() => onSelect(crane.craneId)}
        aria-pressed={selected}
        className={cn(
          "min-w-0 flex-1 rounded-xl border px-3.5 py-3.5 text-left transition-colors",
          selected || checked
            ? "border-accent-500/70 bg-accent-500/10"
            : "border-ink-800 bg-ink-900 hover:border-ink-700 hover:bg-ink-850",
        )}
      >
        <div className="flex items-start gap-3.5">
          <span
            className={cn(
              "relative flex size-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded-xl border",
              selected
                ? "border-white bg-white text-ink-950"
                : "border-ink-700 bg-ink-850 text-white",
            )}
          >
            <svg viewBox="0 0 200 84" className="absolute inset-0 h-full w-full opacity-20" aria-hidden>
              <path
                d={CRANE_PATH}
                transform="translate(80 14) scale(0.9)"
                fill={craneFill(crane.currentStatus)}
              />
            </svg>
            <span className="relative text-[17px] leading-none font-semibold tabular-nums">
              {Math.round(crane.capacityT)}
            </span>
            <span className="relative mt-1 text-[12px] font-semibold tracking-[0.14em] text-neutral-500">
              TON
            </span>
          </span>

          <span className="min-w-0 flex-1">
            <span className="block text-[16px] leading-snug font-semibold break-words text-neutral-100">
              {crane.make} {crane.model}
            </span>
            <span className="mt-1 block text-[14px] leading-snug break-words text-neutral-400">
              {crane.vendorName}
            </span>
            <span className="mt-0.5 block text-[14px] leading-snug break-words text-neutral-500">{place}</span>
          </span>

        </div>

        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-ink-800 pt-3">
          <span className="flex w-full items-baseline justify-between gap-3">
            <span
              className={cn(
                "block text-[16px] leading-tight font-semibold text-neutral-100 tabular-nums",
                route?.loading && "opacity-60",
              )}
            >
              {route ? route.distanceLabel : listDistanceLabel(crane)}
            </span>
            <span
              className={cn(
                "mt-1 block text-[13px]",
                route?.fallback ? "text-amber-700" : "text-neutral-500",
              )}
            >
              {route ? route.methodLabel : listMethodLabel(crane)}
            </span>
          </span>
        </div>

        <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {crane.availableInTime ? (
            <span className="inline-flex items-center gap-1.5 text-[14px] text-emerald-700">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
              Available in time
            </span>
          ) : null}
          {hasExceptions ? (
            <>
              {mode === "distance" && crane.belowRequiredCapacity ? (
                <Badge tone="amber" className="px-2 py-0 text-[13px]">
                  Below capacity
                </Badge>
              ) : null}
              {!crane.availableInTime ? (
                <Badge tone="amber" className="px-2 py-0 text-[13px]">
                  {engagedUntil ? `Engaged until ${engagedUntil}` : "Not free in time"}
                </Badge>
              ) : null}
              {crane.locationUnverified ? (
                <Badge tone="amber" className="px-2 py-0 text-[13px]">
                  Location unverified
                </Badge>
              ) : null}
              {crane.stale ? (
                <Badge tone="neutral" className="px-2 py-0 text-[13px]">
                  Stale
                </Badge>
              ) : null}
            </>
          ) : null}
        </span>

        {crane.boomWarnings.length > 0 ? (
          <span className="mt-2 block text-[13px] leading-snug text-amber-700">
            {crane.boomWarnings.join(" · ")}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Refresh is the technical snapshot's own control: it re-runs the engine and
 * replaces the stored list, which is why it does not exist on the live Distance
 * tab.
 */
function RefreshButton({
  lineId,
  onModeChange,
}: {
  lineId: string;
  onModeChange: (mode: RecommendationMode) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => refreshLineRecommendations(lineId),
    onSuccess: (data: LineRecommendationsResponse) => {
      setNote(null);
      queryClient.setQueryData(["enquiries", "recommendations", lineId, "technical"], data);
      onModeChange("technical");
    },
    onError: (error: Error) => setNote(error.message),
  });

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
        className="flex items-center gap-1 rounded-md border border-ink-800 px-2 py-1 text-[13px] font-medium text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", refresh.isPending && "animate-spin")} aria-hidden />
        {refresh.isPending ? "Evaluating…" : "Refresh"}
      </button>
      {note ? <p className="max-w-40 text-right text-[13px] text-red-700">{note}</p> : null}
    </div>
  );
}

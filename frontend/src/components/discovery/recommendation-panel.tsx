import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  formatKm,
  lineRecommendations,
  recommendationCranes,
  refreshLineRecommendations,
  type LineRecommendations,
  type LineRecommendationsResponse,
  type RecommendationCrane,
  type RecommendationMode,
} from "@/lib/discovery";
import type { RaisableLine } from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { CRANE_PATH, craneFill } from "@/components/crane-glyph";
import { capacityText, lineReference } from "@/components/discovery/line-panel";
import type { RouteSummary } from "@/components/discovery/route-card";
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
  recommendations: LineRecommendations | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  /** The selected crane's route contact, once the API answers. */
  route: RouteSummary | null;
  selectedCraneId: string | null;
  hoveredCraneId: string | null;
  onSelect: (craneId: string) => void;
  onHover: (craneId: string | null) => void;
  onModeChange: (mode: RecommendationMode) => void;
  onClear: () => void;
  onRetry: () => void;
}

export function RecommendationPanel({
  lineId,
  line,
  mode,
  recommendations,
  isPending,
  isError,
  error,
  route,
  selectedCraneId,
  hoveredCraneId,
  onSelect,
  onHover,
  onModeChange,
  onClear,
  onRetry,
}: RecommendationPanelProps) {
  const noticeId = useId();
  const groups = recommendations?.vendor.groups ?? [];
  const unverified = recommendations?.vendor.unverified ?? [];
  const total = recommendationCranes(recommendations).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-ink-800 px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Recommendations
            </p>
            <p className="mt-1 truncate text-[13px] font-semibold text-white">
              {line ? lineReference(line) : "Selected line"}
            </p>
            {line ? (
              <p className="mt-0.5 truncate text-[10px] text-neutral-400">
                {line.craneTypeName ?? line.craneTypeCode ?? "Crane type not set"} ·{" "}
                {capacityText(line)}
                {line.siteLocation ? ` · ${line.siteLocation}` : ""}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClear}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        </div>

        <Tabs
          value={mode}
          onChange={onModeChange}
          label="Recommendation view"
          idPrefix="recommendation"
          className="mt-3"
          tabs={[
            { value: "technical", label: "Technical" },
            { value: "distance", label: "Distance" },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {isError ? (
          <Alert tone="error" title="Could not load recommendations">
            <p>{error?.message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md border border-red-400/40 px-2 py-1 text-[11px] font-medium text-red-100 hover:bg-red-500/10"
            >
              Try again
            </button>
          </Alert>
        ) : isPending || !recommendations ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-[92px] w-full" />
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

            <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
              <p className="text-[10px] text-neutral-500">
                {mode === "distance"
                  ? "Nearest first · capacity is a label, not a filter"
                  : `${total} crane${total === 1 ? "" : "s"} · ${recommendations.capacityRule}`}
              </p>
              {mode === "technical" ? (
                <RefreshButton lineId={lineId} onModeChange={onModeChange} />
              ) : null}
            </div>

            {mode === "technical" && recommendations.evaluatedAt ? (
              <p className="mb-2 px-0.5 text-[10px] text-neutral-600">
                {recommendations.snapshotId
                  ? evaluatedLabel(recommendations.evaluatedAt)
                  : "Live evaluation"}
              </p>
            ) : null}

            {total === 0 ? (
              <EmptyState
                icon={<SlidersHorizontal className="size-4" aria-hidden />}
                title={
                  mode === "technical"
                    ? "No crane passes the technical check"
                    : "No cranes are near this site"
                }
                description={
                  mode === "technical"
                    ? "Switch to Distance to see nearby cranes that are short on capacity."
                    : "Add pins to the vendor fleet, or widen the line's crane type."
                }
                className="px-0 py-10 [&_p]:text-neutral-200 [&_p:last-child]:text-neutral-500"
                action={
                  mode === "technical" ? (
                    <button
                      type="button"
                      onClick={() => onModeChange("distance")}
                      className="rounded-lg border border-ink-700 px-3 py-1.5 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
                    >
                      Try Distance
                    </button>
                  ) : null
                }
              />
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <section key={group.vendorId}>
                    <p className="px-1 pb-1 text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                      {group.vendorName}
                      {group.nearestKm !== null ? (
                        <span className="ml-1 font-normal normal-case tracking-normal text-neutral-600">
                          · nearest {formatKm(group.nearestKm)}
                        </span>
                      ) : null}
                    </p>
                    <ul className="space-y-1.5">
                      {group.cranes.map((crane) => (
                        <RecommendationRow
                          key={crane.craneId}
                          crane={crane}
                          mode={mode}
                          selected={crane.craneId === selectedCraneId}
                          hovered={crane.craneId === hoveredCraneId}
                          route={route && route.craneId === crane.craneId ? route : null}
                          onHover={onHover}
                          onSelect={onSelect}
                        />
                      ))}
                    </ul>
                  </section>
                ))}

                {unverified.length > 0 ? (
                  <details className="group rounded-xl border border-ink-800 bg-ink-900/40">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium text-neutral-300">
                      <span>No location on file · {unverified.length}</span>
                      <ChevronDown
                        className="size-3.5 text-neutral-500 transition-transform group-open:rotate-180"
                        aria-hidden
                      />
                    </summary>
                    <ul className="space-y-1.5 p-1.5 pt-0">
                      {unverified.map((crane) => (
                        <RecommendationRow
                          key={crane.craneId}
                          crane={crane}
                          mode={mode}
                          selected={crane.craneId === selectedCraneId}
                          hovered={crane.craneId === hoveredCraneId}
                          route={route && route.craneId === crane.craneId ? route : null}
                          onHover={onHover}
                          onSelect={onSelect}
                        />
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RecommendationRow({
  crane,
  mode,
  selected,
  hovered,
  route,
  onHover,
  onSelect,
}: {
  crane: RecommendationCrane;
  mode: RecommendationMode;
  selected: boolean;
  hovered: boolean;
  /** Only the selected crane has a fetched route. */
  route: RouteSummary | null;
  onHover: (craneId: string | null) => void;
  onSelect: (craneId: string) => void;
}) {
  const engagedUntil = crane.availableInTime ? null : shortDay(crane.availableFrom);

  return (
    <li id={`crane-row-${crane.craneId}`}>
      <button
        type="button"
        onClick={() => onSelect(crane.craneId)}
        onMouseEnter={() => onHover(crane.craneId)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(crane.craneId)}
        onBlur={() => onHover(null)}
        aria-pressed={selected}
        className={cn(
          "w-full rounded-xl border px-2.5 py-2.5 text-left transition-colors",
          selected
            ? "border-accent-500/70 bg-accent-500/10"
            : hovered
              ? "border-ink-700 bg-ink-850/80"
              : "border-ink-800 bg-ink-900/40 hover:border-ink-700 hover:bg-ink-850/70",
        )}
      >
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "relative flex size-11 shrink-0 flex-col items-center justify-center overflow-hidden rounded-xl border",
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
            <span className="relative text-[15px] leading-none font-semibold tabular-nums">
              {Math.round(crane.capacityT)}
            </span>
            <span
              className={cn(
                "relative mt-0.5 text-[7px] font-semibold tracking-[0.14em]",
                selected ? "text-neutral-500" : "text-neutral-500",
              )}
            >
              TON
            </span>
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-neutral-100">
              {crane.make} {crane.model}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-neutral-400">
              {crane.vendorName}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-neutral-500">
              {crane.typeOfCraneName} · {crane.currentLocation}
              {crane.stateName ? `, ${crane.stateName}` : ""}
            </span>
          </span>

          <span className="shrink-0 text-right">
            <span
              className={cn(
                "block text-[13px] leading-tight font-semibold text-neutral-100 tabular-nums",
                route?.loading && "opacity-60",
              )}
            >
              {route ? route.distanceLabel : listDistanceLabel(crane)}
            </span>
            <span
              className={cn(
                "mt-1 inline-block rounded-full border px-1.5 py-0 text-[9px] font-medium",
                route?.fallback
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  : "border-ink-700 bg-ink-900 text-neutral-400",
              )}
            >
              {route ? route.methodLabel : listMethodLabel(crane)}
            </span>
          </span>
        </div>

        <span className="mt-2 flex flex-wrap items-center gap-1">
          {mode === "distance" && crane.belowRequiredCapacity ? (
            <Badge tone="amber" className="px-1.5 py-0 text-[9px]">
              Below capacity
            </Badge>
          ) : null}
          {crane.availableInTime ? (
            <Badge tone="emerald" className="px-1.5 py-0 text-[9px]">
              Available in time
            </Badge>
          ) : (
            <Badge tone="amber" className="px-1.5 py-0 text-[9px]">
              {engagedUntil ? `Engaged until ${engagedUntil}` : "Not free in time"}
            </Badge>
          )}
          {crane.locationUnverified ? (
            <Badge tone="amber" className="px-1.5 py-0 text-[9px]">
              Location unverified
            </Badge>
          ) : null}
          {crane.stale ? (
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              Stale
            </Badge>
          ) : null}
          {crane.estimatedMobilisationCost !== null ? (
            <span className="text-[9px] text-neutral-500">
              Mob. ≈ ₹{Math.round(crane.estimatedMobilisationCost).toLocaleString("en-IN")}
            </span>
          ) : null}
        </span>

        {crane.boomWarnings.length > 0 ? (
          <span className="mt-1 block truncate text-[9px] text-amber-200/90">
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
        className="flex items-center gap-1 rounded-md border border-ink-800 px-2 py-1 text-[10px] font-medium text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", refresh.isPending && "animate-spin")} aria-hidden />
        {refresh.isPending ? "Evaluating…" : "Refresh"}
      </button>
      {note ? <p className="max-w-40 text-right text-[9px] text-red-300">{note}</p> : null}
    </div>
  );
}

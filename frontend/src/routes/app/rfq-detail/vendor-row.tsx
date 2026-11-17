import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronUp, History } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CandidateGroup } from "@/lib/rfqs";
import { CraneFlags, craneAvailability } from "./crane-cells";
import { dayMonth } from "./datetime";
import {
  FAR_KM,
  headroomShort,
  rankCranes,
  shortDistance,
  type ContactedVendor,
  type VendorStats,
} from "./picker-model";

/**
 * One vendor in the draft picker, with its cranes already on the screen.
 *
 * A sales user shortlists vendors by the cranes they have, so the three best
 * cranes are always visible and the columns line up across every card. The rest
 * of the fleet is one "show more" away, and the head of the card stays a single
 * scannable line: name, distance, how many match and how many are free in time.
 */

/** Shared column track, so every card's table reads across the whole list. */
const CRANE_COLUMNS =
  "md:grid-cols-[minmax(0,1.4fr)_7rem_3.5rem_8.5rem_10rem_4.5rem]";

function HistoryChip({
  contacted,
  alreadyRecipient,
}: {
  contacted?: ContactedVendor;
  alreadyRecipient: boolean;
}) {
  if (alreadyRecipient) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-ink-800 px-2 py-0.5 text-[13px] font-medium text-slate-500">
        <Check className="size-3" aria-hidden />
        Already a recipient
      </span>
    );
  }
  if (!contacted) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[13px] font-medium text-amber-700"
      title={`Already sent ${contacted.rfqNumber} for this enquiry line`}
    >
      <History className="size-3" aria-hidden />
      Re-send
    </span>
  );
}

/** The crane's facts, stacked on a phone and tabulated from `md` up. */
function CraneTable({
  id,
  cranes,
  requiredT,
  startDateTbc,
  startLabel,
  showDistance,
}: {
  id: string;
  cranes: ReturnType<typeof rankCranes>;
  requiredT: number;
  startDateTbc: boolean;
  startLabel: string;
  showDistance: boolean;
}) {
  return (
    <div id={id}>
      <div
        className={cn(
          "hidden gap-x-3 border-b border-ink-800/70 pb-1 text-[13px] font-medium tracking-[0.06em] text-slate-500 uppercase md:grid",
          CRANE_COLUMNS,
        )}
        aria-hidden
      >
        <span>Crane</span>
        <span>Capacity</span>
        <span>Year</span>
        <span>Availability</span>
        <span>Location · distance</span>
        <span>Flags</span>
      </div>

      <ul>
        {cranes.map((crane) => {
          const availability = craneAvailability(crane, startDateTbc, startLabel);
          const name = `${crane.make} ${crane.model}`;
          return (
            <li
              key={crane.craneId}
              className="border-b border-ink-800/50 py-2 last:border-b-0"
            >
              {/* phone: one stacked block per crane */}
              <div className="md:hidden">
                <p className="text-[15px] text-slate-800">
                  <span>{name}</span>
                  <span className="text-slate-500">
                    {" · "}
                    {crane.capacityT} t
                    {crane.belowRequiredCapacity
                      ? `, below ${requiredT} t`
                      : ` · ${headroomShort(crane, requiredT)}`}
                  </span>
                </p>
                <p className="mt-0.5 text-[14px] text-slate-500 tabular-nums">
                  {crane.yom ?? "Year unknown"}
                  {" · "}
                  <span
                    className={
                      availability.tone === "warning" ? "text-amber-600" : "text-slate-600"
                    }
                  >
                    {availability.text}
                  </span>
                  {" · "}
                  {crane.currentLocation}
                  {showDistance && crane.distanceKm !== null ? (
                    <> · {shortDistance(crane.distanceKm, crane.distanceApproximate)}</>
                  ) : null}
                </p>
                <div className="mt-1">
                  <CraneFlags crane={crane} />
                </div>
              </div>

              {/* tablet and up: aligned columns, no zebra stripes */}
              <div
                className={cn(
                  "hidden gap-x-3 text-[15px] tabular-nums md:grid md:items-baseline",
                  CRANE_COLUMNS,
                )}
              >
                <span className="min-w-0 truncate text-slate-800" title={name}>
                  {name}
                </span>
                <span className="text-slate-700">
                  {crane.capacityT} t
                  <span className="text-slate-500"> · {headroomShort(crane, requiredT)}</span>
                </span>
                <span className="text-slate-600">{crane.yom ?? "—"}</span>
                <span
                  className={
                    availability.tone === "warning" ? "text-amber-600" : "text-slate-600"
                  }
                >
                  {availability.text}
                </span>
                <span
                  className="min-w-0 truncate text-slate-600"
                  title={`${crane.currentLocation}, ${crane.stateName}`}
                >
                  {crane.currentLocation}
                  {showDistance && crane.distanceKm !== null ? (
                    <span className="text-slate-500">
                      {" · "}
                      {shortDistance(crane.distanceKm, crane.distanceApproximate)}
                    </span>
                  ) : null}
                </span>
                <CraneFlags crane={crane} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VendorCard({
  group,
  stats,
  requiredT,
  startDateTbc,
  startLabel,
  showDistance,
  checked,
  alreadyRecipient,
  contacted,
  expanded,
  onToggleExpand,
  onSelect,
}: {
  group: CandidateGroup;
  stats: VendorStats;
  requiredT: number;
  startDateTbc: boolean;
  startLabel: string;
  /** False when the site has no pin, so the server produced no distances at all. */
  showDistance: boolean;
  checked: boolean;
  /** Already received this RFQ — the row cannot be sent to twice. */
  alreadyRecipient: boolean;
  contacted?: ContactedVendor;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
}) {
  const detailId = `vendor-cranes-${group.vendorId}`;
  const far = stats.nearestKm !== null && stats.nearestKm > FAR_KM;
  const more = stats.count - 3;
  const cranes = expanded ? rankCranes(group.cranes) : stats.top;
  const availableText = startDateTbc
    ? "availability not checked"
    : `${stats.availableCount} available in time`;

  return (
    <article
      data-vendor-row
      id={`vendor-row-${group.vendorId}`}
      aria-labelledby={`vendor-name-${group.vendorId}`}
      className={cn(
        "relative border-b border-l-2 border-ink-800/70 py-4 pr-1 pl-3 transition-colors",
        checked ? "border-l-accent-500" : "border-l-transparent",
        contacted && !alreadyRecipient && "opacity-75",
        alreadyRecipient && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={alreadyRecipient}
          onChange={onSelect}
          aria-label={
            alreadyRecipient
              ? `${group.vendorName} has already received this RFQ`
              : contacted
                ? `Re-send the RFQ to ${group.vendorName}`
                : `Select ${group.vendorName}`
          }
          className="mt-1 size-4 shrink-0 cursor-pointer rounded border-slate-600 bg-ink-900 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3
              id={`vendor-name-${group.vendorId}`}
              className="text-[17px] leading-tight font-semibold text-slate-900"
            >
              {group.vendorName}
            </h3>
            <HistoryChip contacted={contacted} alreadyRecipient={alreadyRecipient} />
            {showDistance && stats.nearestKm !== null ? (
              <p
                className="text-[15px] text-slate-600 tabular-nums"
                title={
                  stats.approximate ? "Straight-line estimate, not road distance" : "Road distance"
                }
              >
                nearest {shortDistance(stats.nearestKm, stats.approximate)}
              </p>
            ) : null}
            {far ? <span className="text-[14px] text-slate-500">Far from site</span> : null}
          </div>

          <p className="mt-0.5 text-[14px] text-slate-500 tabular-nums">
            {stats.count} matching ·{" "}
            <span
              className={
                !startDateTbc && stats.availableCount === 0 ? "text-amber-600" : undefined
              }
            >
              {availableText}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-2 md:pl-7">
        <CraneTable
          id={detailId}
          cranes={cranes}
          requiredT={requiredT}
          startDateTbc={startDateTbc}
          startLabel={startLabel}
          showDistance={showDistance}
        />

        {more > 0 ? (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-controls={detailId}
            className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[14px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" aria-hidden />
                Hide
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" aria-hidden />
                Show {more} more crane{more === 1 ? "" : "s"}
              </>
            )}
            <span className="sr-only"> for {group.vendorName}</span>
          </button>
        ) : null}

        {contacted ? (
          <p className="mt-1 text-[14px] text-slate-500">
            Sent{" "}
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: contacted.rfqId }}
              className="text-accent-400 underline decoration-accent-500/40 underline-offset-2 transition-colors hover:text-accent-300"
            >
              {contacted.rfqNumber}
            </Link>
            {contacted.sentAt ? ` on ${dayMonth(contacted.sentAt)}` : ""}
            {" · "}
            {contacted.responseStatus.toLowerCase().replaceAll("_", " ")}
            {/* Quote totals are not in the list payload, so there is no total to
                print here yet. Backend ask: expose the latest quote total. */}
          </p>
        ) : null}
      </div>
    </article>
  );
}


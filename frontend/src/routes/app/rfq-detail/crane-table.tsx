import { useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { CraneFlags, craneAvailability } from "./crane-cells";
import {
  CRANE_SORT_LABELS,
  headroomShort,
  shortDistance,
  sortCraneRows,
  type CraneRow,
  type CraneSortKey,
} from "./picker-model";

/**
 * Every matching crane in one flat, sortable table.
 *
 * The table exists so a user can scan the fleet across vendors, but it never
 * pretends a crane is the recipient: ticking any row selects the crane's
 * vendor, and every row of that vendor carries the same accent bar and state.
 * The send itself is still by vendor id.
 */

function SortHeader({
  label,
  sortKey,
  active,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: CraneSortKey;
  active: boolean;
  direction: "asc" | "desc";
  onSort: (key: CraneSortKey) => void;
  className?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={!active ? "none" : direction === "asc" ? "ascending" : "descending"}
      className={cn("px-1.5 py-1.5 text-left font-medium", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 rounded text-[11px] tracking-[0.06em] uppercase transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ChevronUp className="size-3" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}

/** Rows rendered before the "show more" step; the fixtures are far below this. */
const PAGE = 200;

export function AllCranesTable({
  rows,
  requiredT,
  startDateTbc,
  startLabel,
  showDistance,
  selected,
  onToggleVendor,
}: {
  rows: CraneRow[];
  requiredT: number;
  startDateTbc: boolean;
  startLabel: string;
  showDistance: boolean;
  selected: string[];
  onToggleVendor: (vendorId: string) => void;
}) {
  const [sort, setSort] = useState<CraneSortKey>("best");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(PAGE);

  const sorted = useMemo(() => {
    const base = sortCraneRows(rows, sort);
    // "Best match" has one meaningful order; everywhere else the same header
    // toggles direction. A copy, so the source rows are never mutated.
    return sort === "best" || direction === "asc" ? base : [...base].reverse();
  }, [rows, sort, direction]);

  const shown = sorted.slice(0, limit);
  const remaining = sorted.length - shown.length;

  function onSort(key: CraneSortKey) {
    if (key === "best") {
      setSort("best");
      setDirection("asc");
      return;
    }
    if (sort === key) {
      setDirection((previous) => (previous === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDirection("asc");
  }

  return (
    <div className="mt-1">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-[13px] tabular-nums">
          <colgroup>
            <col className="w-8" />
            <col />
            <col className="w-28" />
            <col className="w-14" />
            <col className="w-32" />
            <col className="w-40" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-40" />
          </colgroup>
          {/* The app bar is 48 px and sticky, so the header docks below it. */}
          <thead className="sticky top-12 z-20 bg-slate-50">
            <tr className="border-b border-ink-800 text-slate-500">
              <th scope="col" className="px-1.5 py-1.5 text-left">
                <span className="sr-only">Selected vendor</span>
              </th>
              <SortHeader
                label={CRANE_SORT_LABELS.crane}
                sortKey="crane"
                active={sort === "crane"}
                direction={direction}
                onSort={onSort}
              />
              <SortHeader
                label={CRANE_SORT_LABELS.capacity}
                sortKey="capacity"
                active={sort === "capacity"}
                direction={direction}
                onSort={onSort}
              />
              <SortHeader
                label={CRANE_SORT_LABELS.year}
                sortKey="year"
                active={sort === "year"}
                direction={direction}
                onSort={onSort}
              />
              <SortHeader
                label={CRANE_SORT_LABELS.availability}
                sortKey="availability"
                active={sort === "availability"}
                direction={direction}
                onSort={onSort}
              />
              <SortHeader
                label={CRANE_SORT_LABELS.location}
                sortKey="location"
                active={sort === "location"}
                direction={direction}
                onSort={onSort}
              />
              <SortHeader
                label={CRANE_SORT_LABELS.distance}
                sortKey="distance"
                active={sort === "distance"}
                direction={direction}
                onSort={onSort}
                className="text-right"
              />
              <th scope="col" className="px-1.5 py-1.5 text-left text-[11px] font-medium tracking-[0.06em] uppercase">
                Flags
              </th>
              <SortHeader
                label={CRANE_SORT_LABELS.vendor}
                sortKey="vendor"
                active={sort === "vendor"}
                direction={direction}
                onSort={onSort}
              />
            </tr>
          </thead>
          <tbody>
            {shown.map(({ crane, group }) => {
              const picked = selected.includes(group.vendorId);
              const availability = craneAvailability(crane, startDateTbc, startLabel);
              const name = `${crane.make} ${crane.model}`;
              return (
                <tr
                  key={crane.craneId}
                  className={cn(
                    "border-b border-ink-800/50 align-baseline transition-colors hover:bg-ink-900/50",
                    picked && "bg-accent-500/[0.06]",
                  )}
                >
                  <td
                    className={cn(
                      "border-l-2 py-1.5 pl-1",
                      picked ? "border-l-accent-500" : "border-l-transparent",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => onToggleVendor(group.vendorId)}
                      aria-label={`${picked ? "Deselect" : "Select"} ${group.vendorName} through ${name}`}
                      title="The RFQ goes to the vendor, who chooses which crane to quote"
                      className="size-4 cursor-pointer rounded border-slate-600 bg-ink-900 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                    />
                    {picked ? (
                      <span className="sr-only">Selected via {group.vendorName}</span>
                    ) : null}
                  </td>
                  <td className="max-w-0 px-1.5 py-1.5">
                    <span className="block truncate text-slate-800" title={name}>
                      {name}
                    </span>
                  </td>
                  <td className="px-1.5 py-1.5 text-slate-700">
                    {crane.capacityT} t
                    <span className="text-slate-500"> · {headroomShort(crane, requiredT)}</span>
                  </td>
                  <td className="px-1.5 py-1.5 text-slate-600">{crane.yom ?? "—"}</td>
                  <td
                    className={cn(
                      "px-1.5 py-1.5",
                      availability.tone === "warning" ? "text-amber-600" : "text-slate-600",
                    )}
                  >
                    {availability.text}
                  </td>
                  <td
                    className="max-w-0 px-1.5 py-1.5"
                    title={`${crane.currentLocation}, ${crane.stateName}`}
                  >
                    <span className="block truncate text-slate-600">{crane.currentLocation}</span>
                  </td>
                  <td className="px-1.5 py-1.5 text-right text-slate-600">
                    {showDistance ? shortDistance(crane.distanceKm, crane.distanceApproximate) : "—"}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <CraneFlags crane={crane} />
                  </td>
                  <td className="max-w-0 px-1.5 py-1.5">
                    <span className="block truncate text-slate-700" title={group.vendorName}>
                      {group.vendorName}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {remaining > 0 ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-slate-500">
          <p className="tabular-nums">
            Showing {shown.length.toLocaleString("en-IN")} of{" "}
            {sorted.length.toLocaleString("en-IN")} cranes
          </p>
          <button
            type="button"
            onClick={() => setLimit((previous) => previous + PAGE)}
            className="rounded-md border border-ink-800 px-2 py-1 font-medium text-slate-600 transition-colors hover:border-ink-700 hover:text-white"
          >
            Show {Math.min(PAGE, remaining)} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

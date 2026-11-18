import { Check, Clock, MapPin } from "lucide-react";
import { cn } from "@/lib/cn";
import { craneAvailability } from "./crane-cells";
import { headroomShort, shortDistance, type CraneRow } from "./picker-model";

/**
 * The recommended cranes, one card each, ranked.
 *
 * Ticking a card tags *that crane* to the RFQ. Two cranes from the same vendor
 * are independent: the vendor is invited once, and is told which of its cranes
 * were tagged.
 */
export function TopCranesTable({
  rows,
  requiredT,
  startDateTbc,
  startLabel,
  showDistance,
  selectedCranes,
  alreadySent,
  contacted,
  onToggleCrane,
}: {
  rows: CraneRow[];
  requiredT: number;
  startDateTbc: boolean;
  startLabel: string;
  showDistance: boolean;
  selectedCranes: string[];
  /** Vendors that already hold this RFQ; their cranes cannot be ticked. */
  alreadySent: string[];
  /** Vendors already sent another RFQ for this enquiry line, by vendor id. */
  contacted: Set<string>;
  onToggleCrane: (craneId: string, vendorId: string) => void;
}) {
  return (
    <ul className="space-y-2.5">
      {rows.map(({ crane, group }, index) => {
        const already = alreadySent.includes(group.vendorId);
        const picked = selectedCranes.includes(crane.craneId);
        const availability = craneAvailability(crane, startDateTbc, startLabel);
        const name = `${crane.make} ${crane.model}`;
        const fill = Math.min(100, Math.round((crane.capacityT / Math.max(requiredT, 1)) * 100));
        return (
          <li key={crane.craneId}>
            <label
              className={cn(
                "group flex cursor-pointer items-center gap-4 rounded-xl border bg-ink-900 px-4 py-3.5 shadow-sm transition-all",
                picked
                  ? "border-accent-500/60 bg-accent-500/[0.06] ring-1 ring-accent-500/30"
                  : "border-ink-800 hover:border-ink-700 hover:shadow-md",
                already && "cursor-not-allowed opacity-55 hover:shadow-sm",
              )}
            >
              <input
                type="checkbox"
                checked={picked}
                disabled={already}
                onChange={() => onToggleCrane(crane.craneId, group.vendorId)}
                aria-label={`${picked ? "Deselect" : "Select"} ${name} from ${group.vendorName}`}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                  picked
                    ? "border-accent-500 bg-accent-500 text-[#fff]"
                    : "border-slate-400 bg-ink-900 group-hover:border-accent-500",
                )}
              >
                {picked ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </span>

              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-800 text-[13px] font-semibold text-slate-600 tabular-nums">
                {index + 1}
              </span>

              <div className="grid min-w-0 flex-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                <div className="min-w-0">
                  <p className="truncate text-[16px] font-semibold text-slate-900">{name}</p>
                  <p className="truncate text-[14px] text-slate-500">
                    {group.vendorName}
                    {crane.yom ? ` · ${crane.yom}` : ""}
                  </p>
                  {already ? (
                    <p className="text-[13px] text-slate-500">Already sent</p>
                  ) : contacted.has(group.vendorId) ? (
                    <p className="text-[13px] text-amber-600">Sent for this line before</p>
                  ) : null}
                </div>

                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-slate-900 tabular-nums">
                    {crane.capacityT} t
                    <span
                      className={cn(
                        "ml-1.5 text-[13px] font-normal",
                        crane.belowRequiredCapacity ? "text-amber-600" : "text-slate-500",
                      )}
                    >
                      {headroomShort(crane, requiredT)}
                    </span>
                  </p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        crane.belowRequiredCapacity ? "bg-amber-500" : "bg-emerald-500",
                      )}
                      style={{ width: `${fill}%` }}
                    />
                  </div>
                </div>

                <div className="flex min-w-0 flex-col gap-1 text-[14px]">
                  <span className="inline-flex items-center gap-1.5 text-slate-600">
                    <MapPin className="size-3.5 shrink-0 text-slate-500" aria-hidden />
                    <span className="truncate">
                      {crane.currentLocation}, {crane.stateName}
                      {showDistance ? (
                        <span className="ml-1 font-medium text-slate-700">
                          · {shortDistance(crane.distanceKm, crane.distanceApproximate)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium",
                      availability.tone === "warning"
                        ? "bg-amber-500/10 text-amber-600"
                        : "bg-emerald-500/10 text-emerald-600",
                    )}
                  >
                    <Clock className="size-3" aria-hidden />
                    {availability.text}
                  </span>
                </div>
              </div>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

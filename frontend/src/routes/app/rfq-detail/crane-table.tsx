import { cn } from "@/lib/cn";
import { craneAvailability } from "./crane-cells";
import { headroomShort, shortDistance, type CraneRow } from "./picker-model";

/**
 * The recommended cranes, one row each, ranked.
 *
 * Ticking a row selects the crane's vendor, because an RFQ goes to the vendor
 * and the vendor chooses which crane to quote. When one vendor owns several
 * rows they tick together, so the screen never suggests a crane can be sent on
 * its own.
 */
export function TopCranesTable({
  rows,
  requiredT,
  startDateTbc,
  startLabel,
  showDistance,
  selected,
  alreadySent,
  contacted,
  onToggleVendor,
}: {
  rows: CraneRow[];
  requiredT: number;
  startDateTbc: boolean;
  startLabel: string;
  showDistance: boolean;
  selected: string[];
  /** Vendors that already hold this RFQ; their rows cannot be ticked. */
  alreadySent: string[];
  /** Vendors already sent another RFQ for this enquiry line, by vendor id. */
  contacted: Set<string>;
  onToggleVendor: (vendorId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-800 bg-ink-900">
      <table className="w-full min-w-[760px] border-collapse text-[15px] tabular-nums">
        <thead>
          <tr className="border-b border-ink-800 text-left text-[13px] font-medium tracking-[0.06em] text-slate-500 uppercase">
            <th scope="col" className="w-10 py-2.5 pr-1 pl-4">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className="px-2 py-2.5">
              Crane
            </th>
            <th scope="col" className="px-2 py-2.5">
              Capacity
            </th>
            <th scope="col" className="px-2 py-2.5">
              Year
            </th>
            <th scope="col" className="px-2 py-2.5">
              Availability
            </th>
            <th scope="col" className="px-2 py-2.5">
              Location
            </th>
            {showDistance ? (
              <th scope="col" className="px-2 py-2.5 text-right">
                Distance
              </th>
            ) : null}
            <th scope="col" className="py-2.5 pr-4 pl-3">
              Vendor
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ crane, group }, index) => {
            const already = alreadySent.includes(group.vendorId);
            const picked = selected.includes(group.vendorId);
            const availability = craneAvailability(crane, startDateTbc, startLabel);
            const name = `${crane.make} ${crane.model}`;
            return (
              <tr
                key={crane.craneId}
                className={cn(
                  "border-b border-ink-800 transition-colors last:border-b-0",
                  picked ? "bg-accent-500/[0.07]" : "hover:bg-ink-850",
                  already && "opacity-60",
                )}
              >
                <td className="py-3 pr-1 pl-4">
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={already}
                    onChange={() => onToggleVendor(group.vendorId)}
                    aria-label={`${picked ? "Deselect" : "Select"} ${name} from ${group.vendorName}`}
                    className="size-4 cursor-pointer rounded border-slate-400 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-2 py-3">
                  <span className="mr-2 text-[13px] text-slate-500">{index + 1}</span>
                  <span className="font-medium text-slate-900">{name}</span>
                </td>
                <td className="px-2 py-3 text-slate-700">
                  {crane.capacityT} t
                  <span
                    className={cn(
                      "ml-1",
                      crane.belowRequiredCapacity ? "text-amber-600" : "text-slate-500",
                    )}
                  >
                    {headroomShort(crane, requiredT)}
                  </span>
                </td>
                <td className="px-2 py-3 text-slate-600">{crane.yom ?? "—"}</td>
                <td
                  className={cn(
                    "px-2 py-3",
                    availability.tone === "warning" ? "text-amber-600" : "text-slate-600",
                  )}
                >
                  {availability.text}
                </td>
                <td className="px-2 py-3 text-slate-600">
                  {crane.currentLocation}
                  <span className="text-slate-500">, {crane.stateName}</span>
                </td>
                {showDistance ? (
                  <td className="px-2 py-3 text-right font-medium text-slate-700">
                    {shortDistance(crane.distanceKm, crane.distanceApproximate)}
                  </td>
                ) : null}
                <td className="py-3 pr-4 pl-3 text-slate-700">
                  {group.vendorName}
                  {already ? (
                    <span className="block text-[13px] text-slate-500">Already sent</span>
                  ) : contacted.has(group.vendorId) ? (
                    <span className="block text-[13px] text-amber-600">
                      Sent for this line before
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

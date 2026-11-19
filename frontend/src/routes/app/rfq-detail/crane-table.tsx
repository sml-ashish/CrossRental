import { Check, Clock, FileText, MapPin, MapPinOff, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CandidateCrane } from "@/lib/rfqs";
import { craneAvailability } from "./crane-cells";
import { shortDistance, type CraneRow } from "./picker-model";

/** "exact", "+50 t", "50 t short" — measured against the RFQ. */
function capacityVerdict(crane: CandidateCrane, requiredT: number): string {
  if (crane.belowRequiredCapacity) return `${Math.round(requiredT - crane.capacityT)} t short`;
  const headroom = crane.capacityT - requiredT;
  return headroom <= 0 ? "exact" : `+${headroom} t`;
}

/** Only the lengths the vendor recorded; an unrecorded one is left out, not shown as 0. */
function specList(crane: CandidateCrane): { label: string; value: string }[] {
  const specs: [string, number | null][] = [
    ["Boom", crane.mainBoomM],
    ["Fixed jib", crane.fixedJibM],
    ["Luffing jib", crane.luffingJibM],
    ["Wind jib", crane.windJibM],
  ];
  return specs
    .filter(([, value]) => value !== null && value > 0)
    .map(([label, value]) => ({ label, value: `${value} m` }));
}

/** "12 Nov 2026" — always with the year. */
function updatedOn(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function Badge({
  icon: Icon,
  children,
  tone = "muted",
}: {
  icon: typeof FileText;
  children: React.ReactNode;
  tone?: "muted" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium",
        tone === "warning" ? "bg-amber-500/10 text-amber-600" : "bg-ink-800 text-slate-600",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

/**
 * The recommended cranes, one compact card each, ranked.
 *
 * The details are spread across the full width of the card in fixed columns
 * (crane, capacity, boom & jib, location, availability) so the eye scans down
 * a column to compare cranes. Ticking a card tags *that crane* to the RFQ; two
 * cranes from the same vendor are independent.
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
    <ul className="space-y-2">
      {rows.map(({ crane, group }, index) => {
        const already = alreadySent.includes(group.vendorId);
        const picked = selectedCranes.includes(crane.craneId);
        const availability = craneAvailability(crane, startDateTbc, startLabel);
        const name = `${crane.make} ${crane.model}`;
        const specs = specList(crane);
        const distance = showDistance ? shortDistance(crane.distanceKm, crane.distanceApproximate) : null;
        const hasDistance = distance !== null && distance !== "—";
        return (
          <li key={crane.craneId}>
            <label
              className={cn(
                "group flex cursor-pointer items-center gap-3 rounded-xl border bg-ink-900 px-3.5 py-3 shadow-sm transition-all",
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

              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink-800 text-[13px] font-semibold text-slate-600 tabular-nums">
                {index + 1}
              </span>

              <div className="grid min-w-0 flex-1 grid-cols-2 items-center gap-x-6 gap-y-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)]">
                {/* 1 · Crane */}
                <div className="col-span-2 min-w-0 lg:col-span-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-[16px] font-semibold text-slate-900">{name}</p>
                    <span className="shrink-0 rounded-md bg-ink-800 px-1.5 py-0.5 text-[12px] font-medium text-slate-600">
                      {crane.typeOfCraneName}
                    </span>
                  </div>
                  <p className="truncate text-[14px] text-slate-600">
                    <span className="font-medium text-slate-700">{group.vendorName}</span>
                    {crane.yom ? ` · YOM ${crane.yom}` : ""}
                    {crane.ownershipType === "SML" ? " · SML-owned" : ""}
                  </p>
                  {already ? (
                    <p className="text-[13px] text-slate-500">Already sent</p>
                  ) : contacted.has(group.vendorId) ? (
                    <p className="text-[13px] text-amber-600">Sent for this line before</p>
                  ) : null}
                </div>

                {/* 2 · Capacity */}
                <div className="min-w-0">
                  <p className="text-[18px] font-semibold leading-tight text-slate-900 tabular-nums">
                    {crane.capacityT} t
                  </p>
                  <p
                    className={cn(
                      "text-[13px] font-medium",
                      crane.belowRequiredCapacity ? "text-amber-600" : "text-emerald-600",
                    )}
                  >
                    {capacityVerdict(crane, requiredT)}
                  </p>
                </div>

                {/* 3 · Boom & jib */}
                <div className="min-w-0">
                  {specs.length > 0 ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[13px]">
                      {specs.map((spec) => (
                        <div key={spec.label} className="flex min-w-0 items-baseline gap-1">
                          <dt className="truncate text-slate-500">{spec.label}</dt>
                          <dd className="font-medium text-slate-800 tabular-nums">{spec.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-[13px] text-slate-500">Boom &amp; jib not recorded</p>
                  )}
                </div>

                {/* 4 · Location */}
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[14px] font-medium text-slate-800">
                    <MapPin className="size-3.5 shrink-0 text-slate-500" aria-hidden />
                    <span className="truncate">
                      {crane.currentLocation}, {crane.stateName}
                    </span>
                  </p>
                  {hasDistance ? (
                    <p className="text-[13px] text-slate-600">
                      <span className="text-[15px] font-semibold text-slate-900 tabular-nums">
                        {distance}
                      </span>{" "}
                      from site
                    </p>
                  ) : null}
                  <p className="text-[13px] text-slate-500">
                    Location updated {updatedOn(crane.locationUpdatedAt)}
                  </p>
                </div>

                {/* 5 · Availability + caveats */}
                <div className="flex min-w-0 flex-col items-start gap-1 lg:items-end">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold",
                      availability.tone === "warning"
                        ? "bg-amber-500/10 text-amber-600"
                        : "bg-emerald-500/10 text-emerald-600",
                    )}
                  >
                    <Clock className="size-3.5" aria-hidden />
                    {availability.text}
                  </span>
                  <div className="flex flex-wrap gap-1 lg:justify-end">
                    {crane.loadChartFileName ? <Badge icon={FileText}>Load chart</Badge> : null}
                    {crane.belowRequiredCapacity ? (
                      <Badge icon={TriangleAlert} tone="warning">
                        Lighter
                      </Badge>
                    ) : null}
                    {crane.locationUnverified ? <Badge icon={MapPinOff}>Unverified</Badge> : null}
                  </div>
                </div>
              </div>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

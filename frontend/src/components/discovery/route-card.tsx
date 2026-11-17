import { useState } from "react";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  MapPin,
  Ruler,
  X,
} from "lucide-react";
import type { DisplayCrane } from "@/lib/discovery";
import { CRANE_PATH, craneFill } from "@/components/crane-glyph";
import { RequestCraneDialog } from "@/components/request-crane-dialog";
import { cn } from "@/lib/cn";

/**
 * The floating card over the map.
 *
 * One card serves both a plain browse and an enquiry line: the only difference
 * is the route block, which is rendered when the screen has a route question to
 * answer. The card never computes a distance — every number arrives from the
 * server, and the method label says whether it is a road or an approximation.
 */
export interface RouteAlternative {
  id: string;
  /** "via NH 48 · 9 h 10 min · 412 km", already formatted by the screen. */
  label: string;
  selected: boolean;
}

export interface RouteSummary {
  craneId: string;
  /** "412 km · about 9 h 10 min", already formatted by the screen. */
  distanceLabel: string;
  /** "road" or "approx." — the one word beside the number. */
  methodLabel: string;
  /** True only for the labelled straight-line fallback. */
  fallback: boolean;
  /** Why the route is a straight line, shown beside the fallback label. */
  fallbackReason?: string | null;
  /** True while a fresh route is in flight; the previous one stays visible. */
  loading: boolean;
  siteLabel: string;
  craneLabel: string;
  /** The selected option's description, e.g. "NH 48". */
  via?: string | null;
  /** The other drivable options, in the server's order. */
  alternatives?: RouteAlternative[];
  onSelectRoute?: (routeId: string) => void;
}

/**
 * A short, plain-English reading of the server's fallback reason, with the raw
 * text kept after it so the cause (a Google status, a missing key) is never
 * hidden from the staff who can fix it.
 */
function describeFallbackReason(reason: string): string {
  if (reason === "provider_stub") {
    return "the backend is running with GEO_PROVIDER=stub, which cannot draw roads (provider_stub)";
  }
  if (reason === "provider_disabled") {
    return "the backend has GEO_PROVIDER=disabled (provider_disabled)";
  }
  if (reason === "route_polyline_off") {
    return "route drawing is switched off with ROUTE_POLYLINE=false (route_polyline_off)";
  }
  return reason;
}

export function RouteCard({
  crane,
  route,
  routeMissing,
  compact = false,
  docked = false,
  onClose,
}: {
  crane: DisplayCrane;
  /** Omitted for a plain browse; present when a line is selected. */
  route?: RouteSummary | null;
  routeMissing?: "site" | "crane" | null;
  compact?: boolean;
  /**
   * A small card parked in a corner of the map, so it never covers the route.
   * With a route to read it starts collapsed to one summary line; the facts,
   * alternatives and warnings open with the chevron. Without a route (a plain
   * browse) it starts open, because the facts are the point.
   */
  docked?: boolean;
  onClose: () => void;
}) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => !(docked && route !== undefined));
  const showDetails = !docked || expanded;
  const tight = compact || docked;

  return (
    <div
      className={cn(
        "pointer-events-auto w-full overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)]",
        docked ? "max-w-[340px]" : "max-w-[420px]",
      )}
    >
      {tight ? null : (
        <div className="relative h-24 overflow-hidden border-b border-ink-800 bg-ink-900">
          <div
            aria-hidden
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "linear-gradient(var(--color-ink-800) 1px, transparent 1px), linear-gradient(90deg, var(--color-ink-800) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          />
          <svg viewBox="0 0 200 72" className="absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              <radialGradient id="crane-card-glow" cx="50%" cy="70%" r="55%">
                <stop offset="0%" stopColor={craneFill(crane.currentStatus)} stopOpacity="0.22" />
                <stop offset="100%" stopColor={craneFill(crane.currentStatus)} stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="200" height="72" fill="url(#crane-card-glow)" />
            <path
              d={CRANE_PATH}
              transform="translate(73 13) scale(1.5)"
              fill={craneFill(crane.currentStatus)}
              stroke="#ffffff"
              strokeWidth="1"
              strokeLinejoin="round"
            />
          </svg>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close crane details"
            className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full border border-ink-700 bg-ink-900/90 text-neutral-300 transition-colors hover:text-white"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      <div
        className={cn(
          "p-4",
          tight && "p-3",
          docked && expanded && "max-h-[calc(100dvh-18rem)] overflow-y-auto",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[0.14em] text-neutral-500 uppercase">
              {crane.typeOfCraneName}
            </p>
            <h2
              className={cn(
                "mt-0.5 truncate font-semibold tracking-tight text-white",
                tight ? "text-base" : "text-xl",
              )}
            >
              {crane.make} {crane.model}
            </h2>
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {Math.round(crane.capacityT)} t ·{" "}
              {crane.yom > 0 ? crane.yom : "Year not recorded"}
            </p>
          </div>
          {tight ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {docked ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  aria-expanded={expanded}
                  aria-label={expanded ? "Hide crane details" : "Show crane details"}
                  className="flex size-7 items-center justify-center rounded-full border border-ink-700 bg-ink-900/90 text-neutral-300 transition-colors hover:text-white"
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronUp className="size-3.5" aria-hidden />
                  )}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close crane details"
                className="flex size-7 items-center justify-center rounded-full border border-ink-700 bg-ink-900/90 text-neutral-300 transition-colors hover:text-white"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>

        {compact || !showDetails ? null : (
          <dl className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2.5">
            <CardFact icon={Building2} label="Vendor" value={crane.vendorName} />
            <CardFact
              icon={MapPin}
              label="Location"
              value={`${crane.currentLocation}, ${crane.stateName}`}
            />
            <CardFact
              icon={Ruler}
              label="Boom"
              value={crane.mainBoomM === null ? "—" : `${crane.mainBoomM} m main boom`}
            />
            <CardFact
              icon={CalendarDays}
              label="Availability"
              value={availabilityText(crane)}
            />
          </dl>
        )}

        {route === undefined ? null : routeMissing ? (
          <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[14px] leading-relaxed text-amber-700">
            No route: {routeMissing === "site" ? "the job site has" : "this crane has"} no pin.
          </p>
        ) : route ? (
          <div className="mt-3 rounded-xl border border-ink-800 bg-ink-950/50 px-3 py-2.5">
            {showDetails ? (
              <>
                <p className="text-[13px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                  Route
                </p>
                <p className="mt-1 truncate text-[14px] text-neutral-400">
                  {route.siteLabel}
                  <span className="mx-1 text-neutral-500">→</span>
                  {route.craneLabel}
                </p>
              </>
            ) : null}
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <p
                className={cn(
                  "text-[17px] font-semibold text-neutral-100 tabular-nums",
                  route.loading && "opacity-60",
                )}
              >
                {route.distanceLabel}
              </p>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-1.5 py-0 text-[13px] font-medium",
                  route.fallback
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                    : "border-ink-700 bg-ink-900 text-neutral-400",
                )}
              >
                {route.methodLabel}
              </span>
            </div>
            {route.via ? (
              <p className="mt-0.5 truncate text-[13px] text-neutral-500">via {route.via}</p>
            ) : null}
            {showDetails && route.alternatives && route.alternatives.length > 1 ? (
              <ul className="mt-2 space-y-1">
                {route.alternatives.map((alternative) => (
                  <li key={alternative.id}>
                    <button
                      type="button"
                      onClick={() => route.onSelectRoute?.(alternative.id)}
                      aria-pressed={alternative.selected}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-[13px] transition-colors",
                        alternative.selected
                          ? "border-[#1a73e8]/60 bg-[#1a73e8]/15 text-neutral-100"
                          : "border-ink-800 text-neutral-400 hover:border-ink-700 hover:text-neutral-200",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          alternative.selected ? "bg-[#4f9bff]" : "bg-neutral-600",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{alternative.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {route.fallback ? (
              <p className="mt-1.5 text-[13px] leading-snug text-amber-700">
                Road route unavailable, showing straight-line approx.
                {route.fallbackReason ? (
                  <span className="mt-0.5 block break-words text-amber-700/80">
                    Reason: {describeFallbackReason(route.fallbackReason)}
                  </span>
                ) : null}
              </p>
            ) : null}
            {showDetails &&
            crane.estimatedMobilisationCost !== undefined &&
            crane.estimatedMobilisationCost !== null ? (
              <p className="mt-1 text-[13px] text-neutral-500">
                Mobilisation &asymp; ₹
                {Math.round(crane.estimatedMobilisationCost).toLocaleString("en-IN")}
              </p>
            ) : null}
            {showDetails && crane.boomWarnings && crane.boomWarnings.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5">
                {crane.boomWarnings.map((warning) => (
                  <li key={warning} className="text-[13px] leading-snug text-amber-700">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
            {showDetails ? (
              <p className="mt-1.5 border-t border-ink-800 pt-1.5 text-[13px] leading-snug text-neutral-600">
                Indicative road route for a standard vehicle. Heavy-haul / oversize routes can
                differ.
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setRequestOpen(true)}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl bg-accent-500 px-4 font-semibold text-[#fff] transition-colors hover:bg-accent-600",
            tight ? "mt-2.5 py-2 text-[16px]" : "mt-4 py-2.5 text-sm",
          )}
        >
          Request this crane
          <ArrowRight className="size-4" aria-hidden />
        </button>

        <RequestCraneDialog
          open={requestOpen}
          onOpenChange={setRequestOpen}
          crane={{
            craneId: crane.craneId,
            vendorId: crane.vendorId,
            vendorName: crane.vendorName,
            typeOfCraneCode: crane.typeOfCraneCode,
            typeOfCraneName: crane.typeOfCraneName,
            capacityT: crane.capacityT,
            mainBoomM: crane.mainBoomM,
            currentLocation: crane.currentLocation,
            stateCode: crane.stateCode,
            stateName: crane.stateName,
            availableFrom: crane.availableFrom,
            latitude: crane.latitude,
            longitude: crane.longitude,
          }}
        />
      </div>
    </div>
  );
}

function CardFact({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[13px] font-medium tracking-[0.08em] text-neutral-500 uppercase">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[15px] text-neutral-200">{value}</dd>
    </div>
  );
}

/** `Free now`, `Free from 14 Nov`, `In maintenance` — the card's availability line. */
function availabilityText(crane: DisplayCrane): string {
  if (crane.currentStatus === "AVAILABLE") return "Free now";
  if (crane.currentStatus === "UNDER_MAINTENANCE") {
    const ready = shortDate(crane.expectedReadyDate);
    return ready ? `Ready ${ready}` : "In maintenance";
  }
  const from = shortDate(crane.availableFrom);
  return from ? `Free from ${from}` : "Engaged";
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
}

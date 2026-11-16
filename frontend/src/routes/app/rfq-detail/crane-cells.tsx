import { Clock, FileText, MapPinOff, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CandidateCrane } from "@/lib/rfqs";
import { dayMonth } from "./datetime";

/**
 * The cells the two crane views share.
 *
 * Availability and flags are printed the same way whether a crane appears in a
 * vendor card or in the flat all-cranes table, so the reader does not have to
 * learn a second vocabulary when they switch view.
 */

/**
 * "Free now" / "Free by 18 Nov" / "From 2 Dec" / "After start".
 *
 * Amber means the crane is not free on the required start date. With a TBC
 * start the server skips the date check entirely, so the line reports the
 * release date instead of claiming a readiness the data does not carry.
 */
export function craneAvailability(
  crane: CandidateCrane,
  startDateTbc: boolean,
  startLabel: string,
): { text: string; tone: "ok" | "warning" } {
  if (startDateTbc) {
    if (crane.availableFrom && new Date(crane.availableFrom).getTime() > Date.now()) {
      return { text: `From ${dayMonth(crane.availableFrom)}`, tone: "ok" };
    }
    return { text: "Free now", tone: "ok" };
  }
  if (crane.availableInTime) {
    return crane.currentStatus === "ENGAGED"
      ? { text: `Free by ${startLabel}`, tone: "ok" }
      : { text: "Free now", tone: "ok" };
  }
  if (crane.availableFrom) {
    return { text: `From ${dayMonth(crane.availableFrom)}`, tone: "warning" };
  }
  return { text: "After start", tone: "warning" };
}

function Flag({
  icon: Icon,
  label,
  tone = "muted",
}: {
  icon: typeof FileText;
  label: string;
  tone?: "muted" | "warning";
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex", tone === "warning" ? "text-amber-600" : "text-slate-500")}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/**
 * The crane's caveats, as icons with words attached.
 *
 * Every flag has an accessible name and a tooltip, so none of them relies on
 * colour or on a shape the reader has to memorise.
 */
export function CraneFlags({ crane }: { crane: CandidateCrane }) {
  const flags = [
    crane.loadChartFileName ? (
      <Flag key="chart" icon={FileText} label="Load chart on file" />
    ) : null,
    crane.stale ? (
      <Flag
        key="stale"
        icon={Clock}
        label={`Record is ${crane.daysSinceUpdate} day${crane.daysSinceUpdate === 1 ? "" : "s"} old`}
        tone="warning"
      />
    ) : null,
    crane.locationUnverified ? (
      <Flag key="location" icon={MapPinOff} label="Location unverified" />
    ) : null,
    crane.belowRequiredCapacity ? (
      <Flag
        key="capacity"
        icon={TriangleAlert}
        label="Lighter than the required capacity"
        tone="warning"
      />
    ) : null,
  ].filter(Boolean);

  if (flags.length === 0) {
    return <span className="text-slate-600">—</span>;
  }

  return <span className="inline-flex flex-wrap items-center gap-1.5">{flags}</span>;
}

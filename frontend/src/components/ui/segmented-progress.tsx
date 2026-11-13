import { cn } from "@/lib/cn";

/**
 * One segment per recipient, shaded by how that vendor has responded.
 *
 * A percentage bar would tell the truth about the number and lie about the
 * situation: three declines and three quotations are both "50%", and a sales user
 * chasing an RFQ needs to know which one they are looking at. Each segment is a
 * vendor, tinted by its real `ResponseStatus`, with the count repeated as text so
 * the bar never carries meaning on its own.
 *
 * Exposed to assistive tech as a progress bar over *responses*: `aria-valuenow`
 * is the number of vendors that have answered, out of the recipient count.
 */
export type SegmentTone = "pending" | "quoted" | "declined" | "expired" | "finalised";

const SEGMENT: Record<SegmentTone, string> = {
  pending: "bg-ink-700",
  quoted: "bg-amber-500",
  declined: "bg-red-500",
  expired: "bg-slate-500",
  finalised: "bg-emerald-500",
};

export function SegmentedProgress({
  segments,
  responded,
  total,
  ariaLabel,
  className,
}: {
  segments: Array<{ key: string; tone: SegmentTone; label: string }>;
  /** Vendors that have answered (quoted, declined or expired). */
  responded: number;
  total: number;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.max(total, 1)}
      aria-valuenow={Math.min(responded, Math.max(total, 1))}
      aria-valuetext={`${responded} of ${total} responded`}
      aria-label={ariaLabel}
      className={cn("flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-ink-800", className)}
    >
      {segments.length === 0 ? (
        <span className="h-full w-full bg-ink-700/60" />
      ) : (
        segments.map((segment) => (
          <span
            key={segment.key}
            title={segment.label}
            className={cn("h-full flex-1", SEGMENT[segment.tone])}
          />
        ))
      )}
    </div>
  );
}

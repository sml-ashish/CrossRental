import { cn } from "@/lib/cn";

/**
 * Status badge tones. These mirror the badge palette in design.md so the same
 * word never appears in two colours across the portal. Extending this is
 * deliberate work — a one-off colour here reads as a bug to whoever inherits it.
 */
const TONES = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  purple: "border-purple-200 bg-purple-50 text-purple-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  orange: "border-orange-200 bg-orange-50 text-orange-700",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red: "border-red-200 bg-red-50 text-red-700",
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Maps a domain status to a tone, so screens do not each invent one. */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "OPEN":
    case "SUBMITTED":
    case "IN_PROGRESS":
      return "blue";
    case "APPROVED":
    case "AWARDED":
    case "COMPLETED":
    case "AVAILABLE":
    case "SELECTED":
    case "HIRED":
      return "emerald";
    case "REJECTED":
    case "CANCELLED":
    case "EXPIRED":
    case "NOT_AWARDED":
    case "LOST":
      return "red";
    case "ON_HOLD":
    case "PENDING":
    case "BOOKED":
      return "amber";
    case "REOPENED":
    case "UNDER_REVIEW":
    case "QUOTED":
    case "SHORTLISTED":
      return "purple";
    case "WITHDRAWN":
    case "FINALISED":
      return "neutral";
    case "DRAFT":
    case "SUBMITTED_QUOTE":
      return "neutral";
    default:
      return "neutral";
  }
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={statusTone(status)} className={className}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}
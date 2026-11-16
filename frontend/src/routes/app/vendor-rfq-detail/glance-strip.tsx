import { CalendarClock, CalendarDays, Clock, MapPin, Package, Weight } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import type { VendorRfqDetail } from "@/lib/quotations";
import { formatCalendarDate } from "@/lib/format";
import {
  deadlineInfo,
  durationLabel,
  expectedEndDate,
  shortDate,
  startHint,
} from "./rfq-utils";

/**
 * Six answers before the detail: what machine, how many, from when, for how
 * long, where, and how long is left to quote. Everything here is already on the
 * RFQ or derived from its dates; nothing is a new backend field.
 */
export function GlanceStrip({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const end = expectedEndDate(rfq);
  const countdown = deadlineInfo(rfq);

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile
        label="Crane"
        icon={<Weight className="size-3" aria-hidden />}
        value={`${rfq.capacityT} t`}
        hint={rfq.craneTypeName}
      />
      <StatTile
        label="Quantity"
        icon={<Package className="size-3" aria-hidden />}
        value={rfq.quantity}
        hint={rfq.quantity === 1 ? "one crane" : `${rfq.quantity} cranes`}
      />
      <StatTile
        label="Start"
        icon={<CalendarDays className="size-3" aria-hidden />}
        value={rfq.startDateTbc ? "TBC" : shortDate(rfq.requiredStartDate)}
        hint={startHint(rfq)}
      />
      <StatTile
        label="Duration"
        icon={<Clock className="size-3" aria-hidden />}
        value={durationLabel(rfq)}
        hint={end ? `Ends ${shortDate(end)}` : "End date follows the start"}
      />
      <StatTile
        label="Site"
        icon={<MapPin className="size-3" aria-hidden />}
        value={
          <span className="block truncate text-lg" title={rfq.siteLocation}>
            {rfq.siteLocation}
          </span>
        }
        hint={[rfq.siteStateName, rfq.sitePincode].filter(Boolean).join(" · ")}
      />
      <StatTile
        label="Deadline"
        icon={<CalendarClock className="size-3" aria-hidden />}
        value={<span className="text-lg">{countdown.label}</span>}
        hint={rfq.locked ? "Finalised" : formatCalendarDate(rfq.submissionDeadline.slice(0, 10))}
        tone={countdown.tone === "overdue" ? "red" : countdown.tone === "soon" ? "amber" : "neutral"}
      />
    </div>
  );
}

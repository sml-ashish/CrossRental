import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  getVendorDashboard,
  type VendorDashboard,
} from "@/lib/dashboard";
import { VENDOR_RESPONSE_LABELS, type VendorResponseStatus } from "@/lib/quotations";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { deadlineCountdown, formatDate, formatDateTime } from "@/routes/app/rfqs";

/**
 * The vendor's landing screen (brief 7.5, M7).
 *
 * Counters first, then the lists a counter leads to. The brief asks for links
 * out to the filtered lists rather than repeating them here, so each list is
 * capped and every row links into the screen that owns the detail — My Fleet
 * for a stale crane, the RFQ detail for an awaiting response, My Fleet for a
 * booking.
 *
 * An after-deadline row is overdue and red rather than hidden: the vendor
 * cannot past the deadline anymore, but seeing it beats wondering.
 */
export function VendorDashboardPage() {
  const dashboard = useQuery({
    queryKey: ["vendor-dashboard"],
    queryFn: getVendorDashboard,
  });

  if (dashboard.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading your dashboard
      </div>
    );
  }

  if (dashboard.error) {
    return (
      <Alert title="Could not load your dashboard">
        {(dashboard.error as Error).message}
      </Alert>
    );
  }

  const data = dashboard.data;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        description="Where your fleet and your quotations stand with SML right now."
      />

      <CounterGrid data={data} />

      <AwaitingSection data={data} />

      <div className="grid gap-5 lg:grid-cols-2">
        <DueForUpdateSection data={data} />
        <BookingsSection data={data} />
      </div>
    </div>
  );
}

function CounterCard({
  label,
  value,
  to,
  accent,
}: {
  label: string;
  value: string | number;
  to: string;
  accent?: "amber" | "emerald" | "neutral";
}) {
  return (
    <Link to={to} className="block">
      <StatTile
        label={label}
        value={value}
        tone={accent === "amber" ? "amber" : accent === "emerald" ? "emerald" : "neutral"}
        className="h-full transition-colors hover:border-brand-300"
      />
    </Link>
  );
}

function CounterGrid({ data }: { data: VendorDashboard }) {
  const dueCount = data.fleet.dueForUpdate.length;
  const bookingCount = data.fleet.bookings.count;

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <CounterCard
        label="Active cranes"
        value={data.fleet.totalCranes}
        to="/app/fleet"
      />
      <CounterCard
        label="Need a status update"
        value={dueCount}
        to="/app/fleet"
        accent={dueCount === 0 ? "neutral" : "amber"}
      />
      <CounterCard
        label="Booked / hired"
        value={bookingCount}
        to="/app/fleet"
        accent={bookingCount === 0 ? "neutral" : "emerald"}
      />
      <CounterCard
        label="Open RFQs"
        value={data.rfqs.openCount}
        to="/app/rfqs"
      />
      <CounterCard
        label="Awaiting my quote"
        value={data.rfqs.awaitingResponseCount}
        to="/app/rfqs"
        accent={data.rfqs.awaitingResponseCount === 0 ? "neutral" : "amber"}
      />
      <CounterCard
        label="Quotations submitted"
        value={data.quotations.submittedCount}
        to="/app/rfqs"
      />
    </div>
  );
}

function AwaitingSection({ data }: { data: VendorDashboard }) {
  return (
    <Panel
      title="Awaiting my response"
      description="Nearest deadline first. Overdue rows cannot be quoted anymore but stay visible until they are cleared."
      bodyClassName=""
    >
      {data.rfqs.awaitingResponse.length === 0 ? (
        <EmptyState
          title="Nothing is waiting on you"
          description="New RFQs appear here the moment SML sends one to your company."
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>RFQ</TH>
              <TH>Requirement</TH>
              <TH>Deadline</TH>
              <TH>Your status</TH>
              <TH align="right">Quotes</TH>
            </tr>
          </THead>
          <TBody>
            {data.rfqs.awaitingResponse.map((row) => (
              <TR key={row.rfqId} className="align-top">
                <TD>
                  <Link
                    to="/app/rfqs/$rfqId"
                    params={{ rfqId: row.rfqId }}
                    className="font-mono text-sm font-medium text-brand-700 hover:underline"
                  >
                    {row.rfqNumber}
                  </Link>
                  <p className="text-[11px] text-slate-500">
                    {row.siteLocation}, {row.siteStateName}
                  </p>
                </TD>
                <TD className="text-xs">
                  {row.craneTypeName} · {row.capacityT} t
                </TD>
                <TD className="text-xs">
                  <p className={row.overdue ? "font-medium text-red-600" : ""}>
                    {formatDateTime(row.deadline)}
                  </p>
                  <p className={row.overdue ? "text-red-500" : "text-[11px] text-slate-500"}>
                    {deadlineCountdown(row.deadline, "SENT").label}
                  </p>
                </TD>
                <TD>
                  <StatusBadge status={row.responseStatus} />
                  <p className="mt-1 text-[11px] text-slate-500">
                    {VENDOR_RESPONSE_LABELS[row.responseStatus as VendorResponseStatus] ??
                      row.responseStatus}
                  </p>
                </TD>
                <TD align="right" className="text-xs tabular-nums">
                  {row.liveQuotationCount === 0 ? "—" : row.liveQuotationCount}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  );
}

function DueForUpdateSection({ data }: { data: VendorDashboard }) {
  return (
    <Panel
      title="Cranes needing a status update"
      description="SML reads this too. A crane whose status is untouched long enough earns a reminder email to your whole vendor team."
    >
      {data.fleet.dueForUpdate.length === 0 ? (
        <EmptyState
          title="Every crane is current"
          description="Nothing is overdue for a status update."
        />
      ) : (
        <ul className="space-y-2">
          {data.fleet.dueForUpdate.map((crane) => (
            <li
              key={crane.craneId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
            >
              <div>
                <Link
                  to="/app/fleet/$craneId/edit"
                  params={{ craneId: crane.craneId }}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  {crane.label}
                </Link>
                <p className="text-xs text-slate-500">
                  {formatDate(crane.statusUpdatedAt)} · {crane.daysSinceUpdate}{" "}
                  day{crane.daysSinceUpdate === 1 ? "" : "s"} since update
                  {crane.locationUnverified ? " · location not pin-verified" : ""}
                  {crane.availableFromLapsed ? " · availability date lapsed, confirm" : ""}
                </p>
              </div>
              <StatusBadge status={crane.currentStatus} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BookingsSection({ data }: { data: VendorDashboard }) {
  return (
    <Panel
      title="Booked and hired cranes"
      description="Set by SML when a quotation is awarded. Until brief 8 opens them, bookings are read-only here."
      actions={
        <Link
          to="/app/calendar"
          className="text-xs font-medium text-brand-700 hover:underline"
        >
          Booking calendar
        </Link>
      }
    >
      {data.fleet.bookings.cranes.length === 0 ? (
        <EmptyState
          title="Nothing booked or hired"
          description="Awarded quotations show up here with their hire window."
        />
      ) : (
        <ul className="space-y-2">
          {data.fleet.bookings.cranes.map((crane) => (
            <li
              key={crane.craneId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
            >
              <div>
                <Link
                  to="/app/fleet/$craneId/edit"
                  params={{ craneId: crane.craneId }}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  {crane.label}
                </Link>
                <p className="text-xs text-slate-500">
                  {crane.startDate && crane.endDate
                    ? `${formatDate(crane.startDate)} – ${formatDate(crane.endDate)}`
                    : `Since ${formatDate(crane.statusUpdatedAt)}`}
                </p>
              </div>
              <StatusBadge status={crane.currentStatus} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

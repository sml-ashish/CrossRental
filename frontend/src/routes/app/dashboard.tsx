import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  getVendorDashboard,
  type VendorDashboard,
} from "@/lib/dashboard";
import { VENDOR_RESPONSE_LABELS, type VendorResponseStatus } from "@/lib/quotations";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Section } from "@/components/ui/form";
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
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Where your fleet and your quotations stand with SML right now.
        </p>
      </header>

      {data.fleet.updatedOnBehalf.count > 0 ? (
        <Alert tone="info" title="SML updated your fleet on your behalf">
          <p>
            {data.fleet.updatedOnBehalf.count === 1
              ? "1 crane was changed by an SML user for you"
              : `${data.fleet.updatedOnBehalf.count} cranes were changed by an SML user for you`}
            . Please review the details.
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {data.fleet.updatedOnBehalf.cranes.slice(0, 5).map((crane) => (
              <li key={crane.craneId}>
                <Link
                  to="/app/fleet/$craneId/edit"
                  params={{ craneId: crane.craneId }}
                  className="underline underline-offset-2"
                >
                  {crane.label}
                </Link>{" "}
                <span className="text-blue-700/70">
                  {formatDateTime(crane.statusUpdatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

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
    <Link
      to={to}
      className="card block p-4 transition-colors hover:border-brand-300 hover:bg-brand-50"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={
          accent === "amber"
            ? "mt-1 text-2xl font-semibold text-amber-700"
            : accent === "emerald"
              ? "mt-1 text-2xl font-semibold text-emerald-700"
              : "mt-1 text-2xl font-semibold text-slate-900"
        }
      >
        {value}
      </p>
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
    <Section
      title="Awaiting my response"
      description="Nearest deadline first. Overdue rows cannot be quoted anymore but stay visible until they are cleared."
    >
      {data.rfqs.awaitingResponse.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing is waiting on you right now.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">RFQ</th>
                <th className="px-3 py-2 font-medium">Requirement</th>
                <th className="px-3 py-2 font-medium">Deadline</th>
                <th className="px-3 py-2 font-medium">Your status</th>
                <th className="px-3 py-2 font-medium">Quotes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rfqs.awaitingResponse.map((row) => (
                <tr key={row.rfqId} className="align-top">
                  <td className="px-3 py-2.5">
                    <Link
                      to="/app/rfqs/$rfqId"
                      params={{ rfqId: row.rfqId }}
                      className="font-mono text-sm font-medium text-brand-700 hover:underline"
                    >
                      {row.rfqNumber}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {row.siteLocation}, {row.siteStateName}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {row.craneTypeName} · {row.capacityT} t
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <p className={row.overdue ? "font-medium text-red-600" : "text-slate-700"}>
                      {formatDateTime(row.deadline)}
                    </p>
                    <p
                      className={
                        row.overdue ? "text-red-500" : "text-slate-500"
                      }
                    >
                      {deadlineCountdown(row.deadline, "SENT").label}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={row.responseStatus} />
                    <p className="mt-1 text-xs text-slate-500">
                      {VENDOR_RESPONSE_LABELS[row.responseStatus as VendorResponseStatus] ??
                        row.responseStatus}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {row.liveQuotationCount === 0 ? "—" : row.liveQuotationCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function DueForUpdateSection({ data }: { data: VendorDashboard }) {
  return (
    <Section
      title="Cranes needing a status update"
      description="SML reads this too. A crane whose status is untouched long enough earns a reminder email to your whole vendor team."
    >
      {data.fleet.dueForUpdate.length === 0 ? (
        <p className="text-sm text-slate-500">No crane is overdue for an update.</p>
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
    </Section>
  );
}

function BookingsSection({ data }: { data: VendorDashboard }) {
  return (
    <Section
      title="Booked and hired cranes"
      description="Set by SML when a quotation is awarded. Until brief 8 opens them, bookings are read-only here."
    >
      {data.fleet.bookings.cranes.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing is booked or hired at the moment.
        </p>
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
    </Section>
  );
}

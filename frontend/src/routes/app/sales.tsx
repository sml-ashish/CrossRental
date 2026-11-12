import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Spinner } from "@/components/ui/spinner";
import { AlertList } from "@/components/alerts";
import { loadSalesDashboard } from "@/lib/internalDashboard";
import { TRAIL_LABELS, type EnquiryLineTrailStatus } from "@/lib/enquiries";

/**
 * P5 sales dashboard (BPD 6.2).
 *
 * The day's working list: intake, sourcing stages, the RFQs that need chasing
 * and the quotations about to lapse. Every counter links into the list behind
 * it; the alert panel is the same list the daily digest emails.
 */

function CounterCard({
  value,
  label,
  hint,
  to,
}: {
  value: number;
  label: string;
  hint?: string;
  to: string;
}) {
  return (
    <Link to={to as never} className="block">
      <StatTile
        label={label}
        value={value}
        hint={hint}
        className="h-full transition-colors hover:border-brand-300"
      />
    </Link>
  );
}

export function SalesDashboardPage() {
  const dashboard = useQuery({ queryKey: ["dashboard", "sales"], queryFn: loadSalesDashboard });

  if (dashboard.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (dashboard.error) {
    return <Alert tone="error">{(dashboard.error as Error).message}</Alert>;
  }

  const data = dashboard.data!;
  const stages = Object.entries(data.linesAtEachStage).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales dashboard"
        description="Enquiries in intake, lines in sourcing, and the RFQs that need a chase."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CounterCard
          value={data.counts.newEnquiries}
          label="New enquiries"
          hint="Received, pending sourcing"
          to="/app/enquiries"
        />
        <CounterCard
          value={data.counts.pendingSourcing}
          label="Lines pending sourcing"
          hint="New, availability check or shortlisted"
          to="/app/enquiries"
        />
        <CounterCard
          value={data.counts.rfqSent}
          label="Lines with RFQs out"
          hint="RFQ sent or awaiting quotes"
          to="/app/rfqs"
        />
        <CounterCard
          value={data.counts.quotesReceived}
          label="Lines with quotes received"
          hint="Quotes received or under evaluation"
          to="/app/enquiries"
        />
        <CounterCard
          value={data.counts.finalised}
          label="Lines finalised"
          hint="Vendor finalised, booked or internal"
          to="/app/enquiries"
        />
        <CounterCard
          value={data.counts.closedEnquiries}
          label="Closed enquiries"
          to="/app/enquiries"
        />
        <CounterCard
          value={data.counts.overdueRfqs}
          label="Overdue RFQ responses"
          hint={`Past the deadline with no response`}
          to="/app/rfqs"
        />
        <CounterCard
          value={data.counts.expiringQuotations}
          label="Quotations expiring soon"
          hint={`Within ${data.thresholds.alertQuotationExpiryDays} days`}
          to="/app/rfqs"
        />
      </div>

      <Panel
        title="Needs action"
        description={`${data.counts.needsAction} item${data.counts.needsAction === 1 ? "" : "s"} matched the alert rules.`}
      >
        <AlertList alerts={data.alerts} />
      </Panel>

      <Panel
        title="Lines at each stage"
        description="The whole sourcing pipeline for the CR team."
        bodyClassName=""
      >
        {stages.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">No enquiry lines yet.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Stage</TH>
                <TH align="right">Lines</TH>
              </tr>
            </THead>
            <TBody>
              {stages.map(([stage, count]) => (
                <TR key={stage}>
                  <TD>{TRAIL_LABELS[stage as EnquiryLineTrailStatus] ?? stage.replaceAll("_", " ")}</TD>
                  <TD align="right" className="font-medium tabular-nums">
                    {count}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, Select, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import {
  loadManagementDashboard,
  type ManagementFilters,
} from "@/lib/internalDashboard";

/**
 * P5 Management Viewer dashboard (BPD 6.2).
 *
 * Read-only and aggregate by construction: no customer name, address or budget
 * is returned by the endpoint behind it. Filters narrow the same period the
 * reports screen uses.
 */

function metric(value: number | null, suffix = ""): string {
  if (value === null) return "—";
  return `${value.toLocaleString()}${suffix}`;
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <StatTile label={label} value={value} hint={hint} className="h-full" />;
}

export function ManagementDashboardPage() {
  const [filters, setFilters] = useState<ManagementFilters>({});
  const dashboard = useQuery({
    queryKey: ["dashboard", "management", filters],
    queryFn: () => loadManagementDashboard(filters),
  });

  const options = dashboard.data?.options;
  const metrics = dashboard.data?.metrics;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Management dashboard"
        description="Read-only sourcing metrics across the selected period."
        actions={
          <Link to="/app/reports" className="btn-secondary">
            Open reports
          </Link>
        }
      />

      <Panel title="Filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="From" htmlFor="management-from">
            <TextInput
              id="management-from"
              type="date"
              value={filters.from ?? ""}
              onChange={(value) => setFilters((prev) => ({ ...prev, from: value || undefined }))}
            />
          </Field>
          <Field label="To" htmlFor="management-to">
            <TextInput
              id="management-to"
              type="date"
              value={filters.to ?? ""}
              onChange={(value) => setFilters((prev) => ({ ...prev, to: value || undefined }))}
            />
          </Field>
          <Field label="Region" htmlFor="management-region">
            <Select
              id="management-region"
              value={filters.region ?? ""}
              onChange={(value) => setFilters((prev) => ({ ...prev, region: value || undefined }))}
              options={(options?.regions ?? []).map((region) => ({ value: region, label: region }))}
              placeholder="All regions"
            />
          </Field>
          <Field label="Crane category" htmlFor="management-category">
            <Select
              id="management-category"
              value={filters.craneCategory ?? ""}
              onChange={(value) =>
                setFilters((prev) => ({ ...prev, craneCategory: value || undefined }))
              }
              options={(options?.craneCategories ?? []).map((category) => ({
                value: category.code,
                label: category.name,
              }))}
              placeholder="All categories"
            />
          </Field>
        </div>
        <button
          type="button"
          className="btn-secondary mt-3"
          onClick={() => setFilters({})}
          disabled={Object.keys(filters).length === 0}
        >
          Clear filters
        </button>
      </Panel>

      {dashboard.error ? <Alert tone="error">{(dashboard.error as Error).message}</Alert> : null}
      {dashboard.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : null}

      {metrics ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Enquiries processed" value={metric(metrics.enquiriesProcessed)} />
            <MetricCard label="Lines processed" value={metric(metrics.linesProcessed)} />
            <MetricCard
              label="Vendor participation rate"
              value={metric(metrics.vendorParticipationRate, "%")}
              hint="Quoted or declined / recipients"
            />
            <MetricCard
              label="RFQ response rate"
              value={metric(metrics.rfqResponseRate, "%")}
              hint="RFQs with at least one quote"
            />
            <MetricCard
              label="Average response time"
              value={metric(metrics.averageResponseTimeHours, " h")}
              hint="RFQ sent to quote received"
            />
            <MetricCard
              label="RFQ turnaround (first)"
              value={metric(metrics.rfqTurnaroundFirstHours, " h")}
              hint="Sent to first quote"
            />
            <MetricCard
              label="RFQ turnaround (last)"
              value={metric(metrics.rfqTurnaroundLastHours, " h")}
              hint="Sent to last quote"
            />
            <MetricCard
              label="Quotation conversion"
              value={metric(metrics.quotationConversionRate, "%")}
              hint="Awarded / submitted"
            />
            <MetricCard
              label="Average mobilisation distance"
              value={metric(metrics.averageMobilisationDistanceKm, " km")}
              hint="Selected cranes"
            />
            <MetricCard
              label="Average transport cost"
              value={
                metrics.averageTransportCost === null
                  ? "—"
                  : `₹${metrics.averageTransportCost.toLocaleString()}`
              }
              hint="Mobilisation + demobilisation"
            />
          </div>

          <Panel title="Enquiries by region" bodyClassName="">
            {(dashboard.data?.byRegion ?? []).length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                No enquiries match these filters.
              </p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Region</TH>
                    <TH align="right">Enquiries</TH>
                  </tr>
                </THead>
                <TBody>
                  {(dashboard.data?.byRegion ?? []).map((row) => (
                    <TR key={row.region ?? "unassigned"}>
                      <TD>{row.region ?? "Unassigned"}</TD>
                      <TD align="right" className="font-medium tabular-nums">
                        {row.count}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

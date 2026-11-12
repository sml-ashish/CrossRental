import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, Select, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth";
import {
  REPORT_VIEW_LABELS,
  downloadReportCsv,
  loadReport,
  type ReportFilters,
  type ReportView,
} from "@/lib/reports";

/**
 * P5 reports (BPD 5.15 / 6.23).
 *
 * Sales are scoped to their own enquiries by the server; admin and management
 * see everything. The CSV is the same rows the table shows, not a second
 * computation.
 */

const VIEW_OPTIONS = (Object.keys(REPORT_VIEW_LABELS) as ReportView[]).map((view) => ({
  value: view,
  label: REPORT_VIEW_LABELS[view],
}));

function SummaryCell({ label, value }: { label: string; value: string }) {
  return <StatTile label={label} value={value} className="h-full" />;
}

export function ReportsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<ReportFilters>({ view: "enquiry" });

  const report = useQuery({
    queryKey: ["reports", filters],
    queryFn: () => loadReport(filters),
  });

  const download = useMutation({ mutationFn: () => downloadReportCsv(filters) });

  const options = report.data?.options;
  const summary = report.data?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description={
          user?.role === "sales_user"
            ? "Your own enquiries only. Admin and management see the full platform."
            : "Enquiries, lines, vendors and crane categories."
        }
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => download.mutate()}
            disabled={download.isPending}
          >
            <Download className="size-4" aria-hidden />
            {download.isPending ? "Preparing…" : "Download CSV"}
          </button>
        }
      />

      <Panel title="Filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="View" htmlFor="report-view">
            <Select
              id="report-view"
              value={filters.view}
              onChange={(value) =>
                setFilters((prev) => ({ ...prev, view: value as ReportView }))
              }
              options={VIEW_OPTIONS}
              placeholder="Select view"
            />
          </Field>
          <Field label="From" htmlFor="report-from">
            <TextInput
              id="report-from"
              type="date"
              value={filters.from ?? ""}
              onChange={(value) => setFilters((prev) => ({ ...prev, from: value || undefined }))}
            />
          </Field>
          <Field label="To" htmlFor="report-to">
            <TextInput
              id="report-to"
              type="date"
              value={filters.to ?? ""}
              onChange={(value) => setFilters((prev) => ({ ...prev, to: value || undefined }))}
            />
          </Field>
          <Field label="Crane category" htmlFor="report-category">
            <Select
              id="report-category"
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
      </Panel>

      {report.error ? <Alert tone="error">{(report.error as Error).message}</Alert> : null}
      {download.error ? <Alert tone="error">{(download.error as Error).message}</Alert> : null}
      {report.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : null}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryCell label="Enquiries" value={summary.enquiriesProcessed.toLocaleString()} />
          <SummaryCell label="Lines" value={summary.linesProcessed.toLocaleString()} />
          <SummaryCell
            label="Vendor participation"
            value={
              summary.vendorParticipationRate === null
                ? "—"
                : `${summary.vendorParticipationRate}%`
            }
          />
          <SummaryCell
            label="RFQ response rate"
            value={summary.rfqResponseRate === null ? "—" : `${summary.rfqResponseRate}%`}
          />
          <SummaryCell
            label="Quotation conversion"
            value={
              summary.quotationConversionRate === null
                ? "—"
                : `${summary.quotationConversionRate}%`
            }
          />
        </div>
      ) : null}

      {report.data ? (
        <Panel
          title={REPORT_VIEW_LABELS[report.data.view]}
          description={`Generated ${new Date(report.data.generatedAt).toLocaleString()}${
            report.data.filters.ownerScoped ? " · your enquiries only" : ""
          }`}
          bodyClassName=""
        >
          {report.data.rows.length === 0 ? (
            <EmptyState
              title="No rows match these filters"
              description="Widen the date range or clear a filter, then try again."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  {report.data.columns.map((column) => (
                    <TH key={column.key}>{column.label}</TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {report.data.rows.map((row, index) => (
                  <TR key={index}>
                    {report.data.columns.map((column) => (
                      <TD key={column.key} className="text-slate-700">
                        {row[column.key] ?? "—"}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

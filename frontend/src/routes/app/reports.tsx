import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Link2,
  Loader2,
  Printer,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipPayload,
} from "recharts";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { TBody, TD, TH, TR } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/form";
import { Menu } from "@/components/ui/menu";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { listEnquiries } from "@/lib/enquiries";
import {
  REPORT_VIEW_LABELS,
  downloadReportCsv,
  loadReport,
  type Report,
  type ReportFilters,
  type ReportView,
} from "@/lib/reports";
import {
  PERIOD_OPTIONS,
  asNumber,
  asText,
  buildInsights,
  categorySeries,
  columnMeta,
  enquiryVolumeSeries,
  filterByRegion,
  formatCell,
  formatMetric,
  formatNumber,
  formatPercent,
  formatRange,
  formatTimestamp,
  hasReportData,
  isoDay,
  kpiDelta,
  kpiSpecs,
  lineStageSeries,
  parseReportSearch,
  previousRange,
  reportSearchParams,
  reportTotals,
  resolvePeriod,
  searchReportRows,
  sortReportRows,
  stageDot,
  stageLabel,
  vendorWinSeries,
  type ChartPoint,
  type ColumnMeta,
  type Granularity,
  type KpiDelta,
  type KpiSpec,
  type PeriodPreset,
  type ReportSearchState,
  type ReportTotals,
  type ResolvedPeriod,
  type SortState,
} from "@/lib/reportView";

/**
 * P5 reports (BPD 5.15 / 6.23).
 *
 * A report should answer a question, not just move rows. The screen reads the
 * server's numbers, says in plain words what changed, and only then offers the
 * detail. Sales are scoped to their own enquiries by the server; admin and
 * management see everything. The CSV is the same report the table shows.
 *
 * Region is the one client-side filter: the endpoint does not accept it, so it
 * narrows the enquiry rows after they load and the screen says so.
 */

const VIEWS: ReportView[] = ["enquiry", "line", "vendor", "category"];

const DESCRIPTIONS: Record<ReportView, string> = {
  enquiry: "How enquiries, RFQs and vendors are performing.",
  line: "How each enquiry line is moving through the pipeline.",
  vendor: "Who is replying, who is winning, and how quickly.",
  category: "Which crane categories are in demand, and what transport costs.",
};

const ROW_LABELS: Record<ReportView, string> = {
  enquiry: "Enquiry rows",
  line: "Line rows",
  vendor: "Vendor rows",
  category: "Category rows",
};

const KPI_COLUMNS: Record<number, string> = {
  3: "min-[1000px]:grid-cols-3",
  4: "min-[1000px]:grid-cols-4",
  5: "min-[1000px]:grid-cols-5",
};

const VENDOR_CARD_FIELDS = [
  { label: "RFQs received", key: "recipients" },
  { label: "Quoted", key: "quoted" },
  { label: "Declined", key: "declined" },
  { label: "Pending", key: "pending" },
  { label: "Submitted", key: "submitted" },
  { label: "Awarded", key: "awarded" },
] as const;

type ColumnView = { key: string; label: string; meta: ColumnMeta };

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <span className="group inline-flex shrink-0">
      <button
        type="button"
        aria-label={`What "${label}" means: ${text}`}
        className="inline-flex size-5 items-center justify-center rounded-full text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        role="tooltip"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-8 z-40 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] leading-relaxed text-slate-700 opacity-0 shadow-xl transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function DeltaLine({ delta }: { delta: KpiDelta }) {
  if (delta.direction === "flat") {
    return <span className="text-slate-500">No change</span>;
  }
  const arrow = delta.direction === "up" ? "▲" : "▼";
  const tone =
    delta.verdict === "better"
      ? "text-emerald-600"
      : delta.verdict === "worse"
        ? "text-red-600"
        : "text-slate-500";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", tone)}>
      <span className="sr-only">Change against the previous period: </span>
      <span className="font-medium tabular-nums">
        <span aria-hidden>{arrow}</span> {delta.amount}
      </span>
      {delta.verdict !== "neutral" ? (
        <span className="text-slate-500">{delta.verdict}</span>
      ) : null}
    </span>
  );
}

function KpiTile({
  spec,
  report,
  previous,
}: {
  spec: KpiSpec;
  report: Report;
  previous: Report | null;
}) {
  const value = spec.value(report);
  const hint = value === null ? null : (spec.hint?.(report) ?? null);
  const delta = kpiDelta(spec, report, previous);
  return (
    <div className="card relative flex h-full flex-col px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-5 text-slate-600">{spec.label}</p>
        <InfoTip label={spec.label} text={spec.definition} />
      </div>
      <p className="mt-1 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-slate-900">
        {formatMetric(value, spec.format)}
      </p>
      <p className="mt-1.5 min-h-[16px] text-[12px] leading-4 text-slate-500">
        {value === null ? "No data in this period" : hint}
      </p>
      <div className="mt-auto pt-2 text-[12px] leading-4">
        {delta ? (
          <DeltaLine delta={delta} />
        ) : (
          <span className="text-slate-500">No comparison</span>
        )}
      </div>
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  unit,
}: {
  active: boolean;
  payload: TooltipPayload;
  unit: "enquiry" | "line" | "percent";
}) {
  const entry = payload[0];
  const point = entry?.payload as ChartPoint | undefined;
  if (!active || !point) return null;
  const noun = unit === "enquiry" ? "enquiry" : "line";
  const amount =
    unit === "percent"
      ? `${formatNumber(point.value)}%`
      : plural(point.value, noun, `${noun}s`);
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] shadow-xl">
      <p className="font-medium text-slate-900">{point.label}</p>
      <p className="mt-0.5 tabular-nums text-slate-700">{amount}</p>
      {point.meta ? <p className="mt-0.5 text-slate-500">{point.meta}</p> : null}
    </div>
  );
}

function plural(value: number, one: string, many: string): string {
  return `${formatNumber(value)} ${value === 1 ? one : many}`.trim();
}

function ChartEmpty({ title }: { title: string }) {
  return (
    <div className="flex h-[260px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-ink-800 text-center">
      <p className="text-sm text-slate-600">{title}</p>
      <p className="text-[12px] text-slate-500">Try a wider period or clear the filters.</p>
    </div>
  );
}

function ReportChart({ report, range }: { report: Report; range: ResolvedPeriod }) {
  const view = report.view;
  const { points, granularity } = useMemo(() => {
    if (view === "enquiry") {
      const series = enquiryVolumeSeries(report.rows, range);
      return { points: series.points, granularity: series.granularity };
    }
    const other: ChartPoint[] =
      view === "line"
        ? lineStageSeries(report.rows)
        : view === "vendor"
          ? vendorWinSeries(report.rows)
          : categorySeries(report.rows);
    return { points: other, granularity: "day" as Granularity };
  }, [view, report.rows, range.from, range.to]);

  const total = points.reduce((sum, point) => sum + point.value, 0);
  const empty = points.length === 0 || total === 0 && view === "enquiry";
  const unit =
    view === "vendor" ? "percent" : view === "enquiry" ? "enquiry" : "line";

  const title =
    view === "enquiry"
      ? `Enquiries per ${granularity}`
      : view === "line"
        ? "Lines by pipeline stage"
        : view === "vendor"
          ? "Win rate by vendor"
          : "Lines by crane category";

  const description =
    view === "enquiry"
      ? `${formatRange(range.from, range.to)} · ${plural(total, "enquiry", "enquiries")}`
      : view === "line"
        ? "Ordered along the pipeline, from new to booked"
        : view === "vendor"
          ? "Share of submitted quotations won · top 10 by wins"
          : "Bars show lines; the label shows average mobilisation distance";

  const emptyTitle =
    view === "enquiry"
      ? "No enquiries in this period"
      : view === "line"
        ? "No lines to show"
        : view === "vendor"
          ? "No vendor replies to compare"
          : "No crane categories to show";

  const summary =
    view === "enquiry"
      ? `${plural(total, "enquiry", "enquiries")} in ${formatRange(range.from, range.to)}, shown per ${granularity}.`
      : view === "line"
        ? `${plural(total, "line", "lines")} across ${plural(points.length, "pipeline stage", "pipeline stages")}.`
        : view === "vendor"
          ? `Win rate for ${plural(points.length, "vendor", "vendors")}. ${
              points[0]
                ? `${points[0].label} leads with ${formatPercent(points[0].value)}.`
                : ""
            }`
          : `${plural(total, "line", "lines")} across ${plural(points.length, "crane category", "crane categories")}.`;

  return (
    <section
      className="card mt-4 px-4 py-3.5 print:break-inside-avoid"
      aria-labelledby="report-chart-title"
    >
      <div>
        <h2 id="report-chart-title" className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>
      </div>

      {empty ? (
        <ChartEmpty title={emptyTitle} />
      ) : (
        <div role="img" aria-label={summary} className="mt-3 h-[260px]">
          <div aria-hidden="true" className="h-full">
            <ResponsiveContainer width="100%" height="100%">
              {view === "enquiry" ? (
                <BarChart
                  data={points}
                  margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
                  barCategoryGap="22%"
                >
                  <CartesianGrid vertical={false} stroke="#26282b" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#8f9299", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "#34363a" }}
                    interval="preserveStartEnd"
                    minTickGap={18}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "#8f9299", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <Tooltip
                    cursor={{ fill: "#26282b" }}
                    content={(props) => (
                      <ChartTooltip
                        active={props.active}
                        payload={props.payload}
                        unit={unit}
                      />
                    )}
                  />
                  <Bar
                    dataKey="value"
                    fill="#c4443f"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              ) : (
                <BarChart
                  layout="vertical"
                  data={points}
                  margin={{ top: 4, right: 56, bottom: 4, left: 4 }}
                  barCategoryGap={view === "vendor" ? "28%" : "26%"}
                >
                  <CartesianGrid horizontal={false} stroke="#26282b" />
                  <XAxis
                    type="number"
                    domain={view === "vendor" ? ([0, 100] as [number, number]) : undefined}
                    allowDecimals={view !== "vendor"}
                    tickFormatter={view === "vendor" ? (value) => `${value}%` : undefined}
                    tick={{ fill: "#8f9299", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "#34363a" }}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={view === "vendor" ? 148 : 132}
                    tick={{ fill: "#c3c6cb", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "#26282b" }}
                    content={(props) => (
                      <ChartTooltip
                        active={props.active}
                        payload={props.payload}
                        unit={unit}
                      />
                    )}
                  />
                  <Bar
                    dataKey="value"
                    fill="#c4443f"
                    radius={[0, 3, 3, 0]}
                    barSize={14}
                    isAnimationActive={false}
                  >
                    {view === "category" ? (
                      <LabelList
                        dataKey="annotation"
                        position="right"
                        style={{ fill: "#8f9299", fontSize: 12 }}
                      />
                    ) : null}
                  </Bar>
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

function WinRateBar({ value, wide = false }: { value: number | null; wide?: boolean }) {
  if (value === null) return <span className="text-slate-500">—</span>;
  const width = Math.max(0, Math.min(100, value));
  return (
    <span
      className={cn(
        "items-center gap-2",
        wide ? "flex w-full" : "inline-flex justify-end",
      )}
    >
      <span
        className={cn("h-1.5 overflow-hidden rounded-full bg-ink-800", wide ? "flex-1" : "w-12")}
        aria-hidden
      >
        <span
          className="block h-full rounded-full bg-accent-500"
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-slate-700">
        {formatPercent(value)}
      </span>
    </span>
  );
}

function Cell({
  column,
  value,
  link,
}: {
  column: ColumnView;
  value: string | number | null;
  link?: string;
}) {
  if (column.key === "winRate") return <WinRateBar value={asNumber(value)} />;
  if (column.meta.kind === "stage") {
    const status = asText(value);
    if (!status) return <>—</>;
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", stageDot(status))} aria-hidden />
        {stageLabel(status)}
      </span>
    );
  }
  if (column.meta.kind === "enquiry" && link) {
    return (
      <Link
        to="/app/enquiries/$enquiryId"
        params={{ enquiryId: link }}
        className="font-medium text-slate-900 underline decoration-ink-700 underline-offset-2 transition-colors hover:decoration-accent-500"
      >
        {formatCell(column.key, value)}
      </Link>
    );
  }
  return (
    <span className={cn(column.meta.numeric && "tabular-nums")}>
      {formatCell(column.key, value)}
    </span>
  );
}

function VendorCards({ rows }: { rows: Report["rows"] }) {
  return (
    <div className="md:hidden">
      {rows.map((row, index) => {
        const value = asNumber(row.winRate);
        return (
          <article
            key={`${asText(row.vendor)}-${index}`}
            className="border-t border-ink-800 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-slate-900">
                {formatCell("vendor", row.vendor ?? null)}
              </p>
              <span className="text-sm font-semibold tabular-nums text-slate-900">
                {formatPercent(value)}
              </span>
            </div>
            <div className="mt-1.5">
              <WinRateBar value={value} wide />
            </div>
            <dl className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[12px]">
              {VENDOR_CARD_FIELDS.map((field) => (
                <div key={field.key}>
                  <dt className="text-slate-500">{field.label}</dt>
                  <dd className="tabular-nums text-slate-700">
                    {formatNumber(asNumber(row[field.key] ?? null))}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        );
      })}
    </div>
  );
}

interface DetailTableProps {
  report: Report;
  rows: Report["rows"];
  pageRows: Report["rows"];
  columns: ColumnView[];
  sort: SortState | null;
  query: string;
  totals: ReportTotals | null;
  page: number;
  pageSize: number;
  totalPages: number;
  regionFiltered: boolean;
  enquiryLinks: Map<string, string>;
  onSort: (key: string, numeric: boolean) => void;
  onQuery: (value: string) => void;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  onClear: () => void;
  onAllTime: () => void;
}

function DetailTable({
  report,
  rows,
  pageRows,
  columns,
  sort,
  query,
  totals,
  page,
  pageSize,
  totalPages,
  regionFiltered,
  enquiryLinks,
  onSort,
  onQuery,
  onPage,
  onPageSize,
  onClear,
  onAllTime,
}: DetailTableProps) {
  const countDescription =
    rows.length === report.rows.length
      ? `${formatNumber(rows.length)} rows`
      : `${formatNumber(rows.length)} of ${formatNumber(report.rows.length)} rows`;

  return (
    <Panel
      className="mt-4"
      title={<span className="text-base font-semibold">{ROW_LABELS[report.view]}</span>}
      description={countDescription}
      bodyClassName=""
      actions={
        <div className="relative print:hidden">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <input
            id="report-search"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search rows"
            aria-label="Search report rows"
            className="field-input w-44 py-1.5 pl-8 pr-8 text-[13px] sm:w-56"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-500 hover:text-slate-900"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      }
    >
      {report.rows.length === 0 ? (
        <EmptyState
          icon={<BarChart3 className="size-4" aria-hidden />}
          title="No rows in this period"
          description="Nothing was recorded between these dates. Widen the period or look at all time."
          action={
            <button type="button" className="btn-secondary" onClick={onAllTime}>
              Show all time
            </button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Search className="size-4" aria-hidden />}
          title="No rows match these filters"
          description="Try a different category, region or search term."
          action={
            <button type="button" className="btn-secondary" onClick={onClear}>
              Clear filters
            </button>
          }
        />
      ) : (
        <>
          <div
            className={cn(
              "report-table max-h-[70vh] overflow-auto",
              report.view === "vendor" && "hidden md:block",
            )}
          >
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead className="border-b border-slate-200 bg-ink-900">
                <tr>
                  {columns.map((column, index) => {
                    const active = sort?.key === column.key;
                    return (
                      <TH
                        key={column.key}
                        align={column.meta.align}
                        ariaSort={
                          active
                            ? sort?.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        className={cn(
                          "sticky top-0 z-20 bg-ink-900 text-[12px]",
                          index === 0 && "left-0 z-30 border-r border-ink-800",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onSort(column.key, column.meta.numeric)}
                          className="inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                        >
                          <span>{column.label}</span>
                          {active ? (
                            sort?.direction === "asc" ? (
                              <ArrowUp className="size-3" aria-hidden />
                            ) : (
                              <ArrowDown className="size-3" aria-hidden />
                            )
                          ) : (
                            <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      </TH>
                    );
                  })}
                </tr>
              </thead>
              <TBody>
                {pageRows.map((row, rowIndex) => (
                  <TR key={`${report.view}-${page}-${rowIndex}`} className="group">
                    {columns.map((column, index) => (
                      <TD
                        key={column.key}
                        align={column.meta.align}
                        className={cn(
                          "h-11 whitespace-nowrap py-2",
                          index === 0 &&
                            "sticky left-0 z-10 border-r border-ink-800 bg-ink-850 group-hover:bg-ink-800",
                        )}
                      >
                        <Cell
                          column={column}
                          value={row[column.key] ?? null}
                          link={
                            column.key === "enquiryNo"
                              ? enquiryLinks.get(asText(row.enquiryNo))
                              : undefined
                          }
                        />
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
              {totals ? (
                <tfoot className="border-t border-slate-200 bg-ink-900/70">
                  <tr>
                    {columns.map((column, index) => {
                      const value = totals.values[column.key];
                      return (
                        <TD
                          key={column.key}
                          align={column.meta.align}
                          className={cn(
                            "h-11 whitespace-nowrap py-2 font-medium text-slate-900",
                            index === 0 && "sticky left-0 border-r border-ink-800 bg-ink-900",
                          )}
                        >
                          {index === 0
                            ? `${totals.label} · ${formatNumber(rows.length)} rows`
                            : value === undefined
                              ? ""
                              : column.key === "winRate"
                                ? formatPercent(value)
                                : formatCell(column.key, value)}
                        </TD>
                      );
                    })}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>

          {report.view === "vendor" ? <VendorCards rows={pageRows} /> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 px-4 py-3 print:hidden">
            <p className="text-[12px] text-slate-500">
              Showing {formatNumber(pageRows.length)} of {formatNumber(rows.length)} rows · Export
              includes all rows for this report
              {regionFiltered ? " · Region is not applied to the export" : ""}
            </p>
            <div className="flex items-center gap-2 print:hidden">
              <label htmlFor="report-page-size" className="text-[12px] text-slate-500">
                Rows
              </label>
              <select
                id="report-page-size"
                value={pageSize}
                onChange={(event) => onPageSize(Number(event.target.value))}
                className="field-input w-auto py-1 text-[13px]"
              >
                {[25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onPage(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
                className="inline-flex size-8 items-center justify-center rounded-md border border-ink-800 bg-ink-850 text-slate-400 transition-colors hover:text-slate-900 disabled:opacity-40"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="text-[12px] tabular-nums text-slate-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => onPage(page + 1)}
                disabled={page >= totalPages}
                aria-label="Next page"
                className="inline-flex size-8 items-center justify-center rounded-md border border-ink-800 bg-ink-850 text-slate-400 transition-colors hover:text-slate-900 disabled:opacity-40"
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function ReportSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true" aria-label="Loading report">
      <div className="card h-24 animate-pulse" />
      <div className="grid grid-cols-2 gap-3 min-[1000px]:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="card h-[124px] animate-pulse" />
        ))}
      </div>
      <div className="card h-[320px] animate-pulse" />
      <div className="card h-[220px] animate-pulse" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function ReportsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;

  const state = parseReportSearch(routeSearch);
  const range = resolvePeriod(state.period, { from: state.from, to: state.to });
  const previous = previousRange(range);

  // A category filter cannot reach the enquiry rows (the server does not carry a
  // category onto an enquiry), so it is only offered where it can apply.
  const activeCategory = state.view === "enquiry" ? "" : state.category;
  const regionSupported = state.view === "enquiry";

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Back/forward or a pasted link can change the view under the local table UI.
  useEffect(() => {
    setSort(null);
    setQuery("");
    setPage(1);
  }, [state.view]);

  // Keep the address bar honest: a bare /app/reports becomes the full default,
  // and a stale shared link is rewritten to the period it now resolves to. The
  // report itself always renders from the URL, so sharing and refresh work.
  useEffect(() => {
    const desired = reportSearchParams(state, range);
    // The two filters that do not apply to every view never linger in a link.
    if (state.view === "enquiry") delete desired.category;
    else delete desired.region;
    const keys = ["view", "period", "from", "to", "category", "region"] as const;
    const same = keys.every(
      (key) => (routeSearch[key] ?? "") === (desired[key] ?? ""),
    );
    if (same) return;
    void navigate({
      to: "/app/reports",
      search: desired,
      replace: true,
    });
  }, [
    routeSearch,
    state.view,
    state.period,
    state.from,
    state.to,
    state.category,
    state.region,
    range.from,
    range.to,
    navigate,
  ]);

  const reportFilters: ReportFilters = {
    view: state.view,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(activeCategory ? { craneCategory: activeCategory } : {}),
  };

  const reportQuery = useQuery({
    queryKey: ["report", state.view, range.from, range.to, activeCategory, "current"],
    queryFn: () => loadReport(reportFilters),
  });

  const previousQuery = useQuery({
    queryKey: [
      "report",
      state.view,
      previous?.from ?? null,
      previous?.to ?? null,
      activeCategory,
      "previous",
    ],
    queryFn: () => {
      if (!previous?.from || !previous.to) throw new Error("No previous period");
      return loadReport({ ...reportFilters, from: previous.from, to: previous.to });
    },
    enabled: previous !== null,
  });

  const report = reportQuery.data;
  const comparison =
    previousQuery.data && hasReportData(previousQuery.data) ? previousQuery.data : null;

  const enquiryLinkQuery = useQuery({
    queryKey: ["report", "enquiry-links"],
    queryFn: () => listEnquiries(),
    enabled: state.view === "enquiry",
    staleTime: 60_000,
  });

  const enquiryLinks = useMemo(() => {
    const map = new Map<string, string>();
    for (const enquiry of enquiryLinkQuery.data?.enquiries ?? []) {
      map.set(enquiry.enquiryNo, enquiry.id);
    }
    return map;
  }, [enquiryLinkQuery.data]);

  function apply(next: ReportSearchState) {
    const normalised =
      next.view === "enquiry"
        ? next.category
          ? { ...next, category: "" }
          : next
        : { ...next, region: "" };
    const nextRange = resolvePeriod(normalised.period, {
      from: normalised.from,
      to: normalised.to,
    });
    void navigate({
      to: "/app/reports",
      search: reportSearchParams(normalised, nextRange),
      replace: true,
    });
  }

  function setView(nextView: ReportView) {
    setSort(null);
    setQuery("");
    setPage(1);
    apply({ ...state, view: nextView });
  }

  function setPeriod(nextPeriod: PeriodPreset) {
    if (nextPeriod === "custom") {
      const from = range.from ?? isoDay(new Date());
      const to = range.to ?? from;
      apply({ ...state, period: "custom", from, to });
    } else {
      apply({ ...state, period: nextPeriod, from: null, to: null });
    }
    setPage(1);
  }

  function setCustomDate(which: "from" | "to", value: string) {
    if (!value) return;
    let from = range.from;
    let to = range.to;
    if (which === "from") from = value;
    else to = value;
    if (from && to && from > to) {
      if (which === "from") to = from;
      else from = to;
    }
    apply({ ...state, period: "custom", from, to });
    setPage(1);
  }

  function setCategory(value: string) {
    apply({ ...state, category: value });
    setPage(1);
  }

  function setRegion(value: string) {
    apply({ ...state, region: value });
    setPage(1);
  }

  function showAllTime() {
    setSort(null);
    setQuery("");
    setPage(1);
    apply({
      ...state,
      period: "all-time",
      from: null,
      to: null,
      category: "",
      region: "",
    });
  }

  function clearFilters() {
    setQuery("");
    setSort(null);
    setPage(1);
    apply({ ...state, category: "", region: "" });
  }

  function refresh() {
    setNotice(null);
    void queryClient.invalidateQueries({ queryKey: ["report"] });
  }

  async function copyLink() {
    setNotice(null);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("Link copied to the clipboard.");
    } catch {
      setNotice("Could not copy the link. Copy it from the address bar.");
    }
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = VIEWS.indexOf(state.view);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % VIEWS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextView = VIEWS[nextIndex];
    if (!nextView) return;
    setView(nextView);
    document.getElementById(`report-tab-${nextView}`)?.focus();
  }

  function toggleSort(key: string, numeric: boolean) {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: numeric ? "desc" : "asc" },
    );
    setPage(1);
  }

  const exportMutation = useMutation({
    mutationFn: () => downloadReportCsv(reportFilters),
    onMutate: () => {
      setExportError(null);
      setNotice(null);
    },
    onSuccess: () => setNotice("CSV downloaded."),
    onError: (error) =>
      setExportError(
        error instanceof Error ? error.message : "The report could not be downloaded.",
      ),
  });

  const columns = report?.columns ?? [];

  const columnViews = useMemo<ColumnView[]>(
    () =>
      columns.map((column) => ({
        ...column,
        meta: columnMeta(column.key, report?.rows ?? []),
      })),
    [columns, report?.rows],
  );

  const tableRows = useMemo(() => {
    if (!report) return [];
    return filterByRegion(report.rows, regionSupported ? state.region : "");
  }, [report, regionSupported, state.region]);

  const searched = useMemo(
    () => searchReportRows(tableRows, columns, query),
    [tableRows, columns, query],
  );
  const sorted = useMemo(() => sortReportRows(searched, sort), [searched, sort]);

  const totals = report ? reportTotals(report.view, sorted) : null;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const insights = useMemo(
    () =>
      report
        ? buildInsights(report, comparison, { suppressRegion: Boolean(state.region) })
        : [],
    [report, comparison, state.region],
  );

  const categoryOptions = useMemo(() => {
    const options = (report?.options.craneCategories ?? []).map((category) => ({
      value: category.code,
      label: category.name,
    }));
    if (activeCategory && !options.some((option) => option.value === activeCategory)) {
      options.push({ value: activeCategory, label: activeCategory });
    }
    return options;
  }, [report?.options.craneCategories, activeCategory]);

  const regionOptions = useMemo(() => {
    const values = [...(report?.options.regions ?? [])];
    if (state.region && !values.includes(state.region)) values.push(state.region);
    return values.map((value) => ({ value, label: formatCell("region", value) }));
  }, [report?.options.regions, state.region]);

  const filterSummary = [
    formatRange(range.from, range.to),
    activeCategory
      ? (categoryOptions.find((option) => option.value === activeCategory)?.label ??
        activeCategory)
      : "All categories",
    state.region ? formatCell("region", state.region) : "All regions",
  ].join(" · ");

  const comparisonText = previous
    ? comparison
      ? `Compared with ${formatRange(previous.from, previous.to)}`
      : previousQuery.isFetching
        ? "Loading comparison…"
        : previousQuery.isError
          ? "Comparison unavailable"
          : `No data in ${formatRange(previous.from, previous.to)}`
    : "All time · no comparison";

  const ownerScoped = report?.filters.ownerScoped ?? user?.role === "sales_user";
  const kpis = report ? kpiSpecs(report.view) : [];

  const menuItems = [
    {
      label: "Print",
      icon: <Printer className="size-4" aria-hidden />,
      onSelect: () => window.print(),
    },
    {
      label: "Copy link",
      icon: <Link2 className="size-4" aria-hidden />,
      onSelect: () => void copyLink(),
    },
  ];

  return (
    <div className="print-sheet mx-auto w-full max-w-[1400px] px-4 pb-16 pt-6 sm:px-8">
      <PageHeader
        title="Reports"
        titleClassName="text-[28px] leading-8"
        description={DESCRIPTIONS[state.view]}
        meta={
          ownerScoped ? <Badge tone="neutral">Your enquiries only</Badge> : undefined
        }
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
              aria-busy={exportMutation.isPending}
            >
              {exportMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              {exportMutation.isPending ? "Preparing download…" : "Export CSV"}
            </button>
            <Menu label="More report actions" items={menuItems} />
          </div>
        }
      />

      {exportError ? (
        <div className="mt-4 print:hidden">
          <Alert title="The CSV could not be prepared.">{exportError}</Alert>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-[12px] text-slate-500 print:hidden">
          {notice}
        </p>
      ) : null}

      <section className="card mt-4 px-4 py-3 print:hidden" aria-label="Report filters">
        <div className="flex items-center justify-between gap-3 min-[1000px]:hidden">
          <p className="min-w-0 text-[12px] leading-4 text-slate-500">{filterSummary}</p>
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="report-filter-fields"
            className="btn-secondary shrink-0 px-3 py-1.5 text-[13px]"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Filters
          </button>
        </div>

        <div
          id="report-filter-fields"
          className={cn(
            "mt-3 flex flex-wrap items-end gap-x-4 gap-y-3",
            !filtersOpen && "hidden min-[1000px]:flex",
          )}
        >
          <div className="min-w-[150px]">
            <label htmlFor="report-period" className="field-label text-[13px]">
              Period
            </label>
            <select
              id="report-period"
              value={state.period}
              onChange={(event) => setPeriod(event.target.value as PeriodPreset)}
              className="field-input py-2"
            >
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {state.period === "custom" ? (
            <>
              <div className="min-w-[150px]">
                <label htmlFor="report-from" className="field-label text-[13px]">
                  From
                </label>
                <input
                  id="report-from"
                  type="date"
                  value={range.from ?? ""}
                  onChange={(event) => setCustomDate("from", event.target.value)}
                  className="field-input py-2"
                />
              </div>
              <div className="min-w-[150px]">
                <label htmlFor="report-to" className="field-label text-[13px]">
                  To
                </label>
                <input
                  id="report-to"
                  type="date"
                  value={range.to ?? ""}
                  onChange={(event) => setCustomDate("to", event.target.value)}
                  className="field-input py-2"
                />
              </div>
            </>
          ) : null}

          <div className="min-w-[170px]">
            <label htmlFor="report-category" className="field-label text-[13px]">
              Crane category
            </label>
            <Select
              id="report-category"
              value={activeCategory}
              onChange={setCategory}
              options={categoryOptions}
              placeholder="All categories"
              disabled={state.view === "enquiry"}
              ariaLabel="Crane category"
            />
          </div>

          <div className="min-w-[150px]">
            <label htmlFor="report-region" className="field-label text-[13px]">
              Region
            </label>
            <Select
              id="report-region"
              value={state.region}
              onChange={setRegion}
              options={regionOptions}
              placeholder="All regions"
              disabled={!regionSupported}
              ariaLabel="Region"
            />
          </div>

          <div className="ml-auto flex items-center gap-2 pb-0.5">
            <span className="text-[12px] text-slate-500">
              {report
                ? `Generated ${formatTimestamp(report.generatedAt)}`
                : reportQuery.isError
                  ? "Report unavailable"
                  : "Loading report…"}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={reportQuery.isFetching}
              aria-label="Refresh report"
              className="inline-flex size-8 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-400 transition-colors hover:text-slate-900 disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-4", reportQuery.isFetching && "animate-spin")}
                aria-hidden
              />
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500">
          <span className="font-medium text-slate-600">{formatRange(range.from, range.to)}</span>
          <span aria-hidden>·</span>
          <span>{comparisonText}</span>
          {state.region && regionSupported ? (
            <span className="text-amber-600">
              Region filters the table only; summary figures and the CSV cover all regions.
            </span>
          ) : null}
          {!regionSupported ? (
            <span>Region applies to the Enquiries view only.</span>
          ) : state.view === "enquiry" ? (
            <span>Crane category applies to the other three views.</span>
          ) : null}
        </div>
      </section>

      {reportQuery.isError && !report ? (
        <Panel
          className="mt-4"
          title="Report unavailable"
          bodyClassName="p-4"
        >
          <Alert title="The report could not be loaded.">
            {reportQuery.error instanceof Error
              ? reportQuery.error.message
              : "Please try again."}
          </Alert>
          <button type="button" onClick={refresh} className="btn-secondary mt-3">
            <RefreshCw className="size-4" aria-hidden />
            Retry
          </button>
        </Panel>
      ) : reportQuery.isPending || !report ? (
        <ReportSkeleton />
      ) : (
        <>
          {insights.length > 0 ? (
            <section
              className="card mt-4 px-4 py-3.5 print:break-inside-avoid"
              aria-labelledby="report-insights-title"
            >
              <h2
                id="report-insights-title"
                className="text-base font-semibold text-slate-900"
              >
                What the numbers say
              </h2>
              <ul className="mt-2 space-y-1.5">
                {insights.map((sentence, index) => (
                  <li
                    key={`${index}-${sentence}`}
                    className="flex gap-2 text-sm leading-5 text-slate-700"
                  >
                    <span
                      className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent-500"
                      aria-hidden
                    />
                    <span>{sentence}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="mt-5 border-b border-ink-800 print:hidden">
            <div
              role="tablist"
              aria-label="Report view"
              className="flex flex-wrap gap-1"
              onKeyDown={onTabKeyDown}
            >
              {VIEWS.map((view) => {
                const active = view === state.view;
                return (
                  <button
                    key={view}
                    id={`report-tab-${view}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="report-tabpanel"
                    tabIndex={active ? 0 : -1}
                    onClick={() => setView(view)}
                    className={cn(
                      "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "border-accent-500 text-slate-900"
                        : "border-transparent text-slate-500 hover:text-slate-800",
                    )}
                  >
                    {REPORT_VIEW_LABELS[view]}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            id="report-tabpanel"
            role="tabpanel"
            aria-labelledby={`report-tab-${state.view}`}
          >
            <div
              className={cn(
                "mt-4 grid grid-cols-2 gap-3",
                KPI_COLUMNS[kpis.length] ?? "min-[1000px]:grid-cols-4",
              )}
              aria-label={`${REPORT_VIEW_LABELS[state.view]} summary`}
            >
              {kpis.map((spec) => (
                <KpiTile
                  key={spec.id}
                  spec={spec}
                  report={report}
                  previous={comparison}
                />
              ))}
            </div>

            <ReportChart report={report} range={range} />

            <DetailTable
              report={report}
              rows={sorted}
              pageRows={pageRows}
              columns={columnViews}
              sort={sort}
              query={query}
              totals={totals}
              page={safePage}
              pageSize={pageSize}
              totalPages={totalPages}
              regionFiltered={Boolean(state.region) && regionSupported}
              enquiryLinks={enquiryLinks}
              onSort={toggleSort}
              onQuery={(value) => {
                setQuery(value);
                setPage(1);
              }}
              onPage={(nextPage) => setPage(Math.min(Math.max(1, nextPage), totalPages))}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              onClear={clearFilters}
              onAllTime={showAllTime}
            />
          </div>
        </>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { formatDistance, type ReceivedQuotation } from "@/lib/rfqs";

const money = (value: number) => `₹${value.toLocaleString("en-IN")}`;
const gstWord = (quotation: ReceivedQuotation) =>
  quotation.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST";

/** A column of the comparison grid: one commercial term across every vendor. */
interface CompareColumn {
  key: string;
  label: string;
  width: string;
  cell: (quotation: ReceivedQuotation) => ReactNode;
  /** Lower is better. Return null where the quotation has no figure. */
  best?: (quotation: ReceivedQuotation) => number | null;
}

/** Free-text cells only get a column when at least one quote has something to say. */
function NoteBlock({ quotation }: { quotation: ReceivedQuotation }) {
  const deviation = !quotation.acceptsCommercialTerms
    ? quotation.deviationText?.trim() || "Deviation stated"
    : null;
  const remarks = quotation.remarks?.trim();
  const calculation = quotation.calculationNote?.trim();
  if (!deviation && !remarks && !calculation && quotation.warnings.length === 0) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <div className="space-y-1.5 text-[14px] whitespace-pre-wrap">
      {deviation ? <p className="font-medium text-amber-600">{deviation}</p> : null}
      {remarks ? <p className="text-slate-900">{remarks}</p> : null}
      {calculation ? <p className="text-slate-500">{calculation}</p> : null}
      {quotation.warnings.map((warning) => (
        <p
          key={warning.code}
          className="rounded-md bg-amber-500/10 px-2 py-1 text-[13px] text-amber-600"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}

/**
 * Quote comparison: one row per vendor, one column per commercial term. The
 * vendor and action columns stay pinned while the terms scroll horizontally.
 *
 * Actions stay with the caller (`renderActions`) — counter and award carry
 * their own dialogs and permissions, which this table must not decide.
 */
export function QuoteComparisonTable({
  quotations,
  lowestId,
  sourceLabel,
  renderActions,
  muted = false,
}: {
  quotations: ReceivedQuotation[];
  /** The cheapest current quotation, when there is more than one to compare. */
  lowestId: string | null;
  sourceLabel: (quotation: ReceivedQuotation) => string;
  renderActions: (quotation: ReceivedQuotation) => ReactNode;
  muted?: boolean;
}) {
  const lowestTotal = Math.min(...quotations.map((q) => q.totalQuotedValue));
  const mixedTax = new Set(quotations.map((q) => q.taxBasis)).size > 1;
  const hasNotes = quotations.some(
    (q) =>
      !q.acceptsCommercialTerms ||
      q.remarks?.trim() ||
      q.calculationNote?.trim() ||
      q.warnings.length > 0,
  );

  const columns: CompareColumn[] = [
    {
      key: "total",
      label: "Total quoted",
      width: "min-w-[180px]",
      cell: (q) => {
        const isLowest = Boolean(lowestId) && q.quotationId === lowestId;
        const above = q.totalQuotedValue - lowestTotal;
        return (
          <>
            <span
              className={cn(
                "text-[24px] leading-7 font-semibold",
                isLowest ? "text-emerald-600" : "text-slate-900",
              )}
            >
              {money(q.totalQuotedValue)}
            </span>
            <span className="block text-[13px] text-slate-500">
              {gstWord(q)}
              {lowestId && above > 0 ? ` · +${money(above)} vs lowest` : ""}
            </span>
          </>
        );
      },
    },
    {
      key: "rate",
      label: "Rate",
      width: "min-w-[130px]",
      cell: (q) => (
        <>
          <span className="font-medium text-slate-900">{money(q.rentalRate)}</span>
          <span className="block text-[13px] text-slate-500">
            {q.rateBasis.replaceAll("_", " ").toLowerCase()}
          </span>
        </>
      ),
    },
    {
      key: "gst",
      label: "GST",
      width: "min-w-[140px]",
      cell: (q) => (q.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive of GST" : "Exclusive of GST"),
    },
    {
      key: "mobilisation",
      label: "Mobilisation",
      width: "min-w-[130px]",
      cell: (q) => money(q.mobilisationCharges),
      best: (q) => q.mobilisationCharges,
    },
    {
      key: "demobilisation",
      label: "Demobilisation",
      width: "min-w-[140px]",
      cell: (q) => money(q.demobilisationCharges),
      best: (q) => q.demobilisationCharges,
    },
    {
      key: "distance",
      label: "Distance to site",
      width: "min-w-[150px]",
      cell: (q) => formatDistance(q.distanceToSiteKm, q.distanceApproximate),
      best: (q) => q.distanceToSiteKm,
    },
    { key: "validity", label: "Valid until", width: "min-w-[130px]", cell: (q) => formatDate(q.validityDate) },
    {
      key: "availability",
      label: "Availability",
      width: "min-w-[140px]",
      cell: (q) =>
        q.availabilityConfirmed
          ? q.availableFrom
            ? `From ${formatDate(q.availableFrom)}`
            : "Confirmed"
          : "Not confirmed",
    },
    {
      key: "terms",
      label: "Commercial terms",
      width: "min-w-[150px]",
      cell: (q) =>
        q.acceptsCommercialTerms ? (
          "Accepted"
        ) : (
          <span className="font-medium text-amber-600">Deviation stated</span>
        ),
    },
  ];

  if (hasNotes) {
    columns.push({
      key: "notes",
      label: "Remarks & notes",
      width: "min-w-[280px]",
      cell: (q) => <NoteBlock quotation={q} />,
    });
  }

  columns.push(
    {
      key: "status",
      label: "Status",
      width: "min-w-[120px]",
      cell: (q) => <StatusBadge status={q.status} />,
    },
  );

  /** The ids that win a column; empty when all figures are equal. */
  const winners = (column: CompareColumn): Set<string> => {
    if (!column.best || quotations.length < 2) return new Set();
    const figures = quotations
      .map((q) => ({ id: q.quotationId, value: column.best!(q) }))
      .filter((entry): entry is { id: string; value: number } => entry.value !== null);
    if (figures.length < 2) return new Set();
    const min = Math.min(...figures.map((entry) => entry.value));
    if (figures.every((entry) => entry.value === min)) return new Set();
    return new Set(figures.filter((entry) => entry.value === min).map((entry) => entry.id));
  };

  const headCell =
    "border-b border-ink-800 bg-ink-850 px-4 py-3 text-left align-bottom text-[12px] font-medium tracking-[0.08em] whitespace-nowrap text-slate-500 uppercase";
  const cell = "px-4 py-3 align-top text-[15px] text-slate-700 tabular-nums";
  const pinnedVendor =
    "sticky left-0 z-10 w-[240px] min-w-[240px] border-r border-ink-800 bg-ink-850 px-4 py-3 text-left align-top";
  const pinnedAction = "sticky right-0 z-10 min-w-[240px] border-l border-ink-800 bg-ink-850 px-4 py-3";

  return (
    <div className="space-y-2">
      {mixedTax ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[14px] text-amber-600">
          These quotes are on different GST bases. Compare like for like before choosing.
        </p>
      ) : null}

      <div className={cn("card overflow-x-auto", muted && "opacity-70")}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={cn(headCell, "sticky left-0 z-20 w-[240px] min-w-[240px] border-r border-ink-800")}>
                Vendor
              </th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cn(headCell, column.width)}>
                  {column.label}
                </th>
              ))}
              <th
                scope="col"
                className={cn(headCell, "sticky right-0 z-20 min-w-[240px] border-l border-ink-800 text-right")}
              >
                {muted ? "History" : "Action"}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {quotations.map((quotation) => {
              const isLowest = quotation.quotationId === lowestId;
              return (
                <tr key={quotation.quotationId} className="hover:bg-ink-900/40">
                  <th scope="row" className={cn(pinnedVendor, isLowest && "border-l-2 border-l-emerald-600")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[16px] font-semibold text-slate-900">
                        {quotation.vendorName}
                      </span>
                      {isLowest ? <Badge tone="emerald">Lowest total</Badge> : null}
                      {!quotation.isLatest ? <Badge tone="neutral">Superseded</Badge> : null}
                    </div>
                    <p className="mt-1 text-[13px] font-normal text-slate-500">
                      {quotation.craneDescription}
                    </p>
                    <p className="text-[13px] font-normal text-slate-500">
                      {sourceLabel(quotation)} · v{quotation.version} · {formatDate(quotation.submittedAt)}
                    </p>
                  </th>
                  {columns.map((column) => {
                    const won = winners(column).has(quotation.quotationId);
                    return (
                      <td
                        key={column.key}
                        className={cn(cell, column.width, won && "font-semibold text-emerald-600")}
                      >
                        {column.cell(quotation)}
                        {won ? (
                          <span className="mt-0.5 block text-[11px] font-medium tracking-[0.06em] text-emerald-600 uppercase">
                            Best
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                  <td className={pinnedAction}>
                    {muted ? (
                      <p className="text-right text-[13px] text-slate-500">
                        History only — not actionable
                      </p>
                    ) : (
                      <div className="flex flex-wrap justify-end gap-2">
                        {renderActions(quotation)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { formatDistance, type ReceivedQuotation } from "@/lib/rfqs";

const money = (value: number) => `₹${value.toLocaleString("en-IN")}`;
const gstWord = (quotation: ReceivedQuotation) =>
  quotation.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST";

/** One parameter of the comparison; `best` picks the figure that wins the row. */
interface CompareRow {
  label: string;
  cell: (quotation: ReceivedQuotation) => ReactNode;
  /** Lower is better. Return null where the quotation has no figure. */
  best?: (quotation: ReceivedQuotation) => number | null;
}

const ROWS: CompareRow[] = [
  {
    label: "Rate",
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
    label: "GST",
    cell: (q) => (q.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive of GST" : "Exclusive of GST"),
  },
  {
    label: "Mobilisation",
    cell: (q) => money(q.mobilisationCharges),
    best: (q) => q.mobilisationCharges,
  },
  {
    label: "Demobilisation",
    cell: (q) => money(q.demobilisationCharges),
    best: (q) => q.demobilisationCharges,
  },
  {
    label: "Distance to site",
    cell: (q) => formatDistance(q.distanceToSiteKm, q.distanceApproximate),
    best: (q) => q.distanceToSiteKm,
  },
  { label: "Valid until", cell: (q) => formatDate(q.validityDate) },
  {
    label: "Availability",
    cell: (q) =>
      q.availabilityConfirmed
        ? q.availableFrom
          ? `From ${formatDate(q.availableFrom)}`
          : "Confirmed"
        : "Not confirmed",
  },
  {
    label: "Commercial terms",
    cell: (q) =>
      q.acceptsCommercialTerms ? (
        "Accepted"
      ) : (
        <span className="font-medium text-amber-600">Deviation stated</span>
      ),
  },
];

/** The rows that carry free text only appear when at least one quote has some. */
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
 * Quote comparison: one column per quotation, one row per commercial term, so
 * the same figure reads straight across. The lowest figure in a row is marked
 * (total, mobilisation, demobilisation, distance) when the quotes differ.
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
      !q.acceptsCommercialTerms || q.remarks?.trim() || q.calculationNote?.trim() || q.warnings.length > 0,
  );

  // The set of quotation ids that win a row; empty when all figures are equal.
  const winners = (row: CompareRow): Set<string> => {
    if (!row.best || quotations.length < 2) return new Set();
    const figures = quotations
      .map((q) => ({ id: q.quotationId, value: row.best!(q) }))
      .filter((entry): entry is { id: string; value: number } => entry.value !== null);
    if (figures.length < 2) return new Set();
    const min = Math.min(...figures.map((entry) => entry.value));
    if (figures.every((entry) => entry.value === min)) return new Set();
    return new Set(figures.filter((entry) => entry.value === min).map((entry) => entry.id));
  };

  const labelCell =
    "sticky left-0 z-10 w-[150px] min-w-[150px] bg-ink-850 px-4 py-3 text-left align-top text-[12px] font-medium tracking-[0.08em] whitespace-nowrap text-slate-500 uppercase";
  const valueCell = "min-w-[230px] px-4 py-3 align-top text-[15px] text-slate-700 tabular-nums";

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
            <tr className="border-b border-ink-800">
              <th scope="col" className={cn(labelCell, "py-4")}>
                Vendor
              </th>
              {quotations.map((quotation) => (
                <th
                  key={quotation.quotationId}
                  scope="col"
                  className="min-w-[230px] px-4 py-4 text-left align-top font-normal"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[16px] font-semibold text-slate-900">
                      {quotation.vendorName}
                    </span>
                    {quotation.quotationId === lowestId ? (
                      <Badge tone="emerald">Lowest total</Badge>
                    ) : null}
                    {!quotation.isLatest ? <Badge tone="neutral">Superseded</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-[13px] font-normal text-slate-500">
                    {quotation.craneDescription}
                  </p>
                  <p className="text-[13px] font-normal text-slate-500">
                    {sourceLabel(quotation)} · v{quotation.version} · {formatDate(quotation.submittedAt)}
                  </p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            <tr className="bg-ink-900/60">
              <th scope="row" className={cn(labelCell, "bg-ink-900")}>
                Total quoted
              </th>
              {quotations.map((quotation) => {
                const isLowest =
                  quotations.length > 1 && quotation.totalQuotedValue === lowestTotal &&
                  quotations.some((q) => q.totalQuotedValue !== lowestTotal);
                const above = quotation.totalQuotedValue - lowestTotal;
                return (
                  <td key={quotation.quotationId} className={valueCell}>
                    <span
                      className={cn(
                        "text-[24px] leading-7 font-semibold",
                        isLowest ? "text-emerald-600" : "text-slate-900",
                      )}
                    >
                      {money(quotation.totalQuotedValue)}
                    </span>
                    <span className="block text-[13px] text-slate-500">
                      {gstWord(quotation)}
                      {quotations.length > 1 && above > 0 ? ` · +${money(above)} vs lowest` : ""}
                    </span>
                  </td>
                );
              })}
            </tr>

            {ROWS.map((row) => {
              const won = winners(row);
              return (
                <tr key={row.label}>
                  <th scope="row" className={labelCell}>
                    {row.label}
                  </th>
                  {quotations.map((quotation) => (
                    <td
                      key={quotation.quotationId}
                      className={cn(valueCell, won.has(quotation.quotationId) && "font-semibold text-emerald-600")}
                    >
                      {row.cell(quotation)}
                    </td>
                  ))}
                </tr>
              );
            })}

            {hasNotes ? (
              <tr>
                <th scope="row" className={labelCell}>
                  Remarks &amp; notes
                </th>
                {quotations.map((quotation) => (
                  <td key={quotation.quotationId} className={valueCell}>
                    <NoteBlock quotation={quotation} />
                  </td>
                ))}
              </tr>
            ) : null}

            <tr>
              <th scope="row" className={labelCell}>
                Status
              </th>
              {quotations.map((quotation) => (
                <td key={quotation.quotationId} className={valueCell}>
                  <StatusBadge status={quotation.status} />
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className={labelCell}>
                Action
              </th>
              {quotations.map((quotation) => (
                <td key={quotation.quotationId} className={valueCell}>
                  <div className="flex flex-wrap gap-2">{renderActions(quotation)}</div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
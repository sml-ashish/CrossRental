import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { deltaLabel, inr } from "@/lib/negotiation-display";
import type { NegotiationPreview } from "@/lib/negotiations";

/**
 * Live total + advisory warnings for an offer being composed.
 *
 * The total always comes from the server's preview; this component never
 * calculates one. Warnings are advisory data, but a blocking warning must be
 * acknowledged before the offer can be sent (the caller enforces that).
 */
export function OfferPreview({
  preview,
  loading,
  error,
  deltaLabelText,
}: {
  preview: NegotiationPreview | null;
  loading: boolean;
  error?: string | null;
  deltaLabelText?: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-ink-800 bg-ink-850 px-4 py-3 text-sm text-slate-500">
        <Spinner /> Calculating total…
      </div>
    );
  }
  if (error) {
    return <Alert title="Could not preview"> {error}</Alert>;
  }
  if (!preview) {
    return (
      <div className="rounded-xl border border-dashed border-ink-800 px-4 py-3 text-sm text-slate-500">
        Enter the offer terms to see the computed total.
      </div>
    );
  }

  const delta =
    deltaLabelText ??
    deltaLabel(preview.deltaVsVendor ?? preview.deltaVsPrevious);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-ink-900 px-4 py-3">
        <div>
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Computed total
          </p>
          <p className="text-[26px] leading-8 font-semibold text-slate-900 tabular-nums">
            ₹{inr(preview.totalQuotedValue)}
          </p>
        </div>
        {delta ? (
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-[13px] font-medium text-amber-600">
            {delta} vs previous
          </span>
        ) : null}
      </div>
      {preview.calculationNote ? (
        <p className="text-[13px] text-slate-500">{preview.calculationNote}</p>
      ) : null}
      <WarningList warnings={preview.warnings} />
    </div>
  );
}

export function WarningList({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
  if (!warnings.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {warnings.map((warning) => (
        <li
          key={warning.code}
          className="rounded-full bg-amber-500/10 px-3 py-1 text-[13px] text-amber-600"
        >
          {warning.message}
        </li>
      ))}
    </ul>
  );
}

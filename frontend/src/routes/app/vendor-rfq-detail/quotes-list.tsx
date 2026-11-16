import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Undo2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { ReadOnlyValue } from "@/components/ui/form";
import { Panel } from "@/components/ui/page-header";
import { ApiError } from "@/lib/api";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { listCranes } from "@/lib/fleet";
import {
  formatInr,
  listQuotationHistory,
  RATE_BASIS_LABELS,
  reviseQuotation,
  withdrawQuotation,
  type VendorQuotation,
  type VendorRfqDetail,
} from "@/lib/quotations";
import {
  QuoteForm,
  WarningList,
  withoutCrane,
  toInput,
  type FormState,
} from "./quote-panel";

/**
 * The vendor's own quotes on this RFQ, newest version of each crane, with the
 * full trail behind a disclosure. Revise and withdraw stay on the card: those
 * are the two things a vendor comes back to this page to do.
 */
export function QuotesList({
  rfqId,
  rfq,
  quotations,
}: {
  rfqId: string;
  rfq: VendorRfqDetail["rfq"];
  quotations: VendorQuotation[];
}) {
  const [revising, setRevising] = useState<VendorQuotation | null>(null);
  const queryClient = useQueryClient();

  const withdraw = useMutation({
    mutationFn: (quotationId: string) => withdrawQuotation(quotationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
      queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
      queryClient.invalidateQueries({ queryKey: ["quotation-history", rfqId] });
    },
  });

  // Withdrawn versions are listed after the live ones rather than hidden: brief 6.7
  // keeps every version, and a withdrawn quote is the one place the vendor can
  // revive — the backend refuses a fresh quote for a crane that already has one.
  const live = quotations.filter((quotation) => quotation.status !== "WITHDRAWN");
  const withdrawn = quotations.filter((quotation) => quotation.status === "WITHDRAWN");

  const revise = (quotation: VendorQuotation) => {
    setRevising(quotation);
    requestAnimationFrame(() =>
      document.getElementById("revise-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <div className="space-y-5" id="your-quotes">
      <Panel
        title="Your quotes"
        description="The latest version of each crane you quoted. Revising keeps the earlier versions on record."
        actions={
          <span className="text-xs text-slate-500 tabular-nums">
            {live.length} live
            {withdrawn.length > 0 ? ` · ${withdrawn.length} withdrawn` : ""}
          </span>
        }
      >
        <div className="space-y-3">
          {withdraw.error ? <Alert>{(withdraw.error as ApiError).message}</Alert> : null}
          {quotations.length === 0 ? (
            <p className="text-sm text-slate-500">You have not quoted this RFQ yet.</p>
          ) : null}
          {[...live, ...withdrawn].map((quotation) => (
            <QuotationCard
              key={quotation.quotationId}
              quotation={quotation}
              busy={withdraw.isPending}
              onRevise={quotation.editable ? () => revise(quotation) : undefined}
              onWithdraw={
                quotation.editable && quotation.status !== "WITHDRAWN"
                  ? () => withdraw.mutate(quotation.quotationId)
                  : undefined
              }
            />
          ))}
        </div>
      </Panel>

      {revising ? (
        <div id="revise-panel" className="scroll-mt-24">
          <RevisePanel
            rfq={rfq}
            quotation={revising}
            rfqId={rfqId}
            onDone={() => setRevising(null)}
          />
        </div>
      ) : null}

      <HistoryPanel rfqId={rfqId} />
    </div>
  );
}

function QuotationCard({
  quotation,
  busy,
  onRevise,
  onWithdraw,
}: {
  quotation: VendorQuotation;
  busy: boolean;
  /** Absent when the server says this version can no longer be acted on. */
  onRevise?: () => void;
  onWithdraw?: () => void;
}) {
  return (
    <article className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{quotation.craneLabel}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Version {quotation.version}
            {quotation.isLatest ? " · latest" : ""} · sent {formatDateTime(quotation.submittedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={quotation.status} />
          <span className="text-base font-semibold text-slate-900 tabular-nums">
            {formatInr(quotation.totalQuotedValue)}
          </span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <ReadOnlyValue
          label="Rate"
          value={`${formatInr(quotation.rentalRate)} ${RATE_BASIS_LABELS[quotation.rateBasis].toLowerCase()}`}
        />
        <ReadOnlyValue label="Mobilisation" value={formatInr(quotation.mobilisationCharges)} />
        <ReadOnlyValue label="Demobilisation" value={formatInr(quotation.demobilisationCharges)} />
        <ReadOnlyValue
          label="Tax basis"
          value={
            quotation.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive of GST" : "Exclusive of GST"
          }
        />
        <ReadOnlyValue label="Valid until" value={formatCalendarDate(quotation.validityDate)} />
        <ReadOnlyValue
          label="Distance"
          value={
            quotation.distanceToSiteKm === null
              ? "—"
              : `${quotation.distanceToSiteKm.toFixed(1)} km${
                  // The stored quotation keeps the method, not the flag: a
                  // straight-line figure is the approximation and must be
                  // labelled as one (brief 6.9).
                  quotation.distanceMethod === "straight_line" ? " (approx.)" : ""
                }`
          }
        />
      </dl>

      {quotation.calculationNote ? (
        <p className="mt-3 text-xs text-slate-500">{quotation.calculationNote}</p>
      ) : null}

      <WarningList warnings={quotation.warnings} />

      {quotation.deviationText ? (
        <p className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs text-amber-800">
          <span className="font-medium">Deviation: </span>
          {quotation.deviationText}
        </p>
      ) : null}
      {quotation.remarks ? (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-medium text-slate-500">Remarks: </span>
          {quotation.remarks}
        </p>
      ) : null}

      {onRevise || onWithdraw ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {onRevise ? (
            <button
              type="button"
              className="btn-secondary min-h-10 px-3 py-1.5 text-xs"
              onClick={onRevise}
            >
              {quotation.status === "WITHDRAWN" ? "Quote again" : "Revise"}
            </button>
          ) : null}
          {onWithdraw ? (
            <button
              type="button"
              className="btn-secondary min-h-10 px-3 py-1.5 text-xs text-red-700"
              disabled={busy}
              onClick={onWithdraw}
            >
              <Undo2 className="size-3.5" aria-hidden />
              Withdraw
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function RevisePanel({
  rfq,
  quotation,
  rfqId,
  onDone,
}: {
  rfq: VendorRfqDetail["rfq"];
  quotation: VendorQuotation;
  rfqId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState<FormState>({
    craneId: quotation.craneId,
    rentalRate: String(quotation.rentalRate),
    rateBasis: quotation.rateBasis,
    mobilisationCharges: String(quotation.mobilisationCharges),
    demobilisationCharges: String(quotation.demobilisationCharges ?? ""),
    taxBasis: quotation.taxBasis ?? "EXCLUSIVE_OF_GST",
    availabilityConfirmed: quotation.availabilityConfirmed,
    availableFrom: quotation.availableFrom ?? "",
    validityDate: quotation.validityDate,
    acceptsCommercialTerms: quotation.acceptsCommercialTerms,
    deviationText: quotation.deviationText ?? "",
    remarks: quotation.remarks ?? "",
  });

  const cranes = useQuery({ queryKey: ["cranes"], queryFn: () => listCranes() });
  const selectedCrane = cranes.data?.cranes.find((crane) => crane.id === form.craneId) ?? null;
  const queryClient = useQueryClient();

  const revise = useMutation({
    mutationFn: ({ chart }: { chart: File | null }) =>
      reviseQuotation(quotation.quotationId, withoutCrane(toInput(form)), chart),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
      queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
      queryClient.invalidateQueries({ queryKey: ["quotation-history", rfqId] });
      onDone();
    },
  });

  return (
    <QuoteForm
      rfq={rfq}
      form={form}
      setForm={setForm}
      cranes={cranes.data?.cranes ?? []}
      cranesLoading={cranes.isLoading}
      selectedCrane={selectedCrane}
      mutation={revise}
      mode={quotation.status === "WITHDRAWN" ? "reinstate" : "revise"}
      craneLocked
      lockedCraneFallback={{ id: quotation.craneId, label: quotation.craneLabel }}
      onCancel={onDone}
    />
  );
}

/** Every version ever sent, grouped by crane — brief 6.7 keeps the whole trail. */
function HistoryPanel({ rfqId }: { rfqId: string }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["quotation-history", rfqId],
    queryFn: () => listQuotationHistory(rfqId),
    enabled: open,
  });

  const series = useMemo(() => history.data?.series ?? [], [history.data]);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <History className="size-4" aria-hidden />
          Quote history
        </span>
      }
      description="Every version you have sent, including withdrawn ones."
      actions={
        <button
          type="button"
          className="btn-secondary min-h-10 px-3 py-1.5 text-xs"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="quote-history"
        >
          {open ? "Hide" : "Show every version"}
        </button>
      }
    >
      <div id="quote-history" className="p-4">
        {!open ? (
          <p className="text-xs text-slate-500">Open to see every version you have sent.</p>
        ) : history.isLoading ? (
          <p className="text-sm text-slate-500">Loading history…</p>
        ) : history.error ? (
          <Alert>{(history.error as ApiError).message}</Alert>
        ) : (
          <div className="space-y-4">
            {series.map((group) => (
              <div key={group.craneId}>
                <p className="text-sm font-medium text-slate-900">{group.craneLabel}</p>
                <ol className="mt-2 space-y-2 border-l-2 border-ink-800 pl-4">
                  {group.versions.map((version) => (
                    <li key={version.quotationId}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-slate-700">
                          Version {version.version}
                          {version.isLatest ? " · latest" : ""}
                        </span>
                        <StatusBadge status={version.status} />
                        <span className="text-xs text-slate-500">
                          {formatDateTime(version.submittedAt)}
                        </span>
                        <span className="ml-auto text-xs font-semibold text-slate-900 tabular-nums">
                          {formatInr(version.totalQuotedValue)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {formatInr(version.rentalRate)}{" "}
                        {RATE_BASIS_LABELS[version.rateBasis].toLowerCase()} +{" "}
                        {formatInr(version.mobilisationCharges)} mobilisation · valid until{" "}
                        {formatCalendarDate(version.validityDate)}
                      </p>
                      <WarningList warnings={version.warnings} />
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {series.length === 0 ? <p className="text-sm text-slate-500">No history.</p> : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

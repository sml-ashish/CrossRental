import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  getLineComparison,
  markQuotation,
  type ComparisonQuotation,
  type ComparisonResult,
  type QuoteMarkStatus,
} from "@/lib/comparison";
import {
  formatDate,
  getLineWorkspace,
  lineToForm,
  updateLine,
} from "@/lib/enquiries";
import { awardQuotation, formatDistance } from "@/lib/rfqs";
import { loadMasterLists } from "@/lib/settings";
import { formatInr } from "@/lib/quotations";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Field, Select, TextArea, TextInput } from "@/components/ui/form";

/**
 * Quote comparison and final selection (P3, BPD 6.15 + 6.16).
 *
 * One line, every live quotation side by side, ranked by total estimated cost
 * (open item 5; the rule is configurable and named on screen). The internal
 * rental budget sits here because this is an internal screen — it is never part
 * of an RFQ or a vendor's view.
 *
 * The internal marks (Under Review / Shortlisted / Rejected) are SML's working
 * notes: the vendor sees the quotation as still Submitted. Final selection runs
 * through the single `award_quotation` path, which reserves the crane, emails
 * the vendor and marks the rest Not Awarded only once the requirement's
 * quantity is met — a partial award leaves the other quotations open.
 */

const MARK_LABELS: Record<QuoteMarkStatus, string> = {
  UNDER_REVIEW: "Under Review",
  SHORTLISTED: "Shortlisted",
  REJECTED: "Rejected",
};

const RANK_RULE_LABELS: Record<ComparisonResult["rankRule"], string> = {
  TOTAL_ESTIMATED_COST: "Total estimated cost (rental + mobilisation + demobilisation), lowest first",
};

function durationText(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  const label = unit === "MONTHS" ? "month(s)" : "day(s)";
  return `${value} ${label}`;
}

function responseTime(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function LineComparisonPage() {
  const params = useParams({ strict: false }) as { lineId: string };
  const queryClient = useQueryClient();

  const comparison = useQuery({
    queryKey: ["line-comparison", params.lineId],
    queryFn: () => getLineComparison(params.lineId),
  });
  const masterLists = useQuery({ queryKey: ["master-lists"], queryFn: loadMasterLists });
  const workspace = useQuery({
    queryKey: ["line-workspace", params.lineId],
    queryFn: () => getLineWorkspace(params.lineId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["line-comparison", params.lineId] });
    void queryClient.invalidateQueries({ queryKey: ["line-workspace", params.lineId] });
  };

  if (comparison.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (comparison.isError) {
    return <Alert tone="error">Could not load that comparison.</Alert>;
  }

  const data = comparison.data.comparison;
  const markCodes = masterLists.data?.QUOTATION_MARK_REASON_CODES ?? [];
  const awardCodes = masterLists.data?.AWARD_REASON_CODES ?? [];
  const line = workspace.data?.workspace.line ?? null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/app/enquiries/lines/$lineId"
          params={{ lineId: params.lineId }}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Line {data.lineNo}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Compare quotes</h1>
          {data.fullyAwarded ? (
            <Badge tone="emerald">Fully awarded</Badge>
          ) : (
            <Badge tone="amber">
              {data.awardedCount} of {data.quantity} awarded
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          {data.enquiryNo} · line {data.lineNo} ·{" "}
          {data.requirement.craneTypeName ?? data.requirement.craneTypeCode ?? "No type"}{" "}
          {data.requirement.capacityT !== null ? `${data.requirement.capacityT} t ` : ""}
          {data.requirement.capacityRule === "EXACT" ? "(exact)" : "(at least)"} ×{" "}
          {data.requirement.quantity} ·{" "}
          {data.requirement.startDateTbc
            ? "start TBC"
            : `required ${formatDate(data.requirement.requiredStartDate)}`}{" "}
          for {durationText(data.requirement.durationValue, data.requirement.durationUnit)}
        </p>
        <p className="mt-0.5 text-sm text-slate-500">
          {data.siteLocation}
          {data.siteStateName ? `, ${data.siteStateName}` : ""}
        </p>
      </div>

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-slate-900">Internal reference</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Rental budget and PO/SAP reference are internal only and never part of an RFQ or a
          vendor's view.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-slate-500">Rental budget</dt>
            <dd className="mt-0.5 text-sm text-slate-900">
              {data.rentalBudget ?? "—"}
              {data.rentalBudgetValue !== null ? ` (${formatInr(data.rentalBudgetValue)})` : ""}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium text-slate-500">Ranking rule</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{RANK_RULE_LABELS[data.rankRule]}</dd>
          </div>
        </dl>
        {line ? (
          <div className="mt-4 max-w-sm">
            <PoReferenceForm lineId={params.lineId} line={line} onSaved={invalidate} />
          </div>
        ) : null}
      </section>

      {data.quotations.length === 0 ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500">No live quotations to compare yet.</p>
        </section>
      ) : (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-slate-900">
            Quotations ({data.quotations.length})
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Latest version of each live quotation. The vendor sees marks as still Submitted.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Vendor / crane</th>
                  <th className="py-2 pr-3 font-medium">Rental</th>
                  <th className="py-2 pr-3 font-medium">Mob. / demob.</th>
                  <th className="py-2 pr-3 font-medium">Total</th>
                  <th className="py-2 pr-3 font-medium">Distance</th>
                  <th className="py-2 pr-3 font-medium">Age / avail.</th>
                  <th className="py-2 pr-3 font-medium">Validity</th>
                  <th className="py-2 pr-3 font-medium">Response</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.quotations.map((q) => (
                  <QuotationRow
                    key={q.quotationId}
                    quotation={q}
                    markCodes={markCodes}
                    awardCodes={awardCodes}
                    startDateTbc={data.requirement.startDateTbc}
                    defaultStartDate={
                      data.requirement.requiredStartDate
                        ? data.requirement.requiredStartDate.slice(0, 10)
                        : new Date().toISOString().slice(0, 10)
                    }
                    fullyAwarded={data.fullyAwarded}
                    onChanged={invalidate}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            A final selection reserves the crane and emails the vendor. Other quotations are
            marked Not Awarded only when the line's quantity is met; until then the award is
            partial and they stay open.
          </p>
        </section>
      )}
    </div>
  );
}

function QuotationRow({
  quotation,
  markCodes,
  awardCodes,
  startDateTbc,
  defaultStartDate,
  fullyAwarded,
  onChanged,
}: {
  quotation: ComparisonQuotation;
  markCodes: string[];
  awardCodes: string[];
  startDateTbc: boolean;
  defaultStartDate: string;
  fullyAwarded: boolean;
  onChanged: () => void;
}) {
  const [markOpen, setMarkOpen] = useState(false);
  const [awardOpen, setAwardOpen] = useState(false);

  const canAct = quotation.status !== "SELECTED" && quotation.status !== "NOT_AWARDED";

  return (
    <tr className="align-top">
      <td className="py-3 pr-3">
        <p className="font-medium text-slate-800">{quotation.vendorName ?? "Vendor"}</p>
        <p className="text-xs text-slate-500">{quotation.crane.label}</p>
        <p className="text-xs text-slate-500">
          {quotation.crane.make} {quotation.crane.model} · {quotation.crane.capacityT ?? "—"} t
          {quotation.crane.serialRegistrationNo ? ` · ${quotation.crane.serialRegistrationNo}` : ""}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {quotation.recommendationRank !== null ? (
            <Badge tone="purple">Recommendation rank {quotation.recommendationRank}</Badge>
          ) : null}
          {quotation.acceptsCommercialTerms ? null : <Badge tone="amber">Deviation</Badge>}
        </div>
        {quotation.warnings.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {quotation.warnings.map((warning) => (
              <li key={warning.code} className="text-xs font-medium text-amber-700">
                {warning.message}
              </li>
            ))}
          </ul>
        ) : null}
        {quotation.remarks ? (
          <p className="mt-1 text-xs text-slate-500">{quotation.remarks}</p>
        ) : null}
      </td>
      <td className="py-3 pr-3 text-slate-700">
        {formatInr(quotation.rentalRate)}
        <p className="text-xs text-slate-500">{quotation.rateBasis}</p>
        <p className="text-xs text-slate-500">{quotation.taxBasis}</p>
      </td>
      <td className="py-3 pr-3 text-slate-700">
        {formatInr(quotation.mobilisationCharges)}
        <p className="text-xs text-slate-500">{formatInr(quotation.demobilisationCharges)}</p>
      </td>
      <td className="py-3 pr-3 font-medium text-slate-900">
        {formatInr(quotation.totalEstimatedCost)}
      </td>
      <td className="py-3 pr-3 text-slate-700">
        {formatDistance(quotation.distanceToSiteKm, quotation.distanceMethod === "straight_line")}
      </td>
      <td className="py-3 pr-3 text-slate-700">
        {quotation.craneAgeYears !== null ? `${quotation.craneAgeYears.toFixed(1)} yr` : "—"}
        <p className="text-xs text-slate-500">
          {quotation.availabilityConfirmed
            ? quotation.availableFrom
              ? `available ${formatDate(quotation.availableFrom)}`
              : "availability confirmed"
            : "availability not confirmed"}
        </p>
      </td>
      <td className="py-3 pr-3 text-slate-700">{formatDate(quotation.validityDate)}</td>
      <td className="py-3 pr-3 text-slate-700">{responseTime(quotation.responseTimeHours)}</td>
      <td className="py-3 pr-3">
        <StatusBadge status={quotation.status} />
        {quotation.markReasonCode || quotation.markReasonText ? (
          <p className="mt-1 text-xs text-slate-500">
            {quotation.markReasonCode ?? ""}
            {quotation.markReasonCode && quotation.markReasonText ? " · " : ""}
            {quotation.markReasonText ?? ""}
          </p>
        ) : null}
        {quotation.markedAt ? (
          <p className="text-xs text-slate-400">{formatDate(quotation.markedAt)}</p>
        ) : null}
      </td>
      <td className="py-3">
        {canAct ? (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              onClick={() => {
                setAwardOpen(false);
                setMarkOpen((v) => !v);
              }}
            >
              {markOpen ? "Cancel" : "Mark"}
            </button>
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              disabled={fullyAwarded}
              title={fullyAwarded ? "The line's quantity is already awarded" : undefined}
              onClick={() => {
                setMarkOpen(false);
                setAwardOpen((v) => !v);
              }}
            >
              {awardOpen ? "Cancel" : "Select"}
            </button>
          </div>
        ) : (
          <span className="text-xs text-slate-400">Finalised</span>
        )}
        {markOpen ? (
          <MarkControl
            quotation={quotation}
            reasonCodes={markCodes}
            onDone={() => {
              setMarkOpen(false);
              onChanged();
            }}
          />
        ) : null}
        {awardOpen ? (
          <AwardControl
            quotation={quotation}
            reasonCodes={awardCodes}
            startDateTbc={startDateTbc}
            defaultStartDate={defaultStartDate}
            onDone={() => {
              setAwardOpen(false);
              onChanged();
            }}
          />
        ) : null}
      </td>
    </tr>
  );
}

function MarkControl({
  quotation,
  reasonCodes,
  onDone,
}: {
  quotation: ComparisonQuotation;
  reasonCodes: string[];
  onDone: () => void;
}) {
  const [status, setStatus] = useState<QuoteMarkStatus>("UNDER_REVIEW");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");

  const mark = useMutation({
    mutationFn: () =>
      markQuotation(quotation.rfqId, quotation.quotationId, {
        status,
        reasonCode: reasonCode || null,
        reasonText: reasonText || null,
      }),
    onSuccess: onDone,
  });

  return (
    <div className="mt-2 w-56 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-600">
        An internal note. The vendor still sees this quotation as Submitted.
      </p>
      <Field label="Mark as" htmlFor={`mark-status-${quotation.quotationId}`}>
        <Select
          id={`mark-status-${quotation.quotationId}`}
          value={status}
          onChange={(v) => setStatus(v as QuoteMarkStatus)}
          placeholder="Choose"
          options={[
            { value: "UNDER_REVIEW", label: MARK_LABELS.UNDER_REVIEW },
            { value: "SHORTLISTED", label: MARK_LABELS.SHORTLISTED },
            { value: "REJECTED", label: MARK_LABELS.REJECTED },
          ]}
        />
      </Field>
      {reasonCodes.length > 0 ? (
        <Field label="Reason code" htmlFor={`mark-code-${quotation.quotationId}`}>
          <Select
            id={`mark-code-${quotation.quotationId}`}
            value={reasonCode}
            onChange={setReasonCode}
            placeholder="Optional"
            options={reasonCodes.map((code) => ({ value: code, label: code }))}
          />
        </Field>
      ) : null}
      <Field label="Note" htmlFor={`mark-text-${quotation.quotationId}`}>
        <TextArea
          id={`mark-text-${quotation.quotationId}`}
          rows={2}
          value={reasonText}
          onChange={setReasonText}
        />
      </Field>
      {mark.isError ? <Alert tone="error">{(mark.error as Error).message}</Alert> : null}
      <button
        type="button"
        className="btn-primary px-3 py-1.5 text-xs"
        disabled={mark.isPending}
        onClick={() => mark.mutate()}
      >
        {mark.isPending ? <Spinner /> : null}
        Save mark
      </button>
    </div>
  );
}

function AwardControl({
  quotation,
  reasonCodes,
  startDateTbc,
  defaultStartDate,
  onDone,
}: {
  quotation: ComparisonQuotation;
  reasonCodes: string[];
  startDateTbc: boolean;
  defaultStartDate: string;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState(startDateTbc ? defaultStartDate : "");
  const [endDate, setEndDate] = useState("");

  const award = useMutation({
    mutationFn: () =>
      awardQuotation(quotation.rfqId, quotation.quotationId, {
        reason,
        reasonCode,
        dates: startDateTbc ? { startDate, endDate } : undefined,
      }),
    onSuccess: (result) => {
      const detail = result.result.partial
        ? `Partial award (${result.result.awardedCount} of ${result.result.quantity}); the other quotations stay open.`
        : `${result.result.notAwardedCount} other quotation(s) marked Not Awarded and the line finalised.`;
      onDone();
      window.alert(
        `Awarded. ${detail} ` +
          `${result.result.notifiedAwarded} award email(s) and ${result.result.notifiedNotAwarded} ` +
          `not-awarded email(s) sent.`,
      );
    },
  });

  return (
    <div className="mt-2 w-64 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-600">
        Reserves this crane, emails the vendor and — once the line's quantity is met — marks the
        rest Not Awarded.
      </p>
      {startDateTbc ? (
        <>
          <Field label="Reservation start" htmlFor={`award-start-${quotation.quotationId}`} required>
            <TextInput
              id={`award-start-${quotation.quotationId}`}
              type="date"
              value={startDate}
              onChange={setStartDate}
            />
          </Field>
          <Field label="Reservation end" htmlFor={`award-end-${quotation.quotationId}`} required>
            <TextInput
              id={`award-end-${quotation.quotationId}`}
              type="date"
              value={endDate}
              onChange={setEndDate}
            />
          </Field>
        </>
      ) : null}
      {reasonCodes.length > 0 ? (
        <Field label="Award reason code" htmlFor={`award-code-${quotation.quotationId}`}>
          <Select
            id={`award-code-${quotation.quotationId}`}
            value={reasonCode}
            onChange={setReasonCode}
            placeholder="Optional"
            options={reasonCodes.map((code) => ({ value: code, label: code }))}
          />
        </Field>
      ) : null}
      <Field label="Remarks" htmlFor={`award-reason-${quotation.quotationId}`} hint="Optional echo into the emails.">
        <TextArea
          id={`award-reason-${quotation.quotationId}`}
          rows={2}
          value={reason}
          onChange={setReason}
        />
      </Field>
      {award.isError ? <Alert tone="error">{(award.error as Error).message}</Alert> : null}
      <button
        type="button"
        className="btn-primary px-3 py-1.5 text-xs"
        disabled={award.isPending}
        onClick={() => award.mutate()}
      >
        {award.isPending ? <Spinner /> : null}
        Confirm award
      </button>
    </div>
  );
}

function PoReferenceForm({
  lineId,
  line,
  onSaved,
}: {
  lineId: string;
  line: Parameters<typeof lineToForm>[0];
  onSaved: () => void;
}) {
  const [value, setValue] = useState(line.poSapReference ?? "");
  const [message, setMessage] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => updateLine(lineId, { ...lineToForm(line), poSapReference: value }),
    onSuccess: () => {
      setMessage("PO / SAP reference saved.");
      onSaved();
    },
  });

  return (
    <div className="space-y-2">
      <Field
        label="PO / SAP reference"
        htmlFor="po-sap-reference"
        hint="Recorded on the line once the hire is confirmed."
      >
        <TextInput id="po-sap-reference" value={value} onChange={setValue} />
      </Field>
      {message ? <p className="text-xs text-emerald-700">{message}</p> : null}
      {save.isError ? (
        <p className="text-xs text-red-600">
          {save.error instanceof ApiError ? save.error.message : "Could not save the reference."}
        </p>
      ) : null}
      <button
        type="button"
        className="btn-secondary px-3 py-1.5 text-xs"
        disabled={save.isPending}
        onClick={() => {
          setMessage(null);
          save.mutate();
        }}
      >
        {save.isPending ? <Spinner /> : null}
        Save reference
      </button>
    </div>
  );
}

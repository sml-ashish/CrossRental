import { useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, Paperclip, Send, Undo2, XCircle } from "lucide-react";
import {
  RATE_BASIS_LABELS,
  declineRfq,
  extraTermRows,
  formatInr,
  getVendorRfq,
  listQuotationHistory,
  previewQuotation,
  reviseQuotation,
  submitQuotation,
  withdrawQuotation,
  type QuoteInput,
  type QuotationPreview,
  type VendorQuotation,
  type VendorRfqDetail,
} from "@/lib/quotations";
import { ApiError } from "@/lib/api";
import {
  createCrane,
  CRANE_STATUS_LABELS,
  EMPTY_CRANE_FORM,
  fetchReferenceData,
  listCranes,
  VENDOR_STATUSES,
  type Crane,
  type CraneForm,
} from "@/lib/fleet";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Checkbox, Field, ReadOnlyValue, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import {
  deadlineCountdown,
  formatCalendarDate,
  formatDateTime,
} from "@/routes/app/rfqs";

/**
 * One vendor-visible RFQ: the requirement, and the vendor's own quotes on it
 * (brief 7.8, M5).
 *
 * The brief requires the customer, the internal user, and the vendor to read the
 * same *facts* about an RFQ while seeing different things: the vendor never sees
 * SML's internal notes, who else was invited, delivery status, or the recipient
 * list. That separation lives on the server — this screen is only a projection
 * of `/api/vendor/rfqs/:id`, and it never re-derives a deadline or a status.
 *
 * **The rate maths is never done here.** Every total on this screen comes from
 * the backend's `calculationNote`, because brief 6.4 fixes the 30-days-per-month
 * convention and the per-unit rules that go with it; a second implementation in
 * the client would eventually disagree with the one that was emailed.
 *
 * **Warnings do not block.** A crane of the wrong type or one that frees up late
 * is something for the vendor to see and decide about, so the preview's warnings
 * are rendered and the submit button stays live (brief 6.7).
 */

const EMPTY_FORM = {
  craneId: "",
  rentalRate: "",
  rateBasis: "PER_MONTH",
  mobilisationCharges: "",
  demobilisationCharges: "",
  taxBasis: "EXCLUSIVE_OF_GST",
  availabilityConfirmed: false,
  availableFrom: "",
  validityDate: "",
  acceptsCommercialTerms: false,
  deviationText: "",
  remarks: "",
};

type FormState = typeof EMPTY_FORM;

export function VendorRfqDetailPage() {
  const { rfqId } = useParams({ from: "/app/rfqs/$rfqId" }) as { rfqId: string };
  const [quotingAnother, setQuotingAnother] = useState(false);

  const detail = useQuery({
    queryKey: ["vendor-rfq", rfqId],
    queryFn: () => getVendorRfq(rfqId),
  });

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading RFQ
      </div>
    );
  }
  if (detail.error) {
    const error = detail.error as ApiError;
    return (
      <Alert title="Could not open this RFQ">
        {error.status === 404
          ? "This RFQ was not sent to you, or it has been removed."
          : error.message}
      </Alert>
    );
  }

  if (!detail.data) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading RFQ
      </div>
    );
  }

  const { rfq, response, quotations } = detail.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-semibold text-slate-900">{rfq.rfqNumber}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {rfq.enquiryNo}
            {rfq.lineNo ? ` · line ${rfq.lineNo}` : ""}
          </p>
        </div>
        <DeadlineBanner
          deadline={rfq.submissionDeadline}
          locked={rfq.locked}
          canRespond={response.canRespond}
          responseStatus={response.responseStatus}
        />
      </header>

      <RequirementCard rfq={rfq} />

      {response.responseStatus === "PENDING" && response.canRespond ? (
        <DeclinePanel rfqId={rfqId} />
      ) : null}

      {response.responseStatus === "DECLINED" &&
      (response.declineReason || response.declineNote) ? (
        <Alert tone="info" title="You declined this RFQ">
          {response.declineReason ? <p>{response.declineReason}</p> : null}
          {response.declineNote ? (
            <p className="mt-0.5 whitespace-pre-line text-slate-600">{response.declineNote}</p>
          ) : null}
        </Alert>
      ) : null}

      {/*
        A vendor may offer more than one crane on the same RFQ — the backend keeps
        a version series per crane — so the first quote must not close the form.
        Once something is quoted the panel is kept behind a button, otherwise it
        would sit permanently above the list of quotes it produced.
      */}
      {response.canRespond && (quotations.length === 0 || quotingAnother) ? (
        <QuotePanel
          rfqId={rfqId}
          rfq={rfq}
          onQuoted={() => setQuotingAnother(false)}
        />
      ) : null}

      {quotations.length > 0 ? (
        <SubmittedQuotations rfqId={rfqId} rfq={rfq} quotations={quotations} />
      ) : null}

      {response.canRespond && quotations.length > 0 && !quotingAnother ? (
        <div>
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() => setQuotingAnother(true)}
          >
            <Send className="mr-1.5 inline size-4" aria-hidden />
            Quote another crane
          </button>
        </div>
      ) : null}

      {quotations.length > 0 ? <HistoryPanel rfqId={rfqId} /> : null}
    </div>
  );
}

function DeadlineBanner({
  deadline,
  locked,
  canRespond,
  responseStatus,
}: {
  deadline: string;
  locked: boolean;
  canRespond: boolean;
  responseStatus: string;
}) {
  const countdown = deadlineCountdown(deadline, locked ? "CLOSED" : "SENT");
  const tone = locked
    ? "neutral"
    : responseStatus !== "PENDING"
      ? "blue"
      : countdown.tone === "overdue"
        ? "red"
        : countdown.tone === "soon"
          ? "amber"
          : "emerald";

  const message = locked
    ? "This RFQ is finalised. You can still read it and your quotes remain on record."
    : responseStatus === "QUOTED"
      ? "Quote received. You can revise it until the deadline."
      : responseStatus === "DECLINED"
        ? "You declined this RFQ."
        : responseStatus === "EXPIRED"
          ? "This RFQ expired without a quote from you."
          : countdown.label;

  return (
    <div className="min-w-56">
      <Badge tone={tone}>{message}</Badge>
      <p className="mt-1.5 text-xs text-slate-500">
        Quotes due {formatDateTime(deadline)}
        {!canRespond && !locked ? " · no longer accepted" : null}
      </p>
    </div>
  );
}

function RequirementCard({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const terms = rfq.commercialTerms;
  const extraRows = extraTermRows(terms.extra);
  const hasTerms =
    Object.entries(terms).some(([key, value]) => key !== "extra" && value) ||
    extraRows.length > 0;

  return (
    <Section title="Requirement" description="As SML issued it. These fields are not editable.">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <ReadOnlyValue label="Crane type" value={rfq.craneTypeName} />
        <ReadOnlyValue
          label="Capacity"
          value={`${rfq.capacityT} t${rfq.capacityRule === "EXACT" ? " (exact)" : " (at least)"}`}
        />
        <ReadOnlyValue label="Quantity" value={String(rfq.quantity)} />
        <ReadOnlyValue
          label="Required start"
          value={rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate)}
        />
        <ReadOnlyValue
          label="Duration"
          value={`${rfq.durationValue} ${rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}`}
        />
        <ReadOnlyValue label="Configuration" value={rfq.configuration ?? "—"} />
        <ReadOnlyValue label="Site" value={`${rfq.siteLocation}, ${rfq.siteStateName}`} />
        <ReadOnlyValue label="PIN code" value={rfq.sitePincode ?? "—"} mono />
        {rfq.capacityNote ? (
          <ReadOnlyValue label="Capacity note" value={rfq.capacityNote} />
        ) : null}
        {rfq.applicationDescription ? (
          <ReadOnlyValue label="Application" value={rfq.applicationDescription} />
        ) : null}
        {rfq.loadDescription ? (
          <ReadOnlyValue label="Load details" value={rfq.loadDescription} />
        ) : null}
        {rfq.mainBoomM !== null ? (
          <ReadOnlyValue label="Main boom required" value={`${rfq.mainBoomM} m`} />
        ) : null}
        {rfq.jibLengthM !== null ? (
          <ReadOnlyValue label="Jib length required" value={`${rfq.jibLengthM} m`} />
        ) : null}
      </dl>

      {rfq.notes ? (
        <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <p className="text-xs font-medium text-slate-500">Notes from SML</p>
          <p className="mt-1 whitespace-pre-wrap">{rfq.notes}</p>
        </div>
      ) : null}

      {hasTerms ? (
        <div>
          <p className="text-xs font-medium text-slate-500">Commercial terms</p>
          <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {terms.otCharges ? <ReadOnlyValue label="O.T. charges" value={terms.otCharges} /> : null}
            {terms.breakdownTerms ? <ReadOnlyValue label="Breakdown" value={terms.breakdownTerms} /> : null}
            {terms.dieselScope ? <ReadOnlyValue label="Diesel" value={terms.dieselScope} /> : null}
            {terms.workingHoursShift ? <ReadOnlyValue label="Working hours" value={terms.workingHoursShift} /> : null}
            {terms.accommodationConveyance ? (
              <ReadOnlyValue label="Accommodation / conveyance" value={terms.accommodationConveyance} />
            ) : null}
            {terms.paymentTerms ? <ReadOnlyValue label="Payment terms" value={terms.paymentTerms} /> : null}
            {terms.mobilisationTerms ? (
              <ReadOnlyValue label="Mobilisation / demobilisation" value={terms.mobilisationTerms} />
            ) : null}
            {terms.supportCrane ? <ReadOnlyValue label="Support crane" value={terms.supportCrane} /> : null}
            {terms.steelMatsGroundPrep ? (
              <ReadOnlyValue label="Steel mats / ground prep" value={terms.steelMatsGroundPrep} />
            ) : null}
            {terms.ehsHrRequirements ? (
              <ReadOnlyValue label="EHS / HR" value={terms.ehsHrRequirements} />
            ) : null}
            {terms.insuranceTerms ? (
              <ReadOnlyValue label="Insurance" value={terms.insuranceTerms} />
            ) : null}
            {terms.extensionClause ? (
              <ReadOnlyValue label="Extension clause" value={terms.extensionClause} />
            ) : null}
            {extraRows.map((row) => (
              <ReadOnlyValue key={row.key} label={row.label} value={row.value} />
            ))}
          </dl>
        </div>
      ) : null}

      {rfq.smlContact.name || rfq.smlContact.email ? (
        <div>
          <p className="text-xs font-medium text-slate-500">SML contact</p>
          <p className="mt-0.5 text-sm text-slate-700">
            {rfq.smlContact.name}
            {rfq.smlContact.email ? ` · ${rfq.smlContact.email}` : ""}
            {rfq.smlContact.mobile ? ` · ${rfq.smlContact.mobile}` : ""}
          </p>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Declining needs a reason, because the internal user sees why a vendor said no
 * and an empty box would tell them nothing.
 */
function DeclinePanel({ rfqId }: { rfqId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();

  const decline = useMutation({
    mutationFn: () => declineRfq(rfqId, { reason, note: note || undefined }),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
      queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
    },
  });

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn-secondary text-sm" onClick={() => setOpen(true)}>
          <XCircle className="mr-1.5 size-4" aria-hidden />
          Decline this RFQ
        </button>
      </div>
    );
  }

  return (
    <Section
      title="Decline this RFQ"
      description="The reason is shared with the SML user who issued it. If this crane is not available, please use the note to list other cranes you can offer — with make, model, capacity, YOM, type and location — or contacts of other agencies who have the equipment."
    >
      {decline.error ? <Alert>{(decline.error as ApiError).message}</Alert> : null}
      <Field
        label="Reason"
        htmlFor="decline-reason"
        hint="Optional, but the SML user reads this. Suggestions are offered; you can write your own."
        error={(decline.error as ApiError)?.fieldError("reason")}
      >
        <input
          id="decline-reason"
          list="decline-suggestions"
          className="field-input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          placeholder="No capacity available for the required dates"
          aria-invalid={Boolean((decline.error as ApiError)?.fieldError("reason")) || undefined}
        />
        <datalist id="decline-suggestions">
          {DECLINE_REASONS.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </Field>
      <Field
        label="Note (optional)"
        htmlFor="decline-note"
        hint="What else you can offer: other cranes in your fleet, or contacts of agencies who have this equipment."
      >
        <TextArea
          id="decline-note"
          value={note}
          onChange={setNote}
          rows={3}
          placeholder="e.g. We can offer a 250 t crawler (Liebherr LTM 1250, 2019) from Pune, or contact XYZ Cranes on 98xxxxxx21."
        />
      </Field>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={decline.isPending}
          onClick={() => decline.mutate()}
        >
          {decline.isPending ? "Declining…" : "Confirm decline"}
        </button>
        <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </Section>
  );
}

/**
 * Suggestions only. The stored `reason` is free text, so these are phrases a
 * vendor can accept or ignore — a coded value here would reach the internal user
 * as a bare word like "NO_CAPACITY" instead of something they can read.
 */
const DECLINE_REASONS = [
  "No capacity available for the required dates",
  "Site is too far from our cranes",
  "Duration is not suitable for us",
  "Commercial terms are not acceptable",
  "Crane is already committed elsewhere",
];

type QuotePanelProps = {
  rfqId: string;
  rfq: VendorRfqDetail["rfq"];
  /** Lets the screen collapse the "quote another crane" form once one is in. */
  onQuoted?: () => void;
};

/** A quote on an RFQ: pick a crane, price it, see the total, send it. */
function QuotePanel({ rfqId, rfq, onQuoted }: QuotePanelProps) {
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const queryClient = useQueryClient();

  const cranes = useQuery({ queryKey: ["cranes"], queryFn: () => listCranes() });

  const selectedCrane = useMemo(
    () => cranes.data?.cranes.find((crane) => crane.id === form.craneId) ?? null,
    [cranes.data, form.craneId],
  );

  const submit = useMutation({
    mutationFn: ({ chart }: { chart: File | null }) => submitQuotation(rfqId, toInput(form), chart),
    onSuccess: () => {
      onQuoted?.();
      queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
      queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
      queryClient.invalidateQueries({ queryKey: ["quotation-history", rfqId] });
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
      mutation={submit}
      mode="create"
    />
  );
}

function SubmittedQuotations({
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

  return (
    <>
      <Section
        title="Your quote"
        description="The latest version of each crane you quoted. Revising keeps the earlier versions on record."
      >
        {withdraw.error ? <Alert>{(withdraw.error as ApiError).message}</Alert> : null}
        <div className="space-y-3">
          {[...live, ...withdrawn].map((quotation) => (
            <QuotationCard
              key={quotation.quotationId}
              quotation={quotation}
              busy={withdraw.isPending}
              onRevise={
                quotation.editable ? () => setRevising(quotation) : undefined
              }
              onWithdraw={
                quotation.editable && quotation.status !== "WITHDRAWN"
                  ? () => withdraw.mutate(quotation.quotationId)
                  : undefined
              }
            />
          ))}
          {quotations.length === 0 ? (
            <p className="text-sm text-slate-500">You have not quoted this RFQ yet.</p>
          ) : null}
        </div>
      </Section>

      {revising ? (
        <RevisePanel
          rfq={rfq}
          quotation={revising}
          onDone={() => setRevising(null)}
          rfqId={rfqId}
        />
      ) : null}
    </>
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
    <div className="rounded-md border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">{quotation.craneLabel}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Version {quotation.version}
            {quotation.isLatest ? " · latest" : ""} · sent {formatDateTime(quotation.submittedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={quotation.status} />
          <span className="text-sm font-semibold text-slate-900">
            {formatInr(quotation.totalQuotedValue)}
          </span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ReadOnlyValue
          label="Rate"
          value={`${formatInr(quotation.rentalRate)} ${RATE_BASIS_LABELS[quotation.rateBasis].toLowerCase()}`}
        />
        <ReadOnlyValue label="Mobilisation" value={formatInr(quotation.mobilisationCharges)} />
        <ReadOnlyValue label="Demobilisation" value={formatInr(quotation.demobilisationCharges)} />
        <ReadOnlyValue
          label="Tax basis"
          value={quotation.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive of GST" : "Exclusive of GST"}
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
        <p className="mt-3 rounded-md bg-amber-50 p-2.5 text-xs text-amber-900">
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
        <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
          {onRevise ? (
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={onRevise}>
              {quotation.status === "WITHDRAWN" ? "Quote again" : "Revise"}
            </button>
          ) : null}
          {onWithdraw ? (
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs text-red-700"
              disabled={busy}
              onClick={onWithdraw}
            >
              <Undo2 className="mr-1 inline size-3.5" aria-hidden />
              Withdraw
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const selectedCrane =
    cranes.data?.cranes.find((crane) => crane.id === form.craneId) ?? null;
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

type FormMutation = {
  mutate: (variables: { chart: File | null }) => void;
  isPending: boolean;
  error: unknown;
};

function QuoteForm({
  rfq,
  form,
  setForm,
  cranes,
  cranesLoading,
  selectedCrane,
  mutation,
  mode,
  craneLocked = false,
  lockedCraneFallback = null,
  onCancel,
}: {
  rfq: VendorRfqDetail["rfq"];
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  cranes: Crane[];
  cranesLoading: boolean;
  selectedCrane: Crane | null;
  mutation: FormMutation;
  /** "reinstate" is a revision of a version the vendor had withdrawn. */
  mode: "create" | "revise" | "reinstate";
  craneLocked?: boolean;
  lockedCraneFallback?: { id: string; label: string } | null;
  onCancel?: () => void;
}) {
  const [chart, setChart] = useState<File | null>(null);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [addingCrane, setAddingCrane] = useState(false);
  const error = mutation.error as ApiError | null;

  // The backend owns the arithmetic (brief 6.4), so the live figure comes from
  // preview and is only refreshed when a field that moves money changes. Debounced
  // so typing a rate does not fire a request per keystroke.
  const pricedInput = useMemo(
    () => toInput(form),
    [form, craneLocked],
  );
  const debouncedInput = useDebouncedValue(pricedInput, 400);

  const preview = useQuery({
    queryKey: ["quotation-preview", rfq.rfqId, debouncedInput],
    queryFn: () => previewQuotation(rfq.rfqId, debouncedInput),
    enabled: form.craneId !== "" && !mutation.isPending,
    staleTime: 0,
  });

  const previewData = preview.data?.preview;
  const warnings = previewData?.warnings ?? [];
  const needsChart = selectedCrane ? !selectedCrane.loadChart : true;
  const blockedReason = previewData?.blockedReason ?? null;
  const warningsConfirmed = warnings.length === 0 || warningsAcknowledged;

  const canSend =
    form.craneId !== "" &&
    form.rentalRate !== "" &&
    form.validityDate !== "" &&
    // The backend requires both answers explicitly rather than treating a
    // missing field as consent, so the button waits for them here too.
    form.availabilityConfirmed &&
    form.acceptsCommercialTerms &&
    (needsChart ? chart !== null || mode !== "create" : true) &&
    warningsConfirmed &&
    !mutation.isPending &&
    !blockedReason;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <Section
      title={
        mode === "create"
          ? "Quote this RFQ"
          : mode === "reinstate"
            ? "Quote again"
            : "Revise your quote"
      }
      description={
        mode === "create"
          ? "Totals are calculated by SML from the rates you enter — nothing is estimated in your browser."
          : mode === "reinstate"
            ? "This replaces the version you withdrew. The withdrawn version stays on record and becomes a new version in the same history."
            : "This becomes a new version. The version you are replacing stays on record."
      }
    >
      {error ? <Alert title="Could not send your quote">{error.message}</Alert> : null}
      {blockedReason ? <Alert tone="info" title="Not available for a quote">{blockedReason}</Alert> : null}

      <Field
        label="Crane"
        htmlFor="quote-crane"
        required
        hint={
          craneLocked
            ? "The crane is fixed for this revision — a new version belongs to the same crane's history."
            : selectedCrane
              ? selectedCrane.loadChart
                ? "This crane already has a load chart on file, so you do not need to attach one."
                : "This crane has no load chart on file — attach the chart with your quote."
              : "Only your own cranes are listed here."
        }
      >
        <Select
          id="quote-crane"
          value={form.craneId}
          onChange={(value) => set("craneId", value)}
          disabled={craneLocked}
          options={craneOptions(cranes, lockedCraneFallback)}
          placeholder={cranesLoading ? "Loading your cranes…" : "Select a crane"}
        />
        {!craneLocked ? (
          <div className="mt-2">
            <button
              type="button"
              className="text-xs font-medium text-blue-700 underline underline-offset-2"
              onClick={() => setAddingCrane((open) => !open)}
            >
              {addingCrane ? "Hide the add-crane form" : "Crane not in your fleet? Add it here"}
            </button>
          </div>
        ) : null}
      </Field>

      {addingCrane && !craneLocked ? (
        <InlineCraneAdd
          onCancel={() => setAddingCrane(false)}
          onCreated={(craneId) => {
            set("craneId", craneId);
            setAddingCrane(false);
          }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Rental rate" htmlFor="quote-rate" required error={error?.fieldError("rentalRate")}>
          <TextInput
            id="quote-rate"
            value={form.rentalRate}
            onChange={(value) => set("rentalRate", value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(error?.fieldError("rentalRate"))}
          />
        </Field>
        <Field label="Rate basis" htmlFor="quote-basis" required>
          <Select
            id="quote-basis"
            value={form.rateBasis}
            onChange={(value) => set("rateBasis", value as FormState["rateBasis"])}
            options={[
              { value: "PER_MONTH", label: RATE_BASIS_LABELS.PER_MONTH },
              { value: "PER_DAY", label: RATE_BASIS_LABELS.PER_DAY },
              { value: "LUMP_SUM", label: RATE_BASIS_LABELS.LUMP_SUM },
            ]}
          />
        </Field>
        <Field
          label="Mobilisation charges"
          htmlFor="quote-mob"
          hint="Added to the rental charge to give the total."
          error={error?.fieldError("mobilisationCharges")}
        >
          <TextInput
            id="quote-mob"
            value={form.mobilisationCharges}
            onChange={(value) => set("mobilisationCharges", value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(error?.fieldError("mobilisationCharges"))}
          />
        </Field>
        <Field
          label="Demobilisation charges"
          htmlFor="quote-demob"
          hint="Return transport. Added to the total beside mobilisation."
          error={error?.fieldError("demobilisationCharges")}
        >
          <TextInput
            id="quote-demob"
            value={form.demobilisationCharges}
            onChange={(value) => set("demobilisationCharges", value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(error?.fieldError("demobilisationCharges"))}
          />
        </Field>
        <Field label="Tax basis" htmlFor="quote-tax" hint="A declaration for comparing quotes; it does not change the total.">
          <Select
            id="quote-tax"
            value={form.taxBasis}
            onChange={(value) => set("taxBasis", value as FormState["taxBasis"])}
            options={[
              { value: "EXCLUSIVE_OF_GST", label: "Exclusive of GST" },
              { value: "INCLUSIVE_OF_GST", label: "Inclusive of GST" },
            ]}
          />
        </Field>
        <Field label="Quote valid until" htmlFor="quote-validity" required error={error?.fieldError("validityDate")}>
          <TextInput
            id="quote-validity"
            type="date"
            value={form.validityDate}
            onChange={(value) => set("validityDate", value)}
            invalid={Boolean(error?.fieldError("validityDate"))}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Checkbox
            id="quote-available"
            checked={form.availabilityConfirmed}
            onChange={(value) => set("availabilityConfirmed", value)}
            label={
              <>
                <span className="ml-0.5 mr-0.5 text-red-600">*</span>
                This crane is available from {formatCalendarDate(rfq.requiredStartDate)} for the full
                duration
              </>
            }
          />
          {error?.fieldError("availabilityConfirmed") ? (
            <p className="mt-1 text-xs font-medium text-red-600">
              {error.fieldError("availabilityConfirmed")}
            </p>
          ) : null}
        </div>
        <Field label="Available from (if later)" htmlFor="quote-available-from" error={error?.fieldError("availableFrom")}>
          <TextInput
            id="quote-available-from"
            type="date"
            value={form.availableFrom}
            onChange={(value) => set("availableFrom", value)}
            invalid={Boolean(error?.fieldError("availableFrom"))}
          />
        </Field>
      </div>

      <Checkbox
        id="quote-terms"
        checked={form.acceptsCommercialTerms}
        onChange={(value) => set("acceptsCommercialTerms", value)}
        label="I accept SML's commercial terms as stated above"
      />

      <Field
        label="Deviation from terms (optional)"
        htmlFor="quote-deviation"
        hint="Anything you cannot accept. Recorded against your quote."
      >
        <TextArea
          id="quote-deviation"
          value={form.deviationText}
          onChange={(value) => set("deviationText", value)}
          rows={2}
        />
      </Field>

      <Field label="Remarks (optional)" htmlFor="quote-remarks">
        <TextArea id="quote-remarks" value={form.remarks} onChange={(value) => set("remarks", value)} rows={2} />
      </Field>

      {needsChart ? (
        <Field
          label="Load chart"
          htmlFor="quote-chart"
          required={mode === "create"}
          hint="Required: a quotation without a load chart cannot be evaluated."
        >
          <input
            id="quote-chart"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={(event) => setChart(event.target.files?.[0] ?? null)}
            className="field-input text-xs"
          />
        </Field>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Paperclip className="size-3.5" aria-hidden />
          Load chart already on file for this crane — no attachment needed.
        </p>
      )}

      <PreviewPanel preview={previewData} loading={preview.isFetching} />

      {warnings.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <WarningList warnings={warnings} />
          <Checkbox
            id="quote-warnings-ack"
            checked={warningsAcknowledged}
            onChange={setWarningsAcknowledged}
            label="I have read these points and want to quote anyway"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={!canSend}
          onClick={() => mutation.mutate({ chart })}
        >
          <Send className="mr-1.5 inline size-4" aria-hidden />
          {mutation.isPending
            ? "Sending…"
            : mode === "create"
              ? "Send quote"
              : mode === "reinstate"
                ? "Send quote"
                : "Send revision"}
        </button>
        {onCancel ? (
          <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {!canSend && !mutation.isPending && blockedReason === null ? (
          <p className="self-center text-xs text-slate-500">
            {form.craneId === ""
              ? "Choose a crane to continue."
              : !form.availabilityConfirmed
                ? "Confirm the crane's availability to continue."
              : !form.acceptsCommercialTerms
                ? "Accept the commercial terms to continue."
                : warnings.length > 0 && !warningsAcknowledged
                  ? "Confirm you have read the points above."
                  : needsChart && chart === null && mode === "create"
                    ? "Attach the load chart to continue."
                    : ""}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Brief D2: add a crane without leaving the quotation. It is deliberately a
 * subset of the fleet form — only the fields a quote cannot proceed without
 * (brief 5.2's mandatory set). Anything else is finished later on My Fleet,
 * because a vendor mid-quote should not be made to run the whole screen.
 *
 * It posts through the same `createCrane` endpoint as My Fleet, so the duplicate
 * rule, the coordinates and the status rules are enforced in exactly one place.
 */
function InlineCraneAdd({
  onCreated,
  onCancel,
}: {
  onCreated: (craneId: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CraneForm>({ ...EMPTY_CRANE_FORM });
  const [availableFrom, setAvailableFrom] = useState("");
  const reference = useQuery({
    queryKey: ["fleet", "reference-data"],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: () =>
      createCrane(form, {
        availableFrom: form.currentStatus === "ENGAGED" ? availableFrom : null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["cranes"] });
      onCreated(result.crane.id);
    },
  });

  const error = create.error as ApiError | null;
  const set = <K extends keyof CraneForm>(key: K, value: CraneForm[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const craneTypes = (reference.data?.craneTypes ?? []).map((c) => ({ value: c.code, label: c.name }));
  const states = (reference.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }));
  const engaged = form.currentStatus === "ENGAGED";

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/40 p-4">
      <p className="text-sm font-medium text-slate-900">Add a crane to your fleet</p>
      <p className="mt-0.5 text-xs text-slate-500">
        The essentials. You can complete the rest — boom and jib lengths, map pin, load chart — on My
        Fleet afterwards.
      </p>

      {error ? <Alert title="Could not add this crane">{error.message}</Alert> : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Type of crane" htmlFor="inline-type" required error={error?.fieldError("typeOfCraneCode")}>
          <Select
            id="inline-type"
            value={form.typeOfCraneCode}
            onChange={(value) => set("typeOfCraneCode", value)}
            options={craneTypes}
            placeholder="Select a type"
            invalid={Boolean(error?.fieldError("typeOfCraneCode"))}
          />
        </Field>
        <Field label="Capacity (t)" htmlFor="inline-capacity" required error={error?.fieldError("capacityT")}>
          <TextInput
            id="inline-capacity"
            value={form.capacityT}
            onChange={(value) => set("capacityT", value)}
            inputMode="numeric"
            invalid={Boolean(error?.fieldError("capacityT"))}
          />
        </Field>
        <Field label="Make" htmlFor="inline-make" required error={error?.fieldError("make")}>
          <TextInput id="inline-make" value={form.make} onChange={(value) => set("make", value)} invalid={Boolean(error?.fieldError("make"))} />
        </Field>
        <Field label="Model" htmlFor="inline-model" required error={error?.fieldError("model")}>
          <TextInput id="inline-model" value={form.model} onChange={(value) => set("model", value)} invalid={Boolean(error?.fieldError("model"))} />
        </Field>
        <Field label="Year of manufacture" htmlFor="inline-yom" required error={error?.fieldError("yom")} hint="Four digits.">
          <TextInput id="inline-yom" value={form.yom} onChange={(value) => set("yom", value)} inputMode="numeric" placeholder="2021" invalid={Boolean(error?.fieldError("yom"))} />
        </Field>
        <Field label="Main boom (m)" htmlFor="inline-boom" required error={error?.fieldError("mainBoomM")}>
          <TextInput id="inline-boom" value={form.mainBoomM} onChange={(value) => set("mainBoomM", value)} inputMode="numeric" invalid={Boolean(error?.fieldError("mainBoomM"))} />
        </Field>
        <Field
          label="Serial / registration number"
          htmlFor="inline-serial"
          required
          error={error?.fieldError("serialRegistrationNo")}
          hint="Unique among your active cranes."
        >
          <TextInput id="inline-serial" value={form.serialRegistrationNo} onChange={(value) => set("serialRegistrationNo", value)} invalid={Boolean(error?.fieldError("serialRegistrationNo"))} />
        </Field>
        <Field label="Status" htmlFor="inline-status" required>
          <Select
            id="inline-status"
            value={form.currentStatus}
            onChange={(value) => set("currentStatus", value)}
            options={VENDOR_STATUSES.map((status) => ({ value: status, label: CRANE_STATUS_LABELS[status] }))}
          />
        </Field>
        <Field label="Current location" htmlFor="inline-location" required error={error?.fieldError("currentLocation")} className="sm:col-span-2">
          <TextInput id="inline-location" value={form.currentLocation} onChange={(value) => set("currentLocation", value)} placeholder="e.g. Ahmedabad Yard" invalid={Boolean(error?.fieldError("currentLocation"))} />
        </Field>
        <Field label="State" htmlFor="inline-state" required error={error?.fieldError("stateCode")}>
          <Select
            id="inline-state"
            value={form.stateCode}
            onChange={(value) => set("stateCode", value)}
            options={states}
            placeholder="Select a state"
            invalid={Boolean(error?.fieldError("stateCode"))}
          />
        </Field>
        {engaged ? (
          <Field
            label="Available from"
            htmlFor="inline-available-from"
            required
            error={error?.fieldError("availableFrom")}
            hint="Today or later."
          >
            <TextInput
              id="inline-available-from"
              type="date"
              value={availableFrom}
              onChange={setAvailableFrom}
              invalid={Boolean(error?.fieldError("availableFrom"))}
            />
          </Field>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Adding…" : "Add crane and use it"}
        </button>
        <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PreviewPanel({ preview, loading }: { preview?: QuotationPreview; loading: boolean }) {
  if (!preview) {
    return (
      <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-500">
        {loading ? "Calculating…" : "Choose a crane and enter a rate to see the total."}
      </div>
    );
  }

  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-medium text-slate-500">Your total</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-900">
        {formatInr(preview.totalQuotedValue)}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <ReadOnlyValue label="Rental charge" value={formatInr(preview.rentalCharge)} />
        <ReadOnlyValue label="Mobilisation" value={formatInr(preview.mobilisationCharges)} />
        <ReadOnlyValue label="Demobilisation" value={formatInr(preview.demobilisationCharges)} />
        <ReadOnlyValue
          label="Distance"
          value={
            preview.distanceKm === null
              ? "—"
              : `${preview.distanceKm.toFixed(1)} km${preview.distanceApproximate ? " (approx.)" : ""}`
          }
        />
      </dl>
      <p className="mt-2 text-xs text-slate-500">{preview.calculationNote}</p>
    </div>
  );
}

function WarningList({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1">
      {warnings.map((warning) => (
        <li key={warning.code} className="flex items-start gap-1.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
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

  return (
    <div className="card p-5">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <History className="size-4" aria-hidden />
          Quote history
        </span>
        <span className="text-xs text-slate-500">{open ? "Hide" : "Show every version"}</span>
      </button>

      {open ? (
        <div className="mt-4">
          {history.isLoading ? (
            <p className="text-sm text-slate-500">Loading history…</p>
          ) : history.error ? (
            <Alert>{(history.error as ApiError).message}</Alert>
          ) : (
            <div className="space-y-4">
              {(history.data?.series ?? []).map((series) => (
                <div key={series.craneId}>
                  <p className="text-sm font-medium text-slate-900">{series.craneLabel}</p>
                  <ol className="mt-2 space-y-2 border-l-2 border-slate-100 pl-4">
                    {series.versions.map((version) => (
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
                          <span className="ml-auto text-xs font-semibold text-slate-900">
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
              {(history.data?.series ?? []).length === 0 ? (
                <p className="text-sm text-slate-500">No history.</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A crane that has since been deactivated drops out of the active fleet, which
 * would leave a locked revision's picker blank. The stored label is added back in
 * that case so the vendor can still see which crane the version belongs to.
 */
function craneOptions(cranes: Crane[], fallback: { id: string; label: string } | null) {
  const options = cranes.map(craneOption);
  if (fallback && !cranes.some((crane) => crane.id === fallback.id)) {
    options.push({ value: fallback.id, label: `${fallback.label} (no longer active)` });
  }
  return options;
}

function craneOption(crane: Crane) {
  const chart = crane.loadChart ? "load chart on file" : "no load chart";
  return {
    value: crane.id,
    label: `${crane.typeOfCrane?.name ?? crane.typeOfCraneCode} · ${crane.capacityT} t · ${crane.currentLocation} (${crane.currentStatus.toLowerCase()}, ${chart})`,
  };
}

/**
 * Form → request body. The crane id is omitted on a revision: the series is
 * identified by the crane that was already quoted, and letting the request change
 * it would split one crane's trail in two.
 */
function toInput(form: FormState): QuoteInput {
  return {
    craneId: form.craneId || undefined,
    rentalRate: form.rentalRate,
    rateBasis: form.rateBasis as QuoteInput["rateBasis"],
    mobilisationCharges: form.mobilisationCharges || 0,
    demobilisationCharges: form.demobilisationCharges || 0,
    taxBasis: (form.taxBasis as QuoteInput["taxBasis"]) ?? "EXCLUSIVE_OF_GST",
    availabilityConfirmed: form.availabilityConfirmed,
    availableFrom: form.availableFrom || null,
    validityDate: form.validityDate,
    acceptsCommercialTerms: form.acceptsCommercialTerms,
    deviationText: form.deviationText || null,
    remarks: form.remarks || null,
  };
}

/**
 * A revision belongs to the version series of the crane already quoted, and the
 * backend's revise schema has no `craneId` at all — repeating it would be a claim
 * that moving a revision onto another crane is possible, forking one series in
 * two. The preview payload still carries the crane, because that endpoint
 * validates one and needs it to price and to measure distance.
 */
function withoutCrane(input: QuoteInput): QuoteInput {
  const { craneId: _craneId, ...rest } = input;
  return rest;
}

/**
 * Holds a value still for `delay` ms.
 *
 * The running total is a server call, so without this a rate typed as "125000"
 * would fire six previews and the last one to answer would not necessarily be the
 * right one. Debouncing keeps the figure in step with what is on screen.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

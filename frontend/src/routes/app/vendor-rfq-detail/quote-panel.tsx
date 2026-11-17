import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Paperclip, Send } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  Checkbox,
  Field,
  ReadOnlyValue,
  Section,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCalendarDate } from "@/lib/format";
import {
  formatInr,
  previewQuotation,
  RATE_BASIS_LABELS,
  submitQuotation,
  type QuotationPreview,
  type QuoteInput,
  type VendorQuotation,
  type VendorRfqDetail,
} from "@/lib/quotations";
import {
  createCrane,
  CRANE_STATUS_LABELS,
  EMPTY_CRANE_FORM,
  fetchReferenceData,
  listCranes,
  NEW_CRANE_STATUSES,
  type Crane,
  type CraneForm,
} from "@/lib/fleet";
import { fitLabel, fleetFit, type FitVerdict } from "./fit";

/**
 * The quote panel: pick a crane, price it, read the server's total, send it.
 *
 * The panel keeps every field and every guard the old form had. What changed is
 * the order and the help around it: the fleet-fit hint above the picker, the
 * draft that survives a phone call, the previous quote that can be copied, and
 * the review block that repeats the server total immediately above the send
 * button. Warnings still do not block; the button stays live.
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

export type FormState = typeof EMPTY_FORM;

const DEFAULTS_KEY = "vendor-quote-defaults";

function draftKey(rfqId: string): string {
  return `vendor-quote-draft:${rfqId}`;
}

/** localStorage is best-effort: a private window must not stop a quote. */
function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeFlag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Remembered bases only, so a stale crane or rate is never silently reused. */
function storedDefaults(): Partial<FormState> {
  const raw = readJson(DEFAULTS_KEY);
  if (!raw) return {};
  const rateBasis = safeString(raw.rateBasis);
  const taxBasis = safeString(raw.taxBasis);
  return {
    ...(rateBasis === "PER_DAY" || rateBasis === "PER_MONTH" || rateBasis === "LUMP_SUM"
      ? { rateBasis }
      : {}),
    ...(taxBasis === "INCLUSIVE_OF_GST" || taxBasis === "EXCLUSIVE_OF_GST" ? { taxBasis } : {}),
  };
}

function storedDraft(rfqId: string): Partial<FormState> | null {
  const raw = readJson(draftKey(rfqId));
  if (!raw) return null;
  const draft: Partial<FormState> = {
    craneId: safeString(raw.craneId) ?? "",
    rentalRate: safeString(raw.rentalRate) ?? "",
    mobilisationCharges: safeString(raw.mobilisationCharges) ?? "",
    demobilisationCharges: safeString(raw.demobilisationCharges) ?? "",
    availableFrom: safeString(raw.availableFrom) ?? "",
    validityDate: safeString(raw.validityDate) ?? "",
    deviationText: safeString(raw.deviationText) ?? "",
    remarks: safeString(raw.remarks) ?? "",
  };
  const rateBasis = safeString(raw.rateBasis);
  if (rateBasis === "PER_DAY" || rateBasis === "PER_MONTH" || rateBasis === "LUMP_SUM") {
    draft.rateBasis = rateBasis;
  }
  const taxBasis = safeString(raw.taxBasis);
  if (taxBasis === "INCLUSIVE_OF_GST" || taxBasis === "EXCLUSIVE_OF_GST") {
    draft.taxBasis = taxBasis;
  }
  const availability = safeFlag(raw.availabilityConfirmed);
  if (availability !== null) draft.availabilityConfirmed = availability;
  const accepts = safeFlag(raw.acceptsCommercialTerms);
  if (accepts !== null) draft.acceptsCommercialTerms = accepts;
  return draft;
}

/** Digits and one decimal point only — the preview receives a clean number. */
export function cleanMoney(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  return rest.length === 0 ? whole : `${whole}.${rest.join("").slice(0, 2)}`;
}

function formatMoney(value: string): string {
  const cleaned = cleanMoney(value);
  if (cleaned === "") return "";
  const number = Number(cleaned);
  if (Number.isNaN(number)) return value;
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(number);
}

function initialForm(rfqId: string): FormState {
  return {
    ...EMPTY_FORM,
    ...storedDefaults(),
    ...(storedDraft(rfqId) ?? {}),
  };
}

export function QuotePanel({
  rfqId,
  rfq,
  quotations,
  onQuoted,
}: {
  rfqId: string;
  rfq: VendorRfqDetail["rfq"];
  quotations: VendorQuotation[];
  onQuoted?: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(rfqId));
  const queryClient = useQueryClient();

  const cranes = useQuery({ queryKey: ["cranes"], queryFn: () => listCranes() });
  const fleet = useMemo(
    () => fleetFit(cranes.data?.cranes ?? [], rfq),
    [cranes.data, rfq],
  );

  // The last live version is the best starting point for a second crane.
  const previousQuote = useMemo(
    () => quotations.find((quotation) => quotation.isLatest && quotation.status !== "WITHDRAWN") ?? null,
    [quotations],
  );

  // A quote can take a phone call to finish; the draft stays on this device only.
  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey(rfqId), JSON.stringify(form));
    } catch {
      // Storage disabled or full — quoting still works.
    }
  }, [rfqId, form]);

  const submit = useMutation({
    mutationFn: ({ chart }: { chart: File | null }) => submitQuotation(rfqId, toInput(form), chart),
    onSuccess: () => {
      try {
        window.localStorage.removeItem(draftKey(rfqId));
        window.localStorage.setItem(
          DEFAULTS_KEY,
          JSON.stringify({ rateBasis: form.rateBasis, taxBasis: form.taxBasis }),
        );
      } catch {
        // Nothing to clean up.
      }
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
      fit={fleet.verdicts}
      fitMatches={fleet.matches}
      fitTotal={fleet.total}
      selectedCrane={cranes.data?.cranes.find((crane) => crane.id === form.craneId) ?? null}
      mutation={submit}
      mode="create"
      previousQuote={previousQuote}
      quotedCraneIds={quotations
        .filter((quotation) => quotation.status !== "WITHDRAWN")
        .map((quotation) => quotation.craneId)}
    />
  );
}

export type FormMutation = {
  mutate: (variables: { chart: File | null }) => void;
  isPending: boolean;
  error: unknown;
};

export function QuoteForm({
  rfq,
  form,
  setForm,
  cranes,
  cranesLoading,
  fit,
  fitMatches,
  fitTotal,
  selectedCrane,
  mutation,
  mode,
  craneLocked = false,
  lockedCraneFallback = null,
  onCancel,
  previousQuote = null,
  quotedCraneIds = [],
}: {
  rfq: VendorRfqDetail["rfq"];
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  cranes: Crane[];
  cranesLoading: boolean;
  fit?: Map<string, FitVerdict>;
  fitMatches?: number;
  fitTotal?: number;
  selectedCrane: Crane | null;
  mutation: FormMutation;
  /** "reinstate" is a revision of a version the vendor had withdrawn. */
  mode: "create" | "revise" | "reinstate";
  craneLocked?: boolean;
  lockedCraneFallback?: { id: string; label: string } | null;
  onCancel?: () => void;
  previousQuote?: VendorQuotation | null;
  /** Cranes already quoted on this RFQ, so the tagged list can show what is left. */
  quotedCraneIds?: string[];
}) {
  const taggedIds = rfq.taggedCraneIds ?? [];
  const taggedCranes = cranes.filter((crane) => taggedIds.includes(crane.id));
  const [chart, setChart] = useState<File | null>(null);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [addingCrane, setAddingCrane] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const error = mutation.error as ApiError | null;

  // The backend owns the arithmetic (brief 6.4), so the live figure comes from
  // preview and is only refreshed when a field that moves money changes. Debounced
  // so typing a rate does not fire a request per keystroke.
  const pricedInput = useMemo(() => toInput(form), [form]);
  const debouncedInput = useDebouncedValue(pricedInput, 400);

  const preview = useQuery({
    queryKey: ["quotation-preview", rfq.rfqId, debouncedInput],
    queryFn: () => previewQuotation(rfq.rfqId, debouncedInput),
    enabled: form.craneId !== "" && !mutation.isPending,
    staleTime: 0,
  });

  useEffect(() => {
    if (error) setSubmitted(false);
  }, [error]);

  const previewData = preview.data?.preview;
  const warnings = previewData?.warnings ?? [];
  const needsChart = selectedCrane ? !selectedCrane.loadChart : true;
  const blockedReason = previewData?.blockedReason ?? null;
  const warningsConfirmed = warnings.length === 0 || warningsAcknowledged;

  const canSend =
    form.craneId !== "" &&
    cleanMoney(form.rentalRate) !== "" &&
    form.validityDate !== "" &&
    // The backend requires both answers explicitly rather than treating a
    // missing field as consent, so the button waits for them here too.
    form.availabilityConfirmed &&
    form.acceptsCommercialTerms &&
    (needsChart ? chart !== null || mode !== "create" : true) &&
    warningsConfirmed &&
    !mutation.isPending &&
    !submitted &&
    !blockedReason;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const copyPrevious = () => {
    if (!previousQuote) return;
    setForm((previous) => ({
      ...previous,
      craneId: previousQuote.craneId,
      rentalRate: String(previousQuote.rentalRate),
      rateBasis: previousQuote.rateBasis,
      mobilisationCharges: String(previousQuote.mobilisationCharges),
      demobilisationCharges:
        previousQuote.demobilisationCharges === null
          ? ""
          : String(previousQuote.demobilisationCharges),
      taxBasis: previousQuote.taxBasis,
      availableFrom: previousQuote.availableFrom ?? "",
      validityDate: previousQuote.validityDate,
      deviationText: previousQuote.deviationText ?? "",
      remarks: previousQuote.remarks ?? "",
    }));
  };

  const send = () => {
    if (!canSend) return;
    setSubmitted(true);
    mutation.mutate({ chart });
  };

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
      actions={
        previousQuote && mode === "create" ? (
          <button
            type="button"
            onClick={copyPrevious}
            className="btn-secondary min-h-10 px-3 py-1.5 text-xs"
          >
            <Copy className="size-3.5" aria-hidden />
            Copy from my previous quote
          </button>
        ) : null
      }
    >
      {error ? <Alert title="Could not send your quote">{error.message}</Alert> : null}
      {blockedReason ? (
        <Alert tone="info" title="Not available for a quote">
          {blockedReason}
        </Alert>
      ) : null}

      {!craneLocked && taggedCranes.length > 0 ? (
        <div className="rounded-lg border border-accent-500/40 bg-accent-500/[0.06] p-3">
          <p className="text-xs font-medium text-slate-900">
            SML tagged {taggedCranes.length === 1 ? "this crane" : `these ${taggedCranes.length} cranes`}{" "}
            for this RFQ
          </p>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Quote each tagged crane, one after another. You can also quote any other crane from your
            fleet using the list below.
          </p>
          <ul className="mt-2 space-y-1.5">
            {taggedCranes.map((crane) => {
              const quoted = quotedCraneIds.includes(crane.id);
              const active = form.craneId === crane.id;
              return (
                <li key={crane.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate text-slate-800">
                    {crane.typeOfCrane?.name ?? crane.typeOfCraneCode} · {crane.capacityT} t ·{" "}
                    {crane.currentLocation}
                  </span>
                  {quoted ? (
                    <span className="shrink-0 font-medium text-emerald-600">Quoted</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => set("craneId", crane.id)}
                      disabled={active}
                      className="btn-secondary min-h-8 shrink-0 px-2.5 py-1 text-xs"
                    >
                      {active ? "Selected" : "Quote this crane"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {!craneLocked ? (
        <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
          {cranesLoading ? (
            <p className="text-xs text-slate-500">Checking your fleet against this requirement…</p>
          ) : (fitTotal ?? 0) === 0 ? (
            <p className="text-xs text-slate-500">
              No active cranes in your fleet yet. You can add one below.
            </p>
          ) : (
            <>
              <p className="text-xs font-medium text-slate-800">
                <span className="text-slate-900 tabular-nums">{fitMatches ?? 0}</span> of your{" "}
                {fitTotal} {fitTotal === 1 ? "crane" : "cranes"} match this requirement
              </p>
              <p className="mt-0.5 text-[13px] text-slate-500">
                Type, capacity ({rfq.capacityRule === "EXACT" ? "exact" : "at least"}{" "}
                {rfq.capacityT} t)
                {rfq.mainBoomM !== null ? ` and ${rfq.mainBoomM} m boom` : ""} checked on paper. The
                preview below is the final check.
              </p>
            </>
          )}
        </div>
      ) : null}

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
              : "Tagged cranes come first; every crane in your fleet can be quoted."
        }
      >
        <Select
          id="quote-crane"
          value={form.craneId}
          onChange={(value) => set("craneId", value)}
          disabled={craneLocked}
          options={craneOptions(cranes, lockedCraneFallback, fit, taggedIds)}
          placeholder={cranesLoading ? "Loading your cranes…" : "Select a crane"}
        />
        {!craneLocked ? (
          <div className="mt-2">
            <button
              type="button"
              className="min-h-10 text-xs font-medium text-brand-700 underline underline-offset-2"
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
        <MoneyField
          id="quote-rate"
          label="Rental rate"
          required
          value={form.rentalRate}
          onChange={(value) => set("rentalRate", value)}
          error={error?.fieldError("rentalRate")}
        />
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
        <MoneyField
          id="quote-mob"
          label="Mobilisation charges"
          hint="Added to the rental charge to give the total."
          value={form.mobilisationCharges}
          onChange={(value) => set("mobilisationCharges", value)}
          error={error?.fieldError("mobilisationCharges")}
        />
        <MoneyField
          id="quote-demob"
          label="Demobilisation charges"
          hint="Return transport. Added to the total beside mobilisation."
          value={form.demobilisationCharges}
          onChange={(value) => set("demobilisationCharges", value)}
          error={error?.fieldError("demobilisationCharges")}
        />
        <Field
          label="Tax basis"
          htmlFor="quote-tax"
          hint="A declaration for comparing quotes; it does not change the total."
        >
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
        <Field
          label="Quote valid until"
          htmlFor="quote-validity"
          required
          error={error?.fieldError("validityDate")}
        >
          <TextInput
            id="quote-validity"
            type="date"
            value={form.validityDate}
            onChange={(value) => set("validityDate", value)}
            invalid={Boolean(error?.fieldError("validityDate"))}
          />
        </Field>
      </div>

      <div className="space-y-4">
        <div>
          <p className="field-label">
            Availability<span className="ml-0.5 text-red-600">*</span>
          </p>
          <Checkbox
            id="quote-available"
            checked={form.availabilityConfirmed}
            onChange={(value) => set("availabilityConfirmed", value)}
            label={
              rfq.startDateTbc
                ? "This crane is available for the full required duration"
                : `This crane is available from ${formatCalendarDate(rfq.requiredStartDate)} for the full duration`
            }
          />
          {error?.fieldError("availabilityConfirmed") ? (
            <p className="mt-1 text-xs font-medium text-red-600">
              {error.fieldError("availabilityConfirmed")}
            </p>
          ) : null}
        </div>
        <Field
          label="Available from (if later)"
          htmlFor="quote-available-from"
          error={error?.fieldError("availableFrom")}
        >
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
        <TextArea
          id="quote-remarks"
          value={form.remarks}
          onChange={(value) => set("remarks", value)}
          rows={2}
        />
      </Field>

      {needsChart ? (
        <Field
          label="Load chart"
          htmlFor="quote-chart"
          required={mode === "create"}
          hint="Required: a quotation without a load chart cannot be evaluated."
        >
          <label
            htmlFor="quote-chart"
            className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-ink-700 bg-ink-900/60 px-3 py-5 text-center transition-colors hover:border-ink-600 hover:bg-ink-850 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/25"
          >
            <Paperclip
              className={cn("size-4", chart ? "text-emerald-600" : "text-slate-500")}
              aria-hidden
            />
            {chart ? (
              <>
                <span className="max-w-full truncate text-sm font-medium text-slate-800">
                  {chart.name}
                </span>
                <span className="text-[13px] text-slate-500">
                  Click to choose a different file
                </span>
              </>
            ) : (
              <>
                <span className="text-sm text-slate-700">
                  Choose a PDF or image of the load chart
                </span>
                <span className="text-[13px] text-slate-500">PDF, PNG or JPG · one file</span>
              </>
            )}
            <input
              id="quote-chart"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(event) => setChart(event.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </label>
        </Field>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Paperclip className="size-3.5" aria-hidden />
          Load chart already on file for this crane — no attachment needed.
        </p>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-semibold tracking-[0.08em] text-slate-500 uppercase">
          Review before sending
        </p>
        <PreviewPanel preview={previewData} loading={preview.isFetching} />
      </div>

      {warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <WarningList warnings={warnings} />
          <div className="mt-2">
            <Checkbox
              id="quote-warnings-ack"
              checked={warningsAcknowledged}
              onChange={setWarningsAcknowledged}
              label="I have read these points and want to quote anyway"
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-4">
        <button
          type="button"
          className="btn-primary min-h-11 px-4 text-sm"
          disabled={!canSend}
          onClick={send}
        >
          <Send className="size-4" aria-hidden />
          {mutation.isPending
            ? "Sending…"
            : submitted
              ? "Quote sent"
              : mode === "create" || mode === "reinstate"
                ? "Send quote"
                : "Send revision"}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="btn-secondary min-h-11 px-4 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
        {!canSend && !mutation.isPending && !submitted && blockedReason === null ? (
          <p className="self-center text-xs text-slate-500">
            {form.craneId === ""
              ? "Choose a crane to continue."
              : cleanMoney(form.rentalRate) === ""
                ? "Enter a rental rate to continue."
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

/** An INR field: digits while typing, grouped on blur, clean in the request. */
function MoneyField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error}>
      <TextInput
        id={id}
        value={value}
        onChange={(next) => onChange(cleanMoney(next))}
        onFocus={() => onChange(cleanMoney(value))}
        onBlur={() => onChange(formatMoney(value))}
        inputMode="decimal"
        placeholder="0.00"
        invalid={Boolean(error)}
      />
    </Field>
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

  const craneTypes = (reference.data?.craneTypes ?? []).map((c) => ({
    value: c.code,
    label: c.name,
  }));
  const states = (reference.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }));
  const engaged = form.currentStatus === "ENGAGED";

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
      <p className="text-sm font-medium text-slate-900">Add a crane to your fleet</p>
      <p className="mt-0.5 text-xs text-slate-500">
        The essentials. You can complete the rest — boom and jib lengths, map pin, load chart — on My
        Fleet afterwards.
      </p>

      {error ? <Alert title="Could not add this crane">{error.message}</Alert> : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Type of crane"
          htmlFor="inline-type"
          required
          error={error?.fieldError("typeOfCraneCode")}
        >
          <Select
            id="inline-type"
            value={form.typeOfCraneCode}
            onChange={(value) => set("typeOfCraneCode", value)}
            options={craneTypes}
            placeholder="Select a type"
            invalid={Boolean(error?.fieldError("typeOfCraneCode"))}
          />
        </Field>
        <Field
          label="Capacity (t)"
          htmlFor="inline-capacity"
          required
          error={error?.fieldError("capacityT")}
        >
          <TextInput
            id="inline-capacity"
            value={form.capacityT}
            onChange={(value) => set("capacityT", value)}
            inputMode="numeric"
            invalid={Boolean(error?.fieldError("capacityT"))}
          />
        </Field>
        <Field label="Make" htmlFor="inline-make" required error={error?.fieldError("make")}>
          <TextInput
            id="inline-make"
            value={form.make}
            onChange={(value) => set("make", value)}
            invalid={Boolean(error?.fieldError("make"))}
          />
        </Field>
        <Field label="Model" htmlFor="inline-model" required error={error?.fieldError("model")}>
          <TextInput
            id="inline-model"
            value={form.model}
            onChange={(value) => set("model", value)}
            invalid={Boolean(error?.fieldError("model"))}
          />
        </Field>
        <Field
          label="Year of manufacture"
          htmlFor="inline-yom"
          required
          error={error?.fieldError("yom")}
          hint="Four digits."
        >
          <TextInput
            id="inline-yom"
            value={form.yom}
            onChange={(value) => set("yom", value)}
            inputMode="numeric"
            placeholder="2021"
            invalid={Boolean(error?.fieldError("yom"))}
          />
        </Field>
        <Field
          label="Main boom (m)"
          htmlFor="inline-boom"
          required
          error={error?.fieldError("mainBoomM")}
        >
          <TextInput
            id="inline-boom"
            value={form.mainBoomM}
            onChange={(value) => set("mainBoomM", value)}
            inputMode="numeric"
            invalid={Boolean(error?.fieldError("mainBoomM"))}
          />
        </Field>
        <Field
          label="Serial / registration number"
          htmlFor="inline-serial"
          required
          error={error?.fieldError("serialRegistrationNo")}
          hint="Unique among your active cranes."
        >
          <TextInput
            id="inline-serial"
            value={form.serialRegistrationNo}
            onChange={(value) => set("serialRegistrationNo", value)}
            invalid={Boolean(error?.fieldError("serialRegistrationNo"))}
          />
        </Field>
        <Field label="Status" htmlFor="inline-status" required>
          <Select
            id="inline-status"
            value={form.currentStatus}
            onChange={(value) => set("currentStatus", value)}
            options={NEW_CRANE_STATUSES.map((status) => ({
              value: status,
              label: CRANE_STATUS_LABELS[status],
            }))}
          />
        </Field>
        <Field
          label="Current location"
          htmlFor="inline-location"
          required
          error={error?.fieldError("currentLocation")}
          className="sm:col-span-2"
        >
          <TextInput
            id="inline-location"
            value={form.currentLocation}
            onChange={(value) => set("currentLocation", value)}
            placeholder="e.g. Ahmedabad Yard"
            invalid={Boolean(error?.fieldError("currentLocation"))}
          />
        </Field>
        <Field
          label="State"
          htmlFor="inline-state"
          required
          error={error?.fieldError("stateCode")}
        >
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
          className="btn-primary min-h-11 px-4 text-sm"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Adding…" : "Add crane and use it"}
        </button>
        <button
          type="button"
          className="btn-secondary min-h-11 px-4 text-sm"
          onClick={onCancel}
          disabled={create.isPending}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The server's total, always in the same place, with the note that explains it. */
export function PreviewPanel({
  preview,
  loading,
}: {
  preview?: QuotationPreview;
  loading: boolean;
}) {
  if (!preview) {
    return (
      <div className="min-h-16 rounded-lg border border-ink-800 bg-ink-900 p-3 text-xs text-slate-500">
        {loading ? "Calculating…" : "Choose a crane and enter a rate to see the total."}
      </div>
    );
  }

  return (
    <div className="min-h-28 rounded-lg border border-brand-500/40 bg-brand-50 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <p className="text-xs font-medium text-slate-600">Your total</p>
        <p className="text-xl font-semibold text-slate-900 tabular-nums">
          {formatInr(preview.totalQuotedValue)}
        </p>
      </div>
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
        <ReadOnlyValue
          label="Tax basis"
          value={preview.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive of GST" : "Exclusive of GST"}
        />
      </dl>
      <p className="mt-2 text-xs text-slate-600">{preview.calculationNote}</p>
      {preview.blockedReason ? (
        <p className="mt-1 text-xs font-medium text-red-700">{preview.blockedReason}</p>
      ) : null}
    </div>
  );
}

export function WarningList({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
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

/**
 * A crane that has since been deactivated drops out of the active fleet, which
 * would leave a locked revision's picker blank. The stored label is added back in
 * that case so the vendor can still see which crane the version belongs to.
 */
export function craneOptions(
  cranes: Crane[],
  fallback: { id: string; label: string } | null,
  fit?: Map<string, FitVerdict>,
  taggedIds: string[] = [],
) {
  // Tagged cranes lead the list; the rest of the fleet follows, still quotable.
  const ordered = [
    ...cranes.filter((crane) => taggedIds.includes(crane.id)),
    ...cranes.filter((crane) => !taggedIds.includes(crane.id)),
  ];
  const options = ordered.map((crane) => {
    const option = craneOption(crane, fit?.get(crane.id));
    return taggedIds.includes(crane.id) ? { ...option, label: `★ Tagged · ${option.label}` } : option;
  });
  if (fallback && !cranes.some((crane) => crane.id === fallback.id)) {
    options.push({ value: fallback.id, label: `${fallback.label} (no longer active)` });
  }
  return options;
}

function craneOption(crane: Crane, verdict?: FitVerdict) {
  const chart = crane.loadChart ? "load chart on file" : "no load chart";
  const base = `${crane.typeOfCrane?.name ?? crane.typeOfCraneCode} · ${crane.capacityT} t · ${crane.currentLocation} (${crane.currentStatus.toLowerCase()}, ${chart})`;
  return {
    value: crane.id,
    label: verdict ? `${base} — ${fitLabel(verdict)}` : base,
  };
}

/**
 * Form → request body. The crane id is omitted on a revision: the series is
 * identified by the crane that was already quoted, and letting the request change
 * it would split one crane's trail in two.
 */
export function toInput(form: FormState): QuoteInput {
  return {
    craneId: form.craneId || undefined,
    rentalRate: cleanMoney(form.rentalRate),
    rateBasis: form.rateBasis as QuoteInput["rateBasis"],
    mobilisationCharges: cleanMoney(form.mobilisationCharges) || 0,
    demobilisationCharges: cleanMoney(form.demobilisationCharges) || 0,
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
export function withoutCrane(input: QuoteInput): QuoteInput {
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


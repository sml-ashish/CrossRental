import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  EMPTY_ENQUIRY_FORM,
  addLine,
  createEnquiry,
  emptyLine,
  enquiryToForm,
  getEnquiry,
  getLine,
  lineToForm,
  updateEnquiry,
  updateLine,
  type EnquiryForm,
  type EnquiryLineForm,
} from "@/lib/enquiries";
import { fetchReferenceData, type ReferenceOption } from "@/lib/fleet";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import {
  Field,
  Section,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui/form";

/**
 * Enquiry intake form (P1 section 2).
 *
 * Two screens share the line editor: create (header plus any number of new
 * lines) and the single-line editor used to add a line to an existing enquiry or
 * correct one. An enquiry captures the crane requirement and the terms SML may
 * carry into an RFQ; vendor-specific terms are chosen when the RFQ is raised.
 */

export function EnquiryFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { enquiryId?: string };
  const editing = Boolean(params.enquiryId);

  const reference = useQuery({
    queryKey: ["reference-data"],
    queryFn: fetchReferenceData,
  });
  const existing = useQuery({
    queryKey: ["enquiry", params.enquiryId],
    queryFn: () => getEnquiry(params.enquiryId as string),
    enabled: editing,
  });

  const [form, setForm] = useState<EnquiryForm>(EMPTY_ENQUIRY_FORM);
  const [lines, setLines] = useState<EnquiryLineForm[]>([emptyLine()]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (editing && existing.data && !loaded) {
    setForm(enquiryToForm(existing.data.enquiry));
    setLoaded(true);
  }

  const set = <K extends keyof EnquiryForm>(key: K, value: EnquiryForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (editing) {
        await updateEnquiry(params.enquiryId as string, form);
        await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
        void navigate({
          to: "/app/enquiries/$enquiryId",
          params: { enquiryId: params.enquiryId as string },
        });
      } else {
        const created = await createEnquiry(form, lines);
        await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
        void navigate({
          to: "/app/enquiries/$enquiryId",
          params: { enquiryId: created.enquiry.id },
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the enquiry.");
    } finally {
      setSaving(false);
    }
  }

  if (editing && existing.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (editing && existing.isError) {
    return <Alert tone="error">Could not load that enquiry.</Alert>;
  }

  const u = (key: keyof EnquiryForm) => ({
    value: form[key] as string,
    onChange: (value: string) => set(key, value as never),
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageHeader
        title={editing ? "Edit enquiry" : "New enquiry"}
        description="Capture the state, city and crane requirement. Vendor terms are chosen when the RFQ is raised."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Section title="Enquiry" description="Where the crane is needed.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Enquiry date" htmlFor="enquiryDate">
            <TextInput id="enquiryDate" type="date" {...u("enquiryDate")} />
          </Field>
          <Field label="State" htmlFor="siteStateCode" required>
            <Select
              id="siteStateCode"
              value={form.siteStateCode}
              onChange={(value) => set("siteStateCode", value)}
              options={(reference.data?.states ?? []).map((s: ReferenceOption) => ({
                value: s.code,
                label: s.name,
              }))}
            />
          </Field>
          <Field label="City" htmlFor="shipToCity" required>
            <TextInput id="shipToCity" {...u("shipToCity")} />
          </Field>
        </div>
      </Section>

      {editing ? null : (
        <Section
          title="Line items"
          description="Each line is one crane requirement and is sourced separately."
        >
          <div className="space-y-4">
            {lines.map((line, index) => (
              <LineFields
                key={index}
                idPrefix={`line-${index}`}
                value={line}
                onChange={(next) =>
                  setLines((prev) => prev.map((l, i) => (i === index ? next : l)))
                }
                onRemove={
                  lines.length > 1
                    ? () => setLines((prev) => prev.filter((_, i) => i !== index))
                    : undefined
                }
                craneTypes={reference.data?.craneTypes ?? []}
                title={`Line ${index + 1}`}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
          >
            <Plus className="size-4" aria-hidden />
            Add another line
          </button>
        </Section>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : editing ? "Save enquiry" : "Create enquiry"}
        </button>
        <Link
          to={editing ? "/app/enquiries/$enquiryId" : "/app/enquiries"}
          params={editing ? { enquiryId: params.enquiryId as string } : {}}
          className="btn-secondary"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

// --- single line editor -----------------------------------------------------

/** Add a line to an enquiry, or correct one (P1). */
export function EnquiryLineEditorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as {
    enquiryId?: string;
    lineId?: string;
  };
  const editing = Boolean(params.lineId);

  const reference = useQuery({
    queryKey: ["reference-data"],
    queryFn: fetchReferenceData,
  });
  const existing = useQuery({
    queryKey: ["line", params.lineId],
    queryFn: () => getLine(params.lineId as string),
    enabled: editing,
  });

  const [line, setLine] = useState<EnquiryLineForm>(emptyLine());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (editing && existing.data && !loaded) {
    setLine(lineToForm(existing.data.line));
    setLoaded(true);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (editing) {
        await updateLine(params.lineId as string, line);
        const enquiryId = existing.data?.line.enquiryId ?? params.enquiryId;
        await queryClient.invalidateQueries({ queryKey: ["line", params.lineId] });
        void navigate({
          to: "/app/enquiries/$enquiryId",
          params: { enquiryId: enquiryId as string },
        });
      } else {
        await addLine(params.enquiryId as string, line);
        await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
        void navigate({
          to: "/app/enquiries/$enquiryId",
          params: { enquiryId: params.enquiryId as string },
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the line.");
    } finally {
      setSaving(false);
    }
  }

  if (editing && existing.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageHeader title={editing ? "Edit line item" : "Add line item"} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <LineFields
        idPrefix="line"
        value={line}
        onChange={setLine}
        craneTypes={reference.data?.craneTypes ?? []}
        title="Requirement"
      />
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save line"}
        </button>
      </div>
    </form>
  );
}

// --- the line fields (shared) ----------------------------------------------

function LineFields({
  idPrefix,
  title,
  value,
  onChange,
  onRemove,
  craneTypes,
}: {
  idPrefix: string;
  title: string;
  value: EnquiryLineForm;
  onChange: (next: EnquiryLineForm) => void;
  onRemove?: () => void;
  craneTypes: ReferenceOption[];
}) {
  const set = <K extends keyof EnquiryLineForm>(key: K, v: EnquiryLineForm[K]) =>
    onChange({ ...value, [key]: v });
  const t = (key: keyof EnquiryLineForm) => ({
    value: value[key] as string,
    onChange: (v: string) => set(key, v as never),
  });

  const craneOptions = useMemo(
    () => craneTypes.map((c) => ({ value: c.code, label: c.name })),
    [craneTypes],
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-ink-850 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove
          </button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Crane type" htmlFor={`${idPrefix}-type`} required>
          <Select
            id={`${idPrefix}-type`}
            value={value.craneTypeCode}
            onChange={(v) => set("craneTypeCode", v)}
            options={craneOptions}
          />
        </Field>
        <Field label="Crane model" htmlFor={`${idPrefix}-model`}>
          <TextInput id={`${idPrefix}-model`} {...t("craneModel")} />
        </Field>
        <Field label="YOM" htmlFor={`${idPrefix}-yom`}>
          <TextInput id={`${idPrefix}-yom`} inputMode="numeric" {...t("yom")} />
        </Field>
        <Field label="Capacity (t)" htmlFor={`${idPrefix}-capacity`} required>
          <TextInput id={`${idPrefix}-capacity`} inputMode="decimal" {...t("capacityT")} />
        </Field>
        <Field label="Weight to be lifted (t)" htmlFor={`${idPrefix}-lift`}>
          <TextInput id={`${idPrefix}-lift`} inputMode="decimal" {...t("liftLoadT")} />
        </Field>
        <Field label="Height to be lifted (m)" htmlFor={`${idPrefix}-lift-height`}>
          <TextInput id={`${idPrefix}-lift-height`} inputMode="decimal" {...t("liftHeightM")} />
        </Field>
      </div>

      <Field label="Application description" htmlFor={`${idPrefix}-app`}>
        <TextArea id={`${idPrefix}-app`} rows={2} {...t("applicationDescription")} />
      </Field>

      <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Crane configuration
        </p>
        <Field label="Crane configuration (e.g. MB 60 + FJ 12)" htmlFor={`${idPrefix}-config-name`} className="mt-3">
          <TextInput id={`${idPrefix}-config-name`} {...t("craneConfiguration")} />
        </Field>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        <Field label="Required start" htmlFor={`${idPrefix}-start`}>
          <TextInput id={`${idPrefix}-start`} type="date" {...t("requiredStartDate")} />
        </Field>
        <Field label="Duration" htmlFor={`${idPrefix}-dur`}>
          <TextInput id={`${idPrefix}-dur`} inputMode="decimal" {...t("durationValue")} />
        </Field>
        <Field label="Duration unit" htmlFor={`${idPrefix}-unit`}>
          <Select
            id={`${idPrefix}-unit`}
            value={value.durationUnit}
            onChange={(v) => set("durationUnit", v as EnquiryLineForm["durationUnit"])}
            options={[
              { value: "DAYS", label: "Days" },
              { value: "MONTHS", label: "Months" },
            ]}
            placeholder="Days"
          />
        </Field>
        <Field label="Working days / month" htmlFor={`${idPrefix}-wdm`}>
          <TextInput id={`${idPrefix}-wdm`} inputMode="numeric" {...t("workingDaysPerMonth")} />
        </Field>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="OT charges" htmlFor={`${idPrefix}-ot`}>
          <TextInput id={`${idPrefix}-ot`} {...t("otCharges")} />
        </Field>
        <Field label="Breakdown Charges" htmlFor={`${idPrefix}-bd`}>
          <TextInput id={`${idPrefix}-bd`} {...t("breakdownTerms")} />
        </Field>
        <Field label="Diesel scope" htmlFor={`${idPrefix}-diesel`}>
          <TextInput id={`${idPrefix}-diesel`} {...t("dieselScope")} />
        </Field>
        <Field label="Working hours (per day)" htmlFor={`${idPrefix}-hours`}>
          <TextInput id={`${idPrefix}-hours`} {...t("workingHoursPerDay")} />
        </Field>
        <Field label="Shift" htmlFor={`${idPrefix}-shift`}>
          <TextInput id={`${idPrefix}-shift`} {...t("shift")} />
        </Field>
        <Field label="Crane age criterion (years)" htmlFor={`${idPrefix}-age`}>
          <TextInput id={`${idPrefix}-age`} inputMode="numeric" {...t("craneAgeCriteriaYears")} />
        </Field>
        <Field label="Support crane" htmlFor={`${idPrefix}-support`}>
          <TextInput id={`${idPrefix}-support`} {...t("supportCraneScope")} />
        </Field>
        <Field label="Steel mats / ground prep" htmlFor={`${idPrefix}-mats`}>
          <TextInput id={`${idPrefix}-mats`} {...t("steelMatsGroundPrepScope")} />
        </Field>
        <Field label="EHS / HR requirements" htmlFor={`${idPrefix}-ehs`}>
          <TextInput id={`${idPrefix}-ehs`} {...t("ehsHrCompliance")} />
        </Field>
        <Field label="Insurance Coverage" htmlFor={`${idPrefix}-ins`}>
          <TextInput id={`${idPrefix}-ins`} {...t("insuranceTerms")} />
        </Field>
      </div>

      <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Scope terms
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Additional manpower" htmlFor={`${idPrefix}-manpower`}>
            <TextInput id={`${idPrefix}-manpower`} {...t("additionalManpowerScope")} />
          </Field>
          <Field label="Right of way (ROW)" htmlFor={`${idPrefix}-row`}>
            <TextInput id={`${idPrefix}-row`} {...t("rowScope")} />
          </Field>
        </div>
      </div>
    </div>
  );
}

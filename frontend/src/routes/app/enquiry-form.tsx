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
 * correct one. The line fields are the 31 the template carries, including the
 * five scope terms and the internal-only block.
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
        description="Customer and commercial details stay internal and are never sent to vendors."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Section title="Enquiry" description="Who the job is for, and where it is.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Enquiry date" htmlFor="enquiryDate">
            <TextInput id="enquiryDate" type="date" {...u("enquiryDate")} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer name" htmlFor="customerName" required>
            <TextInput id="customerName" {...u("customerName")} />
          </Field>
          <Field label="Site location" htmlFor="siteLocation" required>
            <TextInput id="siteLocation" {...u("siteLocation")} />
          </Field>
        </div>
        <Field label="Customer address" htmlFor="customerAddress" required>
          <TextArea id="customerAddress" rows={2} {...u("customerAddress")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
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
          <Field label="Pincode" htmlFor="sitePincode">
            <TextInput id="sitePincode" {...u("sitePincode")} />
          </Field>
          <Field label="Region" htmlFor="region">
            <TextInput id="region" {...u("region")} />
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
        <Field label="Capacity (t)" htmlFor={`${idPrefix}-capacity`} required>
          <TextInput id={`${idPrefix}-capacity`} inputMode="decimal" {...t("capacityT")} />
        </Field>
        <Field label="Capacity rule" htmlFor={`${idPrefix}-rule`}>
          <Select
            id={`${idPrefix}-rule`}
            value={value.capacityRule}
            onChange={(v) => set("capacityRule", v as EnquiryLineForm["capacityRule"])}
            options={[
              { value: "AT_LEAST", label: "At least" },
              { value: "EXACT", label: "Exactly" },
            ]}
            placeholder="At least"
          />
        </Field>
        <Field label="Quantity" htmlFor={`${idPrefix}-qty`}>
          <TextInput id={`${idPrefix}-qty`} inputMode="numeric" {...t("quantity")} />
        </Field>
        <Field label="Lift load (t)" htmlFor={`${idPrefix}-lift`}>
          <TextInput id={`${idPrefix}-lift`} inputMode="decimal" {...t("liftLoadT")} />
        </Field>
        <Field label="Working radius (m)" htmlFor={`${idPrefix}-radius`}>
          <TextInput id={`${idPrefix}-radius`} inputMode="decimal" {...t("workingRadiusM")} />
        </Field>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Application description" htmlFor={`${idPrefix}-app`}>
          <TextArea id={`${idPrefix}-app`} rows={2} {...t("applicationDescription")} />
        </Field>
        <Field label="Load description" htmlFor={`${idPrefix}-load`}>
          <TextArea id={`${idPrefix}-load`} rows={2} {...t("loadDescription")} />
        </Field>
      </div>
      <Field label="Capacity note" htmlFor={`${idPrefix}-capNote`}>
        <TextInput id={`${idPrefix}-capNote`} {...t("capacityNote")} />
      </Field>

      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        <Field label="Main boom (m)" htmlFor={`${idPrefix}-mb`}>
          <TextInput id={`${idPrefix}-mb`} inputMode="decimal" {...t("requiredMainBoomM")} />
        </Field>
        <Field label="Fixed jib (m)" htmlFor={`${idPrefix}-fj`}>
          <TextInput id={`${idPrefix}-fj`} inputMode="decimal" {...t("requiredFixedJibM")} />
        </Field>
        <Field label="Luffing jib (m)" htmlFor={`${idPrefix}-lj`}>
          <TextInput id={`${idPrefix}-lj`} inputMode="decimal" {...t("requiredLuffingJibM")} />
        </Field>
        <Field label="Wind jib (m)" htmlFor={`${idPrefix}-wj`}>
          <TextInput id={`${idPrefix}-wj`} inputMode="decimal" {...t("requiredWindJibM")} />
        </Field>
      </div>
      <Field label="Configuration notes" htmlFor={`${idPrefix}-config`}>
        <TextInput id={`${idPrefix}-config`} {...t("configurationNotes")} />
      </Field>

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
        <Field label="Breakdown terms" htmlFor={`${idPrefix}-bd`}>
          <TextInput id={`${idPrefix}-bd`} {...t("breakdownTerms")} />
        </Field>
        <Field label="Diesel scope" htmlFor={`${idPrefix}-diesel`}>
          <TextInput id={`${idPrefix}-diesel`} {...t("dieselScope")} />
        </Field>
        <Field label="Working hours / shift" htmlFor={`${idPrefix}-shift`}>
          <TextInput id={`${idPrefix}-shift`} {...t("workingHoursShift")} />
        </Field>
        <Field label="Accommodation / conveyance" htmlFor={`${idPrefix}-accom`}>
          <TextInput id={`${idPrefix}-accom`} {...t("accommodationConveyance")} />
        </Field>
        <Field label="Payment terms" htmlFor={`${idPrefix}-pay`}>
          <TextInput id={`${idPrefix}-pay`} {...t("paymentTerms")} />
        </Field>
        <Field label="Mobilisation terms" htmlFor={`${idPrefix}-mob`}>
          <TextInput id={`${idPrefix}-mob`} {...t("mobilisationTerms")} />
        </Field>
        <Field label="Demobilisation terms" htmlFor={`${idPrefix}-demob`}>
          <TextInput id={`${idPrefix}-demob`} {...t("demobilisationTerms")} />
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
        <Field label="Insurance terms" htmlFor={`${idPrefix}-ins`}>
          <TextInput id={`${idPrefix}-ins`} {...t("insuranceTerms")} />
        </Field>
        <Field label="Extension clause" htmlFor={`${idPrefix}-ext`}>
          <TextInput id={`${idPrefix}-ext`} {...t("extensionClause")} />
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
          <Field label="Intra-site movement" htmlFor={`${idPrefix}-intra`}>
            <TextInput id={`${idPrefix}-intra`} {...t("intraSiteMovementScope")} />
          </Field>
          <Field label="Pre-release terms" htmlFor={`${idPrefix}-prerelease`}>
            <TextInput id={`${idPrefix}-prerelease`} {...t("prereleaseTerms")} />
          </Field>
          <Field label="PPE" htmlFor={`${idPrefix}-ppe`}>
            <TextInput id={`${idPrefix}-ppe`} {...t("ppeScope")} />
          </Field>
          <Field label="Right of way (ROW)" htmlFor={`${idPrefix}-row`} className="sm:col-span-2">
            <TextInput id={`${idPrefix}-row`} {...t("rowScope")} />
          </Field>
        </div>
        <Field label="Other terms" htmlFor={`${idPrefix}-other`} className="mt-4">
          <TextArea id={`${idPrefix}-other`} rows={2} {...t("otherTerms")} />
        </Field>
      </div>

      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
          Internal only
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Rental per month" htmlFor={`${idPrefix}-budget`}>
            <TextInput id={`${idPrefix}-budget`} {...t("rentalBudget")} />
          </Field>
        </div>
      </div>
    </div>
  );
}

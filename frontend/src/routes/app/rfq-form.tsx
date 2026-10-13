import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import {
  EMPTY_RFQ_FORM,
  createRfq,
  getRfq,
  rfqToForm,
  updateRfq,
  type RfqForm,
} from "@/lib/rfqs";
import { fetchReferenceData } from "@/lib/fleet";
import { Alert } from "@/components/ui/alert";
import { Field, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";

/**
 * Creating and editing an RFQ (brief 7.9, fields from 5.4).
 *
 * Both share one screen and one serialisation, because the second version of a
 * form is the first one with something missed in it. Only a draft is editable —
 * the backend refuses once it is sent, since the requirement is already in
 * vendor inboxes by then and changing it silently would invalidate quotations
 * being prepared against it.
 *
 * The job-site pin is typed rather than dragged. Brief 4 open item 1 puts the
 * mapping provider on hold and 6.8 asks for a placeholder map until one is
 * chosen, so the coordinates are entered directly and the site stays "location
 * unverified" until they are. That is not a shortcut around the requirement:
 * the backend accepts a confirmed pin exactly as it would a dragged one, and
 * the picker reports distances as unavailable until one exists.
 */

export function RfqFormPage() {
  const { rfqId } = useParams({ strict: false }) as { rfqId?: string };
  const isEdit = Boolean(rfqId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<RfqForm>(EMPTY_RFQ_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const reference = useQuery({ queryKey: ["reference-data"], queryFn: fetchReferenceData });

  const existing = useQuery({
    queryKey: ["rfq", rfqId],
    queryFn: () => getRfq(rfqId as string),
    enabled: isEdit,
  });

  useEffect(() => {
    if (existing.data?.rfq) setForm(rfqToForm(existing.data.rfq));
  }, [existing.data]);

  // Once sent, the fields are read-only. The backend enforces it too; this just
  // avoids showing an editable form whose save would be refused.
  const locked = existing.data?.rfq ? existing.data.rfq.status !== "DRAFT" : false;

  const save = useMutation({
    mutationFn: () =>
      isEdit ? updateRfq(rfqId as string, form) : createRfq(form),
    onSuccess: (result) => {
      setFieldErrors({});
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void queryClient.invalidateQueries({ queryKey: ["rfq", result.rfq.id] });
      // Straight to the detail screen: that is where the candidate picker and the
      // send action live, so a saved draft has somewhere to go next.
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: result.rfq.id } });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldErrors(
          Object.fromEntries(error.details.map((detail) => [detail.path, detail.message])),
        );
      }
    },
  });

  function set<K extends keyof RfqForm>(key: K, value: RfqForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setFieldErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  const stateOptions = useMemo(
    () => (reference.data?.states ?? []).map((s) => ({ value: s.code, label: s.name })),
    [reference.data],
  );
  const craneTypeOptions = useMemo(
    () => (reference.data?.craneTypes ?? []).map((t) => ({ value: t.code, label: t.name })),
    [reference.data],
  );

  if (isEdit && existing.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading the RFQ
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">
          {isEdit ? `Edit ${existing.data?.rfq.rfqNumber ?? "RFQ"}` : "Create RFQ"}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          One RFQ covers one enquiry line item. Saving stores a draft; vendors are only
          emailed when you send it.
        </p>
      </header>

      {locked ? (
        <Alert tone="info" title="This RFQ has already been sent">
          Its requirement is in the recipients&rsquo; inboxes, so it can no longer be edited.
          Extend the deadline or cancel it instead.
        </Alert>
      ) : null}

      {save.isError && !(save.error instanceof ApiError && save.error.details.length > 0) ? (
        <Alert title="The RFQ was not saved">{(save.error as Error).message}</Alert>
      ) : null}

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Section
          title="Enquiry line item"
          description="Typed in for now. The SAP feed replaces these two fields in a later phase."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Enquiry number" htmlFor="rfq-enquiry" required error={fieldErrors.enquiryNo}>
              <TextInput
                id="rfq-enquiry"
                value={form.enquiryNo}
                onChange={(v) => set("enquiryNo", v)}
                disabled={locked}
                invalid={Boolean(fieldErrors.enquiryNo)}
                placeholder="SP/2026/0412"
              />
            </Field>
            <Field label="Line number" htmlFor="rfq-line" required error={fieldErrors.lineNo}>
              <TextInput
                id="rfq-line"
                value={form.lineNo}
                onChange={(v) => set("lineNo", v)}
                disabled={locked}
                invalid={Boolean(fieldErrors.lineNo)}
                placeholder="10"
              />
            </Field>
          </div>
        </Section>

        <Section title="Requirement">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Crane type" htmlFor="rfq-crane-type" required error={fieldErrors.craneType}>
              <Select
                id="rfq-crane-type"
                value={form.craneType}
                onChange={(v) => set("craneType", v)}
                options={craneTypeOptions}
                placeholder="Choose a crane type"
                disabled={locked}
                invalid={Boolean(fieldErrors.craneType)}
              />
            </Field>
            <Field
              label="Capacity (t)"
              htmlFor="rfq-capacity"
              required
              error={fieldErrors.capacityT}
              hint="Cranes at or above this capacity are offered as candidates."
            >
              <TextInput
                id="rfq-capacity"
                value={form.capacityT}
                onChange={(v) => set("capacityT", v)}
                inputMode="decimal"
                disabled={locked}
                invalid={Boolean(fieldErrors.capacityT)}
              />
            </Field>
            <Field label="Quantity" htmlFor="rfq-quantity" required error={fieldErrors.quantity}>
              <TextInput
                id="rfq-quantity"
                value={form.quantity}
                onChange={(v) => set("quantity", v)}
                inputMode="numeric"
                disabled={locked}
                invalid={Boolean(fieldErrors.quantity)}
              />
            </Field>
          </div>
          <Field
            label="Configuration"
            htmlFor="rfq-configuration"
            hint="Main boom and luffing jib lengths, as the enquiry mail states them."
          >
            <TextArea
              id="rfq-configuration"
              value={form.configuration}
              onChange={(v) => set("configuration", v)}
              disabled={locked}
              placeholder="Main boom 60 m, luffing jib 50 m"
            />
          </Field>
        </Section>

        <Section
          title="Job site"
          description="Distances to this point are what the candidate picker sorts on."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              className="sm:col-span-2"
              label="Location"
              htmlFor="rfq-site"
              required
              error={fieldErrors.siteLocation}
            >
              <TextInput
                id="rfq-site"
                value={form.siteLocation}
                onChange={(v) => set("siteLocation", v)}
                disabled={locked}
                invalid={Boolean(fieldErrors.siteLocation)}
                placeholder="Vadodara, Gujarat"
              />
            </Field>
            <Field label="State" htmlFor="rfq-site-state" required error={fieldErrors.siteStateCode}>
              <Select
                id="rfq-site-state"
                value={form.siteStateCode}
                onChange={(v) => set("siteStateCode", v)}
                options={stateOptions}
                placeholder="Choose a state"
                disabled={locked}
                invalid={Boolean(fieldErrors.siteStateCode)}
              />
            </Field>
          </div>
          <Field label="Pincode" htmlFor="rfq-pincode" hint="Optional, but it sharpens the lookup.">
            <TextInput
              id="rfq-pincode"
              value={form.sitePincode}
              onChange={(v) => set("sitePincode", v)}
              inputMode="numeric"
              disabled={locked}
            />
          </Field>

          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-700">Site pin</p>
            <p className="mt-1 text-xs text-slate-500">
              Left blank, the site is looked up automatically. Entering a latitude and
              longitude yourself marks the pin as confirmed and takes precedence over any
              automatic result.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Latitude" htmlFor="rfq-lat" error={fieldErrors.siteLatitude}>
                <TextInput
                  id="rfq-lat"
                  value={form.siteLatitude}
                  onChange={(v) => set("siteLatitude", v)}
                  inputMode="decimal"
                  placeholder="22.3072"
                  disabled={locked}
                  invalid={Boolean(fieldErrors.siteLatitude)}
                />
              </Field>
              <Field label="Longitude" htmlFor="rfq-lng" error={fieldErrors.siteLongitude}>
                <TextInput
                  id="rfq-lng"
                  value={form.siteLongitude}
                  onChange={(v) => set("siteLongitude", v)}
                  inputMode="decimal"
                  placeholder="73.1812"
                  disabled={locked}
                  invalid={Boolean(fieldErrors.siteLongitude)}
                />
              </Field>
            </div>
          </div>
        </Section>

        <Section title="Deployment">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Required start date"
              htmlFor="rfq-start"
              required
              error={fieldErrors.requiredStartDate}
            >
              <TextInput
                id="rfq-start"
                type="date"
                value={form.requiredStartDate}
                onChange={(v) => set("requiredStartDate", v)}
                disabled={locked}
                invalid={Boolean(fieldErrors.requiredStartDate)}
              />
            </Field>
            <Field label="Duration" htmlFor="rfq-duration" required error={fieldErrors.durationValue}>
              <TextInput
                id="rfq-duration"
                value={form.durationValue}
                onChange={(v) => set("durationValue", v)}
                inputMode="decimal"
                disabled={locked}
                invalid={Boolean(fieldErrors.durationValue)}
              />
            </Field>
            <Field label="Unit" htmlFor="rfq-duration-unit" required error={fieldErrors.durationUnit}>
              <Select
                id="rfq-duration-unit"
                value={form.durationUnit}
                onChange={(v) => set("durationUnit", v as RfqForm["durationUnit"])}
                options={[
                  { value: "DAYS", label: "Days" },
                  { value: "MONTHS", label: "Months" },
                ]}
                placeholder="Unit"
                disabled={locked}
              />
            </Field>
          </div>
          <Field
            label="Submission deadline"
            htmlFor="rfq-deadline"
            required
            error={fieldErrors.submissionDeadline}
            hint="When vendors must have quoted by. Must be in the future."
          >
            <TextInput
              id="rfq-deadline"
              type="datetime-local"
              value={form.submissionDeadline}
              onChange={(v) => set("submissionDeadline", v)}
              disabled={locked}
              invalid={Boolean(fieldErrors.submissionDeadline)}
            />
          </Field>
        </Section>

        <Section
          title="Commercial terms"
          description="Defaults from the enquiry mail. Every term stays editable per RFQ, because a customer's payment terms are often the thing being negotiated."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="OT charges" htmlFor="rfq-ot">
              <TextInput
                id="rfq-ot"
                value={form.otCharges}
                onChange={(v) => set("otCharges", v)}
                disabled={locked}
                placeholder="As per agreement"
              />
            </Field>
            <Field label="Breakdown charges" htmlFor="rfq-breakdown">
              <TextInput
                id="rfq-breakdown"
                value={form.breakdownTerms}
                onChange={(v) => set("breakdownTerms", v)}
                disabled={locked}
                placeholder="As per agreement"
              />
            </Field>
            <Field label="Diesel scope" htmlFor="rfq-diesel">
              <TextInput
                id="rfq-diesel"
                value={form.dieselScope}
                onChange={(v) => set("dieselScope", v)}
                disabled={locked}
                placeholder="To SML"
              />
            </Field>
            <Field label="Working hours / shift" htmlFor="rfq-hours">
              <TextInput
                id="rfq-hours"
                value={form.workingHoursShift}
                onChange={(v) => set("workingHoursShift", v)}
                disabled={locked}
                placeholder="8 hours per shift"
              />
            </Field>
            <Field
              label="Crane age criteria (years)"
              htmlFor="rfq-age"
              error={fieldErrors.craneAgeCriteriaYears}
            >
              <TextInput
                id="rfq-age"
                value={form.craneAgeCriteriaYears}
                onChange={(v) => set("craneAgeCriteriaYears", v)}
                inputMode="numeric"
                disabled={locked}
                invalid={Boolean(fieldErrors.craneAgeCriteriaYears)}
                placeholder="15"
              />
            </Field>
            <Field label="Accommodation & conveyance" htmlFor="rfq-accommodation">
              <TextInput
                id="rfq-accommodation"
                value={form.accommodationConveyance}
                onChange={(v) => set("accommodationConveyance", v)}
                disabled={locked}
                placeholder="As per agreement"
              />
            </Field>
            <Field label="Payment terms" htmlFor="rfq-payment">
              <TextInput
                id="rfq-payment"
                value={form.paymentTerms}
                onChange={(v) => set("paymentTerms", v)}
                disabled={locked}
                placeholder="30 days from invoice"
              />
            </Field>
          </div>
          <Field label="Notes" htmlFor="rfq-notes">
            <TextArea
              id="rfq-notes"
              value={form.notes}
              onChange={(v) => set("notes", v)}
              disabled={locked}
            />
          </Field>
        </Section>

        <Section title="SML contact" description="Shown to every vendor this RFQ is sent to.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="rfq-contact-name">
              <TextInput
                id="rfq-contact-name"
                value={form.smlContactName}
                onChange={(v) => set("smlContactName", v)}
                disabled={locked}
              />
            </Field>
            <Field label="Mobile" htmlFor="rfq-contact-mobile">
              <TextInput
                id="rfq-contact-mobile"
                value={form.smlContactMobile}
                onChange={(v) => set("smlContactMobile", v)}
                inputMode="tel"
                disabled={locked}
              />
            </Field>
            <Field label="Email" htmlFor="rfq-contact-email" error={fieldErrors.smlContactEmail}>
              <TextInput
                id="rfq-contact-email"
                type="email"
                value={form.smlContactEmail}
                onChange={(v) => set("smlContactEmail", v)}
                inputMode="email"
                disabled={locked}
                invalid={Boolean(fieldErrors.smlContactEmail)}
              />
            </Field>
          </div>
        </Section>

        {!locked ? (
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="btn-primary px-5 py-2.5 text-sm"
              disabled={save.isPending}
            >
              {save.isPending ? <Spinner /> : null}
              {isEdit ? "Save changes" : "Save draft"}
            </button>
            <p className="text-xs text-slate-500">
              {isEdit
                ? "Saving keeps the RFQ a draft until you send it."
                : "You will pick vendors and send it on the next screen."}
            </p>
          </div>
        ) : null}
      </form>
    </div>
  );
}

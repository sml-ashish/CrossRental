import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import {
  createCrane,
  craneToForm,
  duplicateCrane,
  EMPTY_CRANE_FORM,
  fetchReferenceData,
  getCrane,
  updateCrane,
  VENDOR_STATUSES,
  CRANE_STATUS_LABELS,
  type CraneForm,
} from "@/lib/fleet";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Field, Section, Select, TextArea, TextInput } from "@/components/ui/form";

/**
 * Add and edit a crane (brief 5.2, 6.1-6.3).
 *
 * One screen serves create, edit and "duplicate this crane", because the three
 * differ only in where the initial values come from. Duplicating in particular
 * must not be a separate form: the vendor still reviews every field, and the
 * serial is left blank so the copy cannot silently collide with the original.
 *
 * The status dropdown offers only the three vendor-settable values. Booked and
 * Hired are set by SML when a contract is signed, so they are not choices here
 * — an edit of such a crane is blocked by the backend, and this screen does not
 * pretend otherwise.
 */

const LENGTH_HINT = "Metres. Leave blank or enter NA if this crane has none.";

/** True when the vendor asked to be Engaged, which is what makes availableFrom required. */
function needsAvailableFrom(form: CraneForm): boolean {
  return form.currentStatus === "ENGAGED";
}

/** Brief D4: the expected-ready date only applies while under maintenance. */
function needsExpectedReadyDate(form: CraneForm): boolean {
  return form.currentStatus === "UNDER_MAINTENANCE";
}

function defaultAvailableFrom(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function CraneFormPage() {
  const { craneId } = useParams({ strict: false }) as { craneId?: string };
  const search = useSearch({ strict: false }) as {
    duplicate?: string;
    /** Brief D1: an SML user writes this vendor's fleet on their behalf. */
    vendorId?: string;
  };
  const onBehalfVendorId = search.vendorId;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const isEdit = Boolean(craneId);
  const duplicateOf = search.duplicate;

  const [form, setForm] = useState<CraneForm>(EMPTY_CRANE_FORM);
  const [availableFrom, setAvailableFrom] = useState<string>(defaultAvailableFrom);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const reference = useQuery({
    queryKey: ["fleet", "reference-data"],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,
  });

  const existing = useQuery({
    queryKey: ["fleet", "crane", craneId],
    queryFn: () => getCrane(craneId as string),
    enabled: isEdit,
  });

  const duplicate = useQuery({
    queryKey: ["fleet", "duplicate", duplicateOf],
    queryFn: () => duplicateCrane(duplicateOf as string),
    enabled: Boolean(duplicateOf),
  });

  // Load the values into the form once, whichever screen produced them. Every
  // path resets first so switching between edit and duplicate never leaves a
  // stale field behind.
  useEffect(() => {
    if (isEdit && existing.data) {
      setForm(craneToForm(existing.data.crane));
    } else if (duplicateOf && duplicate.data) {
      const prefill = duplicate.data.prefill;
      setForm({
        ...EMPTY_CRANE_FORM,
        typeOfCraneCode: prefill.typeOfCraneCode ?? "",
        capacityT: prefill.capacityT === undefined ? "" : String(prefill.capacityT),
        currentStatus: "AVAILABLE",
        currentLocation: prefill.currentLocation ?? "",
        stateCode: prefill.stateCode ?? "",
        make: prefill.make ?? "",
        model: prefill.model ?? "",
        yom: prefill.yom === undefined ? "" : String(prefill.yom),
        mainBoomM: prefill.mainBoomM === null || prefill.mainBoomM === undefined ? "" : String(prefill.mainBoomM),
        fixedJibM: prefill.fixedJibM === null || prefill.fixedJibM === undefined ? "" : String(prefill.fixedJibM),
        luffingJibM: prefill.luffingJibM === null || prefill.luffingJibM === undefined ? "" : String(prefill.luffingJibM),
        windJibM: prefill.windJibM === null || prefill.windJibM === undefined ? "" : String(prefill.windJibM),
        // Never carried over: a copy needs its own registration number.
        serialRegistrationNo: "",
        pincode: prefill.pincode ?? "",
        remarks: prefill.remarks ?? "",
      });
    } else if (!isEdit && !duplicateOf) {
      setForm(EMPTY_CRANE_FORM);
    }
  }, [isEdit, existing.data, duplicateOf, duplicate.data]);

  const save = useMutation({
    mutationFn: () => {
      const payload = withAvailableFrom(form, availableFrom);
      // On edit, only Engaged asserts a date and only Available clears it; Under
      // Maintenance must omit the field so the date already on the crane stays.
      const editAvailableFrom =
        form.currentStatus === "ENGAGED"
          ? availableFrom
          : form.currentStatus === "AVAILABLE"
            ? null
            : undefined;
      return isEdit
        ? updateCrane(craneId as string, form, { availableFrom: editAvailableFrom })
        : createCrane(payload, {
            vendorId: onBehalfVendorId,
            availableFrom: payload.availableFrom,
          });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
      void queryClient.invalidateQueries({ queryKey: ["vendors"] });
      if (onBehalfVendorId) {
        void navigate({
          to: "/app/vendors/$vendorId",
          params: { vendorId: onBehalfVendorId },
        });
        return;
      }
      void navigate({ to: "/app/fleet", search: { notice: `${result.crane.serialRegistrationNo} saved` } });
    },
    onError: (error: unknown) => {
      setFormError(error instanceof Error ? error.message : "The crane could not be saved.");
      if (error instanceof ApiError) {
        const next: Record<string, string> = {};
        for (const detail of error.details) next[detail.path] = detail.message;
        setFieldErrors(next);
      }
    },
  });

  const statusOptions = useMemo(
    () =>
      VENDOR_STATUSES.map((status) => ({
        value: status,
        label: CRANE_STATUS_LABELS[status],
      })),
    [],
  );

  const craneTypeOptions = (reference.data?.craneTypes ?? []).map((c) => ({ value: c.code, label: c.name }));
  const stateOptions = (reference.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }));

  const set = <K extends keyof CraneForm>(key: K, value: CraneForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  const loading = (isEdit && existing.isLoading) || (duplicateOf ? duplicate.isLoading : false);
  const locked = Boolean(existing.data && (existing.data.crane.currentStatus === "BOOKED" || existing.data.crane.currentStatus === "HIRED"));

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-500" role="status">
        <Spinner /> Loading crane
      </div>
    );
  }

  if (isEdit && existing.isError) {
    return <Alert tone="error">{existing.error instanceof Error ? existing.error.message : "Not found."}</Alert>;
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">
          {isEdit ? "Edit crane" : duplicateOf ? "Add a similar crane" : "Add a crane"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Fields marked <span className="text-red-600">*</span> are required. The serial or registration
          number must be the one on the crane&apos;s registration certificate.
        </p>
      </header>

      {formError ? <Alert tone="error">{formError}</Alert> : null}

      {duplicateOf ? (
        <Alert tone="info" title="Copied from an existing crane">
          This is a new record. Check every field and give it its own serial or registration number.
        </Alert>
      ) : null}

      {onBehalfVendorId ? (
        <Alert tone="info" title="Updating on the vendor's behalf">
          This change is recorded as made by SML on the vendor&apos;s behalf, and the vendor is
          notified on their dashboard and by email.
        </Alert>
      ) : null}

      {locked ? (
        <Alert tone="info" title="This crane is on an SML contract">
          Its status is managed by SML and cannot be changed here. The rest of the details can still be
          corrected.
        </Alert>
      ) : null}

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          save.mutate();
        }}
        noValidate
      >
        <Section title="Identification" description="What this crane is and which crane it is.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Type of crane"
              htmlFor="typeOfCraneCode"
              required
              error={fieldErrors.typeOfCraneCode}
            >
              <Select
                id="typeOfCraneCode"
                value={form.typeOfCraneCode}
                onChange={(v) => set("typeOfCraneCode", v)}
                options={craneTypeOptions}
                placeholder="Select a type"
                invalid={Boolean(fieldErrors.typeOfCraneCode)}
              />
            </Field>

            <Field
              label="Serial / registration number"
              htmlFor="serialRegistrationNo"
              required
              error={fieldErrors.serialRegistrationNo}
              hint="Must be unique among your active cranes. “NA” is not accepted."
            >
              <TextInput
                id="serialRegistrationNo"
                value={form.serialRegistrationNo}
                onChange={(v) => set("serialRegistrationNo", v)}
                invalid={Boolean(fieldErrors.serialRegistrationNo)}
              />
            </Field>

            <Field label="Make" htmlFor="make" required error={fieldErrors.make}>
              <TextInput id="make" value={form.make} onChange={(v) => set("make", v)} invalid={Boolean(fieldErrors.make)} />
            </Field>

            <Field label="Model" htmlFor="model" required error={fieldErrors.model}>
              <TextInput id="model" value={form.model} onChange={(v) => set("model", v)} invalid={Boolean(fieldErrors.model)} />
            </Field>

            <Field
              label="Year of manufacture"
              htmlFor="yom"
              required
              error={fieldErrors.yom}
              hint="Four digits."
            >
              <TextInput
                id="yom"
                value={form.yom}
                onChange={(v) => set("yom", v)}
                inputMode="numeric"
                placeholder="2021"
                invalid={Boolean(fieldErrors.yom)}
              />
            </Field>

            <Field
              label="Capacity"
              htmlFor="capacityT"
              required
              error={fieldErrors.capacityT}
              hint="Tonnes."
            >
              <TextInput
                id="capacityT"
                value={form.capacityT}
                onChange={(v) => set("capacityT", v)}
                inputMode="numeric"
                placeholder="120"
                invalid={Boolean(fieldErrors.capacityT)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Location" description="Used to place this crane on a map and to measure distance to a job site.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Current location"
              htmlFor="currentLocation"
              required
              error={fieldErrors.currentLocation}
              className="sm:col-span-2"
              hint="Yard, site or city. Be specific — this is what a buyer sees."
            >
              <TextInput
                id="currentLocation"
                value={form.currentLocation}
                onChange={(v) => set("currentLocation", v)}
                placeholder="e.g. Ahmedabad Yard"
                invalid={Boolean(fieldErrors.currentLocation)}
              />
            </Field>

            <Field label="State" htmlFor="stateCode" required error={fieldErrors.stateCode}>
              <Select
                id="stateCode"
                value={form.stateCode}
                onChange={(v) => set("stateCode", v)}
                options={stateOptions}
                placeholder="Select a state"
                invalid={Boolean(fieldErrors.stateCode)}
              />
            </Field>

            <Field label="Pincode" htmlFor="pincode" error={fieldErrors.pincode} hint="Six digits. Optional, but improves the map pin.">
              <TextInput
                id="pincode"
                value={form.pincode}
                onChange={(v) => set("pincode", v)}
                inputMode="numeric"
                placeholder="380015"
                invalid={Boolean(fieldErrors.pincode)}
              />
            </Field>
          </div>

          <MapPin
            latitude={form.latitude}
            longitude={form.longitude}
            error={fieldErrors.latitude ?? fieldErrors.longitude}
            onChange={(lat, lng) => {
              set("latitude", lat);
              set("longitude", lng);
            }}
          />
        </Section>

        <Section title="Configuration" description="Boom and jib lengths. Blank or NA where the crane has none.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Main boom (m)" htmlFor="mainBoomM" required error={fieldErrors.mainBoomM}>
              <TextInput
                id="mainBoomM"
                value={form.mainBoomM}
                onChange={(v) => set("mainBoomM", v)}
                inputMode="numeric"
                invalid={Boolean(fieldErrors.mainBoomM)}
              />
            </Field>
            <Field label="Fixed jib (m)" htmlFor="fixedJibM" error={fieldErrors.fixedJibM} hint={LENGTH_HINT}>
              <TextInput id="fixedJibM" value={form.fixedJibM} onChange={(v) => set("fixedJibM", v)} inputMode="numeric" />
            </Field>
            <Field label="Luffing jib (m)" htmlFor="luffingJibM" error={fieldErrors.luffingJibM} hint={LENGTH_HINT}>
              <TextInput id="luffingJibM" value={form.luffingJibM} onChange={(v) => set("luffingJibM", v)} inputMode="numeric" />
            </Field>
            <Field label="Wind jib (m)" htmlFor="windJibM" error={fieldErrors.windJibM} hint={LENGTH_HINT}>
              <TextInput id="windJibM" value={form.windJibM} onChange={(v) => set("windJibM", v)} inputMode="numeric" />
            </Field>
          </div>
        </Section>

        <Section title="Availability" description="What SML should know about deploying this crane.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Status"
              htmlFor="currentStatus"
              required
              error={fieldErrors.currentStatus}
              hint={locked ? "Managed by SML for this crane." : undefined}
            >
              <Select
                id="currentStatus"
                value={form.currentStatus}
                onChange={(v) => set("currentStatus", v)}
                options={statusOptions}
                disabled={locked}
                invalid={Boolean(fieldErrors.currentStatus)}
              />
            </Field>

            {needsAvailableFrom(form) ? (
              <Field
                label="Available from"
                htmlFor="availableFrom"
                required
                error={fieldErrors.availableFrom}
                hint="The date this crane becomes free. Today or later."
              >
                <TextInput
                  id="availableFrom"
                  type="date"
                  value={availableFrom}
                  onChange={setAvailableFrom}
                  invalid={Boolean(fieldErrors.availableFrom)}
                />
              </Field>
            ) : null}

            {needsExpectedReadyDate(form) ? (
              <Field
                label="Expected ready date"
                htmlFor="expectedReadyDate"
                error={fieldErrors.expectedReadyDate}
                hint="When this crane is expected back from maintenance. Optional."
              >
                <TextInput
                  id="expectedReadyDate"
                  type="date"
                  value={form.expectedReadyDate}
                  onChange={(v) => set("expectedReadyDate", v)}
                  invalid={Boolean(fieldErrors.expectedReadyDate)}
                />
              </Field>
            ) : null}
          </div>

          <Field label="Remarks" htmlFor="remarks" error={fieldErrors.remarks}>
            <TextArea
              id="remarks"
              value={form.remarks}
              onChange={(v) => set("remarks", v)}
              placeholder="Anything SML should know about this crane"
            />
          </Field>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add crane"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              onBehalfVendorId
                ? void navigate({
                    to: "/app/vendors/$vendorId",
                    params: { vendorId: onBehalfVendorId },
                  })
                : void navigate({ to: "/app/fleet" })
            }
            disabled={save.isPending}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** Builds the payload the backend expects, carrying availableFrom only when Engaged. */
function withAvailableFrom(form: CraneForm, availableFrom: string) {
  return needsAvailableFrom(form)
    ? { ...form, availableFrom }
    : { ...form, availableFrom: null };
}

/**
 * Map pin placeholder (brief 6.3).
 *
 * Brief open item 1 puts the map provider on hold, so this deliberately renders
 * no map, no tiles and no third-party script. It takes the two coordinates and
 * explains that the pin will be editable once a provider is chosen — and lets
 * the vendor type them, which is a real fallback rather than a dead end.
 */
function MapPin({
  latitude,
  longitude,
  error,
  onChange,
}: {
  latitude: string;
  longitude: string;
  error?: string;
  onChange: (latitude: string, longitude: string) => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-800">Map pin</p>
      <p className="mt-1 text-xs text-slate-500">
        An interactive map is not connected yet — the map provider decision is on hold. We have placed this
        crane on the map automatically where possible; enter the coordinates here to correct it.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Latitude" htmlFor="latitude" error={error} hint="Between 6 and 38.">
          <TextInput id="latitude" value={latitude} onChange={(v) => onChange(v, longitude)} inputMode="decimal" invalid={Boolean(error)} />
        </Field>
        <Field label="Longitude" htmlFor="longitude" error={error} hint="Between 68 and 98.">
          <TextInput id="longitude" value={longitude} onChange={(v) => onChange(latitude, v)} inputMode="decimal" invalid={Boolean(error)} />
        </Field>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  DOCUMENT_LABELS,
  initialForm,
  loadInvite,
  REQUIRED_DOC_TYPES,
  type OnboardingDocument,
  saveForm,
  submitForm,
  uploadDocument,
  type DocType,
  type OnboardingForm,
  type OnboardingInviteState,
} from "@/lib/onboarding";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox, Field, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { cn } from "@/lib/cn";

/**
 * The vendor registration form (brief 7.2), reached from the emailed link with
 * no account.
 *
 * Two decisions worth stating:
 *
 * 1. The token arrives in the URL fragment, not the query string. The backend
 *    generates it that way so it stays out of access logs and the Referer
 *    header; this component is the only thing that reads it.
 *
 * 2. Every section saves independently. A registration like this takes a while
 *    and people do not finish long forms in one sitting, so a draft that only
 *    persisted on submit would lose most of the work.
 */

const NATURE_OPTIONS = [
  { value: "PUBLIC_LTD", label: "Public limited company" },
  { value: "PRIVATE_LTD", label: "Private limited company" },
  { value: "PARTNERSHIP", label: "Partnership" },
  { value: "PROPRIETORSHIP", label: "Proprietorship" },
] as const;

const ACCOUNT_TYPE_OPTIONS = [
  { value: "SAVING", label: "Savings" },
  { value: "CURRENT", label: "Current" },
  { value: "OTHER", label: "Other" },
] as const;

const GSTR1_OPTIONS = [
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "COMPOSITE", label: "Composite" },
] as const;

const MSME_OPTIONS = [
  { value: "MICRO", label: "Micro" },
  { value: "SMALL", label: "Small" },
  { value: "MEDIUM", label: "Medium" },
] as const;

const GST_REGISTRATION_OPTIONS = [
  { value: "REGULAR", label: "Regular" },
  { value: "COMPOSITE", label: "Composition scheme" },
  { value: "SEZ", label: "SEZ unit" },
  { value: "EOU", label: "EOU unit" },
] as const;

type FormErrors = Record<string, string>;

/** Flattens the backend's field errors into something a form can render. */
function errorsFrom(error: unknown): FormErrors {
  if (!(error instanceof ApiError)) return {};
  const map: FormErrors = {};
  for (const detail of error.details) {
    if (detail.path) map[detail.path] = detail.message;
  }
  return map;
}

export function OnboardingStartPage({ token: tokenProp }: { token?: string }) {
  // The token may arrive in the fragment (from the email link) or be passed in
  // by the router when the fragment has already been consumed.
  const [token] = useState(() => tokenProp ?? readTokenFromLocation());

  const queryClient = useQueryClient();
  const [form, setForm] = useState<OnboardingForm | null>(null);
  const [touched, setTouched] = useState<Set<keyof OnboardingForm>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  const invite = useQuery({
    queryKey: ["onboarding", "invite", token],
    queryFn: () => loadInvite(token ?? ""),
    enabled: Boolean(token),
    retry: false,
  });

  // Seed the form once the draft arrives, and after each successful save.
  useEffect(() => {
    const state = invite.data as OnboardingInviteState | undefined;
    if (!state) return;
    setForm((current) => current ?? initialForm(state.draft, state.prefill));
  }, [invite.data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("form not ready");
      return saveForm(token ?? null, form, touched);
    },
    onSuccess: (result) => {
      setSavedAt(new Date());
      setFieldErrors({});
      setWarnings(result.warnings);
      // The saved draft is now the truth, so the next save starts from it.
      setTouched(new Set());
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invite", token] });
    },
    onError: (error) => setFieldErrors(errorsFrom(error)),
  });

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("form not ready");
      return submitForm(token ?? null, form);
    },
    onSuccess: (result) => {
      setWarnings(result.warnings);
      setSubmitted(true);
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invite", token] });
    },
    onError: (error) => {
      setFieldErrors(errorsFrom(error));
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });

  const state = invite.data;

  const set = <K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setTouched((current) => new Set(current).add(key));
  };

  const setContacts: ContactsUpdater = (update) => {
    setForm((current) => (current ? { ...current, contacts: update(current.contacts) } : current));
    setTouched((current) => new Set(current).add("contacts"));
  };

  const uploadMutation = useMutation({
    mutationFn: ({ docType, file }: { docType: DocType; file: File }) =>
      uploadDocument(token ?? null, docType, file),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invite", token] }),
  });

  const uploadedByType = useMemo(() => {
    const map = new Map<string, OnboardingDocument>();
    for (const doc of state?.documents ?? []) {
      if (!map.has(doc.docType)) map.set(doc.docType, doc);
    }
    return map;
  }, [state?.documents]);

  const missing = state?.missingDocuments ?? [];

  // The GST certificate is only asked of a GST-registered vendor (open item
  // 2): the backend enforces this too, but the upload list must not offer a
  // row an unregistered vendor can never satisfy.
  const uploadDocs: DocType[] = useMemo(
    () => (form?.gstRegistered ? [...REQUIRED_DOC_TYPES, "GST_CERTIFICATE"] : REQUIRED_DOC_TYPES),
    [form?.gstRegistered],
  );

  if (!token) {
    return (
      <Shell>
        <Alert title="This registration link is incomplete">
          Open the link from your invitation email exactly as it was sent. The address bar should
          look like <span className="font-mono">…/onboarding/start#…</span>.
        </Alert>
      </Shell>
    );
  }

  if (invite.isLoading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 py-16 text-sm text-slate-500">
          <Spinner /> Opening your registration form
        </div>
      </Shell>
    );
  }

  if (invite.error) {
    const message = (invite.error as Error).message;
    return (
      <Shell>
        <Alert title="We could not open this registration">{message}</Alert>
        <p className="mt-4 text-sm text-slate-500">
          If you keep seeing this, ask your SML contact to send a fresh link.
        </p>
      </Shell>
    );
  }

  if (!form || !state) {
    return (
      <Shell>
        <div className="flex items-center gap-2 py-16 text-sm text-slate-500">
          <Spinner /> Loading
        </div>
      </Shell>
    );
  }

  if (submitted && state.status === "SUBMITTED") {
    return (
      <Shell>
        <div className="card p-8 text-center">
          <FileCheck2 className="mx-auto size-10 text-emerald-600" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Registration submitted</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            Thank you. Your registration is with the SML team for review. You will receive an email
            when it has been approved, and it will contain a link to set up your portal login.
          </p>
          {warnings.length > 0 ? (
            <div className="mt-5 text-left">
              <Alert tone="info" title="A note from your submission">
                <ul className="list-disc space-y-1 pl-4">
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}
        </div>
      </Shell>
    );
  }

  const readOnly = !state.canEdit;

  return (
    <Shell>
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-b from-brand-300 via-brand-500 to-brand-600 text-sm font-bold text-white"
            aria-hidden
          >
            SML
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Vendor registration</h1>
            <p className="text-xs text-slate-500">Sanghvi Movers Limited — crossrentel</p>
          </div>
        </div>
      </header>

      {state.rejectionRemarks ? (
        <div className="mb-5">
          <Alert title="Your registration was not approved">
            <p className="whitespace-pre-wrap">{state.rejectionRemarks}</p>
            <p className="mt-2">
              Please correct the details below and submit again. Your previous entries have been kept.
            </p>
          </Alert>
        </div>
      ) : null}

      {readOnly ? (
        <div className="mb-5">
          <Alert tone="info" title="This registration is under review">
            It cannot be changed while it is being reviewed. You will hear from us by email.
          </Alert>
        </div>
      ) : null}

      <div className="mb-5 sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-ink-850/95 px-4 py-3 backdrop-blur">
        <p className="text-xs text-slate-500">
          {savedAt ? `Draft saved at ${savedAt.toLocaleTimeString()}` : "Not saved yet"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            disabled={readOnly || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? <Spinner /> : null}
            Save draft
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-2 text-sm"
            disabled={readOnly || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? <Spinner /> : null}
            Submit registration
          </button>
        </div>
      </div>

      {saveMutation.isError && saveMutation.error instanceof ApiError ? (
        <div className="mb-5">
          <Alert title="The draft could not be saved">
            {(saveMutation.error as Error).message}
          </Alert>
        </div>
      ) : null}

      {submitMutation.isError ? (
        <div className="mb-5">
          <Alert title="The registration is not complete yet">
            <p>{(submitMutation.error as Error).message}</p>
            {Object.values(fieldErrors).length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-4">
                {Object.values(fieldErrors).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="mb-5">
          <Alert tone="info" title="Worth checking">
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div ref={sectionRef} className="space-y-4">
        <Section
          title="Company details"
          description="Exactly as it appears on your registration documents."
        >
          <Field label="Legal name" htmlFor="name" required error={fieldErrors["name"]}>
            <TextInput
              id="name"
              value={form.name}
              onChange={(v) => set("name", v)}
              disabled={readOnly}
              invalid={Boolean(fieldErrors["name"])}
            />
          </Field>
          <Field
            label="Nature of company"
            htmlFor="natureOfCompany"
            required
            error={fieldErrors["natureOfCompany"]}
          >
            <Select
              id="natureOfCompany"
              value={form.natureOfCompany}
              onChange={(v) => set("natureOfCompany", v)}
              options={NATURE_OPTIONS}
              placeholder="Select"
              disabled={readOnly}
              invalid={Boolean(fieldErrors["natureOfCompany"])}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address line 1" htmlFor="addressLine1" required error={fieldErrors["addressLine1"]}>
              <TextInput
                id="addressLine1"
                value={form.addressLine1}
                onChange={(v) => set("addressLine1", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["addressLine1"])}
              />
            </Field>
            <Field label="Address line 2" htmlFor="addressLine2">
              <TextInput
                id="addressLine2"
                value={form.addressLine2}
                onChange={(v) => set("addressLine2", v)}
                disabled={readOnly}
              />
            </Field>
            <Field label="City" htmlFor="city" required error={fieldErrors["city"]}>
              <TextInput
                id="city"
                value={form.city}
                onChange={(v) => set("city", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["city"])}
              />
            </Field>
            <Field label="District" htmlFor="district" required error={fieldErrors["district"]}>
              <TextInput
                id="district"
                value={form.district}
                onChange={(v) => set("district", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["district"])}
              />
            </Field>
            <StateSelect value={form.stateCode} onChange={(v) => set("stateCode", v)} disabled={readOnly} error={fieldErrors["stateCode"]} />
            <Field label="Pincode" htmlFor="pincode" required error={fieldErrors["pincode"]}>
              <TextInput
                id="pincode"
                value={form.pincode}
                onChange={(v) => set("pincode", v.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                disabled={readOnly}
                invalid={Boolean(fieldErrors["pincode"])}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Telephone" htmlFor="telephone" required error={fieldErrors["telephone"]}>
              <TextInput
                id="telephone"
                value={form.telephone}
                onChange={(v) => set("telephone", v)}
                inputMode="tel"
                disabled={readOnly}
                invalid={Boolean(fieldErrors["telephone"])}
              />
            </Field>
            <Field label="Fax" htmlFor="fax">
              <TextInput id="fax" value={form.fax} onChange={(v) => set("fax", v)} disabled={readOnly} />
            </Field>
            <Field label="Email" htmlFor="email" required error={fieldErrors["email"]}>
              <TextInput
                id="email"
                type="email"
                value={form.email}
                onChange={(v) => set("email", v)}
                inputMode="email"
                disabled={readOnly}
                invalid={Boolean(fieldErrors["email"])}
              />
            </Field>
            <Field label="Weekly off days" htmlFor="weeklyOffDays">
              <TextInput
                id="weeklyOffDays"
                value={form.weeklyOffDays}
                onChange={(v) => set("weeklyOffDays", v)}
                placeholder="e.g. Sunday"
                disabled={readOnly}
              />
            </Field>
            <Field label="Company size" htmlFor="companySize">
              <TextInput
                id="companySize"
                value={form.companySize}
                onChange={(v) => set("companySize", v)}
                placeholder="e.g. 11-50"
                disabled={readOnly}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Contact persons"
          description="The contact marked primary will be the portal login, so their email is required."
        >
          {form.contacts.map((contact, index) => (
            <div key={index} className="rounded-lg border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor={`contact-name-${index}`} required>
                  <TextInput
                    id={`contact-name-${index}`}
                    value={contact.name}
                    onChange={(v) => updateContact(setContacts, index, { name: v })}
                    disabled={readOnly}
                  />
                </Field>
                <Field label="Mobile" htmlFor={`contact-mobile-${index}`} required>
                  <TextInput
                    id={`contact-mobile-${index}`}
                    value={contact.mobile}
                    onChange={(v) => updateContact(setContacts, index, { mobile: v })}
                    inputMode="tel"
                    disabled={readOnly}
                  />
                </Field>
                <Field label="Telephone" htmlFor={`contact-tel-${index}`}>
                  <TextInput
                    id={`contact-tel-${index}`}
                    value={contact.telephone}
                    onChange={(v) => updateContact(setContacts, index, { telephone: v })}
                    disabled={readOnly}
                  />
                </Field>
                <Field
                  label="Email"
                  htmlFor={`contact-email-${index}`}
                  required={contact.isPrimary}
                  hint={contact.isPrimary ? "Used to sign in to the portal." : "Optional."}
                >
                  <TextInput
                    id={`contact-email-${index}`}
                    type="email"
                    value={contact.email}
                    onChange={(v) => updateContact(setContacts, index, { email: v })}
                    inputMode="email"
                    disabled={readOnly}
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                <Checkbox
                  id={`contact-primary-${index}`}
                  checked={contact.isPrimary}
                  disabled={readOnly}
                  onChange={(checked) => makePrimary(setContacts, index, checked)}
                  label="Primary contact"
                />
                <Checkbox
                  id={`contact-rfqs-${index}`}
                  checked={contact.receivesRfqs}
                  disabled={readOnly}
                  onChange={(checked) => setContacts((cs) => cs.map((c, i) => (i === index ? { ...c, receivesRfqs: checked } : c)))}
                  label={
                    <span className="whitespace-nowrap">
                      Receives RFQ emails
                      <span className="block text-xs font-normal text-slate-500">
                        Falls back to the primary contact if nobody is ticked.
                      </span>
                    </span>
                  }
                />
                {form.contacts.length > 1 ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-red-600 hover:underline"
                    disabled={readOnly}
                    onClick={() => removeContact(setContacts, index)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            disabled={readOnly}
            onClick={() => addContact(setContacts)}
          >
            Add another contact
          </button>
          {fieldErrors["contacts"] ? (
            <p className="text-xs font-medium text-red-600">{fieldErrors["contacts"]}</p>
          ) : null}
        </Section>

        <Section
          title="Registration"
          description="Enter the identifiers exactly as they appear on your certificates."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="PAN" htmlFor="pan" required error={fieldErrors["pan"]}>
              <TextInput
                id="pan"
                value={form.pan}
                onChange={(v) => set("pan", v.toUpperCase())}
                className="font-mono uppercase"
                disabled={readOnly}
                invalid={Boolean(fieldErrors["pan"])}
              />
            </Field>
            <Field label="TAN" htmlFor="tan">
              <TextInput
                id="tan"
                value={form.tan}
                onChange={(v) => set("tan", v.toUpperCase())}
                className="font-mono uppercase"
                disabled={readOnly}
              />
            </Field>
          </div>
          <Field label="Is the company GST-registered?" htmlFor="gstRegistered" required>
            <div className="flex gap-6 pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gstRegistered"
                  checked={form.gstRegistered === true}
                  disabled={readOnly}
                  onChange={() => set("gstRegistered", true)}
                />
                Yes
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gstRegistered"
                  checked={form.gstRegistered === false}
                  disabled={readOnly}
                  onChange={() => set("gstRegistered", false)}
                />
                No
              </label>
            </div>
          </Field>
          {form.gstRegistered ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="GSTIN" htmlFor="gstn" required error={fieldErrors["gstn"]}>
                <TextInput
                  id="gstn"
                  value={form.gstn}
                  onChange={(v) => set("gstn", v.toUpperCase())}
                  className="font-mono uppercase"
                  disabled={readOnly}
                  invalid={Boolean(fieldErrors["gstn"])}
                />
              </Field>
              <Field
                label="GST registration type"
                htmlFor="gstRegistrationType"
                required
                error={fieldErrors["gstRegistrationType"]}
              >
                <Select
                  id="gstRegistrationType"
                  value={form.gstRegistrationType}
                  onChange={(v) => set("gstRegistrationType", v)}
                  options={GST_REGISTRATION_OPTIONS}
                  placeholder="Select"
                  disabled={readOnly}
                  invalid={Boolean(fieldErrors["gstRegistrationType"])}
                />
              </Field>
              <Field label="GSTR-1 filing frequency" htmlFor="gstr1FilingFrequency">
                <Select
                  id="gstr1FilingFrequency"
                  value={form.gstr1FilingFrequency}
                  onChange={(v) => set("gstr1FilingFrequency", v)}
                  options={GSTR1_OPTIONS}
                  placeholder="Not applicable"
                  disabled={readOnly}
                />
              </Field>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CIN" htmlFor="cin" hint="Only for a company.">
              <TextInput
                id="cin"
                value={form.cin}
                onChange={(v) => set("cin", v.toUpperCase())}
                className="font-mono uppercase"
                disabled={readOnly}
              />
            </Field>
            <Field label="Government registration type" htmlFor="govtRegistrationType">
              <TextInput
                id="govtRegistrationType"
                value={form.govtRegistrationType}
                onChange={(v) => set("govtRegistrationType", v)}
                disabled={readOnly}
              />
            </Field>
            <Field label="Government registration number" htmlFor="govtRegistrationNo">
              <TextInput
                id="govtRegistrationNo"
                value={form.govtRegistrationNo}
                onChange={(v) => set("govtRegistrationNo", v)}
                disabled={readOnly}
              />
            </Field>
          </div>
          <div>
            <Field label="Is the company registered as an MSME?" htmlFor="msmeRegistered" required>
              <div className="flex gap-6 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="msmeRegistered"
                    checked={form.msmeRegistered === true}
                    disabled={readOnly}
                    onChange={() => set("msmeRegistered", true)}
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="msmeRegistered"
                    checked={form.msmeRegistered === false}
                    disabled={readOnly}
                    onChange={() => set("msmeRegistered", false)}
                  />
                  No
                </label>
              </div>
            </Field>
            {form.msmeRegistered ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="MSME category" htmlFor="msmeCategory" required error={fieldErrors["msmeCategory"]}>
                  <Select
                    id="msmeCategory"
                    value={form.msmeCategory}
                    onChange={(v) => set("msmeCategory", v)}
                    options={MSME_OPTIONS}
                    placeholder="Select"
                    disabled={readOnly}
                    invalid={Boolean(fieldErrors["msmeCategory"])}
                  />
                </Field>
                <Field
                  label="MSME registration number"
                  htmlFor="msmeRegNo"
                  required
                  error={fieldErrors["msmeRegNo"]}
                >
                  <TextInput
                    id="msmeRegNo"
                    value={form.msmeRegNo}
                    onChange={(v) => set("msmeRegNo", v)}
                    disabled={readOnly}
                    invalid={Boolean(fieldErrors["msmeRegNo"])}
                  />
                </Field>
                <Field
                  label="Exemption certificate date"
                  htmlFor="msmeExemptionDate"
                  hint="Only if you hold a certificate of exemption from MSME registration. Optional."
                >
                  <TextInput
                    id="msmeExemptionDate"
                    type="date"
                    value={form.msmeExemptionDate}
                    onChange={(v) => set("msmeExemptionDate", v)}
                    disabled={readOnly}
                  />
                </Field>
              </div>
            ) : null}
          </div>
          <div>
            <Checkbox
              id="tdsLowerDeduction"
              checked={form.tdsLowerDeduction}
              onChange={(v) => set("tdsLowerDeduction", v)}
              disabled={readOnly}
              label="We hold a certificate for a lower TDS deduction"
            />
            {form.tdsLowerDeduction ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Certificate number"
                  htmlFor="tdsCertificateNo"
                  required
                  error={fieldErrors["tdsCertificateNo"]}
                >
                  <TextInput
                    id="tdsCertificateNo"
                    value={form.tdsCertificateNo}
                    onChange={(v) => set("tdsCertificateNo", v)}
                    disabled={readOnly}
                    invalid={Boolean(fieldErrors["tdsCertificateNo"])}
                  />
                </Field>
                <Field label="Section" htmlFor="tdsSection" required error={fieldErrors["tdsSection"]}>
                  <TextInput
                    id="tdsSection"
                    value={form.tdsSection}
                    onChange={(v) => set("tdsSection", v)}
                    disabled={readOnly}
                    invalid={Boolean(fieldErrors["tdsSection"])}
                  />
                </Field>
                <Field label="Rate (%)" htmlFor="tdsRatePercent" required error={fieldErrors["tdsRatePercent"]}>
                  <TextInput
                    id="tdsRatePercent"
                    value={form.tdsRatePercent}
                    onChange={(v) => set("tdsRatePercent", v.replace(/[^\d]/g, "").slice(0, 3))}
                    inputMode="numeric"
                    disabled={readOnly}
                    invalid={Boolean(fieldErrors["tdsRatePercent"])}
                  />
                </Field>
                <Field label="Valid from" htmlFor="tdsValidFrom" required error={fieldErrors["tdsValidFrom"]}>
                  <TextInput
                    id="tdsValidFrom"
                    type="date"
                    value={form.tdsValidFrom}
                    onChange={(v) => set("tdsValidFrom", v)}
                    disabled={readOnly}
                  />
                </Field>
                <Field label="Valid to" htmlFor="tdsValidTo" required error={fieldErrors["tdsValidTo"]}>
                  <TextInput
                    id="tdsValidTo"
                    type="date"
                    value={form.tdsValidTo}
                    onChange={(v) => set("tdsValidTo", v)}
                    disabled={readOnly}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </Section>

        <OperatingRegionsSection form={form} set={set} disabled={readOnly} />

        <Section title="Bank details" description="For payment. Stored encrypted at rest.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Account holder name"
              htmlFor="bankAccountHolderName"
              required
              error={fieldErrors["bankAccountHolderName"]}
            >
              <TextInput
                id="bankAccountHolderName"
                value={form.bankAccountHolderName}
                onChange={(v) => set("bankAccountHolderName", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["bankAccountHolderName"])}
              />
            </Field>
            <Field label="Bank name" htmlFor="bankName" required error={fieldErrors["bankName"]}>
              <TextInput
                id="bankName"
                value={form.bankName}
                onChange={(v) => set("bankName", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["bankName"])}
              />
            </Field>
            <Field label="Branch" htmlFor="bankBranch" required error={fieldErrors["bankBranch"]}>
              <TextInput
                id="bankBranch"
                value={form.bankBranch}
                onChange={(v) => set("bankBranch", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["bankBranch"])}
              />
            </Field>
            <Field
              label="Account type"
              htmlFor="bankAccountType"
              required
              error={fieldErrors["bankAccountType"]}
            >
              <Select
                id="bankAccountType"
                value={form.bankAccountType}
                onChange={(v) => set("bankAccountType", v)}
                options={ACCOUNT_TYPE_OPTIONS}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["bankAccountType"])}
              />
            </Field>
            <Field
              label="Account number"
              htmlFor="bankAccountNo"
              hint="Leave blank to keep the number we already hold."
              error={fieldErrors["bankAccountNo"]}
            >
              <TextInput
                id="bankAccountNo"
                value={form.bankAccountNo}
                onChange={(v) => set("bankAccountNo", v.replace(/\s+/g, ""))}
                inputMode="numeric"
                disabled={readOnly}
              />
            </Field>
            <Field
              label="IFSC"
              htmlFor="bankIfsc"
              hint="Leave blank to keep the IFSC we already hold."
              error={fieldErrors["bankIfsc"]}
            >
              <TextInput
                id="bankIfsc"
                value={form.bankIfsc}
                onChange={(v) => set("bankIfsc", v.toUpperCase())}
                className="font-mono uppercase"
                disabled={readOnly}
              />
            </Field>
            <Field label="MICR" htmlFor="bankMicr" hint="9 digits, printed on the cheque leaf.">
              <TextInput
                id="bankMicr"
                value={form.bankMicr}
                onChange={(v) => set("bankMicr", v.replace(/\D/g, "").slice(0, 9))}
                inputMode="numeric"
                disabled={readOnly}
              />
            </Field>
            <Field
              label="IBAN"
              htmlFor="bankIban"
              hint="For a bank account outside India only."
            >
              <TextInput
                id="bankIban"
                value={form.bankIban}
                onChange={(v) => set("bankIban", v.toUpperCase())}
                disabled={readOnly}
              />
            </Field>
            <Field
              label="SWIFT code"
              htmlFor="bankSwift"
              hint="For a bank account outside India only."
            >
              <TextInput
                id="bankSwift"
                value={form.bankSwift}
                onChange={(v) => set("bankSwift", v.toUpperCase())}
                className="font-mono uppercase"
                disabled={readOnly}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Fleet summary"
          description="A short description of the cranes you can supply. You will add the detail later."
        >
          <Field
            label="Crane categories and approximate fleet size"
            htmlFor="fleetSummary"
            required
            error={fieldErrors["fleetSummary"]}
          >
            <TextArea
              id="fleetSummary"
              rows={4}
              value={form.fleetSummary}
              onChange={(v) => set("fleetSummary", v)}
              placeholder="e.g. Crawler and rough-terrain cranes, 20 to 100 tonne, fleet of about 12."
              disabled={readOnly}
              invalid={Boolean(fieldErrors["fleetSummary"])}
            />
          </Field>
        </Section>

        <Section
          title="Documents"
          description="The cancelled cheque, PAN copy and signed declaration page are required for everyone; the GST certificate only if you are GST-registered."
        >
          {uploadMutation.isError ? (
            <Alert title="The upload was rejected">{(uploadMutation.error as Error).message}</Alert>
          ) : null}
          <ul className="space-y-2.5">
            {uploadDocs.map((docType) => {
              const uploaded = uploadedByType.get(docType);
              return (
                <li
                  key={docType}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {DOCUMENT_LABELS[docType]}
                    </p>
                    {uploaded ? (
                      <p className="truncate text-xs text-emerald-700">
                        {uploaded.fileName} · uploaded{" "}
                        {new Date(uploaded.uploadedAt).toLocaleDateString()}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-500">PDF, JPG or PNG. Not yet uploaded.</p>
                    )}
                  </div>
                  <label
                    className={cn(
                      "btn-secondary cursor-pointer px-3 py-1.5 text-xs",
                      readOnly && "pointer-events-none opacity-50",
                    )}
                  >
                    <Upload className="size-3.5" aria-hidden />
                    {uploaded ? "Replace" : "Upload"}
                    <input
                      type="file"
                      className="sr-only"
                      accept="application/pdf,image/jpeg,image/png"
                      disabled={readOnly || uploadMutation.isPending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) uploadMutation.mutate({ docType, file });
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && !readOnly ? (
            <p className="text-xs font-medium text-amber-700">
              Still to upload: {missing.map((docType) => DOCUMENT_LABELS[docType]).join(", ")}.
            </p>
          ) : null}
        </Section>

        <Section
          title="Communication preferences"
          description="The portal communicates by email today. Note here how you would like to be reached otherwise."
        >
          <Field label="Preferences" htmlFor="communicationNotes">
            <TextArea
              id="communicationNotes"
              rows={3}
              value={form.communicationNotes}
              onChange={(v) => set("communicationNotes", v)}
              placeholder="e.g. Email the site office, copy the proprietor on quotes."
              disabled={readOnly}
            />
          </Field>
        </Section>

        <Section title="Declaration">
          <Checkbox
            id="codeOfConductAccepted"
            checked={form.codeOfConductAccepted}
            onChange={(v) => set("codeOfConductAccepted", v)}
            disabled={readOnly}
            label={
              <>
                I have read and accept the SML vendor code of conduct, and the information given is
                true to the best of my knowledge.
              </>
            }
          />
          {fieldErrors["codeOfConductAccepted"] ? (
            <p className="text-xs font-medium text-red-600">
              {fieldErrors["codeOfConductAccepted"]}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Your name" htmlFor="declarationName" required error={fieldErrors["declarationName"]}>
              <TextInput
                id="declarationName"
                value={form.declarationName}
                onChange={(v) => set("declarationName", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["declarationName"])}
              />
            </Field>
            <Field
              label="Designation"
              htmlFor="declarationDesignation"
              required
              error={fieldErrors["declarationDesignation"]}
            >
              <TextInput
                id="declarationDesignation"
                value={form.declarationDesignation}
                onChange={(v) => set("declarationDesignation", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["declarationDesignation"])}
              />
            </Field>
            <Field
              label="Date"
              htmlFor="declarationDate"
              required
              error={fieldErrors["declarationDate"]}
            >
              <TextInput
                id="declarationDate"
                type="date"
                value={form.declarationDate}
                onChange={(v) => set("declarationDate", v)}
                disabled={readOnly}
                invalid={Boolean(fieldErrors["declarationDate"])}
              />
            </Field>
          </div>
        </Section>

        <div className="flex flex-wrap items-center justify-end gap-3 pb-8">
          <button
            type="button"
            className="btn-secondary px-4 py-2.5 text-sm"
            disabled={readOnly || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Save draft
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2.5 text-sm"
            disabled={readOnly || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? <Spinner /> : null}
            Submit registration
          </button>
        </div>
      </div>
    </Shell>
  );
}

/**
 * The state dropdown for the structured address (brief 5.1). Sits on the same
 * reference-data query as operating regions, so both stay consistent and the
 * fetch happens once.
 */
function StateSelect({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["onboarding", "reference-data"],
    queryFn: () => api<{ states: { code: string; name: string }[] }>("/onboarding/reference-data", { anonymous: true }),
  });

  const states = data?.states ?? [];

  return (
    <Field
      label="State"
      htmlFor="stateCode"
      required
      error={error}
      hint={isLoading ? "Loading states" : undefined}
    >
      <Select
        id="stateCode"
        value={value}
        onChange={onChange}
        options={states.map((s) => ({ value: s.code, label: s.name }))}
        placeholder="Select"
        disabled={disabled || isLoading || states.length === 0}
        invalid={Boolean(error)}
      />
    </Field>
  );
}

/**
 * Operating regions, driven by the state list.
 *
 * Fetched separately rather than bundled with the form because it is reference
 * data that never changes for a given vendor, and it is needed by several
 * milestones' forms.
 */
function OperatingRegionsSection({
  form,
  set,
  disabled,
}: {
  form: OnboardingForm;
  set: <K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) => void;
  disabled: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["onboarding", "reference-data"],
    // The public form has no session, so this uses the unauthenticated endpoint
    // rather than /vendors/reference-data, which requires a login.
    queryFn: () => api<{ states: { code: string; name: string }[] }>("/onboarding/reference-data", { anonymous: true }),
  });

  const states: { code: string; name: string }[] = data?.states ?? [];

  return (
    <Section
      title="Operating regions"
      description="The states where you can supply cranes. SML ranks vendors by location."
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading states
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {states.map((state) => {
              const selected = form.operatingRegions.includes(state.code);
              return (
                <button
                  key={state.code}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() =>
                    set(
                      "operatingRegions",
                      selected
                        ? form.operatingRegions.filter((code) => code !== state.code)
                        : [...form.operatingRegions, state.code],
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    selected
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-ink-850 text-slate-600 hover:border-slate-300",
                    disabled && "pointer-events-none opacity-60",
                  )}
                >
                  {state.name}
                </button>
              );
            })}
          </div>
          {form.operatingRegions.length > 0 ? (
            <p className="text-xs text-slate-500">
              Selected: {form.operatingRegions.join(", ")}
            </p>
          ) : (
            <p className="text-xs text-slate-500">At least one region is required.</p>
          )}
        </>
      )}
    </Section>
  );
}

// --- contact helpers -------------------------------------------------------

/**
 * Replaces the contacts array as a whole.
 *
 * A single-key setter cannot express "change the second contact's mobile", so
 * the list is written back wholesale. Every helper below takes this updater and
 * returns a new array rather than mutating, which is what keeps React from
 * re-rendering on an unchanged list.
 */
export type ContactsUpdater = (
  update: (contacts: OnboardingForm["contacts"]) => OnboardingForm["contacts"],
) => void;

function updateContact(
  setContacts: ContactsUpdater,
  index: number,
  patch: Partial<OnboardingForm["contacts"][number]>,
) {
  setContacts((contacts) =>
    contacts.map((contact, i) => (i === index ? { ...contact, ...patch } : contact)),
  );
}

function removeContact(setContacts: ContactsUpdater, index: number) {
  setContacts((contacts) => contacts.filter((_, i) => i !== index));
}

function addContact(setContacts: ContactsUpdater) {
  setContacts((contacts) => [
    ...contacts,
    { name: "", mobile: "", telephone: "", email: "", isPrimary: false, receivesRfqs: false },
  ]);
}

/** Exactly one contact may be primary, so setting one clears the others. */
function makePrimary(setContacts: ContactsUpdater, index: number, checked: boolean) {
  setContacts((contacts) =>
    contacts.map((contact, i) => ({
      ...contact,
      isPrimary: checked ? i === index : contact.isPrimary,
    })),
  );
}

// --- shell ----------------------------------------------------------------

function readTokenFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const fromHash = window.location.hash.startsWith("#")
    ? decodeURIComponent(window.location.hash.slice(1))
    : "";
  const fromSearch = new URLSearchParams(window.location.search).get("token");
  const token = fromHash || fromSearch || "";
  return token.length >= 20 ? token : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-8">{children}</div>
    </div>
  );
}

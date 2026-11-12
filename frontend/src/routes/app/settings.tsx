import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import {
  Checkbox,
  Field,
  Section,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui/form";
import {
  MASTER_LIST_KEYS,
  MASTER_LIST_LABELS,
  QUOTE_MASTER_LIST_KEYS,
  SAP_MASTER_LIST_KEYS,
  loadEmailTemplates,
  loadMasterLists,
  loadMobilisationRates,
  loadSettings,
  loadStateRegions,
  updateAlertSettings,
  updateEmailTemplate,
  updateMasterList,
  updateMobilisationRate,
  updateSettings,
  updateStateRegion,
  type MasterListKey,
  type PortalSettings,
  type RateDayBasis,
} from "@/lib/settings";

/**
 * Admin configuration (brief 6.4, phase D3).
 *
 * Only an admin reaches this screen — the nav entry and the route guard both
 * restrict it, and the API refuses anyone else. The day basis changes how every
 * quotation total is calculated; the master lists back the SAP office-use
 * block, which starts empty so the owner's values can be entered later without
 * a code change.
 */

const RATE_DAY_BASIS_OPTIONS = [
  { value: "CALENDAR_DAYS", label: "Calendar days" },
  { value: "WORKING_DAYS_PER_MONTH", label: "Working days per month" },
] as const;

function toLines(values: string[]): string {
  return values.join("\n");
}

function fromLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function SettingsPage() {
  const queryClient = useQueryClient();

  const settings = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const masterLists = useQuery({ queryKey: ["settings", "master-lists"], queryFn: loadMasterLists });

  const [rateDayBasis, setRateDayBasis] = useState<RateDayBasis>("CALENDAR_DAYS");
  const [lists, setLists] = useState<Record<MasterListKey, string>>(
    () => Object.fromEntries(MASTER_LIST_KEYS.map((k) => [k, ""])) as Record<MasterListKey, string>,
  );

  useEffect(() => {
    if (settings.data) setRateDayBasis(settings.data.settings.rateDayBasis);
  }, [settings.data]);

  useEffect(() => {
    if (masterLists.data) {
      setLists(
        Object.fromEntries(
          MASTER_LIST_KEYS.map((k) => [k, toLines(masterLists.data![k])]),
        ) as Record<MasterListKey, string>,
      );
    }
  }, [masterLists.data]);

  const saveSettings = useMutation({
    mutationFn: () => updateSettings(rateDayBasis),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const saveList = useMutation({
    mutationFn: (key: MasterListKey) => updateMasterList(key, fromLines(lists[key])),
    onSuccess: (result) => {
      setLists((prev) => ({ ...prev, [result.name]: toLines(result.values) }));
      void queryClient.invalidateQueries({ queryKey: ["settings", "master-lists"] });
    },
  });

  if (settings.isLoading || masterLists.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const loadError = settings.error ?? masterLists.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Portal configuration for SML staff: quotation rules, alert thresholds, master lists, rates and templates."
      />

      {loadError ? <Alert tone="error">{(loadError as Error).message}</Alert> : null}

      <Section title="Quotation day basis">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="How a quoted month converts to days"
            htmlFor="rateDayBasis"
            hint="Changes the total on every quotation calculated after saving."
          >
            <Select
              id="rateDayBasis"
              value={rateDayBasis}
              onChange={(value) => setRateDayBasis(value as RateDayBasis)}
              options={RATE_DAY_BASIS_OPTIONS}
              placeholder="Select basis"
            />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-primary"
              disabled={saveSettings.isPending}
              onClick={() => saveSettings.mutate()}
            >
              {saveSettings.isPending ? "Saving…" : "Save day basis"}
            </button>
          </div>
        </div>
        {saveSettings.isError ? (
          <Alert tone="error">{(saveSettings.error as Error).message}</Alert>
        ) : null}
        {saveSettings.isSuccess ? <Alert tone="success">Day basis saved.</Alert> : null}
      </Section>

      <Section title="SAP office-use master lists">
        <p className="mb-4 text-sm text-slate-500">
          The options offered in the office-use block of the SAP vendor creation
          sheet. One value per line. Lists start empty so the owner's SAP values
          can be entered as they are supplied.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          {SAP_MASTER_LIST_KEYS.map((key) => (
            <div key={key} className="space-y-2">
              <Field label={MASTER_LIST_LABELS[key]} htmlFor={`list-${key}`}>
                <TextArea
                  id={`list-${key}`}
                  value={lists[key]}
                  onChange={(value) => setLists((prev) => ({ ...prev, [key]: value }))}
                  rows={4}
                  placeholder="One value per line"
                />
              </Field>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={saveList.isPending && saveList.variables === key}
                  onClick={() => saveList.mutate(key)}
                >
                  {saveList.isPending && saveList.variables === key ? "Saving…" : "Save list"}
                </button>
                {saveList.isSuccess && saveList.variables === key ? (
                  <span className="text-xs text-green-700">Saved.</span>
                ) : null}
              </div>
              {saveList.isError && saveList.variables === key ? (
                <Alert tone="error">{(saveList.error as Error).message}</Alert>
              ) : null}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Quote and award reason codes">
        <p className="mb-4 text-sm text-slate-500">
          The reasons a CR user can pick when marking a quotation Under Review,
          Shortlisted or Rejected, and when awarding one. One value per line;
          starts empty, and marking works with free text until a code list is
          entered.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          {QUOTE_MASTER_LIST_KEYS.map((key) => (
            <div key={key} className="space-y-2">
              <Field label={MASTER_LIST_LABELS[key]} htmlFor={`list-${key}`}>
                <TextArea
                  id={`list-${key}`}
                  value={lists[key]}
                  onChange={(value) => setLists((prev) => ({ ...prev, [key]: value }))}
                  rows={4}
                  placeholder="One value per line"
                />
              </Field>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={saveList.isPending && saveList.variables === key}
                  onClick={() => saveList.mutate(key)}
                >
                  {saveList.isPending && saveList.variables === key ? "Saving…" : "Save list"}
                </button>
                {saveList.isSuccess && saveList.variables === key ? (
                  <span className="text-xs text-green-700">Saved.</span>
                ) : null}
              </div>
              {saveList.isError && saveList.variables === key ? (
                <Alert tone="error">{(saveList.error as Error).message}</Alert>
              ) : null}
            </div>
          ))}
        </div>
      </Section>

      {settings.data ? <AlertSettingsSection settings={settings.data.settings} /> : null}

      <MobilisationRatesSection />

      <EmailTemplatesSection />

      <StateRegionsSection />

      <Section title="Business verticals">
        <p className="mb-4 text-sm text-slate-500">
          The verticals offered on an enquiry. One value per line; starts empty
          so the owner's list can be entered as supplied.
        </p>
        <div className="max-w-md space-y-2">
          <Field label={MASTER_LIST_LABELS.BUSINESS_VERTICAL} htmlFor="list-BUSINESS_VERTICAL">
            <TextArea
              id="list-BUSINESS_VERTICAL"
              value={lists.BUSINESS_VERTICAL}
              onChange={(value) =>
                setLists((prev) => ({ ...prev, BUSINESS_VERTICAL: value }))
              }
              rows={4}
              placeholder="One value per line"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-secondary"
              disabled={saveList.isPending && saveList.variables === "BUSINESS_VERTICAL"}
              onClick={() => saveList.mutate("BUSINESS_VERTICAL")}
            >
              {saveList.isPending && saveList.variables === "BUSINESS_VERTICAL"
                ? "Saving…"
                : "Save list"}
            </button>
            {saveList.isSuccess && saveList.variables === "BUSINESS_VERTICAL" ? (
              <span className="text-xs text-green-700">Saved.</span>
            ) : null}
          </div>
          {saveList.isError && saveList.variables === "BUSINESS_VERTICAL" ? (
            <Alert tone="error">{(saveList.error as Error).message}</Alert>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function AlertSettingsSection({ settings }: { settings: PortalSettings }) {
  const queryClient = useQueryClient();
  const [rfqSla, setRfqSla] = useState(String(settings.alertRfqSlaHours));
  const [quotationDays, setQuotationDays] = useState(
    String(settings.alertQuotationExpiryDays),
  );
  const [bookingDays, setBookingDays] = useState(String(settings.alertBookingLeadDays));
  const [emailsEnabled, setEmailsEnabled] = useState(settings.alertEmailsEnabled);
  const [retention, setRetention] = useState(String(settings.reportRetentionMonths));

  const save = useMutation({
    mutationFn: () =>
      updateAlertSettings({
        alertRfqSlaHours: Number(rfqSla),
        alertQuotationExpiryDays: Number(quotationDays),
        alertBookingLeadDays: Number(bookingDays),
        alertEmailsEnabled: emailsEnabled,
        reportRetentionMonths: Number(retention),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const valid =
    [rfqSla, quotationDays, bookingDays, retention].every(
      (value) => Number.isInteger(Number(value)) && Number(value) > 0,
    );

  return (
    <Section
      title="Alerts and retention"
      description="SLA values drive both the dashboard alerts and the daily email digest. Retention is a configuration value only; deletion is not automated yet."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="RFQ response SLA (hours)" htmlFor="alert-rfq-sla">
          <TextInput id="alert-rfq-sla" value={rfqSla} onChange={setRfqSla} inputMode="numeric" />
        </Field>
        <Field label="Quotation expiry window (days)" htmlFor="alert-quotation-days">
          <TextInput
            id="alert-quotation-days"
            value={quotationDays}
            onChange={setQuotationDays}
            inputMode="numeric"
          />
        </Field>
        <Field label="Booking confirmation lead (days)" htmlFor="alert-booking-days">
          <TextInput
            id="alert-booking-days"
            value={bookingDays}
            onChange={setBookingDays}
            inputMode="numeric"
          />
        </Field>
        <Field label="Report retention (months)" htmlFor="alert-retention">
          <TextInput
            id="alert-retention"
            value={retention}
            onChange={setRetention}
            inputMode="numeric"
          />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox
            id="alert-emails-enabled"
            checked={emailsEnabled}
            onChange={setEmailsEnabled}
            label="Email the daily alert digest"
          />
        </div>
      </div>
      <button
        type="button"
        className="btn-primary"
        disabled={save.isPending || !valid}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Saving…" : "Save alert settings"}
      </button>
      {save.isError ? <Alert tone="error">{(save.error as Error).message}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Alert settings saved.</Alert> : null}
    </Section>
  );
}

function MobilisationRatesSection() {
  const queryClient = useQueryClient();
  const rates = useQuery({ queryKey: ["settings", "rates"], queryFn: loadMobilisationRates });
  const [edits, setEdits] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: ({ id, ratePerKm }: { id: string; ratePerKm: number }) =>
      updateMobilisationRate(id, { ratePerKm }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings", "rates"] }),
  });

  return (
    <Section
      title="Mobilisation cost assumptions"
      description="Rupees per km by crane category, capacity band and ownership. The recommendation engine reads these values directly."
    >
      {rates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading rates
        </div>
      ) : rates.error ? (
        <Alert tone="error">{(rates.error as Error).message}</Alert>
      ) : (
        <Table className="min-w-[42rem]">
          <THead>
            <tr>
              <TH>Category</TH>
              <TH>Band (T)</TH>
              <TH>Ownership</TH>
              <TH>₹ / km</TH>
              <TH align="right">Save</TH>
            </tr>
          </THead>
          <TBody>
            {(rates.data ?? []).map((rate) => {
              const value = edits[rate.id] ?? String(rate.ratePerKm);
              return (
                <TR key={rate.id}>
                  <TD>{rate.craneTypeName}</TD>
                  <TD className="text-slate-600">
                    {rate.capacityMinT}–{rate.capacityMaxT ?? "∞"}
                  </TD>
                  <TD className="text-slate-600">{rate.ownershipType ?? "Any"}</TD>
                  <TD>
                    <TextInput
                      id={`rate-${rate.id}`}
                      value={value}
                      onChange={(next) => setEdits((prev) => ({ ...prev, [rate.id]: next }))}
                      inputMode="decimal"
                    />
                  </TD>
                  <TD align="right">
                    <button
                      type="button"
                      className="btn-secondary px-3 py-1.5 text-xs"
                      disabled={save.isPending || !rate.isActive}
                      onClick={() => save.mutate({ id: rate.id, ratePerKm: Number(value) })}
                    >
                      {rate.isActive ? "Save" : "Inactive"}
                    </button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {save.isError ? <Alert tone="error">{(save.error as Error).message}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Mobilisation rate saved.</Alert> : null}
    </Section>
  );
}

function EmailTemplatesSection() {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ["settings", "email-templates"],
    queryFn: loadEmailTemplates,
  });
  const [selected, setSelected] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const current = templates.data?.find((template) => template.key === selected);

  useEffect(() => {
    const first = templates.data?.[0];
    if (!selected && first) {
      setSelected(first.key);
    }
  }, [selected, templates.data]);

  useEffect(() => {
    if (current) {
      setSubject(current.subject);
      setBody(current.bodyHtml);
    }
  }, [current]);

  const save = useMutation({
    mutationFn: () => updateEmailTemplate(selected, { subject, bodyHtml: body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings", "email-templates"] }),
  });

  return (
    <Section
      title="Communication templates"
      description="The wording of every transactional email. Placeholders such as {{rfqNumber}} are substituted at send time."
    >
      {templates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading templates
        </div>
      ) : templates.error ? (
        <Alert tone="error">{(templates.error as Error).message}</Alert>
      ) : (
        <>
          <Field label="Template" htmlFor="email-template-key">
            <Select
              id="email-template-key"
              value={selected}
              onChange={setSelected}
              options={(templates.data ?? []).map((template) => ({
                value: template.key,
                label: template.key.replaceAll("_", " "),
              }))}
              placeholder="Select template"
            />
          </Field>
          {selected ? (
            <>
              <Field label="Subject" htmlFor="email-template-subject">
                <TextInput
                  id="email-template-subject"
                  value={subject}
                  onChange={setSubject}
                />
              </Field>
              <Field
                label="Body (HTML)"
                htmlFor="email-template-body"
                hint="{{placeholders}} are replaced at send time."
              >
                <TextArea
                  id="email-template-body"
                  value={body}
                  onChange={setBody}
                  rows={14}
                />
              </Field>
              <button
                type="button"
                className="btn-primary"
                disabled={save.isPending || !subject.trim() || !body.trim()}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save template"}
              </button>
            </>
          ) : null}
        </>
      )}
      {save.isError ? <Alert tone="error">{(save.error as Error).message}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Template saved.</Alert> : null}
    </Section>
  );
}

function StateRegionsSection() {
  const queryClient = useQueryClient();
  const states = useQuery({ queryKey: ["settings", "states"], queryFn: loadStateRegions });
  const [regions, setRegions] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: ({ code, region }: { code: string; region: string }) =>
      updateStateRegion(code, region.trim() || null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings", "states"] }),
  });

  return (
    <Section
      title="Region mapping"
      description="The sales region a state belongs to. Reports fall back to this when an enquiry has no region of its own."
    >
      {states.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading states
        </div>
      ) : states.error ? (
        <Alert tone="error">{(states.error as Error).message}</Alert>
      ) : (
        <Table className="min-w-[34rem]">
          <THead>
            <tr>
              <TH>State</TH>
              <TH>Region</TH>
              <TH align="right">Save</TH>
            </tr>
          </THead>
          <TBody>
            {(states.data ?? []).map((state) => {
              const value = regions[state.code] ?? state.region ?? "";
              return (
                <TR key={state.code}>
                  <TD>{state.name}</TD>
                  <TD>
                    <TextInput
                      id={`state-region-${state.code}`}
                      value={value}
                      onChange={(next) => setRegions((prev) => ({ ...prev, [state.code]: next }))}
                      placeholder="Not mapped"
                    />
                  </TD>
                  <TD align="right">
                    <button
                      type="button"
                      className="btn-secondary px-3 py-1.5 text-xs"
                      disabled={save.isPending}
                      onClick={() => save.mutate({ code: state.code, region: value })}
                    >
                      Save
                    </button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {save.isError ? <Alert tone="error">{(save.error as Error).message}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Region mapping saved.</Alert> : null}
    </Section>
  );
}

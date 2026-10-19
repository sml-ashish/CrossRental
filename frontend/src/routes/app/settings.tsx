import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Field, Section, Select, TextArea } from "@/components/ui/form";
import {
  MASTER_LIST_KEYS,
  MASTER_LIST_LABELS,
  QUOTE_MASTER_LIST_KEYS,
  SAP_MASTER_LIST_KEYS,
  loadMasterLists,
  loadSettings,
  updateMasterList,
  updateSettings,
  type MasterListKey,
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
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Portal configuration for SML staff.
        </p>
      </header>

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

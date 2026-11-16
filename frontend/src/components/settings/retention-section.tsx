import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import {
  Callout,
  NumberStepper,
  SectionActions,
  SettingsGate,
  SettingsSection,
  integerRangeError,
  useSectionRegistration,
  type SettingsQuery,
} from "@/components/settings/parts";
import { updateAlertSettings, type PortalSettings } from "@/lib/settings";

/**
 * Report retention (open item 11).
 *
 * The figure is real — it is stored in `app_settings` and read back by the
 * settings API — but as of today nothing consumes it. Saying "records older
 * than this are deleted" would be a lie, and an admin who believed it might
 * expect data to disappear. So the section states the one thing that is true:
 * nothing is deleted or hidden automatically, and this is the configured rule
 * for the retention decision the owner still has to make.
 */

const LIMITS = { min: 1, max: 600 } as const;

export function RetentionSection({ query }: { query: SettingsQuery }) {
  const queryClient = useQueryClient();
  const settings = query.data?.settings ?? null;

  const [months, setMonths] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const servedMonths = useRef<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    const served = String(settings.reportRetentionMonths);
    setMonths((previous) => (servedMonths.current === null || previous === servedMonths.current ? served : previous));
    servedMonths.current = served;
  }, [settings]);

  const save = useMutation({
    mutationFn: (value: number) => updateAlertSettings({ reportRetentionMonths: value }),
    onSuccess: (data) => {
      queryClient.setQueryData<{ settings: PortalSettings }>(["settings"], data);
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const dirty = Boolean(settings) && months !== String(settings?.reportRetentionMonths);
  const clientError = integerRangeError(months, LIMITS.min, LIMITS.max);

  function requestSave() {
    if (!dirty || clientError || save.isPending) return;
    save.mutate(Number(months));
  }

  function discard() {
    if (settings) setMonths(String(settings.reportRetentionMonths));
    save.reset();
  }

  useSectionRegistration("retention", dirty, { save: requestSave, discard });

  return (
    <SettingsSection
      id="retention"
      title="Data and retention"
      summary="The retention period the portal records, and what it does with old records."
      actions={
        <SectionActions
          dirty={dirty}
          pending={save.isPending}
          error={save.error}
          savedAt={savedAt}
          onSave={requestSave}
          onDiscard={discard}
          saveLabel="Save retention"
          canSave={!clientError}
        />
      }
    >
      <SettingsGate query={query} fields={2}>
        {() => (
          <>
            <div className="-my-4">
              <NumberStepper
                id="report-retention-months"
                label="Report retention period"
                hint="How many months of history the report retention rule covers. Stored as configuration; reports read live records today."
                unit="months"
                value={months}
                onChange={setMonths}
                min={LIMITS.min}
                max={LIMITS.max}
                error={clientError}
                disabled={save.isPending}
              />
            </div>

            <div className="mt-4">
              <Callout>
                <span className="font-medium">Nothing is deleted or hidden automatically.</span> No
                vendor, enquiry, quotation, booking or report is removed because of its age, and
                lowering this figure will not make anything disappear. It records the retention
                period; the deletion policy itself is not built.
              </Callout>
            </div>

            {save.error ? (
              <div className="mt-4">
                <Alert tone="error" title="The retention period was not saved">
                  {save.error.message}
                </Alert>
              </div>
            ) : null}
          </>
        )}
      </SettingsGate>
    </SettingsSection>
  );
}

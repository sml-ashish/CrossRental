import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  NumberStepper,
  SectionActions,
  SettingsGate,
  SettingsSection,
  SwitchField,
  integerRangeError,
  useSectionRegistration,
  type SettingsQuery,
} from "@/components/settings/parts";
import { ApiError } from "@/lib/api";
import { updateAlertSettings, type PortalSettings } from "@/lib/settings";

/**
 * Alert thresholds (brief 7.3 / open item 11).
 *
 * The same values drive the dashboard alerts and the daily email digest, so
 * every field says what it makes appear and prints the range the API accepts.
 * They are saved together because they are read together.
 */

interface Draft {
  rfqSla: string;
  quotationDays: string;
  bookingDays: string;
  emails: boolean;
}

const LIMITS = {
  rfqSla: { min: 1, max: 720 },
  quotationDays: { min: 1, max: 90 },
  bookingDays: { min: 1, max: 90 },
} as const;

function draftFrom(settings: PortalSettings): Draft {
  return {
    rfqSla: String(settings.alertRfqSlaHours),
    quotationDays: String(settings.alertQuotationExpiryDays),
    bookingDays: String(settings.alertBookingLeadDays),
    emails: settings.alertEmailsEnabled,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.rfqSla === b.rfqSla &&
    a.quotationDays === b.quotationDays &&
    a.bookingDays === b.bookingDays &&
    a.emails === b.emails
  );
}

const EMPTY: Draft = { rfqSla: "", quotationDays: "", bookingDays: "", emails: false };

export function AlertsSection({ query }: { query: SettingsQuery }) {
  const queryClient = useQueryClient();
  const settings = query.data?.settings ?? null;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const servedDraft = useRef<Draft | null>(null);

  // Follow the server until the admin changes something the server has not seen.
  useEffect(() => {
    if (!settings) return;
    const next = draftFrom(settings);
    setDraft((previous) =>
      servedDraft.current === null || sameDraft(previous, servedDraft.current) ? next : previous,
    );
    servedDraft.current = next;
  }, [settings]);

  const save = useMutation({
    mutationFn: (next: Draft) =>
      updateAlertSettings({
        alertRfqSlaHours: Number(next.rfqSla),
        alertQuotationExpiryDays: Number(next.quotationDays),
        alertBookingLeadDays: Number(next.bookingDays),
        alertEmailsEnabled: next.emails,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const dirty = Boolean(settings) && !sameDraft(draft, draftFrom(settings as PortalSettings));

  const clientErrors = {
    rfqSla: integerRangeError(draft.rfqSla, LIMITS.rfqSla.min, LIMITS.rfqSla.max),
    quotationDays: integerRangeError(
      draft.quotationDays,
      LIMITS.quotationDays.min,
      LIMITS.quotationDays.max,
    ),
    bookingDays: integerRangeError(draft.bookingDays, LIMITS.bookingDays.min, LIMITS.bookingDays.max),
  };
  const invalid = Object.values(clientErrors).some(Boolean);

  const apiError = save.error instanceof ApiError ? save.error : null;

  function requestSave() {
    if (dirty && !invalid && !save.isPending) save.mutate(draft);
  }

  function discard() {
    if (settings) setDraft(draftFrom(settings));
    save.reset();
  }

  useSectionRegistration("alerts", dirty, { save: requestSave, discard });

  return (
    <SettingsSection
      id="alerts"
      title="Alerts and notifications"
      summary="When an item starts showing as an alert, and whether the daily digest is emailed. These thresholds also decide what the admin dashboard counts."
      actions={
        <SectionActions
          dirty={dirty}
          pending={save.isPending}
          error={save.error}
          savedAt={savedAt}
          onSave={requestSave}
          onDiscard={discard}
          canSave={!invalid}
        />
      }
    >
      <SettingsGate query={query} fields={3}>
        {(loaded) => (
          <>
            <div className="divide-y divide-ink-800">
              <NumberStepper
                id="alert-rfq-sla"
                label="RFQ response SLA"
                hint="RFQs with no vendor reply after this long appear as alerts."
                unit="hours"
                value={draft.rfqSla}
                onChange={(value) => setDraft((prev) => ({ ...prev, rfqSla: value }))}
                min={LIMITS.rfqSla.min}
                max={LIMITS.rfqSla.max}
                error={clientErrors.rfqSla ?? apiError?.fieldError("alertRfqSlaHours") ?? null}
                disabled={save.isPending}
              />
              <NumberStepper
                id="alert-quotation-expiry"
                label="Quotation expiry warning"
                hint="Quotations expiring within this many days appear as alerts."
                unit="days"
                value={draft.quotationDays}
                onChange={(value) => setDraft((prev) => ({ ...prev, quotationDays: value }))}
                min={LIMITS.quotationDays.min}
                max={LIMITS.quotationDays.max}
                error={
                  clientErrors.quotationDays ??
                  apiError?.fieldError("alertQuotationExpiryDays") ??
                  null
                }
                disabled={save.isPending}
              />
              <NumberStepper
                id="alert-booking-lead"
                label="Booking lead alert"
                hint="Bookings starting within this many days appear as alerts."
                unit="days"
                value={draft.bookingDays}
                onChange={(value) => setDraft((prev) => ({ ...prev, bookingDays: value }))}
                min={LIMITS.bookingDays.min}
                max={LIMITS.bookingDays.max}
                error={
                  clientErrors.bookingDays ?? apiError?.fieldError("alertBookingLeadDays") ?? null
                }
                disabled={save.isPending}
              />
              <SwitchField
                id="alert-emails-enabled"
                label="Alert emails"
                hint="Send the daily alert digest to SML staff. The digest lists the same items the dashboard shows."
                checked={draft.emails}
                onChange={(checked) => setDraft((prev) => ({ ...prev, emails: checked }))}
                disabled={save.isPending}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink-800 pt-4 text-[13px] text-slate-500">
              <span>
                Alert emails are {loaded.alertEmailsEnabled ? "on" : "off"} today. Alerts are
                computed when the dashboard is opened, not stored.
              </span>
              <Link
                to="/app/admin"
                className="inline-flex items-center gap-1 font-medium text-accent-400 underline-offset-4 hover:underline"
              >
                See current alerts
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>

            {save.error ? (
              <div className="mt-4">
                <Alert tone="error" title="The alert settings were not saved">
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

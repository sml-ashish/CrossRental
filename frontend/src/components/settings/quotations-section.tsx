import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  Callout,
  ConfirmDialog,
  SectionActions,
  SettingsGate,
  SettingsSection,
  useSectionRegistration,
  type SettingsQuery,
} from "@/components/settings/parts";
import { cn } from "@/lib/cn";
import {
  DAYS_PER_MONTH,
  DEFAULT_WORKING_DAYS_PER_MONTH,
  WORKED_EXAMPLE,
  formatRupees,
  perDayHireTotal,
} from "@/lib/quotationBasis";
import { updateSettings, type RateDayBasis } from "@/lib/settings";

/**
 * Quotation rules (brief 6.7).
 *
 * One setting, but the most consequential on the page: it decides how a quoted
 * month becomes days for every total calculated from now on. So it is a pair of
 * explained options rather than a dropdown, it shows the arithmetic before it is
 * saved, and it asks before it writes.
 */

const RANK_LABELS: Record<string, string> = {
  TOTAL_ESTIMATED_COST: "total estimated cost",
};

const OPTIONS: Array<{ value: RateDayBasis; label: string; explanation: string }> = [
  {
    value: "CALENDAR_DAYS",
    label: "Calendar days",
    explanation: `A month counts as ${DAYS_PER_MONTH} days, whatever the month. Reproducible by hand and the same in every quotation.`,
  },
  {
    value: "WORKING_DAYS_PER_MONTH",
    label: "Working days per month",
    explanation: `A month counts as the working days captured on the RFQ — ${DEFAULT_WORKING_DAYS_PER_MONTH} when the RFQ carries none.`,
  },
];

const CHANGE_NOTE =
  "Changes the total on every quotation calculated after saving.";

export function QuotationsSection({ query }: { query: SettingsQuery }) {
  const queryClient = useQueryClient();
  const settings = query.data?.settings ?? null;

  const [basis, setBasis] = useState<RateDayBasis>("CALENDAR_DAYS");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const servedBasis = useRef<RateDayBasis | undefined>(undefined);

  // Follow the server unless the admin has chosen something it has not seen yet.
  useEffect(() => {
    const served = settings?.rateDayBasis;
    if (!served) return;
    setBasis((previous) => (previous === servedBasis.current ? served : previous));
    servedBasis.current = served;
  }, [settings?.rateDayBasis]);

  const save = useMutation({
    mutationFn: (next: RateDayBasis) => updateSettings(next),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setSavedAt(Date.now());
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    // Close the dialog on failure too, so the section's own error line is not
    // hidden behind a modal that looks like it is still busy.
    onError: () => setConfirming(false),
  });

  const dirty = Boolean(settings) && basis !== settings?.rateDayBasis;

  function requestSave() {
    if (dirty && !save.isPending) setConfirming(true);
  }

  function discard() {
    if (settings) setBasis(settings.rateDayBasis);
    save.reset();
  }

  useSectionRegistration("quotations", dirty, { save: requestSave, discard });

  return (
    <SettingsSection
      id="quotations"
      title="Quotations"
      summary="How a quoted month converts to days, and how quotes are ranked. Every quotation total in the portal follows these rules."
      actions={
        <SectionActions
          dirty={dirty}
          pending={save.isPending}
          error={save.error}
          savedAt={savedAt}
          onSave={requestSave}
          onDiscard={discard}
          saveLabel="Save day basis"
        />
      }
    >
      <SettingsGate query={query} fields={3}>
        {(loaded) => (
          <>
            <fieldset disabled={save.isPending}>
              <legend className="text-sm font-medium text-slate-900">
                How a quoted month converts to days
              </legend>
              <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
                {OPTIONS.map((option) => {
                  const selected = basis === option.value;
                  const inUse = loaded.rateDayBasis === option.value;
                  return (
                    <label
                      key={option.value}
                      className={cn(
                        "relative flex cursor-pointer items-start gap-3 rounded-xl border bg-ink-850 p-4 transition-colors",
                        "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500",
                        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
                        selected
                          ? "border-accent-500"
                          : "border-ink-800 hover:border-ink-700",
                      )}
                    >
                      <input
                        type="radio"
                        name="rateDayBasis"
                        value={option.value}
                        checked={selected}
                        onChange={() => setBasis(option.value)}
                        className="mt-0.5 size-4 shrink-0 accent-accent-500"
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-slate-900">
                            {option.label}
                          </span>
                          {inUse ? (
                            <span className="rounded-full border border-ink-700 px-1.5 py-0.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
                              In use
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-[13px] leading-relaxed text-slate-500">
                          {option.explanation}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-4">
              <Callout>{CHANGE_NOTE}</Callout>
            </div>

            <WorkedExample basis={basis} />

            <div className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink-800 pt-4 text-[13px]">
              <Lock className="size-3.5 shrink-0 text-slate-500" aria-hidden />
              <span className="text-slate-500">Quotes are ranked by</span>
              <span className="font-medium text-slate-900">
                {RANK_LABELS[loaded.quoteRankRule] ?? loaded.quoteRankRule}
              </span>
              <span className="text-slate-500">— the only ranking rule today.</span>
            </div>

            {save.error ? (
              <div className="mt-4">
                <Alert tone="error" title="The day basis was not saved">
                  {save.error.message}
                </Alert>
              </div>
            ) : null}
          </>
        )}
      </SettingsGate>

      <ConfirmDialog
        open={confirming}
        title="Save the new day basis?"
        confirmLabel="Save day basis"
        onCancel={() => setConfirming(false)}
        onConfirm={() => save.mutate(basis)}
      >
        <p>
          Every quotation calculated after you save uses{" "}
          <span className="font-medium text-slate-900">
            {OPTIONS.find((option) => option.value === basis)?.label.toLowerCase()}
          </span>
          . Quotations already sent keep the totals they were sent with.
        </p>
        <p className="mt-2">{CHANGE_NOTE}</p>
      </ConfirmDialog>
    </SettingsSection>
  );
}

/**
 * The arithmetic, shown with the same functions the server uses.
 *
 * Both bases are printed so the difference is visible before choosing; the
 * selected one is marked, so the example follows the radio as it changes.
 */
function WorkedExample({ basis }: { basis: RateDayBasis }) {
  const rows = [
    {
      key: "CALENDAR_DAYS" as RateDayBasis,
      label: "Calendar days",
      days: WORKED_EXAMPLE.months * DAYS_PER_MONTH,
      monthLength: DAYS_PER_MONTH,
    },
    {
      key: "WORKING_DAYS_PER_MONTH" as RateDayBasis,
      label: "Working days per month",
      days: WORKED_EXAMPLE.months * DEFAULT_WORKING_DAYS_PER_MONTH,
      monthLength: DEFAULT_WORKING_DAYS_PER_MONTH,
    },
  ];

  return (
    <div className="mt-6 rounded-xl border border-ink-800 bg-ink-900 p-4">
      <h3 className="text-sm font-medium text-slate-900">Worked example</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
        A vendor quotes{" "}
        <span className="font-medium text-slate-700">
          {formatRupees(WORKED_EXAMPLE.ratePerDay)} per day
        </span>{" "}
        for a {WORKED_EXAMPLE.months}-month hire.
      </p>

      <table className="mt-3 w-full text-[13px]">
        <caption className="sr-only">
          Rental charge for the same per-day quote under each day basis
        </caption>
        <thead>
          <tr className="text-slate-500">
            <th scope="col" className="pb-2 text-left font-medium">
              Basis
            </th>
            <th scope="col" className="pb-2 text-left font-medium">
              Days in the hire
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Rental charge
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((row) => {
            const selected = row.key === basis;
            const total = perDayHireTotal(WORKED_EXAMPLE.ratePerDay, WORKED_EXAMPLE.months, {
              rateDayBasis: row.key,
            });
            return (
              <tr key={row.key} className={selected ? "text-slate-900" : "text-slate-500"}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  <span className="flex flex-wrap items-center gap-2">
                    {row.label}
                    {selected ? (
                      <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-xs font-medium text-accent-400">
                        Selected
                      </span>
                    ) : null}
                  </span>
                </th>
                <td className="py-2 pr-3 tabular-nums">
                  {WORKED_EXAMPLE.months} × {row.monthLength} = {row.days} days
                </td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {formatRupees(total)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        Working days come from the RFQ; {DEFAULT_WORKING_DAYS_PER_MONTH} is the fallback when it
        carries none. Mobilisation, demobilisation and tax are added after this line. A monthly
        rate for a monthly hire multiplies out the same under either basis.
      </p>
    </div>
  );
}

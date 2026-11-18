import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { Field, TextInput } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { createRfqFromLine } from "@/lib/enquiries";
import { listApprovedVendors, sendRfq, type SendResult } from "@/lib/rfqs";
import { addDays, todayDay } from "@/lib/enquiryDetail";
import type { RecommendationCrane } from "@/lib/discovery";
import { cn } from "@/lib/cn";

/**
 * Send an RFQ to the vendors that own the cranes ticked in the recommendation
 * list.
 *
 * The RFQ itself is always raised from the enquiry line (the backend prefills
 * the core requirement; the deadline and the chosen fields are sent) and then
 * dispatched to the chosen vendors by id. Picking a crane picks its vendor: a
 * vendor with three ticked cranes gets one RFQ, not three, and a vendor with no
 * ticked crane is never contacted.
 */

export interface SendRfqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineId: string;
  lineLabel: string;
  cranes: RecommendationCrane[];
  /** Open with "all approved vendors" already ticked. */
  startWithAll?: boolean;
  /** Called after a successful send so the screen can clear its ticks. */
  onSent: () => void;
}

interface VendorGroup {
  vendorId: string;
  vendorName: string;
  cranes: RecommendationCrane[];
}

function groupByVendor(cranes: RecommendationCrane[]): VendorGroup[] {
  const map = new Map<string, VendorGroup>();
  for (const crane of cranes) {
    const group = map.get(crane.vendorId);
    if (group) group.cranes.push(crane);
    else map.set(crane.vendorId, { vendorId: crane.vendorId, vendorName: crane.vendorName, cranes: [crane] });
  }
  return [...map.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

export function SendRfqDialog({
  open,
  onOpenChange,
  lineId,
  lineLabel,
  cranes,
  startWithAll = false,
  onSent,
}: SendRfqDialogProps) {
  const queryClient = useQueryClient();
  const vendors = useMemo(() => groupByVendor(cranes), [cranes]);
  const [deadline, setDeadline] = useState(() => addDays(todayDay(), 7));
  /** Email every approved vendor instead of only the vendors of the ticked cranes. */
  const [allApproved, setAllApproved] = useState(false);
  /** Tag the ticked cranes against the RFQ. Off, and ignored, for "all approved vendors". */
  const [tagCranes, setTagCranes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the RFQ exists, so a failed send is retried without a duplicate. */
  const [rfq, setRfq] = useState<{ id: string; rfqNumber: string } | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  /** The field-selection screen, shown first whenever an RFQ is still to be raised. */
  const [fieldsOpen, setFieldsOpen] = useState(false);

  // A fresh dialog is a fresh RFQ.
  useEffect(() => {
    if (!open) return;
    setDeadline(addDays(todayDay(), 7));
    setError(null);
    setRfq(null);
    setResult(null);
    setAllApproved(startWithAll);
    setTagCranes(true);
    setFieldsOpen(false);
  }, [open, lineId, startWithAll]);

  async function submit(fieldKeys?: RfqLineFieldKey[]) {
    if (!rfq && !fieldKeys) return;
    setBusy(true);
    setError(null);
    try {
      let target = rfq;
      if (!target) {
        const created = await createRfqFromLine(lineId, deadline, fieldKeys);
        target = { id: created.rfq.id, rfqNumber: created.rfq.rfqNumber };
        setRfq(target);
      }
      // Email is the only channel.
      const vendorIds = allApproved
        ? (await listApprovedVendors("")).vendors.map((vendor) => vendor.id)
        : vendors.map((vendor) => vendor.vendorId);
      if (vendorIds.length === 0) throw new ApiError(400, "no_vendors", "No approved vendors to send to.");
      // Sending to every approved vendor goes out untagged; a send to the ticked
      // cranes' vendors tags those cranes when the box is on.
      const craneIds = !allApproved && tagCranes ? cranes.map((crane) => crane.craneId) : undefined;
      const sent = await sendRfq(target.id, vendorIds, ["EMAIL"], craneIds);
      setResult(sent.result);
      await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the RFQ.");
    } finally {
      setBusy(false);
    }
  }

  const done = result !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send RFQ to vendors"
      description={
        allApproved
          ? `${lineLabel} · every approved vendor, by email`
          : `${lineLabel} · ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}, ${cranes.length} crane${cranes.length === 1 ? "" : "s"} selected`
      }
      className="sm:max-w-[520px]"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-ink-700 px-3 py-2 text-[15px] font-medium text-slate-600 transition-colors hover:bg-ink-850"
          >
            {done ? "Close" : "Cancel"}
          </button>
          {done && rfq ? (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: rfq.id }}
              className="rounded-lg bg-accent-500 px-3 py-2 text-[15px] font-semibold text-[#fff] transition-colors hover:bg-accent-600"
            >
              Open {rfq.rfqNumber}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => (rfq ? void submit() : setFieldsOpen(true))}
              disabled={busy || (!allApproved && vendors.length === 0) || !deadline}
              className="rounded-lg bg-accent-500 px-3 py-2 text-[15px] font-semibold text-[#fff] transition-colors hover:bg-accent-600 disabled:opacity-50"
            >
              {busy
                ? "Sending…"
                : rfq
                  ? "Retry sending"
                  : allApproved
                    ? "Email all approved vendors"
                    : `Email ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert tone="error" title={rfq ? `${rfq.rfqNumber} was created but not sent` : "Could not send"}>
            {error}
          </Alert>
        ) : null}

        {done ? (
          <Alert
            tone={result.failed > 0 ? "error" : "success"}
            title={`${rfq?.rfqNumber ?? "RFQ"}: sent to ${result.sent} vendor${result.sent === 1 ? "" : "s"}${
              result.failed > 0 ? `, ${result.failed} failed` : ""
            }`}
          >
            {result.failed > 0
              ? result.results
                  .filter((row) => row.status === "FAILED")
                  .map((row) => {
                    const vendor = vendors.find((item) => item.vendorId === row.vendorId);
                    return `${vendor?.vendorName ?? "Vendor"}: ${row.error ?? "delivery failed"}`;
                  })
                  .join(" · ")
              : "The vendors have been emailed and can quote from their portal."}
          </Alert>
        ) : (
          <>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-800 px-3.5 py-3 text-[15px] text-slate-800">
              <input
                type="checkbox"
                checked={allApproved}
                onChange={(event) => setAllApproved(event.target.checked)}
                className="mt-1 accent-accent-500"
              />
              <span>
                <span className="font-semibold">Send to all approved vendors</span>
                <span className="mt-0.5 block text-slate-500">
                  Emails every approved vendor, not just the ones with ticked cranes.
                </span>
              </span>
            </label>
            {!allApproved && cranes.length > 0 ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-800 px-3.5 py-3 text-[15px] text-slate-800">
                <input
                  type="checkbox"
                  checked={tagCranes}
                  onChange={(event) => setTagCranes(event.target.checked)}
                  className="mt-1 accent-accent-500"
                />
                <span>
                  <span className="font-semibold">
                    Tag the {cranes.length} selected crane{cranes.length === 1 ? "" : "s"} on this RFQ
                  </span>
                  <span className="mt-0.5 block text-slate-500">
                    Each vendor sees its tagged cranes first and can quote every one of them, or any
                    other crane from its fleet. Untick to send without tagging.
                  </span>
                </span>
              </label>
            ) : null}
            <ul className={cn("divide-y divide-ink-800 rounded-xl border border-ink-800", allApproved && "opacity-50")}>
              {vendors.map((vendor) => (
                <li key={vendor.vendorId} className="px-3.5 py-2.5">
                  <p className="text-[15px] font-semibold text-slate-900">{vendor.vendorName}</p>
                  <p className="mt-0.5 text-[14px] text-slate-500">
                    {vendor.cranes
                      .map((crane) => `${crane.make} ${crane.model} (${Math.round(crane.capacityT)} t)`)
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-end gap-2">
              <Field label="Submission deadline" htmlFor="send-rfq-deadline">
                <TextInput
                  id="send-rfq-deadline"
                  type="date"
                  value={deadline}
                  onChange={setDeadline}
                  disabled={Boolean(rfq)}
                />
              </Field>
              <div className="flex gap-1.5">
                {[3, 7, 14].map((days) => (
                  <button
                    key={days}
                    type="button"
                    disabled={Boolean(rfq)}
                    onClick={() => setDeadline(addDays(todayDay(), days))}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-[14px] font-medium transition-colors disabled:opacity-50",
                      deadline === addDays(todayDay(), days)
                        ? "border-accent-500 bg-accent-500/10 text-accent-400"
                        : "border-ink-800 bg-ink-850 text-slate-500 hover:border-ink-700 hover:text-slate-800",
                    )}
                  >
                    +{days} days
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[14px] text-slate-500">
              One RFQ is raised from this enquiry line and emailed {allApproved ? "to every approved vendor, with no crane tagged" : "only to the vendors above"}.
              Only the fields you tick are copied; customer name, address and the internal budget
              are never sent.
            </p>
          </>
        )}
      </div>

      {/* Raising an RFQ always starts here: choose the line fields first. */}
      <RfqFieldsScreen
        open={fieldsOpen && !rfq}
        lineId={lineId}
        title="Raise RFQ"
        lineLabel={lineLabel}
        deadline={deadline}
        onDeadline={setDeadline}
        confirmLabel={
          allApproved
            ? "Raise and email all approved vendors"
            : `Raise and email ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}`
        }
        pending={busy}
        error={error}
        onConfirm={(keys) => {
          setFieldsOpen(false);
          void submit(keys);
        }}
        onClose={() => setFieldsOpen(false)}
      />
    </Dialog>
  );
}

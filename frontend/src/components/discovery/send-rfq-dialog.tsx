import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { RfqFieldsScreen } from "@/components/rfq-fields-screen";
import type { RfqLineFieldKey } from "@/lib/rfqLineFields";
import { ApiError } from "@/lib/api";
import { createRfqFromLine } from "@/lib/enquiries";
import { listApprovedVendors, sendRfq, type SendResult } from "@/lib/rfqs";
import { addDays, todayDay } from "@/lib/enquiryDetail";
import type { RecommendationCrane } from "@/lib/discovery";

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

  // A fresh dialog is a fresh RFQ.
  useEffect(() => {
    if (!open) return;
    setDeadline(addDays(todayDay(), 7));
    setError(null);
    setRfq(null);
    setResult(null);
    setAllApproved(startWithAll);
    setTagCranes(true);
  }, [open, lineId, startWithAll]);

  async function submit(fieldKeys?: RfqLineFieldKey[], remark?: string) {
    if (!rfq && !fieldKeys) return;
    setBusy(true);
    setError(null);
    try {
      let target = rfq;
      if (!target) {
        const created = await createRfqFromLine(lineId, deadline, fieldKeys, remark);
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

  const sectionTitle = "text-[12px] font-semibold text-slate-600";
  const optionBox =
    "flex cursor-pointer items-start gap-2.5 rounded-md border border-ink-800 bg-ink-900 px-3 py-2.5 text-[13px] text-slate-800";

  // The one window: choose recipients, deadline and fields together, then raise
  // and email in a single confirmation. The result replaces the body in place.
  return (
    <RfqFieldsScreen
      open={open}
      lineId={lineId}
      title="Raise RFQ"
      lineLabel={
        allApproved
          ? `${lineLabel} · every approved vendor, by email`
          : `${lineLabel} · ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}, ${cranes.length} crane${cranes.length === 1 ? "" : "s"} selected`
      }
      deadline={deadline}
      onDeadline={setDeadline}
      confirmLabel={
        busy
          ? "Sending…"
          : rfq
            ? "Retry sending"
            : allApproved
              ? "Raise and email all vendors"
              : `Raise and email ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}`
      }
      pending={busy}
      locked={Boolean(rfq)}
      confirmDisabled={!allApproved && vendors.length === 0}
      error={error}
      errorTitle={rfq ? `${rfq.rfqNumber} was created but not sent` : "Could not send"}
      onConfirm={(keys, remark) => void submit(keys, remark)}
      onClose={() => onOpenChange(false)}
      extra={
        <section aria-label="Recipients" className="space-y-2">
          <h3 className={sectionTitle}>Send to</h3>
          <label className={optionBox}>
            <input
              type="checkbox"
              checked={allApproved}
              disabled={Boolean(rfq) || busy}
              onChange={(event) => setAllApproved(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent-500"
            />
            <span>
              <span className="font-semibold">Send to all approved vendors</span>
              <span className="mt-0.5 block text-[12px] text-slate-600">
                Emails every approved vendor, not just the ones with ticked cranes.
              </span>
            </span>
          </label>

          {!allApproved && cranes.length > 0 ? (
            <label className={optionBox}>
              <input
                type="checkbox"
                checked={tagCranes}
                disabled={Boolean(rfq) || busy}
                onChange={(event) => setTagCranes(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-accent-500"
              />
              <span>
                <span className="font-semibold">
                  Tag the {cranes.length} selected crane{cranes.length === 1 ? "" : "s"}
                </span>
                <span className="mt-0.5 block text-[12px] text-slate-600">
                  Each vendor sees its tagged cranes first. Untick to send without tagging.
                </span>
              </span>
            </label>
          ) : null}

          {vendors.length > 0 ? (
            <div className={allApproved ? "opacity-60" : undefined}>
              <p className="mt-1 text-[12px] font-semibold text-slate-600">
                Selected vendor{vendors.length === 1 ? "" : "s"} ({vendors.length})
                {allApproved ? " · included in all approved" : ""}
              </p>
              <ul className="mt-1.5 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
                {vendors.map((vendor) => (
                  <li key={vendor.vendorId} className="px-3 py-2">
                    <p className="text-[13px] font-semibold text-slate-900">{vendor.vendorName}</p>
                    <p className="mt-0.5 text-[12px] text-slate-600">
                      {vendor.cranes
                        .map((crane) => `${crane.make} ${crane.model} (${Math.round(crane.capacityT)} t)`)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      }
      outcome={
        done ? (
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
        ) : undefined
      }
      outcomeFooter={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="btn-secondary !py-1.5 !text-[13px]"
          >
            Close
          </button>
          {rfq ? (
            <Link
              to="/app/rfqs/$rfqId"
              params={{ rfqId: rfq.id }}
              className="btn-primary !py-1.5 !text-[13px]"
            >
              Open {rfq.rfqNumber}
            </Link>
          ) : null}
        </div>
      }
    />
  );
}

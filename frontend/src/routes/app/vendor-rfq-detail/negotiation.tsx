import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DialogFooter, DialogShell } from "@/components/negotiation/dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Field, TextArea } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format";
import {
  inr,
  latestRound,
  NEGOTIATION_STATUS_LABELS_VENDOR,
  needsWarningAcknowledgement,
  negotiationTone,
  timeLeft,
} from "@/lib/negotiation-display";
import {
  getVendorRfqNegotiations,
  previewVendorCounter,
  vendorAccept,
  vendorCounter,
  vendorDecline,
  type NegotiationPreview,
  type NegotiationThread,
} from "@/lib/negotiations";
import {
  emptyOfferForm,
  OfferFieldsForm,
  toOfferFields,
  type OfferFormValues,
} from "@/components/negotiation/offer-fields";
import { OfferPreview } from "@/components/negotiation/preview";
import { OfferComparison } from "../rfq-detail/negotiations";

/** The buyer's counter-offers on this RFQ, compared side by side with your quote. */
export function VendorNegotiations({
  rfqId,
  submissionDeadline,
}: {
  rfqId: string;
  submissionDeadline: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["vendor-rfq-negotiations", rfqId],
    queryFn: () => getVendorRfqNegotiations(rfqId),
  });
  const threads = query.data?.negotiations ?? [];
  const deadlinePassed = new Date(submissionDeadline).getTime() < Date.now();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["vendor-rfq-negotiations", rfqId] });

  if (query.isLoading || threads.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-[17px] font-semibold text-slate-900">Negotiations</h2>
      <ul className="space-y-3">
        {threads.map((thread) => (
          <VendorThreadCard
            key={thread.negotiationId}
            thread={thread}
            deadlinePassed={deadlinePassed}
            onDone={refresh}
          />
        ))}
      </ul>
    </section>
  );
}

function VendorThreadCard({
  thread,
  deadlinePassed,
  onDone,
}: {
  thread: NegotiationThread;
  deadlinePassed: boolean;
  onDone: () => void;
}) {
  const [dialog, setDialog] = useState<"counter" | "accept" | "decline" | null>(null);
  const latest = latestRound(thread.rounds);
  const awaitingVendor = thread.status === "AWAITING_VENDOR";
  const canRespond = awaitingVendor && !deadlinePassed && !thread.deadlinePassed;
  const responseDue = latest?.respondBy;
  const done = () => {
    setDialog(null);
    onDone();
  };

  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] font-semibold text-slate-900">{thread.craneLabel}</h3>
            <Badge tone={negotiationTone(thread.status)}>
              {NEGOTIATION_STATUS_LABELS_VENDOR[thread.status]}
            </Badge>
            {latest?.isFinal ? <Badge tone="purple">Final round</Badge> : null}
          </div>
          <p className="mt-1 text-[14px] text-slate-500">
            Round {thread.currentRound} of {thread.maxRounds}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Latest offer
          </p>
          <p className="text-[24px] leading-7 font-semibold text-slate-900 tabular-nums">
            ₹{inr(latest?.totalQuotedValue ?? thread.baseQuotation.totalQuotedValue)}
          </p>
          <p className="text-[13px] text-slate-500">
            vs ₹{inr(thread.baseQuotation.totalQuotedValue)} your quote
          </p>
        </div>
      </div>

      {thread.status === "AGREED" && thread.agreedQuotation ? (
        <p className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-[15px] font-medium text-emerald-600">
          Terms agreed at ₹{inr(thread.agreedQuotation.totalQuotedValue)}.
        </p>
      ) : null}
      {["DECLINED", "EXPIRED", "CANCELLED"].includes(thread.status) ? (
        <p className="mt-3 text-[14px] text-slate-500">
          {thread.closedReason ?? "This negotiation is closed."}
        </p>
      ) : null}

      <OfferComparison thread={thread} viewer="vendor" />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 pt-4">
        <p className="text-[13px] text-slate-500">
          {awaitingVendor
            ? responseDue
              ? `Respond by ${formatDateTime(responseDue)} · ${timeLeft(responseDue) ?? ""}`
              : "Your response is needed"
            : thread.status === "AWAITING_SML"
              ? "Waiting for the buyer to respond"
              : "No action needed"}
        </p>
        {canRespond ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary px-3 py-2 text-[15px]"
              onClick={() => setDialog("decline")}
            >
              Decline
            </button>
            {thread.currentRound < thread.maxRounds ? (
              <button
                type="button"
                className="btn-secondary px-3 py-2 text-[15px]"
                onClick={() => setDialog("counter")}
              >
                Counter
              </button>
            ) : null}
            <button
              type="button"
              className="btn-primary px-3 py-2 text-[15px]"
              onClick={() => setDialog("accept")}
            >
              Accept offer
            </button>
          </div>
        ) : null}
      </div>

      {dialog === "counter" ? (
        <VendorCounterDialog thread={thread} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === "accept" ? (
        <VendorAcceptDialog thread={thread} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === "decline" ? (
        <VendorDeclineDialog thread={thread} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </li>
  );
}

function VendorCounterDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const latest = latestRound(thread.rounds);
  const base = thread.baseQuotation;
  const [form, setForm] = useState<OfferFormValues>(() =>
    emptyOfferForm({
      rentalRate: String(latest?.rentalRate ?? base.rentalRate),
      rateBasis: latest?.rateBasis ?? base.rateBasis,
      mobilisationCharges: String(latest?.mobilisationCharges ?? base.mobilisationCharges),
      demobilisationCharges: String(latest?.demobilisationCharges ?? base.demobilisationCharges),
      taxBasis: latest?.taxBasis ?? base.taxBasis,
      validityDate: (latest?.validityDate ?? base.validityDate).slice(0, 10),
      availableFrom: (latest?.availableFrom ?? base.availableFrom)?.slice(0, 10) ?? "",
      deviationText: latest?.deviationText ?? base.deviationText ?? "",
    }),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<NegotiationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const requestId = useRef(0);

  const offer = toOfferFields(form);
  const offerKey = JSON.stringify(offer);

  useEffect(() => {
    const id = ++requestId.current;
    if (!offer.rentalRate || !offer.validityDate) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      previewVendorCounter(thread.negotiationId, offer)
        .then((response) => {
          if (id !== requestId.current) return;
          setPreview(response.preview);
          setPreviewError(null);
        })
        .catch((error: Error) => {
          if (id !== requestId.current) return;
          setPreview(null);
          setPreviewError(error.message);
        })
        .finally(() => {
          if (id === requestId.current) setPreviewing(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.negotiationId, offerKey]);

  const blocking = needsWarningAcknowledgement(preview?.warnings ?? []);
  const counter = useMutation({
    mutationFn: () =>
      vendorCounter(thread.negotiationId, {
        ...offer,
        expectedVersion: thread.version,
        acknowledgeWarnings: acknowledged,
      }),
    onSuccess: onDone,
  });

  const canSubmit =
    preview !== null &&
    !previewing &&
    Boolean(offer.rentalRate) &&
    Boolean(offer.validityDate) &&
    (!blocking || acknowledged) &&
    !counter.isPending;

  return (
    <DialogShell title="Send a counter-offer" onClose={onClose}>
      <div className="space-y-4">
        {thread.currentRound + 1 >= thread.maxRounds ? (
          <Alert tone="error" title="Final round">
            This is the last round. After this offer the buyer can only accept or reject.
          </Alert>
        ) : null}
        <OfferFieldsForm
          prefix="vendor-counter"
          values={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        />
        <OfferPreview preview={preview} loading={previewing} error={previewError} />
        {blocking ? (
          <Checkbox
            id="vendor-ack-warnings"
            checked={acknowledged}
            onChange={setAcknowledged}
            label="I have reviewed the warnings above and want to send this offer anyway."
          />
        ) : null}
        {counter.isError ? (
          <Alert title="Counter not sent">{(counter.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[15px]"
          disabled={!canSubmit}
          onClick={() => counter.mutate()}
        >
          {counter.isPending ? <Spinner /> : null}
          Send counter
        </button>
      </DialogFooter>
    </DialogShell>
  );
}

function VendorAcceptDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const latest = latestRound(thread.rounds);
  const [confirm, setConfirm] = useState(false);
  const accept = useMutation({
    mutationFn: () =>
      vendorAccept(thread.negotiationId, { expectedVersion: thread.version, confirm: true }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Accept this offer" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Accepting ₹{inr(latest?.totalQuotedValue ?? 0)} agrees these terms. The buyer then
          confirms the award.
        </p>
        <Checkbox
          id="vendor-accept-confirm"
          checked={confirm}
          onChange={setConfirm}
          label="I have checked the offer terms and want to accept them."
        />
        {accept.isError ? (
          <Alert title="Not accepted">{(accept.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[15px]"
          disabled={!confirm || accept.isPending}
          onClick={() => accept.mutate()}
        >
          {accept.isPending ? <Spinner /> : null}
          Confirm acceptance
        </button>
      </DialogFooter>
    </DialogShell>
  );
}

function VendorDeclineDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const decline = useMutation({
    mutationFn: () =>
      vendorDecline(thread.negotiationId, {
        expectedVersion: thread.version,
        reason: reason.trim() || null,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Decline this negotiation" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Declining ends this negotiation. Your original quotation stays on the RFQ.
        </p>
        <Field label="Reason" htmlFor="vendor-decline-reason" hint="Optional.">
          <TextArea id="vendor-decline-reason" value={reason} onChange={setReason} rows={3} />
        </Field>
        {decline.isError ? (
          <Alert title="Not declined">{(decline.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[15px]"
          disabled={decline.isPending}
          onClick={() => decline.mutate()}
        >
          {decline.isPending ? <Spinner /> : null}
          Decline
        </button>
      </DialogFooter>
    </DialogShell>
  );
}

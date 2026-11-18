import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { DialogFooter, DialogShell } from "@/components/negotiation/dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Field, Select, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import {
  needsWarningAcknowledgement,
  inr,
  latestRound,
  NEGOTIATION_STATUS_LABELS,
  negotiationTone,
  timeLeft,
} from "@/lib/negotiation-display";
import {
  previewSmlCounter,
  smlAccept,
  smlCounter,
  smlReject,
  logVendorOffer,
  type NegotiationPreview,
  type NegotiationRound,
  type NegotiationThread,
} from "@/lib/negotiations";
import {
  emptyOfferForm,
  OfferFieldsForm,
  toOfferFields,
  type OfferFormValues,
} from "@/components/negotiation/offer-fields";
import { OfferPreview } from "@/components/negotiation/preview";

/**
 * Counter-quote threads for one RFQ (phase 1 + 2).
 *
 * SML starts a thread from a vendor's quotation (see `CounterButton` in the
 * quotations list) and then answers each vendor offer here. Every offer is a set
 * of structured terms; the server prices it and returns the total, so this
 * screen only ever displays a computed figure.
 */
export function NegotiationsSection({
  rfqId,
  negotiations,
  loading,
  canCounter,
  closed,
  deadlinePassed,
  submissionDeadline,
  onDone,
  onStartCounter,
}: {
  rfqId: string;
  negotiations: NegotiationThread[];
  loading: boolean;
  canCounter: boolean;
  closed: boolean;
  deadlinePassed: boolean;
  submissionDeadline: string;
  onDone: () => void;
  onStartCounter: () => void;
}) {
  const open = negotiations.filter((thread) =>
    ["AWAITING_VENDOR", "AWAITING_SML", "AGREED"].includes(thread.status),
  );
  const awaiting = negotiations.filter((thread) => thread.status === "AWAITING_SML").length;

  const nearDeadline = !closed && !deadlinePassed &&
    new Date(submissionDeadline).getTime() - Date.now() < 24 * 60 * 60 * 1000;

  return (
    <div className="space-y-4">
      {nearDeadline ? (
        <Alert tone="info" title="Deadline is close">
          Counter-offers and acceptances are blocked once the submission deadline passes. Extend the
          deadline if a negotiation still needs to finish.
        </Alert>
      ) : null}

      {deadlinePassed && open.length > 0 ? (
        <Alert tone="error" title="Submission deadline passed">
          These threads can no longer be answered. Extend the deadline to resume an agreed offer or
          an open negotiation.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Negotiations
          <span className="ml-2 text-[14px] font-normal text-slate-500">
            {awaiting > 0
              ? `${awaiting} awaiting your response`
              : "Counter-offers and agreed terms"}
          </span>
        </h2>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading negotiations…
        </div>
      ) : negotiations.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-[16px] font-medium text-slate-900">No counter-offers yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Start one from a vendor's quotation when you want to negotiate the price or terms.
          </p>
          {canCounter && !closed && !deadlinePassed ? (
            <button
              type="button"
              className="btn-primary mt-4 px-4 py-2 text-[15px]"
              onClick={onStartCounter}
            >
              Go to quotations
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {negotiations.map((thread) => (
            <ThreadCard
              key={thread.negotiationId}
              rfqId={rfqId}
              thread={thread}
              canCounter={canCounter}
              closed={closed}
              deadlinePassed={deadlinePassed}
              onDone={onDone}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadCard({
  rfqId,
  thread,
  canCounter,
  closed,
  deadlinePassed,
  onDone,
}: {
  rfqId: string;
  thread: NegotiationThread;
  canCounter: boolean;
  closed: boolean;
  deadlinePassed: boolean;
  onDone: () => void;
}) {
  const [dialog, setDialog] = useState<"counter" | "accept" | "reject" | "log" | null>(null);
  const latest = latestRound(thread.rounds);
  const blocked = closed || deadlinePassed || thread.deadlinePassed;
  const canRespond = canCounter && !blocked;
  const awaitingSml = thread.status === "AWAITING_SML";

  const responseDue = latest?.respondBy;

  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] font-semibold text-slate-900">
              {thread.vendorName ?? "Vendor"}
            </h3>
            <Badge tone={negotiationTone(thread.status)}>
              {NEGOTIATION_STATUS_LABELS[thread.status]}
            </Badge>
            {latest?.isFinal ? <Badge tone="purple">Final round</Badge> : null}
          </div>
          <p className="mt-1 text-[14px] text-slate-500">
            {thread.craneLabel} · Round {thread.currentRound} of {thread.maxRounds} · v{thread.version}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            {awaitingSml ? "Their latest offer" : thread.status === "AGREED" ? "Agreed total" : "Last offer"}
          </p>
          <p className="text-[24px] leading-7 font-semibold text-slate-900 tabular-nums">
            ₹{inr(latest?.totalQuotedValue ?? thread.baseQuotation.totalQuotedValue)}
          </p>
          <p className="text-[13px] text-slate-500">
            vs ₹{inr(thread.baseQuotation.totalQuotedValue)} base
          </p>
        </div>
      </div>

      {thread.status === "AGREED" && thread.agreedQuotation ? (
        <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
          <p className="text-[15px] font-medium text-emerald-400">
            Terms agreed at ₹{inr(thread.agreedQuotation.totalQuotedValue)}.
          </p>
          <p className="mt-0.5 text-[13px] text-slate-400">
            Award quotation v{thread.agreedQuotation.version} from the Quotations tab to confirm.
            Awarding closes this thread and cancels any other open offers for this RFQ.
          </p>
        </div>
      ) : null}

      {["DECLINED", "EXPIRED", "CANCELLED"].includes(thread.status) ? (
        <p className="mt-3 text-[14px] text-slate-500">
          {thread.closedReason ?? "This negotiation is closed."}
        </p>
      ) : null}

      <RoundTimeline rounds={thread.rounds} baseTotal={thread.baseQuotation.totalQuotedValue} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 pt-4">
        <p className="text-[13px] text-slate-500">
          {awaitingSml
            ? responseDue
              ? `Respond by ${formatDateTime(responseDue)} · ${timeLeft(responseDue) ?? ""}`
              : "Your response is needed"
            : thread.status === "AWAITING_VENDOR"
              ? "Waiting for the vendor to respond"
              : "No action needed"}
        </p>
        <div className="flex flex-wrap gap-2">
          {thread.status === "AWAITING_VENDOR" && canRespond ? (
            <button
              type="button"
              className="btn-secondary px-3 py-2 text-[15px]"
              onClick={() => setDialog("log")}
              title="Record an offer the vendor sent by phone, WhatsApp or email"
            >
              Log an offer
            </button>
          ) : null}
          {awaitingSml && canRespond ? (
            <>
              <button
                type="button"
                className="btn-secondary px-3 py-2 text-[15px]"
                onClick={() => setDialog("reject")}
              >
                Reject
              </button>
              <button
                type="button"
                className="btn-secondary px-3 py-2 text-[15px]"
                onClick={() => setDialog("counter")}
              >
                Counter
              </button>
              <button
                type="button"
                className="btn-primary px-3 py-2 text-[15px]"
                onClick={() => setDialog("accept")}
              >
                Accept offer
              </button>
            </>
          ) : null}
          {!canCounter ? (
            <span className="text-[13px] text-slate-500">Your account cannot negotiate.</span>
          ) : null}
        </div>
      </div>

      {dialog === "counter" ? (
        <CounterDialog
          rfqId={rfqId}
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
      {dialog === "accept" ? (
        <AcceptDialog
          rfqId={rfqId}
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
      {dialog === "reject" ? (
        <RejectDialog
          rfqId={rfqId}
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
      {dialog === "log" ? (
        <LogOfferDialog
          rfqId={rfqId}
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
    </li>
  );
}

function RoundTimeline({
  rounds,
  baseTotal,
}: {
  rounds: NegotiationRound[];
  baseTotal: number;
}) {
  if (!rounds.length) {
    return (
      <p className="mt-3 text-[14px] text-slate-500">
        No offers in this thread yet — the first counter will appear here.
      </p>
    );
  }
  return (
    <ol className="mt-4 space-y-2">
      {rounds.map((round) => {
        const index = rounds.indexOf(round);
        const previousRound = index > 0 ? rounds[index - 1] : undefined;
        const diff = round.totalQuotedValue - (previousRound?.totalQuotedValue ?? baseTotal);
        const fromVendor = round.offeredBy === "VENDOR";
        return (
          <li
            key={round.roundId}
            className={cn(
              "rounded-xl border px-4 py-3",
              round.outcome === "OPEN" ? "border-accent-500/40 bg-accent-500/5" : "border-ink-800",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-medium text-slate-900">
                Round {round.roundNumber} · {fromVendor ? (round.onBehalfOfVendor ? "Vendor (logged)" : "Vendor") : "SML"}
                {round.isFinal ? <span className="ml-2 text-[13px] text-purple-400">final</span> : null}
              </p>
              <p className="text-[16px] font-semibold text-slate-900 tabular-nums">
                ₹{inr(round.totalQuotedValue)}
                {diff !== 0 ? (
                  <span className={cn("ml-2 text-[13px] font-normal", diff > 0 ? "text-amber-500" : "text-emerald-400")}>
                    {diff > 0 ? "+" : "−"}₹{inr(Math.abs(diff))}
                  </span>
                ) : null}
              </p>
            </div>
            <p className="mt-0.5 text-[13px] text-slate-500">
              {round.rateBasis.replaceAll("_", " ")} ·{" "}
              {round.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST"} ·{" "}
              {formatDateTime(round.createdAt)}
            </p>
            {round.message ? (
              <p className="mt-2 text-[14px] text-slate-700">{round.message}</p>
            ) : null}
            {round.warnings.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {round.warnings.map((warning) => (
                  <li key={warning.code} className="rounded-full bg-amber-500/10 px-3 py-0.5 text-[12px] text-amber-500">
                    {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// --- counter dialog ---------------------------------------------------------

function defaultRespondBy(submissionDeadline: string): string {
  const twoDays = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const cap = new Date(submissionDeadline).getTime();
  const chosen = Number.isFinite(cap) ? Math.min(twoDays, cap - 60_000) : twoDays;
  return new Date(chosen).toISOString().slice(0, 16);
}

function CounterDialog({
  rfqId,
  thread,
  onClose,
  onDone,
}: {
  rfqId: string;
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const latest = latestRound(thread.rounds) ?? null;
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
  const [respondBy, setRespondBy] = useState(() => defaultRespondBy(base.validityDate));
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
      previewSmlCounter(rfqId, base.quotationId, offer)
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
    // offerKey captures every field of the offer without retriggering on object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId, base.quotationId, offerKey]);

  const warnings = preview?.warnings ?? [];
  const blocking = needsWarningAcknowledgement(warnings);

  const counter = useMutation({
    mutationFn: () =>
      smlCounter(rfqId, base.quotationId, {
        ...offer,
        expectedVersion: thread.version,
        acknowledgeWarnings: acknowledged,
        respondBy: new Date(respondBy).toISOString(),
      }),
    onSuccess: onDone,
  });

  const canSubmit =
    preview !== null &&
    !previewing &&
    Boolean(offer.rentalRate) &&
    Boolean(offer.validityDate) &&
    Boolean(respondBy) &&
    (!blocking || acknowledged) &&
    !counter.isPending;

  const isFinalRound = thread.currentRound + 1 >= thread.maxRounds;

  return (
    <DialogShell title={`Counter to ${thread.vendorName ?? "vendor"}`} onClose={onClose}>
      <div className="space-y-4">
        {isFinalRound ? (
          <Alert tone="error" title="Final round">
            Round {thread.maxRounds} is the last round. After this offer the thread can only be
            accepted or rejected.
          </Alert>
        ) : null}

        <OfferFieldsForm
          prefix="sml-counter"
          values={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          availabilityLabel="This offer confirms the crane is available for the full duration"
        />

        <Field
          label="Vendor must respond by"
          htmlFor="sml-respond-by"
          required
          hint="Capped automatically to the RFQ deadline and the offer validity."
        >
          <TextInput
            id="sml-respond-by"
            type="datetime-local"
            value={respondBy}
            onChange={setRespondBy}
          />
        </Field>

        <OfferPreview preview={preview} loading={previewing} error={previewError} />

        {blocking ? (
          <Checkbox
            id="sml-ack-warnings"
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

// --- counter from a quotation (starts a new thread) -------------------------

/**
 * A button placed on each vendor quotation that starts (or continues) a
 * negotiation thread. The dialog owns its preview and submission.
 */
export function CounterButton({
  rfqId,
  quotation,
  disabled,
  disabledReason = "Only the latest submitted quotation can be countered",
  onDone,
}: {
  rfqId: string;
  quotation: {
    quotationId: string;
    vendorName: string;
    rentalRate: number;
    rateBasis: string;
    mobilisationCharges: number;
    demobilisationCharges: number;
    taxBasis: string;
    validityDate: string;
  };
  disabled?: boolean;
  disabledReason?: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn-secondary px-3 py-2 text-[15px]"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => setOpen(true)}
      >
        Counter
      </button>
      {open ? (
        <CounterFromQuoteDialog
          rfqId={rfqId}
          quotation={quotation}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      ) : null}
    </>
  );
}

function CounterFromQuoteDialog({
  rfqId,
  quotation,
  onClose,
  onDone,
}: {
  rfqId: string;
  quotation: {
    quotationId: string;
    vendorName: string;
    rentalRate: number;
    rateBasis: string;
    mobilisationCharges: number;
    demobilisationCharges: number;
    taxBasis: string;
    validityDate: string;
  };
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<OfferFormValues>(() =>
    emptyOfferForm({
      rentalRate: String(quotation.rentalRate),
      rateBasis: quotation.rateBasis,
      mobilisationCharges: String(quotation.mobilisationCharges),
      demobilisationCharges: String(quotation.demobilisationCharges),
      taxBasis: quotation.taxBasis,
      validityDate: quotation.validityDate.slice(0, 10),
    }),
  );
  const [respondBy, setRespondBy] = useState(() => defaultRespondBy(quotation.validityDate));
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
      return;
    }
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      previewSmlCounter(rfqId, quotation.quotationId, offer)
        .then((response) => {
          if (id === requestId.current) {
            setPreview(response.preview);
            setPreviewError(null);
          }
        })
        .catch((error: Error) => {
          if (id === requestId.current) {
            setPreview(null);
            setPreviewError(error.message);
          }
        })
        .finally(() => {
          if (id === requestId.current) setPreviewing(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId, quotation.quotationId, offerKey]);

  const blocking = needsWarningAcknowledgement(preview?.warnings ?? []);
  const counter = useMutation({
    mutationFn: () =>
      smlCounter(rfqId, quotation.quotationId, {
        ...offer,
        expectedVersion: 0,
        acknowledgeWarnings: acknowledged,
        respondBy: new Date(respondBy).toISOString(),
      }),
    onSuccess: onDone,
  });

  const canSubmit =
    preview !== null &&
    !previewing &&
    Boolean(offer.rentalRate) &&
    Boolean(offer.validityDate) &&
    Boolean(respondBy) &&
    (!blocking || acknowledged) &&
    !counter.isPending;

  return (
    <DialogShell
      title={`Counter to ${quotation.vendorName}`}
      subtitle="Offer new terms instead of accepting this quotation outright."
      onClose={onClose}
    >
      <div className="space-y-4">
        <OfferFieldsForm
          prefix="sml-new-counter"
          values={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          availabilityLabel="This offer confirms the crane is available for the full duration"
        />
        <Field
          label="Vendor must respond by"
          htmlFor="sml-new-respond-by"
          required
          hint="Capped automatically to the RFQ deadline and the offer validity."
        >
          <TextInput
            id="sml-new-respond-by"
            type="datetime-local"
            value={respondBy}
            onChange={setRespondBy}
          />
        </Field>
        <OfferPreview preview={preview} loading={previewing} error={previewError} />
        {blocking ? (
          <Checkbox
            id="sml-new-ack"
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

// --- accept / reject / log dialogs ------------------------------------------

function AcceptDialog({
  rfqId,
  thread,
  onClose,
  onDone,
}: {
  rfqId: string;
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const latest = latestRound(thread.rounds);
  const [confirm, setConfirm] = useState(false);
  const accept = useMutation({
    mutationFn: () =>
      smlAccept(rfqId, thread.negotiationId, {
        expectedVersion: thread.version,
        confirm: true,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Accept this offer" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Accepting ₹{inr(latest?.totalQuotedValue ?? 0)} creates an agreed quotation version. It does
          not award the work — award it from the Quotations tab afterwards.
        </p>
        <Checkbox
          id="sml-accept-confirm"
          checked={confirm}
          onChange={setConfirm}
          label="I have checked the offer terms and want to accept them."
        />
        {accept.isError ? <Alert title="Not accepted">{(accept.error as Error).message}</Alert> : null}
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

function RejectDialog({
  rfqId,
  thread,
  onClose,
  onDone,
}: {
  rfqId: string;
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const reject = useMutation({
    mutationFn: () =>
      smlReject(rfqId, thread.negotiationId, {
        expectedVersion: thread.version,
        reason,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Reject this counter" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Rejecting ends this negotiation. The vendor's original quotation stays on the RFQ.
        </p>
        <Field label="Reason" htmlFor="sml-reject-reason" required>
          <TextArea
            id="sml-reject-reason"
            value={reason}
            onChange={setReason}
            rows={3}
            placeholder="Why this counter cannot be accepted"
          />
        </Field>
        {reject.isError ? <Alert title="Not rejected">{(reject.error as Error).message}</Alert> : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[15px]"
          disabled={!reason.trim() || reject.isPending}
          onClick={() => reject.mutate()}
        >
          {reject.isPending ? <Spinner /> : null}
          Reject counter
        </button>
      </DialogFooter>
    </DialogShell>
  );
}

function LogOfferDialog({
  rfqId,
  thread,
  onClose,
  onDone,
}: {
  rfqId: string;
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const base = thread.baseQuotation;
  const [form, setForm] = useState<OfferFormValues>(() =>
    emptyOfferForm({
      rentalRate: String(base.rentalRate),
      rateBasis: base.rateBasis,
      mobilisationCharges: String(base.mobilisationCharges),
      demobilisationCharges: String(base.demobilisationCharges),
      taxBasis: base.taxBasis,
      validityDate: base.validityDate.slice(0, 10),
    }),
  );
  const [channel, setChannel] = useState("PHONE");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<NegotiationPreview | null>(null);
  const requestId = useRef(0);
  const offer = toOfferFields(form);
  const offerKey = JSON.stringify(offer);

  useEffect(() => {
    const id = ++requestId.current;
    if (!offer.rentalRate || !offer.validityDate) return;
    previewSmlCounter(rfqId, base.quotationId, offer)
      .then((response) => {
        if (id === requestId.current) setPreview(response.preview);
      })
      .catch(() => {
        if (id === requestId.current) setPreview(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId, base.quotationId, offerKey]);

  const blocking = needsWarningAcknowledgement(preview?.warnings ?? []);
  const log = useMutation({
    mutationFn: () =>
      logVendorOffer(rfqId, thread.negotiationId, {
        ...offer,
        channel: channel as "PHONE" | "EMAIL" | "WHATSAPP" | "PORTAL",
        note,
        expectedVersion: thread.version,
        acknowledgeWarnings: acknowledged,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Log an offer received offline" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[14px] text-slate-500">
          Record an offer the vendor sent by phone, WhatsApp or email. SML can then respond to it in
          this thread.
        </p>
        <OfferFieldsForm
          prefix="sml-log"
          values={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          availabilityLabel="The vendor confirmed the crane is available for the full duration"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel" htmlFor="sml-log-channel" required>
            <Select
              id="sml-log-channel"
              value={channel}
              onChange={setChannel}
              options={[
                { value: "PHONE", label: "Phone" },
                { value: "WHATSAPP", label: "WhatsApp" },
                { value: "EMAIL", label: "Email" },
                { value: "PORTAL", label: "Portal" },
              ]}
            />
          </Field>
          <Field label="Note" htmlFor="sml-log-note" required>
            <TextInput id="sml-log-note" value={note} onChange={setNote} />
          </Field>
        </div>
        <OfferPreview preview={preview} loading={false} />
        {blocking ? (
          <Checkbox
            id="sml-log-ack"
            checked={acknowledged}
            onChange={setAcknowledged}
            label="I have reviewed the warnings above and want to log this offer anyway."
          />
        ) : null}
        {log.isError ? (
          <Alert title="Not logged">{(log.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[15px]"
          disabled={
            !preview || !offer.rentalRate || !note.trim() || (blocking && !acknowledged) || log.isPending
          }
          onClick={() => log.mutate()}
        >
          {log.isPending ? <Spinner /> : null}
          Log offer
        </button>
      </DialogFooter>
    </DialogShell>
  );
}


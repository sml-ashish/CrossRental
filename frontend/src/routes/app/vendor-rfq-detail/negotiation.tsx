import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Field, TextArea } from "@/components/ui/form";
import { Panel } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { DialogFooter, DialogShell } from "@/components/negotiation/dialog";
import {
  emptyOfferForm,
  OfferFieldsForm,
  toOfferFields,
  type OfferFormValues,
} from "@/components/negotiation/offer-fields";
import { OfferPreview, WarningList } from "@/components/negotiation/preview";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import {
  needsWarningAcknowledgement,
  inr,
  lastRoundBy,
  latestRound,
  NEGOTIATION_STATUS_LABELS_VENDOR,
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
  type NegotiationRound,
  type NegotiationThread,
} from "@/lib/negotiations";

/**
 * Counter-offers SML has sent this vendor (phase 1 + 2).
 *
 * The vendor only ever reads threads the backend returned for their own vendor
 * id — the `/api/vendor/negotiations` surface re-scopes every id to the token.
 * Every offer is priced server-side; this component only displays the totals.
 */
export function VendorNegotiations({
  rfqId,
  submissionDeadline,
}: {
  rfqId: string;
  submissionDeadline: string;
}) {
  const queryClient = useQueryClient();
  const threads = useQuery({
    queryKey: ["vendor-rfq-negotiations", rfqId],
    queryFn: () => getVendorRfqNegotiations(rfqId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["vendor-rfq-negotiations", rfqId] });
    void queryClient.invalidateQueries({ queryKey: ["vendor-rfq", rfqId] });
    void queryClient.invalidateQueries({ queryKey: ["vendor-rfqs"] });
  };

  if (threads.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Checking for counter-offers…
      </div>
    );
  }
  const list = threads.data?.negotiations ?? [];
  if (list.length === 0) return null;

  return (
    <div className="space-y-3">
      {list.map((thread) => (
        <VendorThreadCard
          key={thread.negotiationId}
          thread={thread}
          submissionDeadline={submissionDeadline}
          onDone={refresh}
        />
      ))}
    </div>
  );
}

function VendorThreadCard({
  thread,
  submissionDeadline,
  onDone,
}: {
  thread: NegotiationThread;
  submissionDeadline: string;
  onDone: () => void;
}) {
  const [dialog, setDialog] = useState<"accept" | "counter" | "decline" | null>(null);
  const latest = latestRound(thread.rounds);
  const smlOffer = lastRoundBy(thread.rounds, "SML");
  const myOffer = lastRoundBy(thread.rounds, "VENDOR");
  const awaitingVendor = thread.status === "AWAITING_VENDOR";
  const rfqDeadlinePassed = new Date(submissionDeadline).getTime() <= Date.now();
  const blocked = thread.deadlinePassed || rfqDeadlinePassed;
  const canRespond = awaitingVendor && !blocked;
  const compareFrom = myOffer?.totalQuotedValue ?? thread.baseQuotation.totalQuotedValue;
  const compareTo = smlOffer?.totalQuotedValue ?? latest?.totalQuotedValue ?? compareFrom;
  const diff = compareTo - compareFrom;

  return (
    <Panel
      title={awaitingVendor ? "SML sent a counter-offer" : "Negotiation with SML"}
      description={thread.craneLabel}
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={negotiationTone(thread.status)}>
            {NEGOTIATION_STATUS_LABELS_VENDOR[thread.status]}
          </Badge>
          <span className="text-xs text-slate-500">
            Round {thread.currentRound} of {thread.maxRounds}
            {latest?.isFinal ? " · final round" : ""}
          </span>
        </div>

        {awaitingVendor && latest?.respondBy ? (
          <div
            className={cn(
              "rounded-xl border px-4 py-3",
              blocked
                ? "border-red-200 bg-red-50"
                : "border-amber-200 bg-amber-50",
            )}
          >
            <p className={cn("text-sm font-medium", blocked ? "text-red-700" : "text-amber-700")}>
              {blocked
                ? "The response window has closed"
                : `Please respond by ${formatDateTime(latest.respondBy)}`}
            </p>
            {!blocked ? (
              <p className="mt-0.5 text-xs text-amber-700">
                {timeLeft(latest.respondBy) ?? ""} · The RFQ submission deadline also applies.
              </p>
            ) : null}
          </div>
        ) : null}

        {thread.status === "AGREED" ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-sm font-medium text-emerald-700">
              Terms agreed at ₹{inr(thread.agreedQuotation?.totalQuotedValue ?? compareTo)}.
            </p>
            <p className="mt-0.5 text-xs text-emerald-700">
              SML will award the agreed quotation; you will be notified when that happens.
            </p>
          </div>
        ) : null}

        {["DECLINED", "EXPIRED", "CANCELLED"].includes(thread.status) ? (
          <p className="text-sm text-slate-600">
            {thread.closedReason ?? "This negotiation is closed."}
          </p>
        ) : null}

        {/* Offer comparison: the vendor's standing offer vs SML's counter. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-800 px-4 py-3">
            <p className="text-xs font-medium tracking-[0.06em] text-slate-500 uppercase">
              Your last offer
            </p>
            <p className="mt-0.5 text-xl font-semibold text-slate-900 tabular-nums">
              ₹{inr(compareFrom)}
            </p>
          </div>
          <div className="rounded-xl border border-accent-500/40 bg-accent-500/5 px-4 py-3">
            <p className="text-xs font-medium tracking-[0.06em] text-slate-500 uppercase">
              {awaitingVendor ? "SML's counter" : "Latest offer"}
            </p>
            <p className="mt-0.5 text-xl font-semibold text-slate-900 tabular-nums">
              ₹{inr(compareTo)}
              {diff !== 0 ? (
                <span className={cn("ml-2 text-sm font-normal", diff > 0 ? "text-emerald-400" : "text-amber-500")}>
                  {diff > 0 ? "+" : "−"}₹{inr(Math.abs(diff))}
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {smlOffer?.message ? (
          <div>
            <p className="text-xs font-medium text-slate-500">Message from SML</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{smlOffer.message}</p>
          </div>
        ) : null}
        <WarningList warnings={smlOffer?.warnings ?? []} />

        <VendorRoundHistory rounds={thread.rounds} baseTotal={thread.baseQuotation.totalQuotedValue} />

        {["AWAITING_VENDOR", "AWAITING_SML"].includes(thread.status) ? (
          <p className="text-xs text-slate-500">
            While this negotiation is open, revising your quotation is locked — respond here instead.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {canRespond ? (
            <>
              <button
                type="button"
                className="btn-secondary min-h-11 px-4 text-sm"
                onClick={() => setDialog("decline")}
              >
                Decline
              </button>
              <button
                type="button"
                className="btn-secondary min-h-11 px-4 text-sm"
                onClick={() => setDialog("counter")}
              >
                Counter
              </button>
              <button
                type="button"
                className="btn-primary min-h-11 px-4 text-sm"
                onClick={() => setDialog("accept")}
              >
                Accept offer
              </button>
            </>
          ) : awaitingVendor ? (
            <p className="text-xs text-slate-500">
              {blocked ? "The response window has closed." : "No action needed right now."}
            </p>
          ) : null}
        </div>
      </div>

      {dialog === "accept" ? (
        <VendorAcceptDialog
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
      {dialog === "counter" ? (
        <VendorCounterDialog
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
      {dialog === "decline" ? (
        <VendorDeclineDialog
          thread={thread}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onDone();
          }}
        />
      ) : null}
    </Panel>
  );
}

function VendorRoundHistory({
  rounds,
  baseTotal,
}: {
  rounds: NegotiationRound[];
  baseTotal: number;
}) {
  if (!rounds.length) return null;
  return (
    <details className="rounded-xl border border-ink-800">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-slate-700">
        Offer history ({rounds.length})
      </summary>
      <ol className="space-y-2 border-t border-ink-800 px-4 py-3">
        {rounds.map((round) => {
          const index = rounds.indexOf(round);
          const previous = rounds[index - 1]?.totalQuotedValue ?? baseTotal;
          const diff = round.totalQuotedValue - previous;
          return (
            <li key={round.roundId} className="text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-slate-800">
                  Round {round.roundNumber} · {round.offeredBy === "VENDOR" ? "You" : "SML"}
                  {round.isFinal ? " · final" : ""}
                </span>
                <span className="font-semibold text-slate-900 tabular-nums">
                  ₹{inr(round.totalQuotedValue)}
                  {diff !== 0 ? (
                    <span className={cn("ml-2 text-xs font-normal", diff > 0 ? "text-amber-500" : "text-emerald-400")}>
                      {diff > 0 ? "+" : "−"}₹{inr(Math.abs(diff))}
                    </span>
                  ) : null}
                </span>
              </div>
              <p className="text-xs text-slate-500">{formatDateTime(round.createdAt)}</p>
              {round.message ? (
                <p className="mt-1 whitespace-pre-line text-slate-600">{round.message}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// --- dialogs ----------------------------------------------------------------

function VendorAcceptDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const latest = latestRound(thread.rounds);
  const accept = useMutation({
    mutationFn: () =>
      vendorAccept(thread.negotiationId, {
        expectedVersion: thread.version,
        confirm: true,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Accept SML's offer" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-700">
          You are accepting ₹{inr(latest?.totalQuotedValue ?? 0)} as the agreed terms for this crane.
          An agreed quotation is created and SML will confirm the award afterwards.
        </p>
        <Checkbox
          id="vendor-accept-confirm"
          checked={confirm}
          onChange={setConfirm}
          label="I have checked the counter-offer and confirm I accept it."
        />
        {accept.isError ? (
          <Alert title="Not accepted">{(accept.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
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

function VendorCounterDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: NegotiationThread;
  onClose: () => void;
  onDone: () => void;
}) {
  const myOffer = lastRoundBy(thread.rounds, "VENDOR");
  const base = thread.baseQuotation;
  const [form, setForm] = useState<OfferFormValues>(() =>
    emptyOfferForm({
      rentalRate: String(myOffer?.rentalRate ?? base.rentalRate),
      rateBasis: myOffer?.rateBasis ?? base.rateBasis,
      mobilisationCharges: String(myOffer?.mobilisationCharges ?? base.mobilisationCharges),
      demobilisationCharges: String(myOffer?.demobilisationCharges ?? base.demobilisationCharges),
      taxBasis: myOffer?.taxBasis ?? base.taxBasis,
      validityDate: (myOffer?.validityDate ?? base.validityDate).slice(0, 10),
      availableFrom: (myOffer?.availableFrom ?? base.availableFrom)?.slice(0, 10) ?? "",
      deviationText: myOffer?.deviationText ?? base.deviationText ?? "",
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
      return;
    }
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      previewVendorCounter(thread.negotiationId, offer)
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
    <DialogShell
      title="Send a counter-offer"
      subtitle="SML will get a chance to accept, reject, or counter back."
      onClose={onClose}
    >
      <div className="space-y-4">
        <OfferFieldsForm
          prefix="vendor-counter"
          values={form}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          availabilityLabel="I confirm the crane is available for the full duration"
        />
        <OfferPreview preview={preview} loading={previewing} error={previewError} />
        {blocking ? (
          <Checkbox
            id="vendor-counter-ack"
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
          className="btn-primary px-4 py-2 text-sm"
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
        reason: reason || null,
      }),
    onSuccess: onDone,
  });

  return (
    <DialogShell title="Decline this counter-offer" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-700">
          Declining ends this negotiation. Your submitted quotation remains on record.
        </p>
        <Field label="Reason (optional)" htmlFor="vendor-decline-reason">
          <TextArea
            id="vendor-decline-reason"
            value={reason}
            onChange={setReason}
            rows={3}
            placeholder="Why you cannot accept these terms"
          />
        </Field>
        {decline.isError ? (
          <Alert title="Not declined">{(decline.error as Error).message}</Alert>
        ) : null}
      </div>
      <DialogFooter onClose={onClose}>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={decline.isPending}
          onClick={() => decline.mutate()}
        >
          {decline.isPending ? <Spinner /> : null}
          Decline offer
        </button>
      </DialogFooter>
    </DialogShell>
  );
}

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { DialogFooter, DialogShell } from "@/components/negotiation/dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Field, Select, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";
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

      <OfferComparison thread={thread} />

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

interface OfferColumn {
  key: string;
  title: string;
  subtitle: string;
  tone: "base" | "vendor" | "sml";
  isFinal: boolean;
  open: boolean;
  total: number;
  rentalRate: number;
  rateBasis: string;
  mobilisationCharges: number;
  demobilisationCharges: number;
  taxBasis: string;
  validityDate: string;
  availableFrom: string | null;
  note: string | null;
  warnings: NegotiationRound["warnings"];
}

/**
 * The vendor's original quotation and every counter-offer side by side, oldest
 * on the left. Each column is one offer; any figure that moved since the column
 * before it is tinted and shows the change, so the negotiation reads straight
 * across instead of down a list.
 */
export function OfferComparison({
  thread,
  viewer = "sml",
}: {
  thread: NegotiationThread;
  viewer?: "sml" | "vendor";
}) {
  const base = thread.baseQuotation;
  const columns: OfferColumn[] = [
    {
      key: "base",
      title: "Original quote",
      subtitle: viewer === "vendor" ? `Your quote · v${base.version}` : `Vendor · v${base.version}`,
      tone: "base",
      isFinal: false,
      open: false,
      total: base.totalQuotedValue,
      rentalRate: base.rentalRate,
      rateBasis: base.rateBasis,
      mobilisationCharges: base.mobilisationCharges,
      demobilisationCharges: base.demobilisationCharges,
      taxBasis: base.taxBasis,
      validityDate: base.validityDate,
      availableFrom: base.availableFrom,
      note: base.deviationText,
      warnings: [],
    },
    ...thread.rounds.map(
      (round): OfferColumn => ({
        key: round.roundId,
        title: `Round ${round.roundNumber}`,
        subtitle:
          round.offeredBy === "VENDOR"
            ? viewer === "vendor"
              ? "Your counter"
              : round.onBehalfOfVendor
                ? "Vendor (logged)"
                : "Vendor counter"
            : viewer === "vendor"
              ? "Buyer counter"
              : "SML counter",
        tone: round.offeredBy === "VENDOR" ? "vendor" : "sml",
        isFinal: round.isFinal,
        open: round.outcome === "OPEN",
        total: round.totalQuotedValue,
        rentalRate: round.rentalRate,
        rateBasis: round.rateBasis,
        mobilisationCharges: round.mobilisationCharges,
        demobilisationCharges: round.demobilisationCharges,
        taxBasis: round.taxBasis,
        validityDate: round.validityDate,
        availableFrom: round.availableFrom,
        note: round.message ?? round.deviationText,
        warnings: round.warnings,
      }),
    ),
  ];

  const money = (value: number) => `₹${inr(value)}`;
  const delta = (current: number, previous: number | undefined) => {
    if (previous === undefined || current === previous) return null;
    const diff = current - previous;
    return (
      <span
        className={cn(
          "block text-[12px] font-normal",
          diff > 0 ? "text-amber-600" : "text-emerald-600",
        )}
      >
        {diff > 0 ? "+" : "−"}
        {money(Math.abs(diff))}
      </span>
    );
  };

  interface Row {
    label: string;
    value: (column: OfferColumn, previous: OfferColumn | undefined) => React.ReactNode;
    changed: (column: OfferColumn, previous: OfferColumn) => boolean;
  }

  const rows: Row[] = [
    {
      label: "Rate",
      value: (c, p) => (
        <>
          {money(c.rentalRate)}
          <span className="block text-[12px] font-normal text-slate-500">
            {c.rateBasis.replaceAll("_", " ").toLowerCase()}
          </span>
          {delta(c.rentalRate, p?.rentalRate)}
        </>
      ),
      changed: (c, p) => c.rentalRate !== p.rentalRate || c.rateBasis !== p.rateBasis,
    },
    {
      label: "Mobilisation",
      value: (c, p) => (
        <>
          {money(c.mobilisationCharges)}
          {delta(c.mobilisationCharges, p?.mobilisationCharges)}
        </>
      ),
      changed: (c, p) => c.mobilisationCharges !== p.mobilisationCharges,
    },
    {
      label: "Demobilisation",
      value: (c, p) => (
        <>
          {money(c.demobilisationCharges)}
          {delta(c.demobilisationCharges, p?.demobilisationCharges)}
        </>
      ),
      changed: (c, p) => c.demobilisationCharges !== p.demobilisationCharges,
    },
    {
      label: "GST",
      value: (c) => (c.taxBasis === "INCLUSIVE_OF_GST" ? "Inclusive" : "Exclusive"),
      changed: (c, p) => c.taxBasis !== p.taxBasis,
    },
    {
      label: "Valid until",
      value: (c) => formatDate(c.validityDate),
      changed: (c, p) => c.validityDate.slice(0, 10) !== p.validityDate.slice(0, 10),
    },
    {
      label: "Available from",
      value: (c) => (c.availableFrom ? formatDate(c.availableFrom) : "—"),
      changed: (c, p) => (c.availableFrom ?? "") !== (p.availableFrom ?? ""),
    },
  ];

  const hasNotes = columns.some((column) => column.note?.trim() || column.warnings.length > 0);

  const labelCell =
    "sticky left-0 z-10 w-[130px] min-w-[130px] bg-ink-850 px-4 py-3 text-left align-top text-[12px] font-medium tracking-[0.08em] whitespace-nowrap text-slate-500 uppercase";
  const valueCell = "min-w-[190px] px-4 py-3 align-top text-[15px] text-slate-700 tabular-nums";
  const changedCell = "bg-amber-500/10 font-semibold text-slate-900";

  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink-800">
            <th scope="col" className={cn(labelCell, "py-3")}>
              Offer
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "min-w-[190px] px-4 py-3 text-left align-top font-normal",
                  column.open && "bg-accent-500/5",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-slate-900">{column.title}</span>
                  {column.isFinal ? <Badge tone="purple">Final</Badge> : null}
                  {column.open ? <Badge tone="blue">Current</Badge> : null}
                </div>
                <p
                  className={cn(
                    "text-[13px] font-medium",
                    column.tone === "sml"
                      ? "text-blue-600"
                      : column.tone === "vendor"
                        ? "text-amber-600"
                        : "text-slate-500",
                  )}
                >
                  {column.subtitle}
                </p>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          <tr className="bg-ink-900/60">
            <th scope="row" className={cn(labelCell, "bg-ink-900")}>
              Total
            </th>
            {columns.map((column, index) => {
              const previous = columns[index - 1];
              return (
                <td key={column.key} className={valueCell}>
                  <span className="block text-[22px] leading-7 font-semibold text-slate-900">
                    {money(column.total)}
                  </span>
                  {delta(column.total, previous?.total)}
                  {index === 0 ? null : (
                    <span className="block text-[12px] text-slate-500">
                      {column.total === columns[0].total
                        ? "same as original"
                        : `${column.total < columns[0].total ? "−" : "+"}${money(Math.abs(column.total - columns[0].total))} vs original`}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>

          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className={labelCell}>
                {row.label}
              </th>
              {columns.map((column, index) => {
                const previous = columns[index - 1];
                return (
                  <td
                    key={column.key}
                    className={cn(valueCell, previous && row.changed(column, previous) && changedCell)}
                  >
                    {row.value(column, previous)}
                  </td>
                );
              })}
            </tr>
          ))}

          {hasNotes ? (
            <tr>
              <th scope="row" className={labelCell}>
                Notes
              </th>
              {columns.map((column) => (
                <td key={column.key} className={valueCell}>
                  {column.note?.trim() || column.warnings.length > 0 ? (
                    <div className="space-y-1.5 text-[14px] whitespace-pre-wrap">
                      {column.note?.trim() ? <p className="text-slate-700">{column.note}</p> : null}
                      {column.warnings.map((warning) => (
                        <p
                          key={warning.code}
                          className="rounded-md bg-amber-500/10 px-2 py-1 text-[12px] text-amber-600"
                        >
                          {warning.message}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
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

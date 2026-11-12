import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Checkbox, Field, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import {
  convertReply,
  dismissReply,
  loadReply,
  updateReply,
  type InboundReplyDetail,
  type ReplyPatch,
  type ReplyRateBasis,
} from "@/lib/replies";

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function numberString(value: number | null): string {
  return value === null ? "" : String(value);
}

function nullableNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function ReplyDetail({
  id,
  rfqId,
  onChanged,
}: {
  id: string;
  rfqId?: string;
  onChanged: () => void;
}) {
  const detail = useQuery({
    queryKey: ["inbound-reply", rfqId ?? "admin", id],
    queryFn: () => loadReply(id, rfqId),
  });

  if (detail.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (detail.error) return <Alert tone="error">{(detail.error as Error).message}</Alert>;
  if (!detail.data) return null;

  return <ReplyEditor reply={detail.data} rfqId={rfqId} onChanged={onChanged} />;
}

export function ReplyEditor({
  reply,
  rfqId: scopedRfqId,
  onChanged,
}: {
  reply: InboundReplyDetail;
  rfqId?: string;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const readOnly = reply.status !== "PENDING";
  const queryKey = ["inbound-reply", scopedRfqId ?? "admin", reply.id];

  const [vendorId, setVendorId] = useState(reply.vendor?.id ?? "");
  const [rfqId, setRfqId] = useState(reply.rfq?.id ?? "");
  const [craneId, setCraneId] = useState(reply.crane?.id ?? "");
  const [rate, setRate] = useState(numberString(reply.parsedRentalRate));
  const [basis, setBasis] = useState<ReplyRateBasis | "">(
    (reply.parsedRateBasis as ReplyRateBasis | null) ?? "",
  );
  const [mobilisation, setMobilisation] = useState(numberString(reply.parsedMobilisation));
  const [demobilisation, setDemobilisation] = useState(numberString(reply.parsedDemobilisation));
  const [available, setAvailable] = useState(reply.parsedAvailability ?? false);
  const [availableFrom, setAvailableFrom] = useState(toDateInput(reply.parsedAvailableFrom));
  const [validity, setValidity] = useState(toDateInput(reply.parsedValidityDate));
  const [craneRef, setCraneRef] = useState(reply.parsedCraneRef ?? "");
  const [remarks, setRemarks] = useState(reply.parsedRemarks ?? "");
  const [acceptsTerms, setAcceptsTerms] = useState(reply.parsedAcceptsTerms ?? false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function patch(): ReplyPatch {
    return {
      vendorId: vendorId || null,
      rfqId: rfqId || null,
      craneId: craneId || null,
      parsedRentalRate: nullableNumber(rate),
      parsedRateBasis: basis || null,
      parsedMobilisation: nullableNumber(mobilisation),
      parsedDemobilisation: nullableNumber(demobilisation),
      parsedAvailability: available,
      parsedAvailableFrom: availableFrom || null,
      parsedValidityDate: validity || null,
      parsedCraneRef: nullableText(craneRef),
      parsedRemarks: nullableText(remarks),
      parsedAcceptsTerms: acceptsTerms,
    };
  }

  const save = useMutation({
    mutationFn: () => updateReply(reply.id, patch(), scopedRfqId),
    onSuccess: () => {
      setMessage("Saved. The parsed fields are ready for conversion.");
      onChanged();
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const convert = useMutation({
    mutationFn: () => convertReply(reply.id, patch(), scopedRfqId),
    onSuccess: (result) => {
      setMessage(`Converted to quotation ${result.quotationId.slice(0, 8)}.`);
      onChanged();
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const dismiss = useMutation({
    mutationFn: (reason: string | null) => dismissReply(reply.id, reason, scopedRfqId),
    onSuccess: () => {
      setMessage("Dismissed. It stays in the history with your note.");
      onChanged();
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const error = save.error ?? convert.error ?? dismiss.error;

  return (
    <Section
      title="Reply"
      description={`${reply.channel === "WHATSAPP" ? "WhatsApp" : "Email"} from ${reply.fromAddress} · ${new Date(reply.receivedAt).toLocaleString("en-IN")}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={reply.status} />
        {reply.matchedBy ? <Badge tone="blue">Matched by {reply.matchedBy}</Badge> : null}
        {reply.parsedCraneRef ? <Badge tone="neutral">Ref: {reply.parsedCraneRef}</Badge> : null}
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {reply.subject ?? "No subject"}
        </p>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-slate-800">
          {reply.bodyText}
        </pre>
        {reply.attachments && reply.attachments.length > 0 ? (
          <ul className="mt-3 list-disc pl-4 text-xs text-slate-600">
            {reply.attachments.map((attachment) => (
              <li key={attachment.fileRef}>{attachment.fileName}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {reply.parseNote ? <Alert tone="info">{reply.parseNote}</Alert> : null}

      {reply.convertedQuotation ? (
        <Alert tone="success" title="Converted">
          Quotation v{reply.convertedQuotation.version} for{" "}
          {reply.convertedQuotation.totalQuotedValue.toLocaleString("en-IN")} · source{" "}
          {reply.convertedQuotation.source.toLowerCase()}.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor" htmlFor="reply-vendor">
          <Select
            id="reply-vendor"
            value={vendorId}
            onChange={(value) => {
              setVendorId(value);
              setRfqId(scopedRfqId ?? "");
              setCraneId("");
            }}
            options={reply.options.vendors.map((vendor) => ({
              value: vendor.id,
              label: vendor.name ?? vendor.id,
            }))}
            placeholder="Match a vendor"
            disabled={readOnly}
          />
        </Field>
        <Field
          label="RFQ"
          htmlFor="reply-rfq"
          hint={vendorId ? "RFQs this vendor was sent." : "Choose a vendor to narrow the list."}
        >
          <Select
            id="reply-rfq"
            value={rfqId}
            onChange={setRfqId}
            options={reply.options.rfqs.map((rfq) => ({
              value: rfq.id,
              label: `${rfq.rfqNumber} (${rfq.status.toLowerCase()})`,
            }))}
            placeholder="Match an RFQ"
            disabled={readOnly || Boolean(scopedRfqId)}
          />
        </Field>
        <Field
          label="Crane"
          htmlFor="reply-crane"
          hint={vendorId ? undefined : "Save the vendor, then reopen to load their cranes."}
        >
          <Select
            id="reply-crane"
            value={craneId}
            onChange={setCraneId}
            options={reply.options.cranes.map((crane) => ({
              value: crane.id,
              label: crane.label,
            }))}
            placeholder="Match a crane"
            disabled={readOnly}
          />
        </Field>
        <Field label="Crane reference in reply" htmlFor="reply-crane-ref">
          <TextInput
            id="reply-crane-ref"
            value={craneRef}
            onChange={setCraneRef}
            disabled={readOnly}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Rental rate" htmlFor="reply-rate" required>
          <TextInput
            id="reply-rate"
            value={rate}
            onChange={setRate}
            inputMode="decimal"
            disabled={readOnly}
          />
        </Field>
        <Field label="Rate basis" htmlFor="reply-basis" required>
          <Select
            id="reply-basis"
            value={basis}
            onChange={(value) => setBasis(value as ReplyRateBasis | "")}
            options={[
              { value: "PER_DAY", label: "Per day" },
              { value: "PER_MONTH", label: "Per month" },
              { value: "LUMP_SUM", label: "Lump sum" },
            ]}
            placeholder="Choose basis"
            disabled={readOnly}
          />
        </Field>
        <Field label="Validity date" htmlFor="reply-validity" required>
          <TextInput
            id="reply-validity"
            type="date"
            value={validity}
            onChange={setValidity}
            disabled={readOnly}
          />
        </Field>
        <Field label="Mobilisation" htmlFor="reply-mob">
          <TextInput
            id="reply-mob"
            value={mobilisation}
            onChange={setMobilisation}
            inputMode="decimal"
            disabled={readOnly}
          />
        </Field>
        <Field label="Demobilisation" htmlFor="reply-demob">
          <TextInput
            id="reply-demob"
            value={demobilisation}
            onChange={setDemobilisation}
            inputMode="decimal"
            disabled={readOnly}
          />
        </Field>
        <Field label="Available from" htmlFor="reply-available-from">
          <TextInput
            id="reply-available-from"
            type="date"
            value={availableFrom}
            onChange={setAvailableFrom}
            disabled={readOnly}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-5">
        <Checkbox
          id="reply-available"
          checked={available}
          onChange={setAvailable}
          disabled={readOnly}
          label="The crane is available for this requirement"
        />
        <Checkbox
          id="reply-terms"
          checked={acceptsTerms}
          onChange={setAcceptsTerms}
          disabled={readOnly}
          label="The vendor accepted the commercial terms"
        />
      </div>

      <Field label="Remarks" htmlFor="reply-remarks">
        <TextArea id="reply-remarks" value={remarks} onChange={setRemarks} disabled={readOnly} />
      </Field>

      {!readOnly ? (
        <Field label="Review note" htmlFor="reply-note" hint="Optional. Stored with the dismissal.">
          <TextInput id="reply-note" value={note} onChange={setNote} />
        </Field>
      ) : null}

      {error ? <Alert tone="error">{(error as Error).message}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? <Spinner /> : null}
            Save fields
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            onClick={() => convert.mutate()}
            disabled={convert.isPending || !craneId || !rfqId || !vendorId}
          >
            {convert.isPending ? <Spinner /> : <CheckCircle2 className="size-4" aria-hidden />}
            Convert to quotation
          </button>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm text-red-700"
            onClick={() => dismiss.mutate(note.trim() === "" ? null : note.trim())}
            disabled={dismiss.isPending}
          >
            {dismiss.isPending ? <Spinner /> : <XCircle className="size-4" aria-hidden />}
            Dismiss
          </button>
        </div>
      ) : null}
    </Section>
  );
}

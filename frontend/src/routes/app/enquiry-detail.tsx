import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import {
  ENQUIRY_STATUS_LABELS,
  TRAIL_LABELS,
  TRAIL_SEQUENCE,
  cancelLine,
  formatDate,
  getEnquiry,
  recordInternalCheck,
  type EnquiryLine,
  type EnquiryLineTrailStatus,
} from "@/lib/enquiries";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ReadOnlyValue } from "@/components/ui/form";

/**
 * Enquiry detail (P1).
 *
 * The status trail is shown as a fixed sequence rather than a free dropdown,
 * because it is event driven: the line moves when an RFQ is sent, a quotation
 * arrives or an award books it. The only manual outcomes here are the internal
 * check and cancelling a line, both of which the backend records.
 */

function trailTone(status: EnquiryLineTrailStatus): BadgeTone {
  switch (status) {
    case "BOOKED":
    case "VENDOR_FINALISED":
    case "FULFILLED_INTERNALLY":
      return "emerald";
    case "CANCELLED":
      return "red";
    case "CLOSED":
      return "neutral";
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "purple";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
    case "VENDOR_SHORTLISTED":
      return "blue";
    default:
      return "amber";
  }
}

export function EnquiryDetailPage() {
  const params = useParams({ strict: false }) as { enquiryId: string };
  const queryClient = useQueryClient();
  const enquiry = useQuery({
    queryKey: ["enquiry", params.enquiryId],
    queryFn: () => getEnquiry(params.enquiryId),
  });

  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
    await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      setCancelFor(null);
      setReason("");
      setNotesFor(null);
      setNotes("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (enquiry.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (enquiry.isError) {
    return <Alert tone="error">Could not load that enquiry.</Alert>;
  }

  const data = enquiry.data.enquiry;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/app/enquiries" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft className="size-4" aria-hidden />
            All enquiries
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{data.enquiryNo}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {data.customerName} · {data.siteLocation}
            {data.siteStateName ? `, ${data.siteStateName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={data.overallStatus === "FULLY_FINALISED" ? "emerald" : "amber"}>
            {ENQUIRY_STATUS_LABELS[data.overallStatus]}
          </Badge>
          <Link
            to="/app/enquiries/$enquiryId/history"
            params={{ enquiryId: data.id }}
            className="btn-secondary"
          >
            Sourcing history
          </Link>
          <Link
            to="/app/communications"
            search={{ enquiryId: data.id }}
            className="btn-secondary"
          >
            Communication history
          </Link>
          <Link
            to="/app/enquiries/$enquiryId/edit"
            params={{ enquiryId: data.id }}
            className="btn-secondary"
          >
            Edit
          </Link>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-slate-900">Enquiry header</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <ReadOnlyValue label="Customer" value={data.customerName} />
          <ReadOnlyValue label="Sales Partner" value={data.salesPartnerName ?? "—"} />
          <ReadOnlyValue label="External reference" value={data.externalReference ?? "—"} />
          <ReadOnlyValue label="Site" value={`${data.siteLocation}${data.siteStateName ? `, ${data.siteStateName}` : ""}`} />
          <ReadOnlyValue label="Pincode" value={data.sitePincode ?? "—"} />
          <ReadOnlyValue label="Business vertical" value={data.businessVertical ?? "—"} />
          <ReadOnlyValue label="Enquiry date" value={formatDate(data.enquiryDate)} />
          <ReadOnlyValue label="Owner" value={data.crOwner?.fullName ?? data.crOwner?.email ?? "—"} />
        </dl>
        {data.customerAddress ? (
          <p className="mt-4 text-sm text-slate-600">{data.customerAddress}</p>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Line items ({data.lines.length})
          </h2>
          <Link
            to="/app/enquiries/$enquiryId/lines/new"
            params={{ enquiryId: data.id }}
            className="btn-secondary"
          >
            <Plus className="size-4" aria-hidden />
            Add line
          </Link>
        </div>

        {data.lines.map((line) => (
          <div key={line.id} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Line {line.lineNo} · {line.craneTypeName ?? line.craneTypeCode ?? "No type"}{" "}
                  {line.capacityT !== null ? `${line.capacityT} t` : ""}
                  {line.capacityRule === "AT_LEAST" ? "+" : ""}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {line.quantity} × ·{" "}
                  {line.requiredStartDate ? formatDate(line.requiredStartDate) : "Start TBC"}
                  {line.cancelledAt ? ` · cancelled: ${line.cancelReason ?? ""}` : ""}
                </p>
              </div>
              <Badge tone={trailTone(line.trailStatus)}>
                {TRAIL_LABELS[line.trailStatus]}
              </Badge>
            </div>

            <TrailRail status={line.trailStatus} />

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/app/enquiries/lines/$lineId"
                params={{ lineId: line.id }}
                className="btn-primary"
              >
                Sourcing workspace
              </Link>
              <Link
                to="/app/enquiries/lines/$lineId/edit"
                params={{ lineId: line.id }}
                className="btn-secondary"
              >
                Edit line
              </Link>
              {line.trailStatus === "CANCELLED" ? null : (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      setNotesFor(line.id);
                      setNotes("");
                    }}
                  >
                    Internal check
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-red-600"
                    disabled={busy}
                    onClick={() => {
                      setCancelFor(line.id);
                      setReason("");
                    }}
                  >
                    Cancel line
                  </button>
                </>
              )}
            </div>

            {notesFor === line.id ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-600">
                  Record the manual availability check.
                </p>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  placeholder="Notes (optional)"
                  className="field-input mt-2 resize-y"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        recordInternalCheck(line.id, "FULFILLED_INTERNALLY", notes || null),
                      )
                    }
                  >
                    Fulfilled internally
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        recordInternalCheck(line.id, "CHECKED_NOT_AVAILABLE", notes || null),
                      )
                    }
                  >
                    Checked — not available
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setNotesFor(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : null}

            {cancelFor === line.id ? (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                <label htmlFor={`reason-${line.id}`} className="field-label">
                  Why is this line being cancelled?
                </label>
                <textarea
                  id={`reason-${line.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  className="field-input mt-1 resize-y"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => run(() => cancelLine(line.id, reason.trim()))}
                  >
                    Cancel line
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setCancelFor(null)}
                  >
                    Keep line
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

/** The trail as a read-only rail, so the sequence is visible at a glance. */
function TrailRail({ status }: { status: EnquiryLineTrailStatus }) {
  if (status === "CANCELLED" || status === "FULFILLED_INTERNALLY") {
    return null;
  }
  const currentIndex = TRAIL_SEQUENCE.indexOf(status);
  return (
    <ol className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
      {TRAIL_SEQUENCE.map((step, index) => {
        const done = currentIndex >= 0 && index <= currentIndex;
        return (
          <li
            key={step}
            className={
              done
                ? "rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700"
                : "rounded-full bg-slate-100 px-2 py-0.5 text-slate-500"
            }
          >
            {TRAIL_LABELS[step]}
          </li>
        );
      })}
    </ol>
  );
}

export type { EnquiryLine };

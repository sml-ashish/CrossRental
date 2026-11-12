import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  ENQUIRY_STATUS_LABELS,
  TRAIL_LABELS,
  TRAIL_SEQUENCE,
  cancelLine,
  createRfqFromLine,
  formatDate,
  getEnquiry,
  type EnquiryLine,
  type EnquiryLineTrailStatus,
} from "@/lib/enquiries";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { Field, ReadOnlyValue, TextInput } from "@/components/ui/form";

/**
 * Enquiry detail (P1).
 *
 * The status trail is shown as a fixed sequence rather than a free dropdown,
 * because it is event driven: the line moves when an RFQ is sent, a quotation
 * arrives or an award books it. The only manual outcome here is cancelling a
 * line, which the backend records.
 */

function defaultDeadline(): string {
  const date = new Date(Date.now() + 7 * 86_400_000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const enquiry = useQuery({
    queryKey: ["enquiry", params.enquiryId],
    queryFn: () => getEnquiry(params.enquiryId),
  });

  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rfqFor, setRfqFor] = useState<string | null>(null);
  const [rfqDeadline, setRfqDeadline] = useState(defaultDeadline);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["enquiry", params.enquiryId] });
    await queryClient.invalidateQueries({ queryKey: ["enquiries"] });
    await queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
  }

  async function raiseRfq(lineId: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await createRfqFromLine(lineId, rfqDeadline);
      await refresh();
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: created.rfq.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not raise the RFQ.");
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      setCancelFor(null);
      setReason("");
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
      <PageHeader
        back={{ to: "/app/enquiries", label: "All enquiries" }}
        title={data.enquiryNo}
        mono
        description={
          <>
            {data.customerName} · {data.siteLocation}
            {data.siteStateName ? `, ${data.siteStateName}` : ""}
          </>
        }
        meta={
          <Badge tone={data.overallStatus === "FULLY_FINALISED" ? "emerald" : "amber"}>
            {ENQUIRY_STATUS_LABELS[data.overallStatus]}
          </Badge>
        }
        actions={
          <>
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
          </>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Panel title="Enquiry header">
        <dl className="grid gap-4 sm:grid-cols-3">
          <ReadOnlyValue label="Customer" value={data.customerName} />
          <ReadOnlyValue label="Site" value={`${data.siteLocation}${data.siteStateName ? `, ${data.siteStateName}` : ""}`} />
          <ReadOnlyValue label="Pincode" value={data.sitePincode ?? "—"} />
          <ReadOnlyValue label="Enquiry date" value={formatDate(data.enquiryDate)} />
          <ReadOnlyValue label="Owner" value={data.crOwner?.fullName ?? data.crOwner?.email ?? "—"} />
        </dl>
        {data.customerAddress ? (
          <p className="text-sm text-slate-600">{data.customerAddress}</p>
        ) : null}
      </Panel>

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

        {data.lines.length === 0 ? (
          <div className="card">
            <EmptyState
              title="No lines yet"
              description="Add the cranes this enquiry needs, then raise an RFQ from each line."
              action={
                <Link
                  to="/app/enquiries/$enquiryId/lines/new"
                  params={{ enquiryId: data.id }}
                  className="btn-primary"
                >
                  <Plus className="size-4" aria-hidden />
                  Add line
                </Link>
              }
            />
          </div>
        ) : null}

        {data.lines.map((line) => (
          <div key={line.id} className="card p-4">
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
                to="/app/enquiries/lines/$lineId/comparison"
                params={{ lineId: line.id }}
                className="btn-primary"
              >
                Compare quotes
              </Link>
              <Link
                to="/app/enquiries/lines/$lineId/edit"
                params={{ lineId: line.id }}
                className="btn-secondary"
              >
                Edit line
              </Link>
              {line.trailStatus === "CANCELLED" ||
              line.trailStatus === "FULFILLED_INTERNALLY" ? null : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setRfqFor(line.id);
                    setRfqDeadline(defaultDeadline());
                  }}
                >
                  Raise RFQ
                </button>
              )}
              {line.trailStatus === "CANCELLED" ? null : (
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
              )}
            </div>

            {rfqFor === line.id ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-600">
                  Raise an RFQ against this line.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Prefilled from the line. Customer name and address, and the rental
                  budget, are never sent.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Field
                    label="Submission deadline"
                    htmlFor={`rfq-deadline-${line.id}`}
                  >
                    <TextInput
                      id={`rfq-deadline-${line.id}`}
                      type="date"
                      value={rfqDeadline}
                      onChange={setRfqDeadline}
                    />
                  </Field>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => raiseRfq(line.id)}
                  >
                    {busy ? <Spinner /> : null}
                    Raise RFQ
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => setRfqFor(null)}
                  >
                    Cancel
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

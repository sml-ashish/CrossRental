import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  TRAIL_LABELS,
  createRfqFromLine,
  formatDate,
  getLineWorkspace,
} from "@/lib/enquiries";
import { refreshLineRecommendations } from "@/lib/recommendations";
import type { RecommendedCrane, RecommendedGroup } from "@/lib/recommendations";
import { formatDistance } from "@/lib/rfqs";
import { formatInr } from "@/lib/quotations";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Field, TextInput } from "@/components/ui/form";

/**
 * Line sourcing workspace (P1 section 5, extended in P2).
 *
 * P2 replaces the single "vendor recommendations" list with the engine's two
 * sets: an SML section (which today only carries the manual internal check,
 * because SML has no crane fleet — open item 2) and the vendor set, grouped by
 * vendor and ranked. Each crane carries its mobilisation cost estimate and any
 * boom/jib shortfall warning, and participation counts sit beside each vendor
 * (BPD 6.7 — invitations/quotes/awards only; no performance analysis).
 *
 * The list shown is always a stored snapshot. "Re-evaluate" writes a new one;
 * an older snapshot stays readable in the history at the bottom.
 */

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type SortKey = "distance" | "cost";

export function EnquiryLineWorkspacePage() {
  const params = useParams({ strict: false }) as { lineId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["line-workspace", params.lineId],
    queryFn: () => getLineWorkspace(params.lineId),
  });

  const [deadline, setDeadline] = useState(inDays(7));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("distance");

  async function raiseRfq() {
    setBusy(true);
    setError(null);
    try {
      const created = await createRfqFromLine(params.lineId, deadline);
      await queryClient.invalidateQueries({ queryKey: ["line-workspace", params.lineId] });
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: created.rfq.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not raise the RFQ.");
    } finally {
      setBusy(false);
    }
  }

  async function reEvaluate() {
    setRefreshing(true);
    setError(null);
    try {
      await refreshLineRecommendations(params.lineId);
      await queryClient.invalidateQueries({ queryKey: ["line-workspace", params.lineId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not re-evaluate the line.");
    } finally {
      setRefreshing(false);
    }
  }

  if (workspace.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (workspace.isError) {
    return <Alert tone="error">Could not load that line.</Alert>;
  }

  const { line, enquiry, recommendations, snapshots, rfqs, quotations } =
    workspace.data.workspace;
  const canRaise =
    line.trailStatus !== "CANCELLED" &&
    line.trailStatus !== "FULFILLED_INTERNALLY" &&
    line.quantity > 0;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/app/enquiries/$enquiryId"
          params={{ enquiryId: enquiry.id }}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {enquiry.enquiryNo}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">
            Line {line.lineNo} · {line.craneTypeName ?? line.craneTypeCode ?? "No type"}{" "}
            {line.capacityT !== null ? `${line.capacityT} t` : ""}
          </h1>
          <Badge tone="blue">{TRAIL_LABELS[line.trailStatus]}</Badge>
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          {enquiry.siteLocation}
          {enquiry.siteStateName ? `, ${enquiry.siteStateName}` : ""} · required{" "}
          {line.requiredStartDate ? formatDate(line.requiredStartDate) : "start TBC"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link
            to="/app/communications"
            search={{ lineId: params.lineId }}
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            Communication history
          </Link>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Raise an RFQ</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Prefilled from this line. Customer, budget and internal notes are never sent.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Field label="Submission deadline" htmlFor="deadline">
              <TextInput
                id="deadline"
                type="date"
                value={deadline}
                onChange={setDeadline}
              />
            </Field>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !canRaise}
              onClick={raiseRfq}
            >
              Raise RFQ
            </button>
          </div>
        </div>
      </section>

      {!recommendations ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500">
            This line needs a crane type and capacity before the engine can match candidates.
          </p>
        </section>
      ) : (
        <>
          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">SML section</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  SML's own fleet — none exists today — plus the manual internal check.
                </p>
              </div>
            </div>
            {recommendations.sml.internalCheck ? (
              <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-slate-500">Internal trail status</dt>
                  <dd className="text-sm text-slate-700">
                    {TRAIL_LABELS[
                      recommendations.sml.internalCheck.trailStatus as keyof typeof TRAIL_LABELS
                    ] ?? recommendations.sml.internalCheck.trailStatus}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Selected source</dt>
                  <dd className="text-sm text-slate-700">
                    {recommendations.sml.internalCheck.selectedSource ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Closure</dt>
                  <dd className="text-sm text-slate-700">
                    {recommendations.sml.internalCheck.closureStatus ?? "—"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No internal check recorded yet.</p>
            )}
            {recommendations.sml.cranes.length > 0 ? (
              <ul className="mt-3 divide-y divide-slate-100">
                {recommendations.sml.cranes.map((crane) => (
                  <CraneRow key={crane.craneId} crane={crane} />
                ))}
              </ul>
            ) : null}
          </section>

          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Vendor recommendations
                  {recommendations.vendor.groups.length > 0
                    ? ` (${recommendations.vendor.groups.length} vendors)`
                    : ""}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Ranked by{" "}
                  {sortKey === "distance" ? "distance" : "mobilisation cost"}. The two sets are
                  never merged.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-md border border-slate-200 text-xs" role="group" aria-label="Sort vendor set">
                  <button
                    type="button"
                    className={`px-2.5 py-1.5 rounded-l-md ${
                      sortKey === "distance" ? "bg-slate-100 font-medium text-slate-800" : "text-slate-500"
                    }`}
                    onClick={() => setSortKey("distance")}
                  >
                    Distance
                  </button>
                  <button
                    type="button"
                    className={`px-2.5 py-1.5 rounded-r-md border-l border-slate-200 ${
                      sortKey === "cost" ? "bg-slate-100 font-medium text-slate-800" : "text-slate-500"
                    }`}
                    onClick={() => setSortKey("cost")}
                  >
                    Cost
                  </button>
                </div>
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1"
                  disabled={refreshing}
                  onClick={reEvaluate}
                >
                  <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
                  Re-evaluate
                </button>
              </div>
            </div>

            {recommendations.notice ? (
              <div className="mt-3">
                <Alert tone="info">{recommendations.notice}</Alert>
              </div>
            ) : null}
            {!recommendations.distancesAvailable ? (
              <div className="mt-3">
                <Alert tone="info">
                  The job site has no verified pin, so no distance or mobilisation cost can be
                  produced.
                </Alert>
              </div>
            ) : null}

            {sortedGroups(recommendations.vendor.groups, sortKey).length === 0 &&
            recommendations.vendor.unverified.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No vendor cranes match this requirement yet.
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {sortedGroups(recommendations.vendor.groups, sortKey).map((group) => (
                  <div key={group.vendorId}>
                    <p className="text-xs font-semibold text-slate-700">
                      {group.vendorName}
                      {group.nearestKm !== null
                        ? ` · nearest ${formatDistance(group.nearestKm, group.distanceApproximate)}`
                        : ""}
                    </p>
                    {group.participation ? (
                      <p className="text-xs text-slate-500">
                        Invited {group.participation.invitations} · quoted{" "}
                        {group.participation.quoted} · awarded {group.participation.awarded}
                      </p>
                    ) : null}
                    <ul className="mt-2 divide-y divide-slate-100">
                      {group.cranes.map((crane) => (
                        <CraneRow key={crane.craneId} crane={crane} />
                      ))}
                    </ul>
                  </div>
                ))}
                {recommendations.vendor.unverified.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold text-slate-700">Location unverified</p>
                    <ul className="mt-2 divide-y divide-slate-100">
                      {recommendations.vendor.unverified.map((crane) => (
                        <li key={crane.craneId} className="py-2 text-sm text-slate-700">
                          {crane.vendorName} · {crane.make} {crane.model} · {crane.capacityT} t
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {snapshots.length > 0 ? (
            <section className="card p-5">
              <h2 className="text-sm font-semibold text-slate-900">
                Snapshot history ({snapshots.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Every evaluation is stored. The list above is the latest one; older snapshots stay
                readable even after the cranes move.
              </p>
              <ul className="mt-3 divide-y divide-slate-100">
                {snapshots.map((snapshot) => (
                  <li
                    key={snapshot.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      {snapshot.id === recommendations.snapshotId ? (
                        <Badge tone="blue">Current</Badge>
                      ) : null}{" "}
                      {new Date(snapshot.evaluatedAt).toLocaleString("en-IN")} ·{" "}
                      {snapshot.trigger === "refresh" ? "manual refresh" : "initial"} ·{" "}
                      {snapshot.vendorCraneCount} cranes
                    </span>
                    <span className="text-xs text-slate-500">
                      {snapshot.provider === "stub" ? "stub distances" : snapshot.provider ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-slate-900">RFQs ({rfqs.length})</h2>
        {rfqs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No RFQ has been raised from this line.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {rfqs.map((rfq) => (
              <li key={rfq.rfqId} className="flex items-center justify-between py-2.5">
                <div>
                  <Link
                    to="/app/rfqs/$rfqId"
                    params={{ rfqId: rfq.rfqId }}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    {rfq.rfqNumber}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {rfq.recipientCount} vendors · {rfq.quotationCount} quotations · deadline{" "}
                    {formatDate(rfq.submissionDeadline)}
                  </p>
                </div>
                <StatusBadge status={rfq.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Quotations ({quotations.length})
          </h2>
          {quotations.length > 0 ? (
            <Link
              to="/app/enquiries/lines/$lineId/comparison"
              params={{ lineId: params.lineId }}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              Compare quotes
            </Link>
          ) : null}
        </div>
        {quotations.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No quotations received yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 font-medium">Vendor</th>
                <th className="py-2 font-medium">Crane</th>
                <th className="py-2 font-medium">Total</th>
                <th className="py-2 font-medium">Valid to</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {quotations.map((q) => (
                <tr key={q.quotationId}>
                  <td className="py-2 text-slate-700">{q.vendorName}</td>
                  <td className="py-2 text-slate-600">{q.craneDescription}</td>
                  <td className="py-2 text-slate-700">
                    ₹{q.totalQuotedValue.toLocaleString("en-IN")}
                  </td>
                  <td className="py-2 text-slate-600">{formatDate(q.validityDate)}</td>
                  <td className="py-2">
                    <Badge tone="neutral">{q.status.replaceAll("_", " ")}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Compare the live quotes side by side, mark them internally and confirm the final
          selection from the comparison screen.
        </p>
      </section>
    </div>
  );
}

/**
 * Sorts a vendor set. Both keys rank groups by their *nearest* crane, so a
 * vendor shows once at its best. Cost ranking falls back to distance when no
 * crane is priced (no site pin, no rate for the capacity band).
 */
function sortedGroups(groups: RecommendedGroup[], sortKey: SortKey): RecommendedGroup[] {
  const nearest = (group: RecommendedGroup) => group.nearestKm ?? Number.POSITIVE_INFINITY;
  const cheapest = (group: RecommendedGroup) => {
    const costs = group.cranes
      .map((crane) => crane.estimatedMobilisationCost)
      .filter((cost): cost is number => cost !== null);
    return costs.length > 0 ? Math.min(...costs) : Number.POSITIVE_INFINITY;
  };
  return [...groups].sort((a, b) =>
    sortKey === "cost"
      ? cheapest(a) - cheapest(b) || nearest(a) - nearest(b)
      : nearest(a) - nearest(b),
  );
}

/**
 * One crane in a set. The cost line is the P2 addition; boom/jib shortfalls
 * sit underneath in amber, because a crane that cannot lift what was asked for
 * should not look interchangeable with one that can.
 */
function CraneRow({ crane }: { crane: RecommendedCrane }) {
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-slate-700">
          {crane.make} {crane.model} · {crane.capacityT} t · {crane.stateName}
        </span>
        <span className="text-xs text-slate-500">
          {formatDistance(crane.distanceKm, crane.distanceApproximate)}
          {crane.estimatedMobilisationCost !== null ? (
            <>
              {" · mob. "}
              {formatInr(crane.estimatedMobilisationCost)}
              {crane.ratePerKm !== null
                ? ` (${formatInr(crane.ratePerKm)}/km)`
                : ""}
            </>
          ) : (
            " · cost unavailable"
          )}
          {crane.stale ? " · stale" : ""}
        </span>
      </div>
      {crane.boomWarnings.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {crane.boomWarnings.map((warning) => (
            <li key={warning} className="text-xs font-medium text-amber-700">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

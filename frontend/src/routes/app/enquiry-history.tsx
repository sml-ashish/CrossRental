import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getEnquiryHistory, type HistoryEntry } from "@/lib/enquiryHistory";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

/**
 * Audit trail viewer (P4, BPD 5.14).
 *
 * The sourcing history of one enquiry — its lines, RFQs and quotations — in the
 * order it happened, reconstructed from the audit log. Bank details are already
 * scrubbed centrally, so there is nothing here to hide from an internal reader.
 */

const ENTITY_LABELS: Record<string, string> = {
  enquiry: "Enquiry",
  enquiry_line: "Line",
  rfq: "RFQ",
  quotation: "Quotation",
};

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function EnquiryHistoryPage() {
  const { enquiryId } = useParams({ from: "/app/enquiries/$enquiryId/history" });

  const history = useQuery({
    queryKey: ["enquiry-history", enquiryId],
    queryFn: () => getEnquiryHistory(enquiryId),
  });

  if (history.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (history.isError) {
    return <Alert tone="error">Could not load the audit trail.</Alert>;
  }

  const entries = history.data.history.entries;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/app/enquiries/$enquiryId"
          params={{ enquiryId }}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to the enquiry
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Sourcing history</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {entries.length} recorded change{entries.length === 1 ? "" : "s"} across this enquiry and
          everything raised from it.
        </p>
      </div>

      {entries.length === 0 ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500">Nothing has been recorded against this enquiry yet.</p>
        </section>
      ) : (
        <section className="card p-5">
          <ol className="space-y-4">
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  return (
    <li className="border-l-2 border-slate-200 pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{ENTITY_LABELS[entry.entity] ?? entry.entity}</Badge>
        <span className="text-sm font-medium text-slate-800">
          {entry.action.replaceAll("_", " ").toLowerCase()}
        </span>
        <span className="text-xs text-slate-500">
          {new Date(entry.at).toLocaleString("en-IN")}
        </span>
        {entry.onBehalfOfVendor ? <Badge tone="blue">On the vendor&apos;s behalf</Badge> : null}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        {entry.actor
          ? `${entry.actor.name ?? "Unknown"}${entry.actor.role ? ` · ${entry.actor.role.replaceAll("_", " ")}` : ""}`
          : "System"}
      </p>
      {entry.changes.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
          {entry.changes.map((change) => (
            <li key={change.field}>
              <span className="font-medium">{change.field}</span>: {pretty(change.from)} →{" "}
              {pretty(change.to)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

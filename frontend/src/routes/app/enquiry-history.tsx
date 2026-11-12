import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { getEnquiryHistory, type HistoryEntry } from "@/lib/enquiryHistory";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
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
      <PageHeader
        back={{ to: `/app/enquiries/${enquiryId}`, label: "Back to the enquiry" }}
        title="Sourcing history"
        description="Every recorded change across this enquiry and everything raised from it."
        meta={
          <span className="text-xs text-slate-500">
            {entries.length} change{entries.length === 1 ? "" : "s"}
          </span>
        }
      />

      <Panel bodyClassName={entries.length === 0 ? undefined : "p-5"}>
        {entries.length === 0 ? (
          <EmptyState
            icon={<History className="size-4" aria-hidden />}
            title="Nothing recorded yet"
            description="Changes to this enquiry, its lines, RFQs and quotations will appear here."
          />
        ) : (
          <ol className="space-y-4">
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
      </Panel>
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

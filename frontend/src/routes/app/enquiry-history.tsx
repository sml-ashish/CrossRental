import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { getEnquiryHistory, type HistoryEntry } from "@/lib/enquiryHistory";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBackButton } from "@/components/ui/page-back-button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";

/**
 * The sourcing history of one enquiry, in one panel like the enquiry list.
 *
 * Only human-meaningful events are shown. Raw trail moves (`trail` entries and
 * `trailStatus` field changes) are audit machinery: the line card already shows
 * the folded status, so repeating the internal values here would only confuse.
 */

const ENTITY_LABELS: Record<string, string> = {
  enquiry: "Enquiry",
  enquiry_line: "Line",
  rfq: "RFQ",
  quotation: "Quotation",
};

function isVisible(entry: HistoryEntry): boolean {
  if (entry.action === "trail") return false;
  return entry.changes.some((change) => change.field !== "trailStatus") || entry.changes.length === 0;
}

function fieldLabel(field: string): string {
  return field
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function pretty(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function EnquiryHistoryPage() {
  const { enquiryId } = useParams({ from: "/app/enquiries/$enquiryId/history" });
  const { theme } = useTheme();

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
    return <Alert tone="error">Could not load the sourcing history.</Alert>;
  }

  const entries = history.data.history.entries.filter(isVisible);

  return (
    <div
      className={cn(
        "enq enq-fiori -mx-4 -my-6 min-h-[calc(100dvh-49px)] bg-ink-950 p-4 text-neutral-200 sm:-mx-6 sm:p-6",
        theme === "light" ? "theme-light" : "theme-dark",
      )}
    >
      <section className="enq-card flex min-w-0 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-5 pt-4 pb-3 sm:px-6">
          <PageBackButton className="text-slate-400 hover:text-white" />
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <h1 className="enq-serif text-[26px] leading-tight font-semibold text-white">
              Sourcing history
            </h1>
            <p className="text-[13px] text-slate-600 tabular-nums">
              {entries.length} change{entries.length === 1 ? "" : "s"}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 px-5 py-4 sm:px-6">
          {entries.length === 0 ? (
            <EmptyState
              icon={<History className="size-4" aria-hidden />}
              title="Nothing recorded yet"
              description="Changes to this enquiry, its lines, RFQs and quotations will appear here."
            />
          ) : (
            <ol className="divide-y divide-ink-800">
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const changes = entry.changes.filter((change) => change.field !== "trailStatus");
  const actor = entry.actor
    ? `${entry.actor.name ?? "Unknown"}${entry.actor.role ? ` · ${entry.actor.role.replaceAll("_", " ")}` : ""}`
    : "System";

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-[13px]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-white">
          {ENTITY_LABELS[entry.entity] ?? entry.entity}
        </span>
        <span className="text-slate-700">{entry.action.replaceAll("_", " ")}</span>
        {changes.length > 0 ? (
          <span className="text-slate-600">
            {changes.map((change) => `${fieldLabel(change.field)}: ${pretty(change.from)} → ${pretty(change.to)}`).join(" · ")}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-slate-500 tabular-nums">
        <span>{actor}</span>
        <span aria-hidden>·</span>
        <span>{new Date(entry.at).toLocaleString("en-IN")}</span>
        {entry.onBehalfOfVendor ? <span className="text-blue-600">(on vendor&apos;s behalf)</span> : null}
      </div>
    </li>
  );
}

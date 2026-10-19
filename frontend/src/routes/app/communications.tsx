import { useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getCommunicationHistory, type CommunicationScope } from "@/lib/communications";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

/**
 * Communication history (P4, BPD 6.21).
 *
 * The messages behind an enquiry, line, RFQ or quotation, in order. Every entry
 * is outbound because the platform only records what it sent — inbound vendor
 * replies arrive with the WhatsApp/parsing work in P6, and the screen says so
 * rather than pretending the thread is complete.
 */

export function CommunicationHistoryPage() {
  const search = useSearch({ strict: false }) as CommunicationScope;
  const scope: CommunicationScope = {
    enquiryId: search.enquiryId,
    lineId: search.lineId,
    rfqId: search.rfqId,
    quotationId: search.quotationId,
  };

  const hasScope = Boolean(scope.enquiryId || scope.lineId || scope.rfqId || scope.quotationId);
  const history = useQuery({
    queryKey: ["communications", scope],
    queryFn: () => getCommunicationHistory(scope),
    enabled: hasScope,
  });

  const scopeLabel = scope.enquiryId
    ? "this enquiry"
    : scope.lineId
      ? "this line"
      : scope.rfqId
        ? "this RFQ"
        : scope.quotationId
          ? "this quotation"
          : "";

  if (!hasScope) {
    return <Alert tone="error">Open this from an enquiry, line, RFQ or quotation.</Alert>;
  }

  if (history.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (history.isError) {
    return <Alert tone="error">Could not load the communication history.</Alert>;
  }

  const { messages, inboundCaptured } = history.data.history;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Communication history</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {messages.length} message{messages.length === 1 ? "" : "s"} logged against {scopeLabel}.
        </p>
      </div>

      {!inboundCaptured ? (
        <Alert tone="info">
          Only outbound messages are recorded today. Inbound vendor replies are not captured until
          the messaging work in P6.
        </Alert>
      ) : null}

      {messages.length === 0 ? (
        <section className="card p-5">
          <p className="text-sm text-slate-500">Nothing has been sent against {scopeLabel} yet.</p>
        </section>
      ) : (
        <section className="card p-5">
          <ol className="space-y-4">
            {messages.map((message) => (
              <li key={message.id} className="border-l-2 border-slate-200 pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{message.templateLabel}</span>
                  <Badge tone={message.direction === "OUTBOUND" ? "blue" : "neutral"}>
                    {message.direction === "OUTBOUND" ? "Outbound" : "Inbound"}
                  </Badge>
                  {message.businessEvent ? (
                    <Badge tone="emerald">{message.businessEvent}</Badge>
                  ) : null}
                  <span className="text-xs text-slate-500">
                    {new Date(message.sentAt).toLocaleString("en-IN")}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-slate-700">{message.subject}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  To {message.toEmail}
                  {message.ccEmail ? ` · cc ${message.ccEmail}` : ""} · {message.channel.toLowerCase()} ·{" "}
                  {message.status}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

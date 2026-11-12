import { useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getCommunicationHistory, type CommunicationScope } from "@/lib/communications";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";

/**
 * Communication history (P4, BPD 6.21).
 *
 * The messages behind an enquiry, line, RFQ or quotation, in order. Outbound
 * messages and the inbound email/WhatsApp replies captured in P6 share one
 * trail, so the screen shows the whole conversation rather than half of it.
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

  const { messages } = history.data.history;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Communication history"
        description={`Every outbound message and captured reply against ${scopeLabel}.`}
        meta={
          <span className="text-xs text-slate-500">
            {messages.length} message{messages.length === 1 ? "" : "s"}
          </span>
        }
      />

      <Panel bodyClassName={messages.length === 0 ? undefined : "p-5"}>
        {messages.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description={`Nothing has been sent against ${scopeLabel}.`}
          />
        ) : (
          <ol className="space-y-4">
            {messages.map((message) => (
              <li key={message.id} className="border-l-2 border-slate-200 pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{message.templateLabel}</span>
                  <Badge tone={message.direction === "OUTBOUND" ? "blue" : "neutral"}>
                    {message.direction === "OUTBOUND" ? "Outbound" : "Inbound"}
                  </Badge>
                  <Badge tone={message.channel === "WHATSAPP" ? "emerald" : "neutral"}>
                    {message.channel === "WHATSAPP" ? "WhatsApp" : "Email"}
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
                  {message.direction === "INBOUND"
                    ? `From ${message.fromAddress ?? message.toEmail}`
                    : `To ${message.toEmail}${message.ccEmail ? ` · cc ${message.ccEmail}` : ""}`}{" "}
                  · {message.channel.toLowerCase()} · {message.status}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

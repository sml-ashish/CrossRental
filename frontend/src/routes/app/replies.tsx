import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/toolbar";
import { Spinner } from "@/components/ui/spinner";
import { ReplyDetail } from "@/components/reply-editor";
import { loadReplies, type InboundReplyStatus } from "@/lib/replies";

/**
 * P6 assisted validation queue.
 *
 * The list stays on Pending by default, because that is the only state needing
 * an action. Selecting a reply opens the parsed fields: an admin corrects what
 * the parser read, matches the vendor/RFQ/crane when needed, then converts it
 * into a quotation. Dismissing records why the message was not a quotation.
 */
export function ReplyQueuePage() {
  const [status, setStatus] = useState<InboundReplyStatus | "ALL">("PENDING");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["admin", "replies", status],
    queryFn: () => loadReplies(status),
  });

  useEffect(() => {
    if (!selectedId && list.data?.replies[0]) {
      setSelectedId(list.data.replies[0].id);
    }
  }, [list.data, selectedId]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "replies"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "dashboard"] });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: "/app/admin", label: "Admin" }}
        title="Reply validation queue"
        description="Email and WhatsApp replies the parser could not turn into a complete quotation."
        meta={<Badge tone="amber">{list.data?.pendingCount ?? 0} pending</Badge>}
        actions={
          <button type="button" className="btn-secondary" onClick={refresh}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={status}
          onChange={(option) => {
            setStatus(option);
            setSelectedId(null);
          }}
          label="Reply status"
          options={[
            { value: "PENDING", label: "Pending" },
            { value: "CONVERTED", label: "Converted" },
            { value: "DISMISSED", label: "Dismissed" },
            { value: "ALL", label: "All" },
          ]}
        />
      </div>

      {list.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : list.error ? (
        <Alert tone="error">{(list.error as Error).message}</Alert>
      ) : list.data && list.data.replies.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Inbox className="size-4" aria-hidden />}
            title={status === "PENDING" ? "Nothing waiting for validation" : "No replies here"}
            description={
              status === "PENDING"
                ? "Complete replies convert automatically. Anything the parser could not finish lands here."
                : "No replies have this status right now."
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-2">
            {list.data?.replies.map((reply) => (
              <button
                key={reply.id}
                type="button"
                onClick={() => setSelectedId(reply.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selectedId === reply.id
                    ? "border-brand-300 bg-brand-50"
                    : "border-slate-200 bg-white hover:border-brand-200"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {reply.vendor?.name ?? reply.fromAddress}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {reply.rfq?.rfqNumber ?? "No RFQ matched"} ·{" "}
                      {reply.channel === "WHATSAPP" ? "WhatsApp" : "Email"}
                    </p>
                  </div>
                  <StatusBadge status={reply.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-slate-600">
                  {reply.subject ?? reply.parseNote ?? "No subject"}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {new Date(reply.receivedAt).toLocaleString("en-IN")}
                </p>
              </button>
            ))}
          </div>

          <div>
            {selectedId ? (
              <ReplyDetail
                key={selectedId}
                id={selectedId}
                onChanged={() => {
                  refresh();
                  void queryClient.invalidateQueries({ queryKey: ["inbound-reply"] });
                }}
              />
            ) : (
              <div className="card">
                <EmptyState
                  title="Choose a reply"
                  description="Select a message on the left to review the parsed fields."
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

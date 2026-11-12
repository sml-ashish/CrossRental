import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Inbox } from "lucide-react";
import {
  TRAIL_LABELS,
  createRfqFromLine,
  formatDate,
  listRaisableLines,
  type RaisableLine,
} from "@/lib/enquiries";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { SearchInput, Toolbar, ToolbarField } from "@/components/ui/toolbar";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";

/**
 * Raise an RFQ against an enquiry line (P1 section 2, brief 6.7).
 *
 * The screen exists so there is exactly one way to create an RFQ: choose the
 * line first. The old free-form create asked for an enquiry number and a line
 * number by hand, which let an RFQ claim a line it did not belong to and left
 * the line's trail untouched. Here the line is the input, and the backend
 * prefills the requirement from its vendor-safe subset and derives the
 * enquiry/line reference from the line itself.
 *
 * Raising a draft is not sending. The RFQ detail screen picks vendors and
 * dispatches, which is where the customer-safe snapshot is frozen.
 */

function defaultDeadline(): string {
  const date = new Date(Date.now() + 7 * 86_400_000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function RfqNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [error, setError] = useState<string | null>(null);

  const lines = useQuery({
    queryKey: ["raisable-lines", search],
    queryFn: () => listRaisableLines(search),
  });

  const raise = useMutation({
    mutationFn: (line: RaisableLine) => createRfqFromLine(line.id, deadline),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["raisable-lines"] });
      void queryClient.invalidateQueries({ queryKey: ["enquiries"] });
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void navigate({ to: "/app/rfqs/$rfqId", params: { rfqId: created.rfq.id } });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not raise the RFQ.");
    },
  });

  function startRaise(line: RaisableLine) {
    setError(null);
    raise.mutate(line);
  }

  const rows = lines.data?.lines ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: "/app/rfqs", label: "All RFQs" }}
        title="Raise an RFQ"
        description="Every RFQ belongs to one enquiry line item. Pick the line, review the prefilled draft, then choose the vendors to send it to."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Toolbar>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Enquiry number or crane type"
            label="Search enquiry lines"
            className="w-64"
          />
          <button type="submit" className="btn-secondary py-[7px]">
            Search
          </button>
        </form>

        <ToolbarField label="Submission deadline" htmlFor="rfq-new-deadline">
          <TextInput
            id="rfq-new-deadline"
            type="date"
            value={deadline}
            onChange={setDeadline}
          />
        </ToolbarField>
      </Toolbar>

      <Panel
        title="Enquiry lines"
        description="Lines with a crane type and capacity that are still open for sourcing."
      >
        {lines.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" aria-hidden />}
            title="No lines are ready for an RFQ"
            description={
              search
                ? "No open line matches that search. Clear it or check the enquiry for a line still in sourcing."
                : "A line needs a crane type and capacity before an RFQ can be raised from it. Add the line to an enquiry first."
            }
            action={
              <Link to="/app/enquiries" className="btn-primary">
                <ArrowLeft className="size-4" aria-hidden />
                Go to enquiries
              </Link>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Enquiry / line</TH>
                <TH>Crane</TH>
                <TH align="right">Capacity</TH>
                <TH align="right">Qty</TH>
                <TH>Site</TH>
                <TH>Required start</TH>
                <TH>Status</TH>
                <TH align="right">RFQs</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((line) => (
                <TR key={line.id}>
                  <TD>
                    <Link
                      to="/app/enquiries/$enquiryId"
                      params={{ enquiryId: line.enquiryId }}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {line.enquiryNo}
                    </Link>
                    <p className="text-xs text-slate-500">Line {line.lineNo}</p>
                  </TD>
                  <TD>
                    <span className="font-medium text-slate-900">
                      {line.craneTypeName ?? line.craneTypeCode ?? "No type"}
                    </span>
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {line.capacityT === null ? "—" : `${line.capacityT} t`}
                    {line.capacityRule === "AT_LEAST" ? "+" : ""}
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {line.quantity}
                  </TD>
                  <TD>
                    <span className="text-slate-700">{line.siteLocation}</span>
                    {line.siteStateName ? (
                      <p className="text-xs text-slate-500">{line.siteStateName}</p>
                    ) : null}
                  </TD>
                  <TD className="whitespace-nowrap">
                    {line.startDateTbc
                      ? "TBC"
                      : line.requiredStartDate
                        ? formatDate(line.requiredStartDate)
                        : "—"}
                  </TD>
                  <TD>
                    <Badge tone="blue">{TRAIL_LABELS[line.trailStatus]}</Badge>
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {line.rfqCount}
                  </TD>
                  <TD align="right">
                    <button
                      type="button"
                      className="btn-primary whitespace-nowrap"
                      disabled={raise.isPending}
                      onClick={() => startRaise(line)}
                    >
                      {raise.isPending && raise.variables?.id === line.id ? (
                        <Spinner />
                      ) : null}
                      Raise RFQ
                    </button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>

      <p className="text-xs text-slate-500">
        The draft is prefilled from the line. Customer name and address, the rental budget,
        internal notes and the Sales Partner&rsquo;s name are never copied into an RFQ.
      </p>
    </div>
  );
}

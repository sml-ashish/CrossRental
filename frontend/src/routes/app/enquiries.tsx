import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Plus } from "lucide-react";
import {
  ENQUIRY_STATUS_LABELS,
  formatDate,
  listEnquiries,
  type EnquiryOverallStatus,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { SearchInput, Toolbar } from "@/components/ui/toolbar";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";

/**
 * Enquiry intake list (P1).
 *
 * Internal only. The row carries the derived roll-up, not a status a user can
 * set: the header status is computed from the lines (P1 section 4), so the list
 * can never disagree with the detail screen.
 */

const STATUS_TABS: Array<{ value: EnquiryOverallStatus | "ALL"; label: string }> = [
  { value: "RECEIVED_PENDING_SOURCING", label: "Pending sourcing" },
  { value: "PARTIALLY_QUOTED", label: "Partially quoted" },
  { value: "PARTIALLY_FINALISED", label: "Partially finalised" },
  { value: "FULLY_FINALISED", label: "Fully finalised" },
  { value: "CLOSED", label: "Closed" },
  { value: "ALL", label: "All" },
];

function enquiryStatusTone(status: EnquiryOverallStatus): BadgeTone {
  switch (status) {
    case "FULLY_FINALISED":
      return "emerald";
    case "PARTIALLY_FINALISED":
      return "purple";
    case "PARTIALLY_QUOTED":
      return "blue";
    case "CLOSED":
      return "neutral";
    default:
      return "amber";
  }
}

export function EnquiryIndexPage() {
  const { user } = useAuth();
  const canCreate = user?.role === "sales_user" || user?.role === "admin_user";

  const [status, setStatus] = useState<EnquiryOverallStatus | "ALL">(
    "RECEIVED_PENDING_SOURCING",
  );
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const enquiries = useQuery({
    queryKey: ["enquiries", status, search],
    queryFn: () =>
      listEnquiries({
        ...(status === "ALL" ? {} : { status }),
        ...(search ? { search } : {}),
      }),
  });

  const rows = enquiries.data?.enquiries ?? [];
  const activeLabel = STATUS_TABS.find((tab) => tab.value === status)?.label ?? "All";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Enquiries"
        description="Capture a cross-rental enquiry and source each line to vendors."
        actions={
          canCreate ? (
            <Link to="/app/enquiries/new" className="btn-primary">
              <Plus className="size-4" aria-hidden />
              New enquiry
            </Link>
          ) : null
        }
      />

      <Toolbar>
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Status
          </p>
          <div className="mt-1 flex flex-wrap gap-1" role="tablist" aria-label="Enquiry status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={status === tab.value}
                onClick={() => setStatus(tab.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  status === tab.value
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Enquiry no, customer, reference"
            label="Search enquiries"
            className="w-64"
          />
          <button type="submit" className="btn-secondary py-[7px]">
            Search
          </button>
        </form>
      </Toolbar>

      {enquiries.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : enquiries.isError ? (
        <Alert tone="error">
          {enquiries.error instanceof Error
            ? enquiries.error.message
            : "Could not load enquiries."}
        </Alert>
      ) : (
        <Panel
          title={activeLabel}
          description={`${rows.length} ${rows.length === 1 ? "enquiry" : "enquiries"}${
            search ? ` matching “${search}”` : ""
          }`}
          bodyClassName=""
        >
          <Table>
            <THead>
              <tr>
                <TH>Enquiry</TH>
                <TH>Customer</TH>
                <TH>Site</TH>
                <TH>Status</TH>
                <TH align="right">Date</TH>
              </tr>
            </THead>
            <TBody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={<Inbox className="size-4" aria-hidden />}
                      title="No enquiries in this view"
                      description={
                        search
                          ? "Nothing matches this search. Clear it, or switch to another status tab."
                          : "Enquiries raised through the portal appear here as soon as they are captured."
                      }
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <Link
                        to="/app/enquiries/$enquiryId"
                        params={{ enquiryId: row.id }}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {row.enquiryNo}
                      </Link>
                    </TD>
                    <TD>{row.customerName}</TD>
                    <TD className="text-slate-600">
                      {row.siteLocation}
                      {row.siteStateName ? `, ${row.siteStateName}` : ""}
                    </TD>
                    <TD>
                      <Badge tone={enquiryStatusTone(row.overallStatus)}>
                        {ENQUIRY_STATUS_LABELS[row.overallStatus]}
                      </Badge>
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-slate-500">
                      {formatDate(row.enquiryDate)}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

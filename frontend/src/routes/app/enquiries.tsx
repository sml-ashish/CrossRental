import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import {
  ENQUIRY_STATUS_LABELS,
  formatDate,
  listEnquiries,
  type EnquiryListRow,
  type EnquiryOverallStatus,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth";

/**
 * Enquiry intake list (P1).
 *
 * Internal only. The row carries the derived roll-up, not a status a user can
 * set: the header status is computed from the lines (P1 section 4), so the list
 * can never disagree with the detail screen.
 */

const STATUS_TABS: Array<{ value: EnquiryOverallStatus | "ALL"; label: string }> = [
  { value: "RECEIVED_PENDING_SOURCING", label: "Pending Sourcing" },
  { value: "PARTIALLY_QUOTED", label: "Partially Quoted" },
  { value: "PARTIALLY_FINALISED", label: "Partially Finalised" },
  { value: "FULLY_FINALISED", label: "Fully Finalised" },
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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Enquiries</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Capture a cross-rental enquiry and source each line to vendors.
          </p>
        </div>
        {canCreate ? (
          <Link to="/app/enquiries/new" className="btn-primary">
            <Plus className="size-4" aria-hidden />
            New enquiry
          </Link>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Enquiry status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={
                status === tab.value
                  ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Enquiry no, customer, reference"
              className="field-input pl-8"
              aria-label="Search enquiries"
            />
          </div>
          <button type="submit" className="btn-secondary">
            Search
          </button>
        </form>
      </div>

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
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-slate-500">No enquiries match this view.</p>
        </div>
      ) : (
        <EnquiryTable rows={rows} />
      )}
    </div>
  );
}

function EnquiryTable({ rows }: { rows: EnquiryListRow[] }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Enquiry</th>
            <th className="px-4 py-2.5 font-medium">Customer</th>
            <th className="px-4 py-2.5 font-medium">Site</th>
            <th className="px-4 py-2.5 font-medium">Lines</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <Link
                  to="/app/enquiries/$enquiryId"
                  params={{ enquiryId: row.id }}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {row.enquiryNo}
                </Link>
                {row.externalReference ? (
                  <p className="text-xs text-slate-500">Ref {row.externalReference}</p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-slate-700">{row.customerName}</td>
              <td className="px-4 py-3 text-slate-600">
                {row.siteLocation}
                {row.siteStateName ? `, ${row.siteStateName}` : ""}
              </td>
              <td className="px-4 py-3 text-slate-600">{row.lineCount}</td>
              <td className="px-4 py-3">
                <Badge tone={enquiryStatusTone(row.overallStatus)}>
                  {ENQUIRY_STATUS_LABELS[row.overallStatus]}
                </Badge>
              </td>
              <td className="px-4 py-3 text-slate-600">{formatDate(row.enquiryDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

interface ReferenceData {
  states: { code: string; name: string }[];
  craneTypes: { code: string; name: string }[];
}

export interface MyVendor {
  id: string;
  sapVendorCode: string | null;
  name: string;
  natureOfCompany: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  stateCode: string | null;
  pincode: string | null;
  telephone: string | null;
  email: string;
  pan: string | null;
  gstRegistered: boolean | null;
  gstn: string | null;
  gstRegistrationType: string | null;
  fleetSummary: string | null;
  communicationNotes: string | null;
  onboardingStatus: string;
  totalFleetSize: number;
  operatingRegions: string[];
  contacts: {
    id: string;
    name: string;
    mobile: string | null;
    email: string | null;
    isPrimary: boolean;
    receivesRfqs: boolean;
  }[];
  bankName: string | null;
  bankBranch: string | null;
  bankAccountType: string | null;
  bankAccountHolderName: string | null;
  /** Already masked by the backend. Never decrypt it here. */
  bankAccountNo: string;
  bankIfsc: string;
  bankMasked: boolean;
}

/**
 * The vendor's own record, read from /api/vendors/me.
 *
 * This screen exists to confirm the M1 isolation work end to end: it shows that
 * a vendor sees their own details, that bank details arrive masked, and that
 * no other vendor's data is reachable from here.
 */
export function VendorProfilePage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["vendors", "me"],
    queryFn: () => api<{ vendor: MyVendor }>("/vendors/me").then((r) => r.vendor),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading your details
      </div>
    );
  }

  if (error) {
    return (
      <Alert title="Could not load your details">
        {(error as Error).message}
        <button type="button" onClick={() => refetch()} className="btn-secondary mt-3 px-3 py-1.5">
          Try again
        </button>
      </Alert>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={data.name}
        description={
          data.sapVendorCode
            ? `SAP vendor code ${data.sapVendorCode}`
            : "Vendor code not assigned yet"
        }
        meta={<Badge tone="neutral">{data.onboardingStatus}</Badge>}
      />

      <Panel title="Registration">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Legal name" value={data.name} />
          <Field label="Nature of company" value={data.natureOfCompany} />
          <div className="sm:col-span-2">
            <Field
              label="Address"
              value={
                [
                  data.addressLine1,
                  data.addressLine2,
                  [data.city, data.district, data.pincode].filter(Boolean).join(" "),
                ]
                  .filter(Boolean)
                  .join(", ") || "—"
              }
            />
          </div>
          <Field label="Telephone" value={data.telephone ?? "—"} />
          <Field label="Email" value={data.email} />
          <Field label="PAN" value={data.pan ?? "—"} mono />
          <Field
            label="GST"
            value={
              data.gstRegistered === true
                ? `${data.gstn ?? "—"}${
                    data.gstRegistrationType
                      ? ` (${data.gstRegistrationType.replace(/_/g, " ").toLowerCase()})`
                      : ""
                  }`
                : data.gstRegistered === false
                  ? "Not registered"
                  : "—"
            }
          />
          <Field label="Operating regions" value={data.operatingRegions.join(", ") || "—"} />
          <Field label="Fleet size" value={String(data.totalFleetSize)} />
        </dl>
      </Panel>

      <Panel
        title="Bank details"
        description="Account number and IFSC are stored encrypted and are never shown in full in the portal."
      >
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Account holder" value={data.bankAccountHolderName ?? "—"} />
          <Field label="Bank" value={data.bankName ?? "—"} />
          <Field label="Branch" value={data.bankBranch ?? "—"} />
          <Field label="Account type" value={data.bankAccountType ?? "—"} />
          <Field label="Account number" value={data.bankAccountNo} mono />
          <Field label="IFSC" value={data.bankIfsc} mono />
        </dl>
      </Panel>

      <Panel title="Contacts" bodyClassName="p-0">
        <ul className="divide-y divide-ink-800">
          {data.contacts.map((contact) => (
            <li key={contact.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {contact.name}
                  {contact.isPrimary ? (
                    <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      Primary
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-slate-500">{contact.email ?? "—"}</p>
              </div>
              <p className="shrink-0 text-sm text-slate-600">{contact.mobile ?? "—"}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-sm text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

export type { ReferenceData };
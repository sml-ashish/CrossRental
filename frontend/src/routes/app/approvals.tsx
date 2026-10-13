import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Search, Send } from "lucide-react";
import { inviteVendor, listVendors, resendActivation, type QueueVendor } from "@/lib/onboarding";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Field, TextInput } from "@/components/ui/form";
import { StatusBadge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";

/**
 * The approval queue (brief 7.3).
 *
 * Two audiences share it. Sales can see and search registrations and send
 * invitations, because that is the day-to-day part of onboarding, but cannot
 * approve — the Approve and Reject controls are not rendered for them. The
 * backend refuses those calls too; hiding the button is only a courtesy.
 */

const STATUS_TABS = [
  { value: "SUBMITTED", label: "Awaiting review" },
  { value: "REJECTED", label: "Rejected" },
  { value: "APPROVED", label: "Approved" },
  { value: "DRAFT", label: "In progress" },
  { value: "ALL", label: "All" },
] as const;

export function ApprovalQueuePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin_user";

  const [status, setStatus] = useState<string>("SUBMITTED");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const queryClient = useQueryClient();

  const queue = useQuery({
    queryKey: ["vendors", "queue", status, search],
    queryFn: () => listVendors(status, search),
  });

  const resend = useMutation({
    mutationFn: (vendorId: string) => resendActivation(vendorId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["vendors"] });
      void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      if (result.sent) window.alert("A fresh activation link has been emailed.");
    },
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Vendor approvals</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Registrations submitted through the vendor portal.
          </p>
        </div>
        <InviteVendorCard />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setStatus(tab.value)}
            className={
              status === tab.value
                ? "rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-300"
            }
          >
            {tab.label}
            {queue.data?.counts?.[tab.value] !== undefined && tab.value !== "ALL" ? (
              <span className="ml-1.5 opacity-70">{queue.data.counts[tab.value]}</span>
            ) : null}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput);
        }}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            className="field-input pl-9"
            placeholder="Search by company, email, PAN or vendor code"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            aria-label="Search vendors"
          />
        </div>
        <button type="submit" className="btn-secondary px-4 text-sm">
          Search
        </button>
        {search ? (
          <button
            type="button"
            className="btn-secondary px-4 text-sm"
            onClick={() => {
              setSearch("");
              setSearchInput("");
            }}
          >
            Clear
          </button>
        ) : null}
      </form>

      {queue.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading registrations
        </div>
      ) : queue.error ? (
        <Alert title="Could not load the queue">{(queue.error as Error).message}</Alert>
      ) : (queue.data?.vendors.length ?? 0) === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          Nothing here. Registrations appear as vendors submit them.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Vendor</th>
                <th className="px-4 py-2.5 font-medium">PAN / GSTIN</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Regions</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Documents</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(queue.data?.vendors ?? []).map((vendor) => (
                <QueueRow
                  key={vendor.id}
                  vendor={vendor}
                  isAdmin={isAdmin}
                  onResend={() => resend.mutate(vendor.id)}
                  resending={resend.isPending && resend.variables === vendor.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QueueRow({
  vendor,
  isAdmin,
  onResend,
  resending,
}: {
  vendor: QueueVendor;
  isAdmin: boolean;
  onResend: () => void;
  resending: boolean;
}) {
  const primary = vendor.contacts[0];

  return (
    <tr className="align-top hover:bg-slate-50/60">
      <td className="px-4 py-3">
        <Link
          to="/app/vendors/$vendorId"
          params={{ vendorId: vendor.id }}
          className="font-medium text-brand-700 hover:underline"
        >
          {vendor.name ?? "(no name yet)"}
        </Link>
        <p className="mt-0.5 text-xs text-slate-500">{primary?.email ?? vendor.email ?? "—"}</p>
        {vendor.sapVendorCode ? (
          <p className="mt-0.5 font-mono text-xs text-slate-500">{vendor.sapVendorCode}</p>
        ) : null}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-slate-700">
        <p>{vendor.pan ?? "—"}</p>
        <p className="text-slate-500">{vendor.gstn ?? ""}</p>
      </td>
      <td className="hidden px-4 py-3 text-xs text-slate-600 lg:table-cell">
        {vendor.operatingRegions.join(", ") || "—"}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={vendor.onboardingStatus} />
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">{vendor.documents.length}/3</td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {isAdmin && vendor.onboardingStatus === "APPROVED" ? (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              onClick={onResend}
              disabled={resending}
              title="Issue a fresh activation link"
            >
              {resending ? <Spinner /> : <Send className="size-3.5" aria-hidden />}
              Resend
            </button>
          ) : null}
          <Link to="/app/vendors/$vendorId" params={{ vendorId: vendor.id }} className="btn-secondary px-2.5 py-1.5 text-xs">
            {isAdmin ? "Review" : "View"}
          </Link>
        </div>
      </td>
    </tr>
  );
}

/**
 * Sends a registration invitation.
 *
 * The returned link is shown so the sender can pass it on by another channel if
 * the email does not arrive. The backend never stores the token in clear, so it
 * cannot be shown again later — a second invitation is the only way to get a
 * new one.
 */
function InviteVendorCard() {
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () => inviteVendor({ email: email.trim(), companyName, contactName }),
    onSuccess: (result) => {
      // Matches the link the backend emails, so a pasted copy behaves identically.
      setLink(`${window.location.origin}/onboarding/start?token=${encodeURIComponent(result.token)}`);
      setCopied(false);
      setEmail("");
      setCompanyName("");
      setContactName("");
    },
  });

  return (
    <div className="card w-full p-4 sm:max-w-md">
      <h2 className="text-sm font-semibold text-slate-900">Invite a vendor to register</h2>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <Field label="Email address" htmlFor="invite-email" required>
          <TextInput
            id="invite-email"
            type="email"
            value={email}
            onChange={setEmail}
            inputMode="email"
            placeholder="vendor@example.com"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company" htmlFor="invite-company">
            <TextInput id="invite-company" value={companyName} onChange={setCompanyName} />
          </Field>
          <Field label="Contact person" htmlFor="invite-contact">
            <TextInput id="invite-contact" value={contactName} onChange={setContactName} />
          </Field>
        </div>
        <button
          type="submit"
          className="btn-primary w-full px-3 py-2 text-sm"
          disabled={invite.isPending || email.trim() === ""}
        >
          {invite.isPending ? <Spinner /> : null}
          Send invitation
        </button>
      </form>

      {invite.isError ? (
        <div className="mt-3">
          <Alert title="The invitation was not sent">{(invite.error as Error).message}</Alert>
        </div>
      ) : null}

      {link ? (
        <div className="mt-3">
          <Alert tone="success" title="Invitation created">
            <p className="text-xs">
              A copy of the link, in case the email does not arrive. It cannot be shown again.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
                className="field-input font-mono text-xs"
                aria-label="Registration link"
              />
              <button
                type="button"
                className="btn-secondary shrink-0 px-2.5 text-xs"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                }}
              >
                <Copy className="size-3.5" aria-hidden />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

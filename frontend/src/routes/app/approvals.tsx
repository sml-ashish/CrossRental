import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Search, Send } from "lucide-react";
import { inviteVendor, listVendors, resendActivation, type QueueVendor } from "@/lib/onboarding";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { SearchInput, Toolbar } from "@/components/ui/toolbar";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Spinner } from "@/components/ui/spinner";
import { Field, TextInput } from "@/components/ui/form";
import { StatusBadge } from "@/components/ui/badge";
import { BulkInviteUpload } from "@/components/vendor-bulk-invite";
import { cn } from "@/lib/cn";
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
      <PageHeader
        title="Vendor approvals"
        description="Registrations submitted through the vendor portal, and the invitations sent to start them."
        meta={
          queue.data?.counts?.SUBMITTED !== undefined ? (
            <span className="text-xs text-slate-500">
              {queue.data.counts.SUBMITTED} awaiting review
            </span>
          ) : null
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <Toolbar>
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                Status
              </p>
              <div className="mt-1 flex flex-wrap gap-1" role="tablist" aria-label="Vendor status">
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
                        ? "bg-ink-700 text-white"
                        : "border border-slate-200 bg-ink-850 text-slate-600 hover:bg-ink-800",
                    )}
                  >
                    {tab.label}
                    {queue.data?.counts?.[tab.value] !== undefined && tab.value !== "ALL" ? (
                      <span className="ml-1.5 opacity-70">{queue.data.counts[tab.value]}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchInput);
              }}
            >
              <SearchInput
                value={searchInput}
                onChange={setSearchInput}
                placeholder="Company, email, PAN or vendor code"
                label="Search vendors"
                className="w-64"
              />
              <button type="submit" className="btn-secondary py-[7px]">
                Search
              </button>
              {search ? (
                <button
                  type="button"
                  className="btn-secondary py-[7px]"
                  onClick={() => {
                    setSearch("");
                    setSearchInput("");
                  }}
                >
                  Clear
                </button>
              ) : null}
            </form>
          </Toolbar>

          {queue.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Loading registrations
            </div>
          ) : queue.error ? (
            <Alert title="Could not load the queue">{(queue.error as Error).message}</Alert>
          ) : (queue.data?.vendors.length ?? 0) === 0 ? (
            <div className="card">
              <EmptyState
                icon={<Search className="size-4" aria-hidden />}
                title="Nothing in this view"
                description="Registrations appear here as vendors submit them. Send an invitation to start one."
              />
            </div>
          ) : (
            <Panel bodyClassName="">
              <Table>
                <THead>
                  <tr>
                    <TH>Vendor</TH>
                    <TH>PAN / GSTIN</TH>
                    <TH className="hidden lg:table-cell">Regions</TH>
                    <TH>Status</TH>
                    <TH align="right">Documents</TH>
                    <TH />
                  </tr>
                </THead>
                <TBody>
                  {(queue.data?.vendors ?? []).map((vendor) => (
                    <QueueRow
                      key={vendor.id}
                      vendor={vendor}
                      isAdmin={isAdmin}
                      onResend={() => resend.mutate(vendor.id)}
                      resending={resend.isPending && resend.variables === vendor.id}
                    />
                  ))}
                </TBody>
              </Table>
            </Panel>
          )}
        </div>

        <div className="xl:sticky xl:top-20">
          <InviteVendorCard />
          <BulkInviteUpload />
        </div>
      </div>
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
    <TR className="align-top">
      <TD>
        <Link
          to="/app/vendors/$vendorId"
          params={{ vendorId: vendor.id }}
          className="font-medium text-brand-700 hover:underline"
        >
          {vendor.name ?? "(no name yet)"}
        </Link>
        <p className="mt-0.5 text-[11px] text-slate-500">{primary?.email ?? vendor.email ?? "—"}</p>
        {vendor.sapVendorCode ? (
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">{vendor.sapVendorCode}</p>
        ) : null}
      </TD>
      <TD className="font-mono text-xs">
        <p>{vendor.pan ?? "—"}</p>
        <p className="text-[11px] text-slate-500">{vendor.gstn ?? ""}</p>
      </TD>
      <TD className="hidden text-xs lg:table-cell">
        {vendor.operatingRegions.join(", ") || "—"}
      </TD>
      <TD>
        <StatusBadge status={vendor.onboardingStatus} />
      </TD>
      <TD align="right" className="text-xs tabular-nums">
        {vendor.documents.length}/3
      </TD>
      <TD align="right">
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
      </TD>
    </TR>
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      inviteVendor({
        name: name.trim(),
        email: email.trim(),
        contactNumber: contactNumber.trim(),
      }),
    onSuccess: (result) => {
      // Matches the link the backend emails, so a pasted copy behaves identically.
      setLink(`${window.location.origin}/onboarding/start?token=${encodeURIComponent(result.token)}`);
      setEmailSent(result.emailSent);
      setCopied(false);
      setName("");
      setEmail("");
      setContactNumber("");
    },
  });

  const complete =
    name.trim().length >= 2 && email.trim() !== "" && contactNumber.trim() !== "";

  return (
    <div className="card w-full p-4">
      <h2 className="text-sm font-semibold text-slate-900">Invite a vendor to register</h2>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <Field label="Vendor name" htmlFor="invite-name" required>
          <TextInput
            id="invite-name"
            value={name}
            onChange={setName}
            placeholder="Registered company name"
          />
        </Field>
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
        <Field
          label="Contact number"
          htmlFor="invite-contact-number"
          required
          hint="10-digit mobile number; +91 or a leading 0 is removed."
        >
          <TextInput
            id="invite-contact-number"
            type="tel"
            value={contactNumber}
            onChange={setContactNumber}
            inputMode="tel"
            placeholder="9876543210"
          />
        </Field>
        <button
          type="submit"
          className="btn-primary w-full px-3 py-2 text-sm"
          disabled={invite.isPending || !complete}
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
          <Alert
            tone={emailSent ? "success" : "error"}
            title={emailSent ? "Invitation created" : "Invitation created — email not sent"}
          >
            <p className="text-xs">
              {emailSent
                ? "A copy of the link, in case the email does not arrive. It cannot be shown again."
                : "The email could not be sent from this deployment. Copy the link below and send it to the vendor directly. It cannot be shown again."}
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

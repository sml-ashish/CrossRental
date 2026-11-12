import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, Select, TextInput } from "@/components/ui/form";
import { useAuth } from "@/lib/auth";
import { AlertList } from "@/components/alerts";
import {
  createAdminUser,
  loadAdminDashboard,
  loadAdminUsers,
  resetUserCredentials,
  updateAdminUser,
  type AdminUser,
  type InternalRole,
} from "@/lib/admin";

/**
 * Admin screen (P0 B).
 *
 * Two audiences-in-one: the day's counters (B1) and the staff who run the
 * portal (B2). Vendor suspension lives on the vendor detail screen, where the
 * vendor is already in view. Every call is admin-gated on the server.
 */

const ROLE_OPTIONS = [
  { value: "admin_user", label: "Admin" },
  { value: "sales_user", label: "Sales (CR team)" },
  { value: "management_viewer", label: "Management Viewer" },
] as const;

export function AdminPage() {
  const dashboard = useQuery({ queryKey: ["admin", "dashboard"], queryFn: loadAdminDashboard });

  if (dashboard.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const counts = dashboard.data?.counts;
  const staleFlagDays = dashboard.data?.thresholds.staleFlagDays ?? 60;
  const fleetHint = "Vendor fleet records awaiting validation.";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Admin"
        description="The day's exceptions and the SML staff who operate the portal."
      />

      {dashboard.error ? (
        <Alert tone="error">{(dashboard.error as Error).message}</Alert>
      ) : null}

      <Panel title="Attention">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Link to="/app/approvals" className="block">
            <StatTile
              value={counts?.awaitingApproval ?? 0}
              label="Registrations awaiting approval"
              className="h-full transition-colors hover:border-brand-300"
            />
          </Link>

          <Link to="/app/rfqs" search={{ delivery: "FAILED" }} className="block">
            <StatTile
              value={counts?.rfqsWithFailures ?? 0}
              label="RFQs with email delivery failures"
              className="h-full transition-colors hover:border-brand-300"
            />
          </Link>

          <StatTile
            value={counts?.cranesStale ?? 0}
            label={`Cranes stale (${staleFlagDays}+ days)`}
            hint={fleetHint}
            className="h-full"
          />
          <StatTile
            value={counts?.cranesUnverified ?? 0}
            label="Cranes with no map location"
            hint={fleetHint}
            className="h-full"
          />
          <StatTile
            value={counts?.cranesLapsed ?? 0}
            label="Engaged cranes past their release date"
            hint={fleetHint}
            className="h-full"
          />
          {dashboard.data?.thresholds.fleetApprovalRequired ? (
            <StatTile
              value={counts?.fleetPendingValidation ?? 0}
              label="Fleet records pending validation"
              className="h-full"
            />
          ) : null}
          <Link to="/app/admin/replies" className="block">
            <StatTile
              value={counts?.unmatchedQuotationResponses ?? 0}
              label="Replies awaiting validation"
              hint="Match the vendor, RFQ and crane, or dismiss it."
              className="h-full transition-colors hover:border-brand-300"
            />
          </Link>
          <StatTile
            value={counts?.failedEmails ?? 0}
            label="Emails failed in the last 7 days"
            className="h-full"
          />
        </div>
      </Panel>

      <Panel
        title="Alerts"
        description={`SLA: ${dashboard.data?.thresholds.alertRfqSlaHours ?? 48}h for RFQ responses, ${dashboard.data?.thresholds.alertQuotationExpiryDays ?? 3} days for quotation expiry, ${dashboard.data?.thresholds.alertBookingLeadDays ?? 7} days before a booking starts.`}
      >
        <AlertList alerts={dashboard.data?.alerts ?? []} />
      </Panel>

      <UserManagement />
    </div>
  );
}

function UserManagement() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<InternalRole>("sales_user");
  const [notice, setNotice] = useState<string | null>(null);

  const users = useQuery({ queryKey: ["admin", "users"], queryFn: loadAdminUsers });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const create = useMutation({
    mutationFn: () => createAdminUser({ email: email.trim(), fullName: fullName.trim(), role }),
    onSuccess: (created) => {
      setEmail("");
      setFullName("");
      setNotice(`${created.email} can now sign in with a one-time code.`);
      void refresh();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { role?: InternalRole; isActive?: boolean } }) =>
      updateAdminUser(id, input),
    onSuccess: () => {
      setNotice("User updated.");
      void refresh();
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => resetUserCredentials(id),
    onSuccess: () => setNotice("A new sign-in credential has been emailed."),
  });

  return (
    <Panel
      title="SML users"
      description="Internal accounts sign in with a one-time code sent to their email — there is no password. Deactivating an account ends its sessions immediately."
    >
      <div className="space-y-4">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {create.isError ? <Alert tone="error">{(create.error as Error).message}</Alert> : null}
        {update.isError ? <Alert tone="error">{(update.error as Error).message}</Alert> : null}
        {reset.isError ? <Alert tone="error">{(reset.error as Error).message}</Alert> : null}

        <form
          className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Email" htmlFor="admin-user-email">
            <TextInput id="admin-user-email" type="email" value={email} onChange={setEmail} />
          </Field>
          <Field label="Full name" htmlFor="admin-user-name">
            <TextInput id="admin-user-name" value={fullName} onChange={setFullName} />
          </Field>
          <Field label="Role" htmlFor="admin-user-role">
            <Select
              id="admin-user-role"
              value={role}
              onChange={(value) => setRole(value as InternalRole)}
              options={ROLE_OPTIONS}
            />
          </Field>
          <button type="submit" className="btn-primary" disabled={create.isPending || !email.trim()}>
            {create.isPending ? "Creating…" : "Create user"}
          </button>
        </form>
      </div>

      <div className="mt-4">
        {users.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading users
          </div>
        ) : users.error ? (
          <Alert tone="error">{(users.error as Error).message}</Alert>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <Table>
              <THead>
                <tr>
                  <TH>User</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Last sign-in</TH>
                  <TH align="right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {(users.data ?? []).map((row) => (
                  <UserRow
                    key={row.id}
                    row={row}
                    isMe={row.id === me?.id}
                    busy={update.isPending || reset.isPending}
                    onChangeRole={(next) => update.mutate({ id: row.id, input: { role: next } })}
                    onToggleActive={() =>
                      update.mutate({ id: row.id, input: { isActive: !row.isActive } })
                    }
                    onReset={() => reset.mutate(row.id)}
                  />
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function UserRow({
  row,
  isMe,
  busy,
  onChangeRole,
  onToggleActive,
  onReset,
}: {
  row: AdminUser;
  isMe: boolean;
  busy: boolean;
  onChangeRole: (role: InternalRole) => void;
  onToggleActive: () => void;
  onReset: () => void;
}) {
  return (
    <TR className="align-middle">
      <TD>
        <p className="font-medium text-slate-900">{row.fullName ?? "—"}</p>
        <p className="text-[11px] text-slate-500">{row.email}</p>
      </TD>
      <TD>
        <Select
          id={`role-${row.id}`}
          aria-label={`Role for ${row.email}`}
          value={row.role as InternalRole}
          onChange={(value) => onChangeRole(value as InternalRole)}
          options={ROLE_OPTIONS}
          disabled={busy}
        />
      </TD>
      <TD>
        <Badge tone={row.isActive ? "emerald" : "neutral"}>
          {row.isActive ? "Active" : "Disabled"}
        </Badge>
      </TD>
      <TD className="text-xs text-slate-500">
        {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "Never"}
      </TD>
      <TD align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            onClick={onReset}
            disabled={busy || !row.isActive}
          >
            Reset credentials
          </button>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            onClick={onToggleActive}
            disabled={busy || isMe}
            title={isMe ? "You cannot deactivate your own account" : undefined}
          >
            {row.isActive ? "Disable" : "Enable"}
          </button>
        </div>
      </TD>
    </TR>
  );
}

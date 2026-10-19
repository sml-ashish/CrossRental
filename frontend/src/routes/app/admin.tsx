import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Field, Section, Select, TextInput } from "@/components/ui/form";
import { useAuth } from "@/lib/auth";
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
] as const;

function CounterCard({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <>
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-sm text-slate-600">{label}</p>
      {hint && value > 0 ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </>
  );
}

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
  const fleetHint = "The SML fleet screen arrives in P1; count only for now.";

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Admin</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The day's exceptions and the SML staff who operate the portal.
        </p>
      </header>

      {dashboard.error ? (
        <Alert tone="error">{(dashboard.error as Error).message}</Alert>
      ) : null}

      <Section title="Attention">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            to="/app/approvals"
            className="card block p-4 transition-colors hover:border-brand-300"
          >
            <CounterCard
              value={counts?.awaitingApproval ?? 0}
              label="Registrations awaiting approval"
            />
          </Link>

          <Link
            to="/app/rfqs"
            search={{ delivery: "FAILED" }}
            className="card block p-4 transition-colors hover:border-brand-300"
          >
            <CounterCard
              value={counts?.rfqsWithFailures ?? 0}
              label="RFQs with email delivery failures"
            />
          </Link>

          <div className="card p-4">
            <CounterCard
              value={counts?.cranesStale ?? 0}
              label={`Cranes stale (${staleFlagDays}+ days)`}
              hint={fleetHint}
            />
          </div>
          <div className="card p-4">
            <CounterCard
              value={counts?.cranesUnverified ?? 0}
              label="Cranes with no map location"
              hint={fleetHint}
            />
          </div>
          <div className="card p-4">
            <CounterCard
              value={counts?.cranesLapsed ?? 0}
              label="Engaged cranes past their release date"
              hint={fleetHint}
            />
          </div>
        </div>
      </Section>

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
    <Section title="SML users">
      <p className="mb-4 text-sm text-slate-500">
        Internal accounts sign in with a one-time code sent to their email — there
        is no password. Deactivating an account ends its sessions immediately.
      </p>

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

      <div className="mt-5 overflow-x-auto">
        {users.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading users
          </div>
        ) : users.error ? (
          <Alert tone="error">{(users.error as Error).message}</Alert>
        ) : (
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2.5 pr-4 font-medium">User</th>
                <th className="py-2.5 pr-4 font-medium">Role</th>
                <th className="py-2.5 pr-4 font-medium">Status</th>
                <th className="py-2.5 pr-4 font-medium">Last sign-in</th>
                <th className="py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
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
            </tbody>
          </table>
        )}
      </div>
    </Section>
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
    <tr className="align-middle">
      <td className="py-3 pr-4">
        <p className="font-medium text-slate-900">{row.fullName ?? "—"}</p>
        <p className="text-xs text-slate-500">{row.email}</p>
      </td>
      <td className="py-3 pr-4">
        <Select
          id={`role-${row.id}`}
          aria-label={`Role for ${row.email}`}
          value={row.role as InternalRole}
          onChange={(value) => onChangeRole(value as InternalRole)}
          options={ROLE_OPTIONS}
          disabled={busy}
        />
      </td>
      <td className="py-3 pr-4">
        <Badge tone={row.isActive ? "emerald" : "neutral"}>
          {row.isActive ? "Active" : "Disabled"}
        </Badge>
      </td>
      <td className="py-3 pr-4 text-xs text-slate-500">
        {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "Never"}
      </td>
      <td className="py-3">
        <div className="flex flex-wrap gap-2">
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
      </td>
    </tr>
  );
}

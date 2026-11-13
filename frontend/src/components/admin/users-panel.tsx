import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, UserCheck, UserX } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, Select, TextInput } from "@/components/ui/form";
import { relativeTime, useNow } from "@/components/admin/hooks";
import type { AdminUser, InternalRole } from "@/lib/admin";
import { createAdminUser, resetUserCredentials, updateAdminUser } from "@/lib/admin";

/**
 * Staff accounts (P0 B2).
 *
 * The portal has no passwords: a new account receives a one-time code. That is
 * why "Reset credentials" re-sends a code instead of opening a password form,
 * and why a disabled account cannot be reset at all.
 *
 * The list is the source of the team snapshot above it, so every successful
 * create/update invalidates the one `["admin", "users"]` query and both views
 * move together. Reset sends mail and changes nothing here, so it does not
 * invalidate.
 */

const ROLE_OPTIONS = [
  { value: "admin_user", label: "Admin" },
  { value: "sales_user", label: "Sales (CR team)" },
  { value: "management_viewer", label: "Management Viewer" },
] as const;

const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLE_OPTIONS.map((option) => [option.value, option.label]),
);

function UsersTableSkeleton() {
  return (
    <div className="divide-y divide-ink-800" aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-2.5 w-48 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-36 md:block" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="hidden h-3 w-24 lg:block" />
          <Skeleton className="h-7 w-32" />
        </div>
      ))}
    </div>
  );
}

export function UsersPanel({
  users,
  loading,
  error,
  meId,
}: {
  users: AdminUser[] | undefined;
  loading: boolean;
  error?: Error | null;
  meId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const now = useNow();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<InternalRole>("sales_user");
  const [notice, setNotice] = useState<string | null>(null);

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
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { role?: InternalRole; isActive?: boolean };
    }) => updateAdminUser(id, input),
    onSuccess: () => {
      setNotice("User updated.");
      void refresh();
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => resetUserCredentials(id),
    onSuccess: () => setNotice("A new sign-in credential has been emailed."),
  });

  const busy = update.isPending || reset.isPending;

  return (
    <Panel
      title="SML users"
      description="Internal accounts sign in with a one-time code sent to their email — there is no password. Deactivating an account ends its sessions immediately."
      actions={
        <Badge tone="neutral">
          <span className="tabular-nums">{users?.length ?? 0}</span> accounts
        </Badge>
      }
      bodyClassName="p-0"
    >
      <div className="space-y-3 p-4">
        {notice ? (
          <Alert tone="success">{notice}</Alert>
        ) : null}
        {create.isError ? (
          <Alert tone="error">{(create.error as Error).message}</Alert>
        ) : null}
        {update.isError ? (
          <Alert tone="error">{(update.error as Error).message}</Alert>
        ) : null}
        {reset.isError ? (
          <Alert tone="error">{(reset.error as Error).message}</Alert>
        ) : null}

        <form
          className="rounded-xl border border-ink-800 bg-ink-900 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_auto]">
            <Field label="Email" htmlFor="admin-user-email" required>
              <TextInput
                id="admin-user-email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="name@sml.com"
                autoComplete="email"
              />
            </Field>
            <Field label="Full name" htmlFor="admin-user-name">
              <TextInput
                id="admin-user-name"
                value={fullName}
                onChange={setFullName}
                placeholder="Optional"
                autoComplete="name"
              />
            </Field>
            <Field label="Role" htmlFor="admin-user-role">
              <Select
                id="admin-user-role"
                value={role}
                onChange={(value) => setRole(value as InternalRole)}
                options={ROLE_OPTIONS}
              />
            </Field>
            <button
              type="submit"
              className="btn-primary py-2 text-[13px] md:col-span-2 xl:col-span-1"
              disabled={create.isPending || !email.trim()}
            >
              <Plus className="size-4" aria-hidden />
              {create.isPending ? "Creating…" : "Create user"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Email is required. The person receives a one-time code; no password is created.
          </p>
        </form>
      </div>

      <div className="border-t border-ink-800">
        {loading ? (
          <UsersTableSkeleton />
        ) : error ? (
          <div className="p-4">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : (
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
              {(users ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm text-slate-500">
                    No staff accounts yet. Create the first one above.
                  </td>
                </tr>
              ) : (
                (users ?? []).map((row) => (
                  <UserRow
                    key={row.id}
                    row={row}
                    now={now}
                    isMe={row.id === meId}
                    busy={busy}
                    onChangeRole={(next) =>
                      update.mutate({ id: row.id, input: { role: next } })
                    }
                    onToggleActive={() =>
                      update.mutate({ id: row.id, input: { isActive: !row.isActive } })
                    }
                    onReset={() => reset.mutate(row.id)}
                  />
                ))
              )}
            </TBody>
          </Table>
        )}
      </div>
    </Panel>
  );
}

function UserRow({
  row,
  now,
  isMe,
  busy,
  onChangeRole,
  onToggleActive,
  onReset,
}: {
  row: AdminUser;
  now: number;
  isMe: boolean;
  busy: boolean;
  onChangeRole: (role: InternalRole) => void;
  onToggleActive: () => void;
  onReset: () => void;
}) {
  const signedIn = row.lastLoginAt ? new Date(row.lastLoginAt) : null;
  const disabledReason = !row.isActive
    ? "Enable the account before resetting credentials"
    : undefined;
  const selfReason = isMe ? "You cannot deactivate your own account" : undefined;

  return (
    <TR className="align-middle">
      <TD>
        <p className="text-[13px] font-medium text-white">{row.fullName ?? "—"}</p>
        <p className="font-mono text-[11px] text-slate-500">{row.email}</p>
      </TD>
      <TD>
        <Select
          id={`role-${row.id}`}
          ariaLabel={`Role for ${row.email}`}
          value={row.role as InternalRole}
          onChange={(value) => onChangeRole(value as InternalRole)}
          options={ROLE_OPTIONS}
          disabled={busy}
        />
        <span className="sr-only">Current role: {ROLE_LABELS[row.role] ?? row.role}</span>
      </TD>
      <TD>
        <StatusPill tone={row.isActive ? "emerald" : "muted"}>
          {row.isActive ? "Active" : "Disabled"}
        </StatusPill>
      </TD>
      <TD className="text-xs whitespace-nowrap text-slate-500">
        {signedIn ? (
          <span title={signedIn.toLocaleString()}>{relativeTime(signedIn.getTime(), now)}</span>
        ) : (
          "Never"
        )}
      </TD>
      <TD align="right">
        <div className="flex flex-wrap justify-end gap-2">
          <span title={disabledReason} className="inline-flex">
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-850 px-2.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-ink-700 hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onReset}
              disabled={busy || !row.isActive}
              aria-label={
                disabledReason ?? `Reset credentials for ${row.email}`
              }
            >
              <KeyRound className="size-3.5" aria-hidden />
              Reset
            </button>
          </span>

          <span title={selfReason} className="inline-flex">
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-850 px-2.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-ink-700 hover:bg-ink-800 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onToggleActive}
              disabled={busy || isMe}
              aria-label={
                selfReason ??
                `${row.isActive ? "Disable" : "Enable"} ${row.email}`
              }
            >
              {row.isActive ? (
                <UserX className="size-3.5" aria-hidden />
              ) : (
                <UserCheck className="size-3.5" aria-hidden />
              )}
              {row.isActive ? "Disable" : "Enable"}
            </button>
          </span>
        </div>
      </TD>
    </TR>
  );
}

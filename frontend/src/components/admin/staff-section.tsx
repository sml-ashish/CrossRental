import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MoreHorizontal, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Field, Select, TextInput } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/settings/parts";
import { relativeTime, useNow } from "@/components/admin/hooks";
import type { AdminUser, InternalRole } from "@/lib/admin";
import type { UserRole } from "@/lib/auth";
import { createAdminUser, resetUserCredentials, updateAdminUser } from "@/lib/admin";
import { cn } from "@/lib/cn";

/**
 * Staff accounts.
 *
 * The portal has no passwords: a new account receives a one-time code. That is
 * why "Reset sign-in" re-sends a code instead of opening a password form, and
 * why a disabled account cannot be reset at all. Every change here invalidates
 * the one `["admin", "users"]` query, so the table and its count move together.
 */

const ROLE_OPTIONS = [
  { value: "admin_user", label: "Admin" },
  { value: "sales_user", label: "Sales (CR team)" },
  { value: "management_viewer", label: "Management Viewer" },
] as const;

const SEARCH_THRESHOLD = 8;

export function StaffSection({
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

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<InternalRole>("sales_user");
  const [notice, setNotice] = useState<string | null>(null);
  const [roleSavedId, setRoleSavedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "reset" | "disable"; user: AdminUser } | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /**
   * The role the admin just picked, held until the refetched row agrees.
   * Without it the select springs back to the old value for the length of the
   * request, which reads as "my change was ignored".
   */
  const [pendingRoles, setPendingRoles] = useState<Record<string, InternalRole>>({});

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const create = useMutation({
    mutationFn: () => createAdminUser({ email: email.trim(), fullName: fullName.trim(), role }),
    onSuccess: (created) => {
      setEmail("");
      setFullName("");
      setRole("sales_user");
      setDrawerOpen(false);
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
    onSuccess: (updated, variables) => {
      void refresh();
      if (variables.input.role) {
        setRoleSavedId(variables.id);
      } else {
        setNotice(updated.isActive ? "Account enabled." : "Account disabled.");
      }
    },
    onError: (_error, variables) => {
      setPendingRoles((current) => {
        const next = { ...current };
        delete next[variables.id];
        return next;
      });
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => resetUserCredentials(id),
    onSuccess: () => setNotice("A new sign-in code has been emailed."),
  });

  const busy = update.isPending || reset.isPending;

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!roleSavedId) return;
    const id = window.setTimeout(() => setRoleSavedId(null), 2500);
    return () => window.clearTimeout(id);
  }, [roleSavedId]);

  const allUsers = users ?? [];

  useEffect(() => {
    if (!users) return;
    setPendingRoles((previous) => {
      const remaining = { ...previous };
      let changed = false;
      for (const [id, role] of Object.entries(previous)) {
        if (users.find((user) => user.id === id)?.role === role) {
          delete remaining[id];
          changed = true;
        }
      }
      return changed ? remaining : previous;
    });
  }, [users]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allUsers;
    return allUsers.filter(
      (user) =>
        (user.fullName ?? "").toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query),
    );
  }, [allUsers, search]);

  function openDrawer() {
    create.reset();
    setDrawerOpen(true);
  }

  function confirmAction() {
    if (!confirm) return;
    if (confirm.kind === "reset") {
      reset.mutate(confirm.user.id);
    } else {
      update.mutate({ id: confirm.user.id, input: { isActive: false } });
    }
    setConfirm(null);
  }

  const updateError = update.error as Error | null;
  const resetError = reset.error as Error | null;
  const createError = create.error as Error | null;

  return (
    <section id="sml-users" className="scroll-mt-20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-[16px] leading-6 font-semibold text-slate-900">
          Staff
          {users ? (
            <span className="ml-2 text-[13px] font-normal tabular-nums text-slate-500">
              {users.length}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          className="btn-secondary h-9 px-3 py-0 text-[13px]"
          onClick={openDrawer}
        >
          Add user
        </button>
      </div>

      <div className="mt-4 border-t border-ink-800 pt-4">
        {notice ? (
          <p
            role="status"
            aria-live="polite"
            className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-slate-500"
          >
            <Check className="size-3.5" aria-hidden />
            {notice}
          </p>
        ) : null}

        {updateError ? (
          <div className="mb-3">
            <Alert tone="error">{updateError.message}</Alert>
          </div>
        ) : null}
        {resetError ? (
          <div className="mb-3">
            <Alert tone="error">{resetError.message}</Alert>
          </div>
        ) : null}

        {(users?.length ?? 0) > SEARCH_THRESHOLD ? (
          <div className="mb-4 max-w-xs">
            <label htmlFor="staff-search" className="sr-only">
              Search staff
            </label>
            <TextInput
              id="staff-search"
              value={search}
              onChange={setSearch}
              placeholder="Search staff"
              className="h-9 py-0"
            />
          </div>
        ) : null}

        {loading ? (
          <StaffSkeleton />
        ) : error ? (
          <Alert tone="error">{error.message}</Alert>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1fr)_132px_80px_36px] gap-x-2 border-b border-ink-800 py-2 text-[12px] text-slate-500 sm:grid">
              <span>Name</span>
              <span>Role</span>
              <span>Last sign-in</span>
              <span className="sr-only">Actions</span>
            </div>

            {filtered.length === 0 ? (
              <p className="py-10 text-center text-[14px] text-slate-500">
                {allUsers.length === 0
                  ? "No staff accounts yet. Add the first one."
                  : `No one matches “${search.trim()}”.`}
              </p>
            ) : (
              <ul className="divide-y divide-ink-800">
                {filtered.map((row) => {
                  const isMe = row.id === meId;
                  const displayName =
                    row.fullName?.trim() || row.email.split("@")[0] || row.email;

                  return (
                    <li
                      key={row.id}
                      className={cn(
                        "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-1.5",
                        "sm:grid-cols-[minmax(0,1fr)_132px_80px_36px]",
                        !row.isActive && "opacity-60",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[14px] leading-5 font-medium text-slate-900">
                          {displayName}
                        </p>
                        <p
                          className="mt-0.5 truncate text-[13px] leading-5 text-slate-500"
                          title={row.email}
                        >
                          {row.email}
                        </p>
                      </div>

                      <div className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:contents">
                        <RoleControl
                          row={row}
                          value={pendingRoles[row.id] ?? row.role}
                          busy={busy}
                          saved={roleSavedId === row.id}
                          onChange={(next) => {
                            setPendingRoles((current) => ({ ...current, [row.id]: next }));
                            update.mutate({ id: row.id, input: { role: next } });
                          }}
                        />
                        <SignInCell row={row} now={now} />
                      </div>

                      <div className="col-start-2 row-span-2 row-start-1 self-center justify-self-end sm:col-start-4 sm:row-span-1">
                        <RowMenu
                          row={row}
                          isMe={isMe}
                          busy={busy}
                          open={openMenuId === row.id}
                          onOpenChange={(open) =>
                            setOpenMenuId(open ? row.id : openMenuId === row.id ? null : openMenuId)
                          }
                          onReset={() => setConfirm({ kind: "reset", user: row })}
                          onDisable={() => setConfirm({ kind: "disable", user: row })}
                          onEnable={() =>
                            update.mutate({ id: row.id, input: { isActive: true } })
                          }
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <p className="mt-4 text-[13px] leading-5 text-slate-500">
          Staff sign in with a one-time code sent to their email. Disabling an account ends its
          sessions immediately.
        </p>
      </div>

      <AddUserDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        email={email}
        fullName={fullName}
        role={role}
        onEmailChange={setEmail}
        onFullNameChange={setFullName}
        onRoleChange={setRole}
        pending={create.isPending}
        error={createError}
        onSubmit={() => create.mutate()}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "reset" ? "Send a new sign-in code?" : "Disable this account?"}
        confirmLabel={confirm?.kind === "reset" ? "Send code" : "Disable account"}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmAction}
      >
        {confirm
          ? confirm.kind === "reset"
            ? `${confirm.user.email} will receive a new one-time code. Their current session stays signed in.`
            : `${confirm.user.email} will be signed out immediately and cannot sign in until re-enabled.`
          : null}
      </ConfirmDialog>
    </section>
  );
}

function RoleControl({
  row,
  value,
  busy,
  saved,
  onChange,
}: {
  row: AdminUser;
  value: UserRole;
  busy: boolean;
  saved: boolean;
  onChange: (role: InternalRole) => void;
}) {
  const known = ROLE_OPTIONS.some((option) => option.value === value);

  return (
    <div className="group/role relative inline-flex items-center justify-self-start sm:col-start-2 sm:row-start-1">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as InternalRole)}
        disabled={busy}
        aria-label={`Role for ${row.email}`}
        className="peer -ml-2 h-9 max-w-[132px] cursor-pointer appearance-none rounded-md border border-transparent bg-transparent py-0 pr-6 pl-2 text-[12px] text-slate-600 transition-colors hover:border-ink-800 hover:bg-ink-850 hover:text-white focus:border-ink-700 focus:bg-ink-850 focus:text-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {!known ? (
          <option value={value} disabled>
            {value.replace(/_/g, " ")}
          </option>
        ) : null}
        {ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-1.5 size-3.5 text-slate-500 opacity-0 transition-opacity group-hover/role:opacity-100 peer-focus:opacity-100"
        aria-hidden
      />
      {saved ? <span className="ml-2 text-[12px] text-slate-500">Saved</span> : null}
    </div>
  );
}

function SignInCell({ row, now }: { row: AdminUser; now: number }) {
  const signedIn = row.lastLoginAt ? new Date(row.lastLoginAt) : null;
  const valid = signedIn !== null && !Number.isNaN(signedIn.getTime());

  return (
    <div className="sm:col-start-3 sm:row-start-1">
      {!row.isActive ? (
        <span className="text-[12px] text-slate-500">Disabled</span>
      ) : signedIn && valid ? (
        <time
          dateTime={signedIn.toISOString()}
          title={signedIn.toLocaleString()}
          className="text-[12px] whitespace-nowrap text-slate-500 tabular-nums"
        >
          {relativeTime(signedIn.getTime(), now)}
        </time>
      ) : (
        <span className="text-[12px] whitespace-nowrap text-slate-500">Never signed in</span>
      )}
    </div>
  );
}

function RowMenu({
  row,
  isMe,
  busy,
  open,
  onOpenChange,
  onReset,
  onDisable,
  onEnable,
}: {
  row: AdminUser;
  isMe: boolean;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
  onDisable: () => void;
  onEnable: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    first?.focus();
  }, [open]);

  function close(returnFocus = true) {
    onOpenChange(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  }

  const resetDisabled = busy || !row.isActive;
  const resetReason = !row.isActive ? "Enable the account before resetting sign-in" : undefined;
  const disableDisabled = busy || isMe;
  const disableReason = isMe ? "You cannot disable your own account" : undefined;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${row.email}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition-colors",
          "hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
          open && "bg-ink-850 text-white",
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            className="fixed inset-0 z-[60] cursor-default"
            onClick={() => close(false)}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${row.email}`}
            onKeyDown={onMenuKeyDown}
            className="absolute top-full right-0 z-[70] mt-1 w-48 rounded-lg border border-ink-800 bg-ink-900 p-1 shadow-xl"
          >
            <MenuAction
              label="Reset sign-in"
              disabled={resetDisabled}
              reason={resetReason}
              onSelect={() => {
                close();
                onReset();
              }}
            />
            <MenuAction
              label={row.isActive ? "Disable account" : "Enable account"}
              disabled={row.isActive ? disableDisabled : busy}
              reason={row.isActive ? disableReason : undefined}
              onSelect={() => {
                close();
                if (row.isActive) onDisable();
                else onEnable();
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuAction({
  label,
  disabled,
  reason,
  onSelect,
}: {
  label: string;
  disabled: boolean;
  reason?: string;
  onSelect: () => void;
}) {
  return (
    <span className="block" title={reason}>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
          disabled
            ? "cursor-not-allowed text-slate-500 opacity-50"
            : "text-slate-600 hover:bg-ink-850 hover:text-white",
        )}
      >
        {label}
      </button>
    </span>
  );
}

function StaffSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-ink-800 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_132px_80px_36px]"
        >
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
          <Skeleton className="hidden h-3.5 w-24 sm:block" />
          <Skeleton className="hidden h-3.5 w-28 sm:block" />
          <Skeleton className="size-9 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function AddUserDrawer({
  open,
  onClose,
  email,
  fullName,
  role,
  onEmailChange,
  onFullNameChange,
  onRoleChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
  fullName: string;
  role: InternalRole;
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onRoleChange: (value: InternalRole) => void;
  pending: boolean;
  error: Error | null;
  onSubmit: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    panel?.querySelector<HTMLInputElement>("#admin-user-email")?.focus();

    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-user-title"
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-ink-800 bg-ink-900 shadow-2xl",
          "max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[88vh] max-sm:max-w-none max-sm:rounded-t-2xl max-sm:border-t max-sm:border-l-0",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-6 py-4">
          <h2 id="add-user-title" className="text-[16px] leading-6 font-semibold text-slate-900">
            Add user
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add user"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {error ? <Alert tone="error">{error.message}</Alert> : null}

            <Field label="Email" htmlFor="admin-user-email" required>
              <TextInput
                id="admin-user-email"
                type="email"
                value={email}
                onChange={onEmailChange}
                placeholder="name@sml.com"
                autoComplete="email"
              />
            </Field>

            <Field label="Full name" htmlFor="admin-user-name">
              <TextInput
                id="admin-user-name"
                value={fullName}
                onChange={onFullNameChange}
                placeholder="Optional"
                autoComplete="name"
              />
            </Field>

            <Field label="Role" htmlFor="admin-user-role">
              <Select
                id="admin-user-role"
                value={role}
                onChange={(value) => {
                  if (value) onRoleChange(value as InternalRole);
                }}
                options={ROLE_OPTIONS}
              />
            </Field>

            <p className="text-[13px] leading-5 text-slate-500">
              They&rsquo;ll receive a one-time sign-in code. No password is created.
            </p>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-800 px-6 py-4">
            <button
              type="button"
              className="btn-secondary h-9 px-3 py-0 text-[13px]"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary h-9 px-3.5 py-0 text-[13px]"
              disabled={pending || !email.trim()}
            >
              {pending ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

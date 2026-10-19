import { api } from "@/lib/api";
import type { UserRole } from "@/lib/auth";

/**
 * Admin-only surface (P0 B).
 *
 * The dashboard counters each link to the list that filters the same way; staff
 * management creates and disables the internal accounts; a vendor is suspended
 * from their detail screen. Every call here is admin-gated on the server.
 */

export interface AdminDashboardCounts {
  awaitingApproval: number;
  rfqsWithFailures: number;
  cranesStale: number;
  cranesUnverified: number;
  cranesLapsed: number;
}

export interface AdminDashboard {
  counts: AdminDashboardCounts;
  thresholds: { staleFlagDays: number };
}

export type InternalRole = Extract<UserRole, "admin_user" | "sales_user">;

export interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export async function loadAdminDashboard(): Promise<AdminDashboard> {
  const res = await api<{ dashboard: AdminDashboard }>("/admin/dashboard");
  return res.dashboard;
}

export async function loadAdminUsers(): Promise<AdminUser[]> {
  const res = await api<{ users: AdminUser[] }>("/admin/users");
  return res.users;
}

export async function createAdminUser(input: {
  email: string;
  fullName?: string;
  role: InternalRole;
}): Promise<AdminUser> {
  const res = await api<{ user: AdminUser }>("/admin/users", {
    method: "POST",
    body: input,
  });
  return res.user;
}

export async function updateAdminUser(
  id: string,
  input: { role?: InternalRole; isActive?: boolean },
): Promise<AdminUser> {
  const res = await api<{ user: AdminUser }>(`/admin/users/${id}`, {
    method: "PATCH",
    body: input,
  });
  return res.user;
}

export async function resetUserCredentials(id: string): Promise<void> {
  await api<{ ok: true }>(`/admin/users/${id}/reset-credentials`, {
    method: "POST",
    body: {},
  });
}

export interface SuspendedVendor {
  id: string;
  name: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
}

export async function suspendVendor(id: string, reason?: string): Promise<SuspendedVendor> {
  const res = await api<{ vendor: SuspendedVendor }>(`/admin/vendors/${id}/suspend`, {
    method: "POST",
    body: { reason: reason ?? null },
  });
  return res.vendor;
}

export async function reinstateVendor(id: string): Promise<SuspendedVendor> {
  const res = await api<{ vendor: SuspendedVendor }>(`/admin/vendors/${id}/reinstate`, {
    method: "POST",
    body: {},
  });
  return res.vendor;
}

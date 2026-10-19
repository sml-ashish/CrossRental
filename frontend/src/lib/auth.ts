/**
 * Session shape and role rules.
 *
 * Kept free of any API or storage import so this module can be imported by
 * components that only need to know "who is this and where do they go".
 */

import { createContext, use } from "react";

export type UserRole = "vendor_user" | "sales_user" | "admin_user";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  vendorId: string | null;
  vendorName?: string;
  capabilities?: string[];
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/** Where each role lands after signing in. Mirrors the backend's RBAC map. */
export const ROLE_HOME: Record<UserRole, string> = {
  vendor_user: "/app/dashboard",
  sales_user: "/app/rfqs",
  admin_user: "/app/approvals",
};

export function isVendor(role: UserRole | undefined): boolean {
  return role === "vendor_user";
}

export function isInternal(role: UserRole | undefined): boolean {
  return role === "sales_user" || role === "admin_user";
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case "admin_user":
      return "Administrator";
    case "sales_user":
      return "SML Sales";
    default:
      return "Vendor";
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  /** False until a stored token has been checked against the backend. */
  isLoading: boolean;
  login(email: string, password: string): Promise<AuthUser>;
  loginWithOtp(email: string, code: string): Promise<AuthUser>;
  logout(): void;
  setSession(auth: AuthResponse): void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
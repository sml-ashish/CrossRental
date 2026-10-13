import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Alert } from "@/components/ui/alert";
import { FullPageSpinner } from "@/components/ui/spinner";
import { ROLE_HOME, useAuth, type UserRole } from "@/lib/auth";

/**
 * Guards a route on authentication and on role.
 *
 * Two rules this follows deliberately:
 *
 * 1. While the stored token is still being checked, nothing is rendered. A
 *    flash of the signed-out screen then the portal — or the reverse — reads as
 *    a bug and, on a shared device, briefly exposes the wrong shell.
 * 2. A signed-in user who lands on a route for the wrong role is sent to their
 *    own home rather than shown a 403. They did nothing wrong; the link was
 *    simply not theirs to follow.
 *
 * Neither is a security control. The backend is.
 */
export function RequireAuth({
  roles,
  children,
}: {
  roles?: UserRole[];
  children: ReactNode;
}) {
  const { user, isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  if (isLoading) return <FullPageSpinner label="Checking your session" />;

  if (!isAuthenticated || !user) {
    // Replace rather than push: the sign-in screen should not become a step
    // someone has to go back through.
    void navigate({ to: "/auth/login", replace: true });
    return <FullPageSpinner label="Redirecting to sign in" />;
  }

  if (roles && !roles.includes(user.role)) {
    void navigate({ to: ROLE_HOME[user.role], replace: true });
    return <FullPageSpinner label="Redirecting" />;
  }

  return <>{children}</>;
}

/** Keeps a signed-in user away from the sign-in screens. */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { user, isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  if (isLoading) return <FullPageSpinner />;

  if (isAuthenticated && user) {
    void navigate({ to: ROLE_HOME[user.role], replace: true });
    return <FullPageSpinner label="Redirecting" />;
  }

  return <>{children}</>;
}

/** Shown when the backend refuses something the UI thought was allowed. */
export function ForbiddenNotice({ children }: { children?: ReactNode }) {
  const { logout } = useAuth();
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <Alert title="You do not have access to this">
        {children ?? "Your account is not permitted to view this page."}
      </Alert>
      <button type="button" onClick={logout} className="btn-secondary mt-4">
        Sign in with a different account
      </button>
    </div>
  );
}
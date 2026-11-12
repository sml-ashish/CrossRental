import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AuthLayout } from "@/components/auth-layout";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import { completeSso } from "@/lib/sso";

/**
 * P5 SSO callback. The provider redirects here with `code` and `state`; the
 * component posts them to the backend and stores the returned session. The
 * token never appears in the URL.
 */
export function SsoCallbackPage() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (!code || !state) {
      setError("The sign-in response is incomplete. Please try again.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const auth = await completeSso(code, state);
        if (cancelled) return;
        setSession(auth);
        await navigate({ to: ROLE_HOME[auth.user.role] });
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Single sign-on could not be completed. Please use the email code instead.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, setSession]);

  return (
    <AuthLayout>
      <div className="card w-full max-w-sm p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Signing you in</h1>
        {error ? (
          <div className="mt-4 text-left">
            <Alert>{error}</Alert>
            <a href="/auth/otp" className="btn-secondary mt-4 w-full">
              Use a sign-in code instead
            </a>
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center gap-2 text-sm text-slate-500">
            <Spinner /> Verifying with your organisation
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

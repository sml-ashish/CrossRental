import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

/**
 * Password reset from an emailed link.
 *
 * Like activation, the token arrives in the fragment so it never reaches the
 * backend in a referrer header or an access log.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token] = useState(() => readFragmentToken());
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: { token, password },
        anonymous: true,
      });
      await navigate({ to: "/auth/login" });
    } catch (cause) {
      setError(cause instanceof ApiError ? (cause.fieldError("password") ?? cause.message) : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <div className="card w-full max-w-sm p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Reset link invalid</h1>
          <p className="mt-2 text-sm text-slate-500">
            This link is missing its reset code. Request a new one from the sign-in screen.
          </p>
          <Link to="/auth/login" className="btn-secondary mt-5 w-full">
            Back to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-slate-900">Set a new password</h1>

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}

          <div>
            <label className="field-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="confirm-password">
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              className="field-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={submitting || !password}>
            {submitting ? <Spinner /> : null}
            Save new password
          </button>
        </form>
      </div>
    </AuthLayout>
  );
}

function readFragmentToken(): string {
  const match = window.location.hash.match(/token=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
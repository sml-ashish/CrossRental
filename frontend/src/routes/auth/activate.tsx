import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api, ApiError } from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

/**
 * First-use password set, reached from the activation link SML emails on
 * approval. The emailed token is the only credential at this point, so it is
 * kept in the URL fragment — fragments are not sent to servers or written to
 * access logs.
 */
export function ActivatePage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { token?: string };

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Prefer the query parameter; fall back to the fragment. Both are resolved
  // once, up front, so the value submitted can never diverge from the one the
  // screen validated as present.
  const activationToken = search.token ?? readFragmentToken();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await api("/auth/activate", {
        method: "POST",
        body: { token: activationToken, password },
        anonymous: true,
      });
      await navigate({ to: "/auth/login" });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.fieldError("password") ?? cause.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!activationToken) {
    return (
      <AuthLayout>
        <div className="card w-full max-w-sm p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Activation link invalid</h1>
          <p className="mt-2 text-sm text-slate-500">
            This link is missing its activation code. Open the most recent email from SML, or ask
            your SML contact to resend it.
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
        <h1 className="text-lg font-semibold text-slate-900">Choose a password</h1>
        <p className="mt-1 text-sm text-slate-500">
          This sets the password for your vendor account. You will use it from now on.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}

          <div>
            <label className="field-label" htmlFor="password">
              New password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="confirm">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              className="field-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={submitting || password.length === 0}
          >
            {submitting ? <Spinner /> : null}
            Activate account
          </button>
        </form>
      </div>
    </AuthLayout>
  );
}

/** Reads #token=... without ever putting it into a request or a log line. */
function readFragmentToken(): string {
  const match = window.location.hash.match(/token=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
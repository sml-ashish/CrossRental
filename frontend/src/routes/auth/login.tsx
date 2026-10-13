import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ROLE_HOME, useAuth } from "@/lib/auth";

/**
 * Vendor sign-in: email + password.
 *
 * The backend returns the same generic error for an unknown address and a wrong
 * password, so this screen must not try to distinguish them either. The three
 * codes that *are* safe to show — NOT_ACTIVATED, VENDOR_NOT_APPROVED,
 * ACCOUNT_DEACTIVATED — are actionable for the person signing in.
 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      const user = await login(email, password);
      await navigate({ to: ROLE_HOME[user.role] });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        if (cause.code === "NOT_ACTIVATED") {
          setNotice("Check your inbox for the activation link SML sent when your vendor was approved.");
        }
        if (cause.code === "VENDOR_NOT_APPROVED") {
          setNotice("Your registration is still being reviewed. You will receive an email once it is approved.");
        }
        if (cause.code === "RATE_LIMITED") {
          setNotice("Too many attempts. Please wait a few minutes and try again.");
        }
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onForgotPassword() {
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ message: string }>("/auth/forgot-password", {
        method: "POST",
        body: { email },
        anonymous: true,
      });
      // Always the same sentence, whether or not the address is registered.
      setNotice(res.message);
    } catch {
      setNotice("If that email address belongs to a vendor account, a password reset link has been sent.");
    }
  }

  return (
    <AuthLayout>
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">
          Use the email address your vendor registration was approved against.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {notice ? <Alert tone="info">{notice}</Alert> : null}

          <div>
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="field-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            Sign in
          </button>

          <button
            type="button"
            onClick={onForgotPassword}
            className="w-full text-center text-sm text-brand-600 hover:text-brand-700"
            disabled={submitting || email.trim().length === 0}
          >
            Forgot your password?
          </button>
        </form>

        {/*
          Internal SML accounts have no password and sign in with an emailed
          code. Without this link they have no way to get there from here, and
          would only ever see the deliberately generic "Invalid email or
          password" — which looks like a bad credential rather than the wrong
          sign-in method.
        */}
        <p className="mt-5 border-t border-slate-200 pt-4 text-center text-sm text-slate-500">
          SML staff?{" "}
          <Link to="/auth/otp" className="font-medium text-brand-600 hover:text-brand-700">
            Sign in with an emailed code
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
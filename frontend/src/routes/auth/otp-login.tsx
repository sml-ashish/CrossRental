import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "@/lib/api";
import { AuthLayout } from "@/components/auth-layout";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import { loadSsoStatus, startSso } from "@/lib/sso";

type Stage = "email" | "code";

/**
 * Internal (sales / admin) sign-in: email, then a 6-digit code.
 *
 * Two screens in one component because the two steps are one task and the
 * backend is the only thing that decides whether the address belongs to an
 * internal account — it answers the same way either way, so this screen shows
 * the same "check your inbox" line regardless.
 */
export function OtpLoginPage() {
  const { loginWithOtp } = useAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoStarting, setSsoStarting] = useState(false);

  const sso = useQuery({
    queryKey: ["sso-status"],
    queryFn: loadSsoStatus,
    staleTime: 5 * 60 * 1000,
  });

  async function onSso() {
    setSsoError(null);
    setSsoStarting(true);
    try {
      window.location.assign(await startSso());
    } catch (cause) {
      setSsoError(
        cause instanceof ApiError ? cause.message : "Single sign-on is unavailable right now.",
      );
      setSsoStarting(false);
    }
  }

  async function onRequestCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api<{ message: string; devCode?: string }>("/auth/otp/request", {
        method: "POST",
        body: { email },
        anonymous: true,
      });
      setMessage(res.message);
      setDevCode(res.devCode ?? null);
      setStage("code");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await loginWithOtp(email, code);
      await navigate({ to: ROLE_HOME[user.role] });
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <div className="card w-full max-w-sm p-6">
        {sso.data?.enabled ? (
          <>
            <button
              type="button"
              className="btn-secondary w-full"
              disabled={ssoStarting}
              onClick={() => void onSso()}
            >
              {ssoStarting ? <Spinner /> : null}
              Sign in with Microsoft
            </button>
            <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              or
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            {ssoError ? <Alert>{ssoError}</Alert> : null}
          </>
        ) : null}

        <h1 className="text-lg font-semibold text-slate-900">SML staff sign-in</h1>
        <p className="mt-1 text-sm text-slate-500">
          {stage === "email"
            ? "We will email you a one-time sign-in code."
            : "Enter the 6-digit code we emailed you."}
        </p>

        {stage === "email" ? (
          <form onSubmit={onRequestCode} className="mt-5 space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}

            <div>
              <label className="field-label" htmlFor="otp-email">
                Work email
              </label>
              <input
                id="otp-email"
                type="email"
                autoComplete="username"
                required
                className="field-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? <Spinner /> : null}
              Send code
            </button>
          </form>
        ) : (
          <form onSubmit={onVerify} className="mt-5 space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            {message ? <Alert tone="info">{message}</Alert> : null}

            <div>
              <label className="field-label" htmlFor="otp-email-locked">
                Work email
              </label>
              <input
                id="otp-email-locked"
                type="email"
                className="field-input"
                value={email}
                readOnly
                disabled
              />
              {devCode ? (
                <p className="mt-1.5 text-xs text-slate-500">
                  UAT sign-in code:{" "}
                  <span className="font-mono font-semibold tracking-[0.2em] text-slate-800">
                    {devCode}
                  </span>
                </p>
              ) : null}
            </div>

            <div>
              <label className="field-label" htmlFor="otp-code">
                Sign-in code
              </label>
              <input
                id="otp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                className="field-input text-center text-lg tracking-[0.3em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <p className="mt-1.5 text-xs text-slate-400">Valid for 10 minutes.</p>
            </div>

            <button type="submit" className="btn-primary w-full" disabled={submitting || code.length !== 6}>
              {submitting ? <Spinner /> : null}
              Verify and sign in
            </button>

            <button
              type="button"
              onClick={() => {
                setStage("email");
                setCode("");
                setDevCode(null);
                setError(null);
                setMessage(null);
              }}
              className="w-full text-center text-sm text-slate-500 hover:text-slate-700"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
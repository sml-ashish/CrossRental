import { api } from "@/lib/api";
import type { AuthResponse } from "@/lib/auth";

/**
 * P5 SSO client. The backend decides whether a provider is configured; this
 * module only asks and then follows the authorization URL it returns.
 */

export interface SsoStatus {
  enabled: boolean;
  provider: "entra" | null;
  authorizationEndpoint: string | null;
}

export async function loadSsoStatus(): Promise<SsoStatus> {
  const res = await api<{ sso: SsoStatus }>("/auth/sso/status", { anonymous: true });
  return res.sso;
}

export async function startSso(): Promise<string> {
  const res = await api<{ authorizationUrl: string }>("/auth/sso/start", {
    anonymous: true,
  });
  return res.authorizationUrl;
}

export async function completeSso(
  code: string,
  state: string,
): Promise<AuthResponse> {
  return api<AuthResponse>("/auth/sso/callback", {
    method: "POST",
    body: { code, state },
    anonymous: true,
  });
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * OAuth2 for the shared mailbox's IMAP login.
 *
 * Microsoft 365 blocks basic IMAP logins on most tenants ("Login is disabled"),
 * so the poller authenticates with an OAuth2 access token when an Entra app is
 * configured. A device-code sign-in is done once by `npm run imap:token`; the
 * refresh token it produces is exchanged for an access token on every poll.
 *
 * No client secret is used: the Entra registration is a public client with
 * delegated IMAP.AccessAsUser.All + offline_access permissions.
 */

export const IMAP_SCOPE = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All";

export interface ImapOAuthConfig {
  clientId: string | null;
  tenantId: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  tokenFile: string | null;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export function oauthConfigured(config: ImapOAuthConfig): boolean {
  return Boolean(
    config.clientId &&
      config.tenantId &&
      (config.accessToken || config.refreshToken || config.tokenFile),
  );
}

function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function deviceCodeEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`;
}

async function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    throw new Error(`Token endpoint returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const error = body as TokenResponse;
    throw new Error(
      `Token endpoint ${response.status}: ${error.error ?? "request failed"} — ${error.error_description ?? text.slice(0, 200)}`,
    );
  }
  return body;
}

/** Step 1 of the one-time device-code sign-in. */
export async function beginDeviceCode(
  clientId: string,
  tenantId: string,
): Promise<DeviceCode> {
  const device = await postForm<DeviceCode>(deviceCodeEndpoint(tenantId), {
    client_id: clientId,
    scope: IMAP_SCOPE,
  });
  if (!device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error(`Unexpected device-code response: ${JSON.stringify(device)}`);
  }
  return device;
}

/** Step 2: wait for the user to approve, then return the token response. */
export async function completeDeviceCode(
  clientId: string,
  tenantId: string,
  device: DeviceCode,
  onPending?: (message: string) => void,
): Promise<TokenResponse> {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(device.interval || 5, 5);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    try {
      return await postForm<TokenResponse>(tokenEndpoint(tenantId), {
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("authorization_pending")) {
        onPending?.("Waiting for sign-in...");
        continue;
      }
      if (message.includes("slow_down")) {
        interval += 5;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Device-code sign-in expired before it was approved.");
}

async function readTokenFile(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { refresh_token?: string };
    return parsed.refresh_token ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTokenFile(path: string, refreshToken: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ refresh_token: refreshToken, obtainedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Returns a valid IMAP access token, refreshing it when needed. */
export async function getImapAccessToken(config: ImapOAuthConfig): Promise<string | null> {
  if (config.accessToken) return config.accessToken;
  if (!oauthConfigured(config)) return null;

  let refreshToken = config.refreshToken;
  if (config.tokenFile) {
    refreshToken = (await readTokenFile(config.tokenFile)) ?? refreshToken;
  }
  if (!refreshToken || !config.clientId || !config.tenantId) return null;

  const tokens = await postForm<TokenResponse>(tokenEndpoint(config.tenantId), {
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: IMAP_SCOPE,
  });
  if (!tokens.access_token) {
    throw new Error(
      `IMAP token refresh failed: ${tokens.error ?? "no access token"} — ${tokens.error_description ?? ""}`,
    );
  }

  // Microsoft may rotate the refresh token. Keep the new one for later polls.
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    process.env["IMAP_REFRESH_TOKEN"] = tokens.refresh_token;
    if (config.tokenFile) await writeTokenFile(config.tokenFile, tokens.refresh_token);
  }
  return tokens.access_token;
}

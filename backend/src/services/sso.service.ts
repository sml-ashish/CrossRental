import { createPublicKey, verify as verifySignature } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { randomToken } from "../utils/crypto";

/**
 * P5 SSO for internal users (open item 8).
 *
 * Working assumption: Microsoft Entra ID (OIDC). OTP remains the fallback and
 * is untouched. The provider is disabled unless `SSO_PROVIDER=entra` and all
 * of tenant/client/secret/redirect are present, so an incomplete deploy fails
 * closed rather than exposing a half-configured login.
 *
 * The frontend receives the authorization URL from `/api/auth/sso/start`,
 * sends the browser to it, and posts the returned `code`/`state` back to
 * `/api/auth/sso/callback`. The token is never put in a redirect URL.
 */

export interface SsoStatePayload extends jwt.JwtPayload {
  purpose: "sso_state";
  nonce: string;
}

export interface SsoIdentity {
  email: string;
  fullName: string | null;
  subject: string;
}

function isConfigured(): boolean {
  return (
    env.sso.provider === "entra" &&
    Boolean(env.sso.tenantId) &&
    Boolean(env.sso.clientId) &&
    Boolean(env.sso.clientSecret) &&
    Boolean(env.sso.redirectUri)
  );
}

export function ssoStatus(): {
  enabled: boolean;
  provider: "entra" | null;
  authorizationEndpoint: string | null;
} {
  return {
    enabled: isConfigured(),
    provider: isConfigured() ? "entra" : null,
    authorizationEndpoint: isConfigured()
      ? `https://login.microsoftonline.com/${env.sso.tenantId}/oauth2/v2.0/authorize`
      : null,
  };
}

function assertConfigured(): void {
  if (!isConfigured()) {
    throw AppError.badRequest("SSO is not configured on this deployment");
  }
}

export function createState(): string {
  const payload: SsoStatePayload = {
    purpose: "sso_state",
    nonce: randomToken(16),
  };
  return jwt.sign(payload, env.auth.jwtSecret, { expiresIn: "10m" });
}

export function consumeState(state: string): string {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(state, env.auth.jwtSecret);
  } catch {
    throw AppError.badRequest("The sign-in request has expired. Please try again.");
  }
  if (
    typeof decoded === "string" ||
    decoded.purpose !== "sso_state" ||
    typeof decoded.nonce !== "string"
  ) {
    throw AppError.badRequest("The sign-in request is not valid. Please try again.");
  }
  return decoded.nonce;
}

export function authorizationUrl(state: string): string {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.sso.clientId!,
    response_type: "code",
    redirect_uri: env.sso.redirectUri!,
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce: consumeState(state),
  });
  return `https://login.microsoftonline.com/${env.sso.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

interface Jwks {
  keys: Array<Record<string, unknown>>;
}

let jwksCache: { value: Jwks; loadedAt: number } | null = null;

async function loadJwks(): Promise<Jwks> {
  if (jwksCache && Date.now() - jwksCache.loadedAt < 3_600_000) return jwksCache.value;
  assertConfigured();
  const response = await fetch(
    `https://login.microsoftonline.com/${env.sso.tenantId}/discovery/v2.0/keys`,
  );
  if (!response.ok) throw AppError.unauthorized("Could not verify the sign-in response");
  const value = (await response.json()) as Jwks;
  jwksCache = { value, loadedAt: Date.now() };
  return value;
}

interface IdTokenClaims extends jwt.JwtPayload {
  nonce?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
  name?: string;
  tid?: string;
}

async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === "string") {
    throw AppError.unauthorized("The sign-in response was malformed");
  }

  const kid = decoded.header.kid;
  if (!kid) throw AppError.unauthorized("The sign-in response was not signed by the provider");

  const jwks = await loadJwks();
  const jwk = jwks.keys.find((key) => key["kid"] === kid);
  if (!jwk) throw AppError.unauthorized("The signing key is not recognised");

  const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
  const [header, payload, signature] = idToken.split(".");
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw AppError.unauthorized("The sign-in response signature is not valid");

  const claims = jwt.decode(idToken) as IdTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp !== undefined && claims.exp < now) {
    throw AppError.unauthorized("The sign-in response has expired");
  }
  if (claims.aud !== env.sso.clientId) {
    throw AppError.unauthorized("The sign-in response is for another application");
  }
  if (env.sso.tenantId && claims.tid && claims.tid !== env.sso.tenantId) {
    throw AppError.unauthorized("The sign-in response is for another tenant");
  }
  if (claims.nonce !== expectedNonce) {
    throw AppError.unauthorized("The sign-in response did not match the request");
  }

  return claims;
}

export async function exchangeCode(code: string, state: string): Promise<SsoIdentity> {
  assertConfigured();
  const expectedNonce = consumeState(state);

  const body = new URLSearchParams({
    client_id: env.sso.clientId!,
    client_secret: env.sso.clientSecret!,
    grant_type: "authorization_code",
    code,
    redirect_uri: env.sso.redirectUri!,
    scope: "openid profile email",
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${env.sso.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) throw AppError.unauthorized("The provider rejected the sign-in");

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw AppError.unauthorized("The provider returned no identity token");

  const claims = await verifyIdToken(tokens.id_token, expectedNonce);
  const email = claims.preferred_username ?? claims.email ?? claims.upn;
  if (!email) throw AppError.unauthorized("The provider did not return an email address");

  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (env.sso.allowedDomains.length > 0 && !env.sso.allowedDomains.includes(domain)) {
    throw AppError.forbidden("That email domain is not allowed to sign in");
  }

  return {
    email: email.toLowerCase(),
    fullName: claims.name ?? null,
    subject: String(claims.sub ?? ""),
  };
}

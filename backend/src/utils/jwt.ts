import jwt from "jsonwebtoken";
import { env } from "../config/env";

/**
 * Vendors authenticate with email + password and receive a JWT. Internal
 * users (admin_user / sales_user) never get a JWT from a password — they
 * exchange a one-time code for one (see services/auth.service.ts).
 *
 * The payload deliberately carries the vendorId so the server can scope every
 * vendor query without a second lookup, and the role so requireRole() does not
 * need one either.
 */

export type PortalRole =
  | "vendor_user"
  | "admin_user"
  | "sales_user"
  | "management_viewer";

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: PortalRole;
  vendorId: string | null;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: env.auth.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, env.auth.jwtSecret);
  if (typeof decoded === "string") {
    throw new Error("Malformed token payload");
  }
  return decoded as AuthTokenPayload;
}

/** Deep link into the portal, e.g. used in every RFQ email. */
export function portalUrl(path: string): string {
  return `${env.appUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
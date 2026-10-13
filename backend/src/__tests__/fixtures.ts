/**
 * Shared test constants. All fabricated — the sample forms in docs/ carry real
 * PAN, GSTIN and bank numbers and must never be copied into fixtures or logs
 * (brief working rule 3).
 */

/**
 * Addresses are lowercase because the auth service normalises every inbound
 * address with trim().toLowerCase() before it looks the user up. A mixed-case
 * fixture would silently fail to authenticate.
 */
export const VENDOR_USERS = {
  a: "vendor-a@isolation.test",
  b: "vendor-b@isolation.test",
} as const;

export const INTERNAL_USERS = {
  admin: "admin@isolation.test",
  sales: "sales@isolation.test",
} as const;

export const VENDOR_PASSWORD = "Vendor@Portal2026";

export const CRANE_SERIALS = {
  a: "ISO-SERIAL-A",
  b: "ISO-SERIAL-B",
} as const;
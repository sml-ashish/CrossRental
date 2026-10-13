import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { env } from "../config/env";

/**
 * Field-level encryption for the vendor bank block (brief 6.6: "encrypt at
 * rest, mask in the UI, show in full to admins only, never write to logs").
 *
 * AES-256-GCM. The stored string is `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`
 * so the key can be rotated later by version prefix without a data migration.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = env.fieldEncryptionKey.trim();
  let buf: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    buf = Buffer.from(raw, "base64");
  }

  if (buf.length !== 32) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }

  cachedKey = buf;
  return buf;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptField(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted field");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Last 4 characters, stored in clear so the UI can mask without decrypting. */
export function last4(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : value.slice(-4);
}

/**
 * What non-admin roles receive instead of the real account number. Built from
 * the clear-text last4 so masking never requires decrypting the field.
 */
export function maskAccountNumber(last4Digits: string): string {
  return `XXXXXXXX${last4Digits}`;
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Random opaque token for activation / password-reset links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
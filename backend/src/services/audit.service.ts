import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/database";
import { AuthedRequest } from "../middleware/auth";

/**
 * Audit trail for the changes the brief calls out: crane status, crane
 * location, approval decisions (section 5.3).
 *
 * Bank details are never written here. `scrub` strips them centrally so no
 * call site can accidentally record an account number by passing a whole
 * vendor object as oldValue/newValue.
 */

type AuditJson = Prisma.InputJsonValue;

const FORBIDDEN_FIELDS = new Set([
  "bankAccountNoEnc",
  "bankAccountNo",
  "bankIfscEnc",
  "bankIfsc",
  "bankAccountNoLast4",
  "passwordHash",
  "resetToken",
  "activationToken",
  "codeHash",
]);

function scrub(value: unknown): AuditJson | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item) ?? null) as AuditJson;
  }
  if (typeof value === "object") {
    const out: Record<string, AuditJson> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.has(key)) continue;
      const cleaned = scrub(val);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out as AuditJson;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return String(value);
}

export interface AuditInput {
  entity: string;
  entityId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  craneId?: string;
  ipAddress?: string;
  actor?: AuthedRequest["user"] | null;
}

/**
 * Audit writes must never break the operation they describe, so a failure is
 * logged and swallowed rather than surfaced.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        entity: input.entity,
        entityId: input.entityId,
        action: input.action,
        oldValue: scrub(input.oldValue),
        newValue: scrub(input.newValue),
        craneId: input.craneId ?? null,
        actorId: input.actor?.id ?? null,
        actorRole: input.actor?.role ?? null,
        actorName: input.actor?.email ?? null,
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] failed to record entry", input.entity, input.action, err);
  }
}

/**
 * Returns only the keys whose values actually changed, so an audit row records
 * what moved rather than the entire before/after object.
 */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } | null {
  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  let changed = false;

  for (const field of fields) {
    const a = before[field];
    const b = after[field];
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
    if (!same) {
      oldValue[field] = a;
      newValue[field] = b;
      changed = true;
    }
  }

  return changed ? { oldValue, newValue } : null;
}
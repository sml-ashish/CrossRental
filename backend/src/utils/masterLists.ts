import { prisma } from "../lib/database";

/**
 * Admin-editable master lists for the SAP office-use block (phase D3, open
 * item 3).
 *
 * The owner's SAP "Legal Form Logic" values are not known yet, so rather than
 * guess them (or hard-code them), each list starts empty and an admin fills it
 * in from the settings screen. Values are stored as a JSON array in
 * `app_settings`, keyed `MASTER_LIST_<NAME>`, so the SAP creation sheet and the
 * office-use form read whatever has been entered without a code change.
 */

export const MASTER_LIST_KEYS = [
  "VENDOR_ORIGIN",
  "VENDOR_TYPE",
  "PURCHASE_ORG",
  "PAYMENT_TERM",
  "WITHHOLDING_TAX_TYPE",
  "LEGAL_FORM",
  // P1: the business vertical chosen on an enquiry (open item 6). An admin
  // maintains it here like any other list; it feeds no vendor column.
  "BUSINESS_VERTICAL",
  // P3: the reason codes a CR user picks when marking a quotation in the
  // comparison screen, and the code recorded on an award. Free-standing
  // reference data, like BUSINESS_VERTICAL — no vendor column.
  "QUOTATION_MARK_REASON_CODES",
  "AWARD_REASON_CODES",
] as const;

export type MasterListKey = (typeof MASTER_LIST_KEYS)[number];

/**
 * The vendor column each SAP list feeds, so callers can stay declarative.
 * BUSINESS_VERTICAL has no vendor column and is therefore absent (hence the
 * `Partial`): it is free-standing reference data for enquiries.
 */
export const MASTER_LIST_FIELDS: Partial<
  Record<
    MasterListKey,
    | "vendorOrigin"
    | "vendorType"
    | "purchaseOrg"
    | "paymentTerm"
    | "withholdingTaxType"
    | "legalForm"
  >
> = {
  VENDOR_ORIGIN: "vendorOrigin",
  VENDOR_TYPE: "vendorType",
  PURCHASE_ORG: "purchaseOrg",
  PAYMENT_TERM: "paymentTerm",
  WITHHOLDING_TAX_TYPE: "withholdingTaxType",
  LEGAL_FORM: "legalForm",
};

export function isMasterListKey(value: string): value is MasterListKey {
  return (MASTER_LIST_KEYS as readonly string[]).includes(value);
}

function settingKey(name: MasterListKey): string {
  return `MASTER_LIST_${name}`;
}

function parse(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function getMasterList(name: MasterListKey): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: settingKey(name) } });
  return parse(row?.value);
}

export async function getMasterLists(): Promise<Record<MasterListKey, string[]>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: MASTER_LIST_KEYS.map(settingKey) } },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const out = {} as Record<MasterListKey, string[]>;
  for (const name of MASTER_LIST_KEYS) {
    out[name] = parse(map.get(settingKey(name)));
  }
  return out;
}

export async function setMasterList(
  name: MasterListKey,
  values: string[],
  updatedBy?: string,
): Promise<string[]> {
  // Trim, drop blanks and de-duplicate case-insensitively while keeping the
  // first spelling, so a list cannot hold "Yes" and "yes" at once.
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(value);
  }

  await prisma.appSetting.upsert({
    where: { key: settingKey(name) },
    create: { key: settingKey(name), value: JSON.stringify(clean), updatedBy },
    update: { value: JSON.stringify(clean), updatedBy },
  });
  return clean;
}

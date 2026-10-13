import { prisma } from "../lib/database";
import { env } from "../config/env";

/**
 * Configurable business thresholds live in the `app_settings` table rather
 * than in code, so `fleet_approval_required` and the stale-data windows can be
 * changed without a deploy. The environment supplies the value on first run;
 * after that the database is the source of truth.
 */

export const SETTING_KEYS = [
  "FLEET_APPROVAL_REQUIRED",
  "STALE_DUE_DAYS",
  "STALE_FLAG_DAYS",
  "STALE_REMINDER_REPEAT_DAYS",
  "RFQ_REMINDER_LEAD_HOURS",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export interface PortalSettings {
  fleetApprovalRequired: boolean;
  staleDueDays: number;
  staleFlagDays: number;
  staleReminderRepeatDays: number;
  rfqReminderLeadHours: number;
}

const FALLBACK: PortalSettings = {
  fleetApprovalRequired: env.defaultSettings.FLEET_APPROVAL_REQUIRED,
  staleDueDays: env.defaultSettings.STALE_DUE_DAYS,
  staleFlagDays: env.defaultSettings.STALE_FLAG_DAYS,
  staleReminderRepeatDays: env.defaultSettings.STALE_REMINDER_REPEAT_DAYS,
  rfqReminderLeadHours: env.defaultSettings.RFQ_REMINDER_LEAD_HOURS,
};

let cache: { value: PortalSettings; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function parseBoolean(raw: string): boolean {
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseNumber(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function getSettings(): Promise<PortalSettings> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const value: PortalSettings = {
    fleetApprovalRequired: parseBoolean(
      map.get("FLEET_APPROVAL_REQUIRED") ?? String(FALLBACK.fleetApprovalRequired),
    ),
    staleDueDays: parseNumber(map.get("STALE_DUE_DAYS") ?? "", FALLBACK.staleDueDays),
    staleFlagDays: parseNumber(map.get("STALE_FLAG_DAYS") ?? "", FALLBACK.staleFlagDays),
    staleReminderRepeatDays: parseNumber(
      map.get("STALE_REMINDER_REPEAT_DAYS") ?? "",
      FALLBACK.staleReminderRepeatDays,
    ),
    rfqReminderLeadHours: parseNumber(
      map.get("RFQ_REMINDER_LEAD_HOURS") ?? "",
      FALLBACK.rfqReminderLeadHours,
    ),
  };

  cache = { value, loadedAt: Date.now() };
  return value;
}

export async function setSetting(key: SettingKey, raw: string, updatedBy?: string) {
  const row = await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: raw, updatedBy },
    update: { value: raw, updatedBy },
  });
  cache = null;
  return row;
}

/** Writes any missing default rows. Safe to call repeatedly. */
export async function seedSettings(): Promise<void> {
  for (const [key, value] of Object.entries(env.defaultSettings)) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: {},
    });
  }
  cache = null;
}
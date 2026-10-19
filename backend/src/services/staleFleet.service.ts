import { prisma } from "../lib/database";
import { sendTemplate } from "./email.service";
import { getSettings } from "../utils/settings";
import { toCalendarDateString } from "../lib/dates";

/**
 * Stale-fleet reminders (brief 6.5, M7).
 *
 * A crane that has not had a status or location update for `staleDueDays`
 * (default 30) is "due for update", and the vendor gets a reminder. The brief
 * wants the repeat interval configurable (default 7 days) and the reminders to
 * continue until the vendor updates — so the sweep re-sends on an interval
 * rather than once and stopping.
 *
 * Whether this crane was already chased within the window is read from the
 * `email_logs` table: every template send writes a row with the entity id, so
 * the trail the vendor-facing history screen will one day read is also the
 * dedupe ledger. That keeps `Crane` free of a reminder column whose only reader
 * is this job.
 *
 * The job is idempotent by construction: it re-reads the thresholds from
 * `app_settings` and only acts on rows currently past them, so an overlap
 * between the cron tick and a manual run sends nothing twice.
 */

export const STALE_REMINDER_TEMPLATE = "fleet_update_reminder" as const;

export interface StaleReminderRun {
  /** Cranes past the due window. */
  due: number;
  /** Cranes for which a reminder was actually sent this run. */
  sent: number;
  /** Cranes skipped only because one was already sent inside the window. */
  skippedRecentlyReminded: number;
}

export async function sendStaleReminders(now: Date = new Date()): Promise<StaleReminderRun> {
  const settings = await getSettings();
  const dueThresholdMs = now.getTime() - settings.staleDueDays * 24 * 60 * 60 * 1000;
  const repeatWindowMs =
    Math.max(1, settings.staleReminderRepeatDays) * 24 * 60 * 60 * 1000;

  const cranes = await prisma.crane.findMany({
    where: {
      isActive: true,
      statusUpdatedAt: { lt: new Date(dueThresholdMs) },
    },
    select: {
      id: true,
      currentLocation: true,
      serialRegistrationNo: true,
      capacityT: true,
      statusUpdatedAt: true,
      typeOfCrane: { select: { name: true } },
      vendor: { select: { id: true, name: true, email: true } },
    },
    orderBy: { statusUpdatedAt: "asc" },
  });

  if (cranes.length === 0) {
    return { due: 0, sent: 0, skippedRecentlyReminded: 0 };
  }

  // One query for the whole sweep: the most recent reminder per crane inside
  // the repeat window. Any crane id in this set was chased recently.
  const recent = await prisma.emailLog.findMany({
    where: {
      template: STALE_REMINDER_TEMPLATE,
      entity: "crane",
      entityId: { in: cranes.map((c) => c.id) },
      createdAt: { gte: new Date(now.getTime() - repeatWindowMs) },
    },
    select: { entityId: true },
  });
  const recentlyReminded = new Set(recent.map((row) => row.entityId));

  const portalBase = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";
  let sent = 0;

  for (const crane of cranes) {
    if (recentlyReminded.has(crane.id)) {
      continue;
    }
    if (!crane.vendor) continue;
    // A vendor without an address has nowhere for the reminder to go; counting
    // it as recently-reminded would be a lie, so it stays due until one exists.
    if (!crane.vendor.email) continue;

    await sendTemplate({
      to: crane.vendor.email,
      template: STALE_REMINDER_TEMPLATE,
      entity: "crane",
      entityId: crane.id,
      vars: {
        vendorName: crane.vendor.name ?? "The vendor",
        craneLabel: `${crane.typeOfCrane.name} ${Number(crane.capacityT)} t — ${crane.serialRegistrationNo} (${crane.currentLocation})`,
        lastUpdatedAt: toCalendarDateString(crane.statusUpdatedAt),
        craneUrl: `${portalBase}/app/fleet/${crane.id}/edit`,
      },
    }).catch((err) => console.error("[stale-reminders] send failed", err));

    // Counted as sent: the EmailLog row exists, which is what the window reads.
    // A bounced delivery must not make the job re-spam a dead mailbox hourly.
    sent += 1;
  }

  return {
    due: cranes.length,
    sent,
    skippedRecentlyReminded: cranes.length - sent,
  };
}

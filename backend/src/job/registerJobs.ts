import { registerJob } from "./scheduler";
import { expireOverdueRecipients, runAutomaticRfqReminders } from "../services/rfq.service";
import { sendStaleReminders } from "../services/staleFleet.service";
import { completeOverdueReservations } from "../services/reservations.service";
import { sendAlertDigest } from "../services/alert.service";
import { isImapConfigured, pollInboundMailbox } from "../services/imap.service";

/**
 * The milestone plan's "callable functions become scheduled jobs" step.
 *
 * Every background rule involved ships here, not in a service that forgets to
 * be scheduled. Expressions are spread so no two jobs share a minute boundary.
 * All three re-read their thresholds from `app_settings`, so changing a
 * threshold needs no re-registration:
 *
 * - `stale-fleet-reminders` — 05:11 UTC daily. Cranes past `STALE_DUE_DAYS`
 *   (default 30) remind their vendor, repeating every
 *   `STALE_REMINDER_REPEAT_DAYS` (default 7) until updated (brief 6.5).
 * - `rfq-reminders` — 47 minutes past every hour. Pending recipients inside
 *   `RFQ_REMINDER_LEAD_HOURS` (default 24) of their deadline get the reminder
 *   (brief 6.7).
 * - `rfq-expiry` — 13 minutes past every hour. Still-Pending recipients whose
 *   deadline has passed become Expired (brief 6.7).
 * - `reservation-expiry` — 01:23 UTC daily. Active reservations whose end date
 *   has passed become Completed, so the crane stops reading as Booked/Hired
 *   (brief 6.1).
 */
export function registerDefaultJobs(): void {
  registerJob({
    name: "stale-fleet-reminders",
    expression: "11 5 * * *",
    run: async () => {
      const run = await sendStaleReminders();
      if (run.due > 0) {
        console.log(
          `[scheduler] stale-fleet-reminders — ${run.due} due, ${run.sent} sent, ` +
            `${run.skippedRecentlyReminded} recently reminded`,
        );
      }
    },
  });

  registerJob({
    name: "rfq-reminders",
    expression: "47 * * * *",
    run: async () => {
      const run = await runAutomaticRfqReminders();
      if (run.reminded > 0) {
        console.log(
          `[scheduler] rfq-reminders — ${run.reminded} recipients chased, ${run.sent} emails sent`,
        );
      }
    },
  });

  registerJob({
    name: "rfq-expiry",
    expression: "13 * * * *",
    run: async () => {
      const expired = await expireOverdueRecipients();
      if (expired > 0) {
        console.log(`[scheduler] rfq-expiry — ${expired} recipients expired`);
      }
    },
  });

  // P5: one daily digest of the alert list the dashboards show. Only sends when
  // there is at least one item, and respects ALERT_EMAILS_ENABLED.
  registerJob({
    name: "internal-alert-digest",
    expression: "23 6 * * *",
    run: async () => {
      const run = await sendAlertDigest();
      if (run.sent > 0) {
        console.log(
          `[scheduler] internal-alert-digest — ${run.alerts} alerts emailed to ${run.sent} users`,
        );
      }
    },
  });

  // P6: poll the shared mailbox for vendor replies. Disabled unless IMAP_POLL_ENABLED
  // is on and credentials are present, so local/test runs make no network call.
  registerJob({
    name: "inbound-email-poll",
    expression: "*/5 * * * *",
    run: async () => {
      if (!isImapConfigured()) return;
      const run = await pollInboundMailbox();
      if (run.processed > 0 || run.failed > 0) {
        console.log(
          `[scheduler] inbound-email-poll — ${run.processed} ingested, ${run.failed} failed`,
        );
      }
    },
  });

  registerJob({
    name: "reservation-expiry",
    expression: "23 1 * * *",
    run: async () => {
      const completed = await completeOverdueReservations();
      if (completed > 0) {
        console.log(`[scheduler] reservation-expiry — ${completed} reservations completed`);
      }
    },
  });
}

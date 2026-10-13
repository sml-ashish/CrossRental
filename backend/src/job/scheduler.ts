import cron, { ScheduledTask } from "node-cron";

/**
 * Background job registry.
 *
 * Jobs are registered here as the milestones that need them land, so a job is
 * never registered before the service it calls exists. Every job must be
 * idempotent — it re-reads its threshold from app_settings and only acts on
 * rows currently in the right state — because the cron expression and a
 * manual run can overlap.
 *
 * Planned, by milestone:
 *   M3  crane stale-data reminders
 *   M4  RFQ deadline expiry, automatic pre-deadline reminders
 */

export interface JobDefinition {
  name: string;
  expression: string;
  run: () => Promise<void>;
}

const registry = new Map<string, JobDefinition>();
const running = new Map<string, ScheduledTask>();

export function registerJob(job: JobDefinition): void {
  registry.set(job.name, job);
}

const LOG = "[scheduler]";

async function execute(job: JobDefinition): Promise<void> {
  const startedAt = Date.now();
  try {
    await job.run();
    const ms = Date.now() - startedAt;
    if (ms > 100) console.log(`${LOG} ${job.name} finished in ${ms}ms`);
  } catch (err) {
    // A failed job must never take the process down; the next tick retries.
    console.error(`${LOG} ${job.name} failed`, err);
  }
}

export function startScheduler(): void {
  for (const job of registry.values()) {
    if (running.has(job.name)) continue;
    const task = cron.schedule(job.expression, () => void execute(job));
    running.set(job.name, task);
    console.log(`${LOG} registered "${job.name}" (${job.expression})`);
  }
  if (registry.size === 0) {
    console.log(`${LOG} no jobs registered yet`);
  }
}

export function stopScheduler(): void {
  for (const task of running.values()) task.stop();
  running.clear();
}

/** Runs every registered job once, in order. Used by tests and by `npm run jobs:once`. */
export async function runAllJobs(): Promise<void> {
  for (const job of registry.values()) {
    await execute(job);
  }
}
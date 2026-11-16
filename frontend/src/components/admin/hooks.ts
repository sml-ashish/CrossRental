import { useEffect, useState } from "react";

/**
 * Small timing helpers for the admin console.
 *
 * The page is a "what changed today" screen, so the relative "Updated 10 min
 * ago" line and every last-sign-in cell have to move without polling the API.
 * That ticking clock is independent of the data queries.
 */

/** A ticking clock, refreshed at a readable cadence. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}

/**
 * "just now", "42 seconds ago", "10 min ago", "1 hour ago".
 *
 * Deliberately coarse: a dashboard header does not need the exact second, and a
 * number that changes every tick pulls the eye away from the list.
 */
export function relativeTime(timestamp: number | null | undefined, now: number): string {
  if (!timestamp) return "not yet";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

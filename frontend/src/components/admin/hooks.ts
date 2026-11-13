import { useEffect, useRef, useState } from "react";

/**
 * Small timing helpers for the admin console.
 *
 * The dashboard is a "what changed today" screen, so two things have to move
 * without polling the API: the relative "Updated 12s ago" line, and the one-time
 * count-up on the summary strip. Both are independent of the data queries.
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
 * "just now", "42s ago", "6m ago". Deliberately coarse: a dashboard header does
 * not need the exact second, and a number that changes every tick pulls the eye
 * away from the counters.
 */
export function relativeTime(timestamp: number | null | undefined, now: number): string {
  if (!timestamp) return "not yet";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Count from zero to the value once, when the card first mounts.
 *
 * The strip is read as "how busy is today", and a short rise makes the number
 * land rather than appear. Refreshes deliberately do not replay it: a value that
 * keeps animating every 30 seconds is noise, not feedback.
 */
export function useCountUpOnce(value: number, duration = 600, enabled = true): number {
  const [shown, setShown] = useState(0);
  const animated = useRef(false);
  const shownRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (animated.current) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    animated.current = true;

    if (prefersReducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }

    let frame = 0;
    const from = shownRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (value - from) * eased);
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, enabled]);

  return shown;
}

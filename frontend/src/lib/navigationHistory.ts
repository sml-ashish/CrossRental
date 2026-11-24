/**
 * A tab-local memory of the pages visited inside `/app`.
 *
 * The browser's own history already exists, but it is not a reliable "go back"
 * for an operator: deep links, redirects and role homes leave gaps. This store
 * keeps the recent internal route list in sessionStorage so a page's Back
 * button always has somewhere sensible to return to, without leaking the stack
 * across tabs or recording signed-out pages.
 */

const STORAGE_KEY = "crossrental:app-history:v1";
const MAX_ENTRIES = 60;

let pendingTarget: string | null = null;
let awaitingPopState = false;

/** Only real signed-in screens are remembered; the `/app` redirect is not. */
export function isTrackedAppHref(href: string): boolean {
  return href.startsWith("/app/") && href !== "/app/";
}

function readHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && isTrackedAppHref(entry))
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeHistory(entries: string[]): string[] {
  const trimmed = entries.slice(-MAX_ENTRIES);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Private browsing or a full storage quota must not break navigation.
    }
  }
  return trimmed;
}

/**
 * The page before the current one. If the current href was not recorded (for
 * example after a reload), the last remembered page is still a safe fallback.
 */
export function previousHref(currentHref: string): string | null {
  const entries = readHistory();
  const index = entries.lastIndexOf(currentHref);
  if (index > 0) return entries[index - 1] ?? null;
  if (index === -1) return entries[entries.length - 1] ?? null;
  return null;
}

/** A screen's Back button is about to navigate to a known earlier entry. */
export function markBackTarget(href: string): void {
  pendingTarget = href;
}

/** The user pressed the browser's own Back/Forward button. */
export function markBrowserHistoryPop(): void {
  awaitingPopState = true;
}

/** Called whenever the router commits a new location. */
export function recordVisit(href: string): void {
  if (!isTrackedAppHref(href)) return;

  const restoring = pendingTarget === href || awaitingPopState;
  pendingTarget = null;
  awaitingPopState = false;

  const entries = readHistory();
  if (entries[entries.length - 1] === href && !restoring) return;

  if (restoring) {
    const index = entries.lastIndexOf(href);
    writeHistory(index >= 0 ? entries.slice(0, index + 1) : [...entries, href]);
    return;
  }

  writeHistory([...entries, href]);
}

/** Called on sign out so the next session starts with a clean memory. */
export function clearHistory(): void {
  pendingTarget = null;
  awaitingPopState = false;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }
}

import { useCallback, useState } from "react";

/**
 * Light / dark choice for the Find cranes workspace.
 *
 * Dark stays the default so nobody's screen changes under them; the choice is
 * remembered per browser. Storage can be blocked (private windows, locked-down
 * profiles), so every access is guarded and the page simply works unsaved.
 */
export type DiscoveryTheme = "light" | "dark";

const STORAGE_KEY = "crossrentel.discovery.theme";

function readTheme(): DiscoveryTheme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function useDiscoveryTheme(): [DiscoveryTheme, () => void] {
  const [theme, setTheme] = useState<DiscoveryTheme>(readTheme);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: DiscoveryTheme = current === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* unsaved is fine */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
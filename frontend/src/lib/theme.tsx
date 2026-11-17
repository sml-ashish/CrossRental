import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Light / dark theme for the whole portal.
 *
 * The palette is token-based (see styles/index.css): dark values live on :root and
 * `.theme-light` re-declares them. This provider puts the matching class on <html>,
 * so every screen — signed-in or not — follows one switch. Dark stays the default,
 * the choice is remembered per browser, and storage can be blocked, so every
 * access is guarded and the page simply works unsaved.
 */
export type Theme = "light" | "dark";

// Same key the Find cranes workspace already used, so nobody's choice is lost.
const STORAGE_KEY = "crossrentel.discovery.theme";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", theme === "light");
  root.classList.toggle("theme-dark", theme === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#eef0f3" : "#17181b");
}

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Another tab changing the theme updates this one too.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTheme(readTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* unsaved is fine */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}

/** Colours for charts, which draw with literal values instead of CSS classes. */
export function chartColors(theme: Theme) {
  return theme === "light"
    ? { grid: "#e2e5e9", axis: "#cbd0d6", tick: "#667085", tickStrong: "#262a30", cursor: "#eef0f3" }
    : { grid: "#26282b", axis: "#34363a", tick: "#8f9299", tickStrong: "#c3c6cb", cursor: "#26282b" };
}
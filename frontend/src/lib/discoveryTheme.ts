import { useTheme, type Theme } from "@/lib/theme";

/**
 * The Find cranes workspace follows the portal-wide theme (lib/theme.tsx); this
 * keeps its existing `[theme, toggle]` shape so the screen did not need rewiring.
 */
export type DiscoveryTheme = Theme;

export function useDiscoveryTheme(): [DiscoveryTheme, () => void] {
  const { theme, toggle } = useTheme();
  return [theme, toggle];
}
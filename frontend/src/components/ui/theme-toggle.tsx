import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";

/** Sun/moon switch for the whole portal. Shows the mode you would switch TO. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const toLight = theme === "dark";
  const Icon = toLight ? Sun : Moon;
  const label = toLight ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-ink-850 hover:text-white",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
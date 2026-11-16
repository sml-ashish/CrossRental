import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The small overflow menu used by a page header and by each line.
 *
 * There is no popover library in the portal, and a menu is one of the few
 * controls where the accessible behaviour is worth spelling out: the trigger
 * announces `aria-haspopup`, Escape closes and returns focus, and the arrow
 * keys walk the items. Keeping it here means the header menu and every line's
 * Edit/Cancel menu behave identically.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Destructive items read red, and only destructive items do. */
  tone?: "default" | "danger";
  disabled?: boolean;
}

export function Menu({
  label,
  items,
  align = "right",
  trigger,
  className,
}: {
  /** Read out for the icon-only trigger: "More actions", "Actions for Line 1". */
  label: string;
  items: MenuItem[];
  align?: "left" | "right";
  /** Custom trigger content. Defaults to the ⋯ icon. */
  trigger?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
      return;
    }
  }

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex size-10 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-400 transition-colors",
          "hover:border-ink-700 hover:bg-ink-800 hover:text-slate-900",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
          open && "border-ink-700 bg-ink-800 text-slate-900",
        )}
      >
        {trigger ?? <MoreHorizontal className="size-4" aria-hidden />}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            className="fixed inset-0 z-[60] cursor-default"
            onClick={() => close(false)}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            className={cn(
              "absolute top-full z-[70] mt-2 w-56 rounded-xl border border-ink-800 bg-ink-900 p-1.5 shadow-2xl",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  close(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500",
                  item.tone === "danger"
                    ? "text-red-600 hover:bg-red-50"
                    : "text-neutral-300 hover:bg-ink-850 hover:text-white",
                  item.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

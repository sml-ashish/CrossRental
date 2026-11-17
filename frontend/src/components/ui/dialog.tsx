import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The portal's one reusable dialog shell.
 *
 * Centred on a desktop, a full-height sheet on a phone. Base UI supplies the
 * things a hand-built overlay usually forgets: focus is trapped and returned to
 * the trigger, Escape closes, the page behind stops scrolling, and the title and
 * description are wired to the dialog with ids. Screens only bring the body.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  bodyClassName,
  closeLabel = "Close dialog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Pinned below the scrolling body, for the screen's own footer links. */
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-[1px]" />
        <BaseDialog.Viewport className="fixed inset-0 z-[81] flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
          <BaseDialog.Popup
            className={cn(
              "relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden border-ink-800 bg-ink-900 text-neutral-200 shadow-2xl outline-none",
              "sm:h-auto sm:max-h-[88vh] sm:max-w-[720px] sm:rounded-2xl sm:border",
              className,
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-800 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <BaseDialog.Title className="text-base font-semibold tracking-tight text-slate-900">
                  {title}
                </BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description className="mt-1 text-[15px] leading-5 text-slate-500">
                    {description}
                  </BaseDialog.Description>
                ) : null}
              </div>
              <BaseDialog.Close
                aria-label={closeLabel}
                className="flex size-8 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 text-slate-500 transition-colors hover:bg-ink-800 hover:text-white"
              >
                <X className="size-4" aria-hidden />
              </BaseDialog.Close>
            </div>

            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6",
                bodyClassName,
              )}
            >
              {children}
            </div>

            {footer ? (
              <div className="shrink-0 border-t border-ink-800 bg-ink-900 px-4 py-3 sm:px-6">
                {footer}
              </div>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}


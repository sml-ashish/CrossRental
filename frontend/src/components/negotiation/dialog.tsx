import { useEffect } from "react";
import { X } from "lucide-react";

/** Modal chrome shared by the SML and vendor negotiation dialogs. */
export function DialogShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[1px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-800 bg-ink-900 shadow-2xl sm:max-w-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-800 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[14px] text-slate-500">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-ink-800 bg-ink-850 text-slate-500 hover:text-slate-900"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer}
      </div>
    </div>
  );
}

export function DialogFooter({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-ink-800 bg-ink-850 px-6 py-3">
      <button type="button" className="btn-secondary px-4 py-2 text-[15px]" onClick={onClose}>
        Cancel
      </button>
      {children}
    </div>
  );
}

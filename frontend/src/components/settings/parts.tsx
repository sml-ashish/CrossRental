import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Check, TriangleAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/components/admin/hooks";
import { cn } from "@/lib/cn";
import type { PortalSettings } from "@/lib/settings";

/**
 * The parts every Settings section shares.
 *
 * A settings screen is mostly chrome: a heading that says what the block is, a
 * save control that says where the change is, and a field that says what it
 * accepts. Keeping that chrome in one place is what makes five sections read as
 * one page instead of five forms.
 */

export type SettingSectionId =
  | "quotations"
  | "alerts"
  | "email-templates"
  | "retention"
  | "access";

export type SettingsQuery = UseQueryResult<{ settings: PortalSettings }, Error>;

/** What a section tells the page so the sticky bar and nav can stay honest. */
export interface SectionHandlers {
  save: () => void;
  discard: () => void;
}

export interface SectionRegistryApi {
  setDirty: (id: SettingSectionId, dirty: boolean) => void;
  setHandlers: (id: SettingSectionId, handlers: SectionHandlers | null) => void;
}

export const SettingsRegistryContext = createContext<SectionRegistryApi | null>(null);

/**
 * Publishes a section's dirty flag and its save/discard actions to the page.
 *
 * The section stays the owner of its own form; the page only needs to know that
 * something is unsaved, which sections those are, and how to ask them to save or
 * throw the draft away.
 */
export function useSectionRegistration(
  id: SettingSectionId,
  dirty: boolean,
  handlers: SectionHandlers,
): void {
  const registry = useContext(SettingsRegistryContext);

  // The section re-creates its callbacks on every render, so the page must not
  // see a new function identity each time — it would re-render the page in a
  // loop. A stable wrapper reads the latest callbacks from a ref instead.
  const latest = useRef(handlers);
  latest.current = handlers;
  const stable = useMemo<SectionHandlers>(
    () => ({
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    }),
    [],
  );

  useEffect(() => {
    registry?.setHandlers(id, stable);
    return () => registry?.setHandlers(id, null);
  }, [registry, id, stable]);

  useEffect(() => {
    registry?.setDirty(id, dirty);
  }, [registry, id, dirty]);

  useEffect(
    () => () => {
      registry?.setDirty(id, false);
    },
    [registry, id],
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * One section of the page: a heading, one line of purpose, the save control, and
 * the fields. A hairline above instead of a card, so the page reads as one
 * document rather than a stack of boxes.
 */
export function SettingsSection({
  id,
  title,
  summary,
  actions,
  children,
}: {
  id: SettingSectionId;
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className="scroll-mt-[84px] border-t border-ink-800 pt-7 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 max-w-[64ch]">
          <h2
            id={titleId}
            className="text-[18px] leading-6 font-semibold tracking-tight text-slate-900"
          >
            {title}
          </h2>
          {summary ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{summary}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** "Saved just now", "Saved 4 minutes ago", "Saved at 14:32". */
function savedLabel(savedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 60) return "Saved just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Saved ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `Saved at ${new Date(savedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/**
 * The save control a section carries in its heading.
 *
 * The button is the only thing that writes; nothing saves on blur. The status
 * line says which of the four states the section is in, and the error appears
 * inline in the section body as well, so a failed save is never just a colour.
 */
export function SectionActions({
  dirty,
  pending,
  error,
  savedAt,
  onSave,
  onDiscard,
  saveLabel = "Save",
  canSave = true,
}: {
  dirty: boolean;
  pending: boolean;
  error?: Error | null;
  savedAt: number | null;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  /** False while a field holds a value the API would reject. */
  canSave?: boolean;
}) {
  const now = useNow(15_000);

  return (
    <>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center gap-1.5 text-[13px]",
          error ? "text-red-600" : savedAt && !dirty ? "text-emerald-600" : "text-slate-500",
        )}
      >
        {!pending && error ? (
          <>
            <TriangleAlert className="size-3.5" aria-hidden />
            Not saved
          </>
        ) : null}
        {!pending && !error && dirty ? "Unsaved changes" : null}
        {!pending && !error && !dirty && savedAt ? (
          <>
            <Check className="size-3.5" aria-hidden />
            {savedLabel(savedAt, now)}
          </>
        ) : null}
      </span>

      {dirty ? (
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-[13px]"
          onClick={onDiscard}
          disabled={pending}
        >
          Discard
        </button>
      ) : null}

      <button
        type="button"
        className="btn-primary px-3.5 py-1.5 text-[13px]"
        onClick={onSave}
        disabled={!dirty || pending || !canSave}
      >
        {pending ? "Saving…" : saveLabel}
      </button>
    </>
  );
}

/** A quiet amber note: something an admin should read before saving. */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-amber-800">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading and failure
// ---------------------------------------------------------------------------

/** Holds the shape of a section while its query is in flight. */
export function SectionSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: fields }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}

/** A first line that a section's data could not be read, with a way to retry. */
export function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <Alert tone="error" title={title}>
      <p>{error?.message ?? "The server did not answer. Please try again."}</p>
      <button
        type="button"
        className="btn-secondary mt-2.5 px-3 py-1.5 text-[13px]"
        onClick={onRetry}
      >
        Retry
      </button>
    </Alert>
  );
}

/**
 * Renders a section body only once the settings payload has arrived.
 *
 * Three sections read the same query, so each one shows its own skeleton and its
 * own retry rather than the page blanking out as a whole.
 */
export function SettingsGate({
  query,
  fields,
  children,
}: {
  query: SettingsQuery;
  fields?: number;
  children: (settings: PortalSettings) => ReactNode;
}) {
  if (query.isLoading) return <SectionSkeleton fields={fields} />;
  if (query.error) {
    return (
      <LoadFailure
        title="This setting could not load"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return null;
  return <>{children(query.data.settings)}</>;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * A whole-number field with its own step buttons.
 *
 * A stepper rather than a bare input because these values are small ranges an
 * admin nudges ("48 hours is too long; try 24"), and the limits printed beside
 * it are the ones the API enforces.
 */
export function NumberStepper({
  id,
  label,
  hint,
  unit,
  value,
  onChange,
  min,
  max,
  error,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  error?: string | null;
  disabled?: boolean;
}) {
  const parsed = Number(value);
  const atMin = value.trim() !== "" && Number.isFinite(parsed) && parsed <= min;
  const atMax = Number.isFinite(parsed) && parsed >= max;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  function step(delta: number) {
    const base = Number.isFinite(parsed) ? parsed : min;
    const next = Math.min(max, Math.max(min, Math.round(base) + delta));
    onChange(String(next));
  }

  return (
    <div className="py-4">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
      </label>
      <p id={hintId} className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-slate-500">
        {hint}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div
          className={cn(
            "inline-flex items-stretch overflow-hidden rounded-lg border border-ink-800 bg-ink-850",
            error && "border-red-300",
          )}
        >
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={disabled || atMin}
            aria-label={`Decrease ${label}`}
            className="px-2.5 text-sm text-slate-600 transition-colors hover:bg-ink-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            −
          </button>
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            className="w-16 border-x border-ink-800 bg-transparent px-1 py-1.5 text-center text-sm tabular-nums text-slate-900 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={() => step(1)}
            disabled={disabled || atMax}
            aria-label={`Increase ${label}`}
            className="px-2.5 text-sm text-slate-600 transition-colors hover:bg-ink-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
        </div>
        <span className="text-[13px] text-slate-500">{unit}</span>
        <span className="text-xs text-slate-500">
          Between {min} and {max}
        </span>
      </div>

      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** An on/off setting. A real switch, so the state is read as on or off. */
export function SwitchField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-slate-900">
          {label}
        </span>
        <p id={hintId} className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-slate-500">
          {hint}
        </p>
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-2.5">
        <span id={`${id}-state`} className="text-[13px] text-slate-500">
          {checked ? "On" : "Off"}
        </span>
        <button
          type="button"
          id={id}
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={`${hintId} ${id}-state`}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            "inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
            checked ? "border-accent-500 bg-accent-500" : "border-ink-700 bg-ink-800",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <span
            className={cn(
              "block size-4.5 rounded-full bg-white transition-transform",
              checked ? "translate-x-[18px]" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </div>
  );
}

/** A whole-number check mirroring the API's zod rule. */
export function integerRangeError(value: string, min: number, max: number): string | null {
  if (value.trim() === "") return "Enter a number.";
  const parsed = Number(value);
  if (!Number.isNaN(parsed) && !Number.isInteger(parsed)) return "Use a whole number.";
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return `Enter a whole number between ${min} and ${max}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * A small confirmation dialog for a change that reaches beyond this page.
 *
 * `Escape` cancels, focus starts on Cancel, the tab loop stays inside the
 * dialog, and focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));

    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onCancel}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="relative w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
      >
        <h3 id={titleId} className="text-[15px] font-semibold text-slate-900">
          {title}
        </h3>
        <div id={bodyId} className="mt-2 text-[13px] leading-relaxed text-slate-500">
          {children}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-[13px]"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn-primary px-3.5 py-1.5 text-[13px]"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

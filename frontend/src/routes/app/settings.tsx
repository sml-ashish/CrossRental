import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { PageHeader } from "@/components/ui/page-header";
import {
  ConfirmDialog,
  SettingsRegistryContext,
  type SectionHandlers,
  type SettingSectionId,
} from "@/components/settings/parts";
import { QuotationsSection } from "@/components/settings/quotations-section";
import { AlertsSection } from "@/components/settings/alerts-section";
import { EmailTemplatesSection } from "@/components/settings/email-templates-section";
import { RetentionSection } from "@/components/settings/retention-section";
import { AccessSection } from "@/components/settings/access-section";
import { cn } from "@/lib/cn";
import { loadSettings } from "@/lib/settings";

/**
 * Admin configuration (brief 6.4, phase D3 / P5).
 *
 * Only an admin reaches this screen — the nav entry and the route guard both
 * restrict it, and the API refuses anyone else. The page is deliberately a
 * document rather than a stack of cards: one column of settings with a short
 * section list beside it, and every section saying what it changes before it is
 * changed.
 *
 * Each section owns its draft and its Save button. The page only borrows that
 * state to answer three questions: which sections are unsaved, how to save them
 * all, and whether leaving now would throw work away.
 */

const SECTIONS = [
  { id: "quotations", label: "Quotations" },
  { id: "alerts", label: "Alerts and notifications" },
  { id: "email-templates", label: "Email templates" },
  { id: "retention", label: "Data and retention" },
  { id: "access", label: "Access" },
] as const satisfies readonly { id: SettingSectionId; label: string }[];

const NO_DIRTY: Record<SettingSectionId, boolean> = {
  quotations: false,
  alerts: false,
  "email-templates": false,
  retention: false,
  access: false,
};

/** The scroll position that counts as "at" a section, below the sticky header. */
const SPY_OFFSET = 168;

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: loadSettings });

  const [dirty, setDirty] = useState<Record<SettingSectionId, boolean>>(NO_DIRTY);
  const [handlers, setHandlers] = useState<Partial<Record<SettingSectionId, SectionHandlers>>>({});
  const [active, setActive] = useState<SettingSectionId>("quotations");

  const registry = useMemo(
    () => ({
      setDirty: (id: SettingSectionId, value: boolean) =>
        setDirty((previous) => (previous[id] === value ? previous : { ...previous, [id]: value })),
      setHandlers: (id: SettingSectionId, value: SectionHandlers | null) =>
        setHandlers((previous) => {
          if (value === null) {
            if (!(id in previous)) return previous;
            const next = { ...previous };
            delete next[id];
            return next;
          }
          return previous[id] === value ? previous : { ...previous, [id]: value };
        }),
    }),
    [],
  );

  const anyDirty = Object.values(dirty).some(Boolean);
  const dirtyCount = Object.values(dirty).filter(Boolean).length;

  const blocker = useBlocker({
    shouldBlockFn: () => anyDirty,
    enableBeforeUnload: () => anyDirty,
    withResolver: true,
  });

  // ---------------------------------------------------------------- scroll-spy
  useEffect(() => {
    let frame = 0;
    let seen: SettingSectionId = "quotations";

    function measure() {
      frame = 0;
      let current: SettingSectionId = SECTIONS[0]?.id ?? "quotations";
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= SPY_OFFSET) current = section.id;
      }
      // A short last section may never reach the offset, so the page bottom
      // always selects it.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
      if (atBottom) current = SECTIONS[SECTIONS.length - 1]?.id ?? "access";

      if (seen === current) return;
      seen = current;
      // Keep the address bar in step, so the link to a section can be shared.
      // Outside the state updater: a history write notifies the router, which
      // must not happen while React is working out the next state.
      if (window.location.hash !== `#${current}`) {
        window.history.replaceState(null, "", `#${current}`);
      }
      setActive(current);
    }

    function schedule() {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    }

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  // A hash in the address bar arrives before the sections exist, so honour it
  // once the page has painted.
  useEffect(() => {
    const wanted = window.location.hash.replace(/^#/, "");
    if (!SECTIONS.some((section) => section.id === wanted)) return;
    document.getElementById(wanted)?.scrollIntoView({ block: "start" });
  }, []);

  function saveAll() {
    for (const section of SECTIONS) {
      if (dirty[section.id]) handlers[section.id]?.save();
    }
  }

  function discardAll() {
    for (const section of SECTIONS) {
      if (dirty[section.id]) handlers[section.id]?.discard();
    }
  }

  return (
    <SettingsRegistryContext.Provider value={registry}>
      <div className={cn("max-w-[1100px]", anyDirty ? "pb-24" : "pb-2")}>
        <PageHeader
          title="Settings"
          titleClassName="text-[28px] leading-9 font-semibold tracking-tight"
          description="Quotation rules, alert thresholds, email wording and retention. Each section saves on its own, and the API refuses changes from anyone who is not an admin."
          meta={
            <span className="text-xs text-slate-500">
              Changes apply across the portal as soon as they are saved.
            </span>
          }
        />

        <div className="mt-8 grid gap-8 min-[900px]:grid-cols-[220px_minmax(0,1fr)] min-[900px]:gap-10">
          {/* ---------------------------------------------------------- section nav */}
          <nav
            aria-label="Settings sections"
            className={cn(
              "-mx-1 flex gap-1 overflow-x-auto px-1 pb-1",
              "min-[900px]:sticky min-[900px]:top-[72px] min-[900px]:mx-0 min-[900px]:block min-[900px]:space-y-0.5 min-[900px]:self-start min-[900px]:overflow-visible min-[900px]:px-0 min-[900px]:pb-0",
            )}
          >
            {SECTIONS.map((section) => {
              const isActive = section.id === active;
              const isDirty = dirty[section.id];
              return (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  aria-current={isActive ? "location" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
                    isActive
                      ? "bg-ink-850 font-medium text-white"
                      : "text-slate-500 hover:bg-ink-850 hover:text-white",
                  )}
                >
                  <span>{section.label}</span>
                  {isDirty ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-accent-500"
                      aria-hidden
                    />
                  ) : null}
                  {isDirty ? <span className="sr-only">Unsaved changes</span> : null}
                </a>
              );
            })}
          </nav>

          {/* ------------------------------------------------------------- sections */}
          <div className="min-w-0 space-y-7">
            <QuotationsSection query={settings} />
            <AlertsSection query={settings} />
            <EmailTemplatesSection />
            <RetentionSection query={settings} />
            <AccessSection />
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- unsaved bar */}
      {anyDirty ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-900/95 backdrop-blur print:hidden">
          <div className="flex max-w-[1100px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
            <p className="flex items-center gap-2 text-[13px] text-slate-600">
              <span className="size-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden />
              Unsaved changes in {dirtyCount} {dirtyCount === 1 ? "section" : "sections"}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-[13px]"
                onClick={discardAll}
              >
                Discard all
              </button>
              <button
                type="button"
                className="btn-primary px-3.5 py-1.5 text-[13px]"
                onClick={saveAll}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- leave guard */}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        title="Leave with unsaved changes?"
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      >
        Some settings on this page have not been saved. Leaving now throws those changes away.
      </ConfirmDialog>
    </SettingsRegistryContext.Provider>
  );
}

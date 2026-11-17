import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Code2, Eye, Search } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Field, TextInput } from "@/components/ui/form";
import {
  Callout,
  ConfirmDialog,
  LoadFailure,
  SectionActions,
  SectionSkeleton,
  SettingsSection,
  useSectionRegistration,
} from "@/components/settings/parts";
import { useNow } from "@/components/admin/hooks";
import { cn } from "@/lib/cn";
import {
  buildPreviewHtml,
  friendlyTemplateName,
  hasSample,
  placeholdersIn,
} from "@/lib/emailPreview";
import {
  loadEmailTemplates,
  updateEmailTemplate,
  type EmailTemplateRow,
} from "@/lib/settings";

/**
 * Email templates (brief section 8).
 *
 * The old screen was a dropdown and two textareas with no way to see what the
 * email looked like. This one keeps the wording beside the closest thing to the
 * sent email: the body rendered in a sandboxed frame with clearly fictional
 * sample values, the placeholders it uses as insertable chips, and a warning
 * when the draft and the saved template disagree about which values the email
 * carries.
 */

const SUBJECT_MAX = 300;

interface Draft {
  subject: string;
  body: string;
}

function editedLabel(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Edited recently";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Last edited just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last edited ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last edited ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Last edited ${days} day${days === 1 ? "" : "s"} ago`;
  return `Last edited ${new Date(then).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

export function EmailTemplatesSection() {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ["settings", "email-templates"],
    queryFn: loadEmailTemplates,
  });
  const now = useNow(30_000);

  const rows = templates.data ?? [];
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pane, setPane] = useState<"edit" | "preview">("edit");

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastField = useRef<"subject" | "body">("body");
  const servedDraft = useRef<Draft | null>(null);

  const current = rows.find((row) => row.key === selected);

  /**
   * What the server currently holds for this template. It is derived, not
   * copied: a refetch that brings another admin's edit can then never leave the
   * dirty comparison pointing at a version that no longer exists.
   */
  const baseline: Draft | null = current
    ? { subject: current.subject, body: current.bodyHtml }
    : null;

  function openTemplate(row: EmailTemplateRow) {
    setSelected(row.key);
    setDraft({ subject: row.subject, body: row.bodyHtml });
    servedDraft.current = { subject: row.subject, body: row.bodyHtml };
    setSavedAt(null);
    setPane("edit");
    save.reset();
  }

  // The first template opens by itself, so the editor is never an empty pane.
  useEffect(() => {
    if (selected || rows.length === 0) return;
    const first = rows[0];
    if (!first) return;
    setSelected(first.key);
    setDraft({ subject: first.subject, body: first.bodyHtml });
    servedDraft.current = { subject: first.subject, body: first.bodyHtml };
  }, [selected, rows]);

  // Re-read a row that changed underneath an untouched draft (a save settling,
  // or another admin's edit arriving on refetch). A draft with local edits is
  // left exactly as typed — silently replacing someone's work is worse than
  // showing them a warning.
  useEffect(() => {
    if (!current) return;
    const served = servedDraft.current;
    const next = { subject: current.subject, body: current.bodyHtml };
    if (served && sameDraft(served, next)) return;
    setDraft((previous) => {
      if (previous && served && !sameDraft(previous, served)) return previous;
      return next;
    });
    servedDraft.current = next;
  }, [current?.key, current?.subject, current?.bodyHtml]);

  const save = useMutation({
    mutationFn: (next: Draft) =>
      updateEmailTemplate(selected, {
        subject: next.subject.trim(),
        bodyHtml: next.body,
      }),
    onSuccess: (row) => {
      setDraft({ subject: row.subject, body: row.bodyHtml });
      servedDraft.current = { subject: row.subject, body: row.bodyHtml };
      setSavedAt(Date.now());
      // Write the saved row into the list at once so "Last edited" and the
      // dirty comparison agree before the refetch lands.
      queryClient.setQueryData<EmailTemplateRow[]>(
        ["settings", "email-templates"],
        (rows) => rows?.map((existing) => (existing.key === row.key ? row : existing)),
      );
      void queryClient.invalidateQueries({ queryKey: ["settings", "email-templates"] });
    },
  });

  const dirty = Boolean(draft && baseline) && !sameDraft(draft as Draft, baseline as Draft);

  const subjectError =
    draft && draft.subject.trim() === ""
      ? "Enter a subject."
      : draft && draft.subject.trim().length > SUBJECT_MAX
        ? `Keep the subject to ${SUBJECT_MAX} characters or fewer.`
        : null;
  const bodyError =
    draft && draft.body.trim() === "" ? "Enter the email body." : null;

  function requestSave() {
    if (!dirty || !draft || subjectError || bodyError || save.isPending) return;
    save.mutate(draft);
  }

  function discard() {
    if (baseline) setDraft({ ...baseline });
    save.reset();
  }

  function requestOpen(key: string) {
    if (key === selected || templates.isFetching || save.isPending) return;
    if (dirty) {
      setPendingKey(key);
      return;
    }
    const row = rows.find((candidate) => candidate.key === key);
    if (row) openTemplate(row);
  }

  useSectionRegistration("email-templates", dirty, { save: requestSave, discard });

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? rows.filter(
        (row) =>
          friendlyTemplateName(row.key).toLowerCase().includes(needle) ||
          row.key.toLowerCase().includes(needle),
      )
    : rows;

  const originalVariables = placeholdersIn(baseline?.subject, baseline?.body);
  const draftVariables = placeholdersIn(draft?.subject, draft?.body);
  const removedVariables = originalVariables.filter((name) => !draftVariables.includes(name));
  const addedVariables = draftVariables.filter((name) => !originalVariables.includes(name));
  const unknownVariables = draftVariables.filter((name) => !hasSample(name));
  const previewHtml = buildPreviewHtml(draft?.body ?? "");

  function insertVariable(name: string) {
    if (!draft) return;
    const field = lastField.current;
    const element = field === "subject" ? subjectRef.current : bodyRef.current;
    const value = field === "subject" ? draft.subject : draft.body;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const token = `{{${name}}}`;
    const next = value.slice(0, start) + token + value.slice(end);
    setDraft(
      field === "subject"
        ? { ...draft, subject: next }
        : { ...draft, body: next },
    );
    requestAnimationFrame(() => {
      const target = field === "subject" ? subjectRef.current : bodyRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <SettingsSection
      id="email-templates"
      title="Email templates"
      summary="Placeholders such as {{rfqNumber}} are filled in when the email is sent. The preview uses sample values, never a real vendor's data."
      actions={
        <SectionActions
          dirty={dirty}
          pending={save.isPending}
          error={save.error}
          savedAt={savedAt}
          onSave={requestSave}
          onDiscard={discard}
          saveLabel="Save template"
          canSave={!subjectError && !bodyError}
        />
      }
    >
      {templates.isLoading ? (
        <SectionSkeleton fields={4} />
      ) : templates.error ? (
        <LoadFailure
          title="The templates could not load"
          error={templates.error instanceof Error ? templates.error : null}
          onRetry={() => void templates.refetch()}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)]">
          {/* ------------------------------------------------------- list */}
          <div className="min-w-0">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <label htmlFor="template-search" className="sr-only">
                Search templates
              </label>
              <input
                id="template-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search templates"
                className="field-input py-1.5 pl-8 text-[15px]"
              />
            </div>

            <ul className="mt-2.5 max-h-[460px] space-y-0.5 overflow-y-auto pr-1">
              {filtered.map((row) => {
                const active = row.key === selected;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => requestOpen(row.key)}
                      disabled={save.isPending}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        active
                          ? "bg-ink-850 text-white"
                          : "text-slate-600 hover:bg-ink-850 hover:text-white",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                          {friendlyTemplateName(row.key)}
                        </span>
                        {active && dirty ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-accent-500">
                            <span className="sr-only">Unsaved changes</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-500">
                        {editedLabel(row.updatedAt, now)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 ? (
                <li className="px-2.5 py-3 text-[15px] text-slate-500">
                  No template matches “{search.trim()}”.
                </li>
              ) : null}
            </ul>
          </div>

          {/* ----------------------------------------------------- editor */}
          {draft && current ? (
            <div className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-slate-900">
                    {friendlyTemplateName(current.key)}
                  </h3>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">{current.key}</p>
                </div>
                <div className="flex gap-1 lg:hidden">
                  <button
                    type="button"
                    aria-pressed={pane === "edit"}
                    onClick={() => setPane("edit")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[15px]",
                      pane === "edit"
                        ? "border-ink-700 bg-ink-800 text-white"
                        : "border-ink-800 text-slate-500",
                    )}
                  >
                    <Code2 className="size-3.5" aria-hidden />
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-pressed={pane === "preview"}
                    onClick={() => setPane("preview")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[15px]",
                      pane === "preview"
                        ? "border-ink-700 bg-ink-800 text-white"
                        : "border-ink-800 text-slate-500",
                    )}
                  >
                    <Eye className="size-3.5" aria-hidden />
                    Preview
                  </button>
                </div>
              </div>

              <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-slate-500">
                Saving changes this email for every recipient from now on. Emails already sent keep
                the wording they were sent with.
              </p>

              <div className="mt-4 grid gap-5 lg:grid-cols-2">
                {/* fields */}
                <div className={cn("min-w-0 space-y-4", pane === "preview" && "hidden lg:block")}>
                  <div>
                    <Field
                      label="Subject"
                      htmlFor="template-subject"
                      error={subjectError}
                      hint="The line the recipient sees in their inbox."
                    >
                      <TextInput
                        id="template-subject"
                        value={draft.subject}
                        onChange={(value) => setDraft((prev) => (prev ? { ...prev, subject: value } : prev))}
                        invalid={Boolean(subjectError)}
                      />
                    </Field>
                    <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
                      <span>Placeholders work in the subject too.</span>
                      <span
                        className={cn(
                          "tabular-nums",
                          draft.subject.trim().length > SUBJECT_MAX && "text-red-600",
                        )}
                      >
                        {draft.subject.trim().length} / {SUBJECT_MAX}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="template-body" className="field-label">
                      Body (HTML)
                    </label>
                    <textarea
                      id="template-body"
                      ref={bodyRef}
                      rows={14}
                      value={draft.body}
                      onChange={(event) =>
                        setDraft((prev) => (prev ? { ...prev, body: event.target.value } : prev))
                      }
                      onFocus={() => {
                        lastField.current = "body";
                      }}
                      spellCheck={false}
                      aria-invalid={Boolean(bodyError) || undefined}
                      aria-describedby={bodyError ? "template-body-error" : undefined}
                      className={cn(
                        "field-input resize-y font-mono text-[14px] leading-relaxed",
                        bodyError && "border-red-300 focus:border-red-400",
                      )}
                    />
                    {bodyError ? (
                      <p id="template-body-error" className="mt-1 text-xs font-medium text-red-600">
                        {bodyError}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">
                        Keep the layout tags intact; the preview shows what the recipient gets.
                      </p>
                    )}
                  </div>

                  <div className="border-t border-ink-800 pt-4">
                    <p className="text-[15px] font-medium text-slate-900">
                      Variables in this template
                    </p>
                    {originalVariables.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">
                        The saved template uses no placeholders.
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-xs text-slate-500">
                          Click a variable to insert it where the cursor is.
                        </p>
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {originalVariables.map((name) => (
                            <li key={name}>
                              <button
                                type="button"
                                onClick={() => insertVariable(name)}
                                className="rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 font-mono text-xs text-slate-700 transition-colors hover:border-ink-700 hover:bg-ink-800 hover:text-white"
                              >
                                {name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>

                  {removedVariables.length > 0 ? (
                    <Callout>
                      No longer used: {removedVariables.join(", ")}. The email will be sent without
                      {removedVariables.length === 1 ? " it" : " them"}.
                    </Callout>
                  ) : null}
                  {addedVariables.length > 0 ? (
                    <Callout>
                      Not in the saved template: {addedVariables.join(", ")}. If the portal does not
                      fill a name it stays in the email exactly as typed, so check the preview and
                      the sent copy.
                    </Callout>
                  ) : null}
                </div>

                {/* preview */}
                <div className={cn("min-w-0", pane === "edit" && "hidden lg:block")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[15px] font-medium text-slate-900">Preview</p>
                    <p className="text-xs text-slate-500">Sample values · no scripts run</p>
                  </div>
                  <div className="mt-2 overflow-hidden rounded-xl border border-ink-800 bg-white">
                    <iframe
                      title={`Preview of ${friendlyTemplateName(current.key)}`}
                      sandbox=""
                      srcDoc={previewHtml}
                      className="h-[520px] w-full"
                    />
                  </div>
                  {unknownVariables.length > 0 ? (
                    <div className="mt-3">
                      <Callout>
                        <span className="font-medium">
                          The portal does not fill{" "}
                          {unknownVariables.length === 1 ? "this placeholder" : "these placeholders"}:
                        </span>{" "}
                        {unknownVariables.join(", ")}.{" "}
                        {unknownVariables.length === 1 ? "It stays" : "They stay"} in the email
                        exactly as typed — outlined in the preview above. Check the saved template
                        before relying on it.
                      </Callout>
                    </div>
                  ) : null}
                </div>
              </div>

              {save.error ? (
                <div className="mt-4">
                  <Alert tone="error" title="The template was not saved">
                    {save.error.message}
                  </Alert>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingKey !== null}
        title="Discard your changes to this template?"
        confirmLabel="Discard and switch"
        cancelLabel="Keep editing"
        onCancel={() => setPendingKey(null)}
        onConfirm={() => {
          const row = rows.find((candidate) => candidate.key === pendingKey);
          setPendingKey(null);
          if (row) openTemplate(row);
        }}
      >
        The draft you have now has not been saved. Switching templates throws it away.
      </ConfirmDialog>
    </SettingsSection>
  );
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.subject === b.subject && a.body === b.body;
}


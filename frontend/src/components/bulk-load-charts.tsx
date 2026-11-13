import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Upload, X } from "lucide-react";
import { uploadLoadChart, type Crane } from "@/lib/fleet";
import { matchChartFile } from "@/lib/chartMatch";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Spinner } from "@/components/ui/spinner";

/**
 * Attaching load charts in bulk (sales and admin), matched to the fleet in the
 * browser and uploaded through the existing single-chart endpoint.
 *
 * The design is deliberately a **review step, not a fire-and-forget import**:
 * file names are matched to serial numbers as a suggestion, every row can be
 * reassigned or left out, and nothing is uploaded until the user presses the
 * button. A wrong chart on the wrong crane is worse than no chart.
 *
 * There is no batch endpoint. Each selected file is a normal
 * `POST /cranes/:craneId/load-chart` call, so type validation, scoping, storage
 * layout, replacement cleanup and audit are the same code as attaching one chart
 * by hand. Three uploads run at a time and each row reports its own outcome; one
 * bad file never stops the rest.
 *
 * One chart per crane is a portal rule, not a UI preference: if two selected
 * files point at the same crane the later one is skipped rather than silently
 * replacing the one that just uploaded. Replacing an existing chart is possible
 * but flagged in the row before the upload starts.
 */

const MAX_FILES_PER_BATCH = 250;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = /\.(pdf|jpe?g|png)$/i;
const CONCURRENCY = 3;

type RowStatus = "ready" | "uploading" | "uploaded" | "replaced" | "failed" | "skipped";

interface ChartRow {
  id: string;
  file: File;
  craneId: string | null;
  selected: boolean;
  status: RowStatus;
  message: string | null;
}

let rowSequence = 0;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function badgeFor(row: ChartRow, hasChart: boolean): { tone: BadgeTone; label: string } {
  switch (row.status) {
    case "uploading":
      return { tone: "blue", label: "Uploading" };
    case "uploaded":
      return { tone: "emerald", label: "Uploaded" };
    case "replaced":
      return { tone: "blue", label: "Replaced" };
    case "failed":
      return { tone: "red", label: "Failed" };
    case "skipped":
      return { tone: "amber", label: "Skipped" };
    case "ready":
      if (!row.craneId) {
        if (row.message?.includes("cranes match this name")) {
          return { tone: "amber", label: "Ambiguous" };
        }
        if (row.message?.startsWith("Matches the deactivated")) {
          return { tone: "amber", label: "Deactivated" };
        }
        return { tone: "neutral", label: "Unmatched" };
      }
      if (!row.selected) return { tone: "neutral", label: "Not selected" };
      return hasChart
        ? { tone: "amber", label: "Will replace" }
        : { tone: "emerald", label: "Ready" };
  }
}

/** Runs `worker` over items with a small concurrency limit, preserving order of completion. */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

export function BulkLoadCharts({
  vendorId,
  cranes,
}: {
  vendorId: string;
  cranes: Crane[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChartRow[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finished, setFinished] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const activeCranes = useMemo(
    () => cranes.filter((crane) => crane.isActive),
    [cranes],
  );
  const craneById = useMemo(
    () => new Map(activeCranes.map((crane) => [crane.id, crane])),
    [activeCranes],
  );

  const selected = rows.filter((row) => row.status === "ready" && row.selected && row.craneId);
  const done = rows.filter((row) =>
    ["uploaded", "replaced", "failed", "skipped"].includes(row.status),
  );
  const uploadedCount = rows.filter((row) =>
    ["uploaded", "replaced"].includes(row.status),
  ).length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const skippedCount = rows.filter((row) => row.status === "skipped").length;

  function reset() {
    setRows([]);
    setAddError(null);
    setFinished(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    if (uploading) return;
    setOpen(false);
    reset();
  }

  function addFiles(files: File[]) {
    setFinished(false);
    setAddError(null);

    const remaining = MAX_FILES_PER_BATCH - rows.length;
    if (remaining <= 0) {
      setAddError(`A batch holds at most ${MAX_FILES_PER_BATCH} files. Upload this set first.`);
      return;
    }
    const accepted = files.slice(0, remaining);
    if (files.length > remaining) {
      setAddError(
        `Only the first ${remaining} files were added — a batch holds at most ${MAX_FILES_PER_BATCH}.`,
      );
    }

    const next: ChartRow[] = accepted.map((file) => {
      rowSequence += 1;
      const id = `chart-${rowSequence}`;

      if (!ACCEPTED.test(file.name)) {
        return {
          id,
          file,
          craneId: null,
          selected: false,
          status: "failed",
          message: "Only PDF, JPG and PNG load charts can be attached.",
        };
      }
      if (file.size > MAX_BYTES) {
        return {
          id,
          file,
          craneId: null,
          selected: false,
          status: "failed",
          message: `Larger than 10 MB (${formatSize(file.size)}).`,
        };
      }

      const match = matchChartFile(file.name, cranes);
      if (match.kind === "matched") {
        const hasChart = Boolean(match.crane.loadChart);
        return {
          id,
          file,
          craneId: match.crane.id,
          selected: !hasChart,
          status: "ready",
          message: hasChart
            ? "This crane already has a chart — tick the row only if you mean to replace it"
            : match.how === "exact"
              ? "Matched on the serial number"
              : "Matched on the serial number at the start of the file name",
        };
      }
      if (match.kind === "ambiguous") {
        return {
          id,
          file,
          craneId: null,
          selected: false,
          status: "ready",
          message: `${match.candidates.length} cranes match this name — choose one`,
        };
      }
      if (match.kind === "inactive") {
        return {
          id,
          file,
          craneId: null,
          selected: false,
          status: "ready",
          message: `Matches the deactivated crane ${match.crane.serialRegistrationNo} — choose an active one`,
        };
      }
      return {
        id,
        file,
        craneId: null,
        selected: false,
        status: "ready",
        message: "No crane serial matched this file name — choose one",
      };
    });

    setRows((previous) => [...previous, ...next]);
  }

  function assign(rowId: string, craneId: string | null) {
    setRows((previous) =>
      previous.map((row) =>
        row.id === rowId
          ? {
              ...row,
              craneId,
              selected: craneId !== null,
              message:
                craneId === null
                  ? "No crane chosen"
                  : craneById.get(craneId)?.loadChart
                    ? "This crane already has a chart; uploading replaces it"
                    : "Chosen by hand",
            }
          : row,
      ),
    );
  }

  function toggle(rowId: string) {
    setRows((previous) =>
      previous.map((row) =>
        row.id === rowId ? { ...row, selected: !row.selected } : row,
      ),
    );
  }

  function remove(rowId: string) {
    setRows((previous) => previous.filter((row) => row.id !== rowId));
  }

  async function startUpload() {
    if (uploading) return;

    // One chart per crane: the first selected row for a crane wins, the rest are
    // reported instead of quietly overwriting it.
    const claimed = new Set<string>();
    const queue: ChartRow[] = [];
    const duplicates: string[] = [];
    for (const row of selected) {
      const craneId = row.craneId!;
      if (claimed.has(craneId)) {
        duplicates.push(row.id);
        continue;
      }
      claimed.add(craneId);
      queue.push(row);
    }
    if (duplicates.length > 0) {
      setRows((previous) =>
        previous.map((row) =>
          duplicates.includes(row.id)
            ? {
                ...row,
                status: "skipped",
                selected: false,
                message:
                  "Another file in this batch is already assigned to this crane — one chart per crane",
              }
            : row,
        ),
      );
    }

    setUploading(true);
    try {
      await runPool(queue, CONCURRENCY, async (row) => {
        const craneId = row.craneId!;
        const hadChart = Boolean(craneById.get(craneId)?.loadChart);
        setRows((previous) =>
          previous.map((item) =>
            item.id === row.id ? { ...item, status: "uploading" } : item,
          ),
        );
        try {
          await uploadLoadChart(craneId, row.file);
          setRows((previous) =>
            previous.map((item) =>
              item.id === row.id
                ? {
                    ...item,
                    status: hadChart ? "replaced" : "uploaded",
                    selected: false,
                    message: hadChart ? "Replaced the crane's previous chart" : null,
                  }
                : item,
            ),
          );
        } catch (error) {
          setRows((previous) =>
            previous.map((item) =>
              item.id === row.id
                ? {
                    ...item,
                    status: "failed",
                    selected: false,
                    message:
                      error instanceof Error ? error.message : "The chart could not be uploaded",
                  }
                : item,
            ),
          );
        }
      });
    } finally {
      setUploading(false);
      setFinished(true);
      void queryClient.invalidateQueries({
        queryKey: ["fleet", "list", "vendor", vendorId],
      });
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary px-3 py-2 text-sm"
        onClick={() => setOpen(true)}
      >
        <FileUp className="size-4" aria-hidden />
        Attach charts
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-charts-title"
            className="card w-full max-w-4xl overflow-hidden"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id="bulk-charts-title" className="text-sm font-semibold text-slate-900">
                  Attach load charts
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Charts are matched to cranes by serial number. Review every match before
                  uploading — nothing is attached until you press the button.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={uploading}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-ink-800 hover:text-slate-700 disabled:opacity-40"
                aria-label="Close"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div
                className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-ink-900/60 px-4 py-6 text-center"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (uploading) return;
                  addFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <p className="text-sm text-slate-600">
                  Drop PDF, JPG or PNG charts here, or
                </p>
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  onClick={() => inputRef.current?.click()}
                  disabled={uploading}
                >
                  <FileUp className="size-4" aria-hidden />
                  Choose files
                </button>
                <p className="text-xs text-slate-500">
                  Name each file after the crane serial (for example{" "}
                  <span className="font-mono">ISO-SERIAL-A.pdf</span>) to match automatically.
                  Up to 250 files, 10 MB each.
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="hidden"
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </div>

              {addError ? <Alert tone="info" title="Some files were not added">{addError}</Alert> : null}

              {activeCranes.length === 0 ? (
                <Alert tone="info" title="This vendor has no active cranes">
                  Add or reactivate a crane before attaching load charts.
                </Alert>
              ) : null}

              {finished ? (
                <Alert
                  tone={failedCount > 0 ? "info" : "success"}
                  title={`Upload finished — ${uploadedCount} chart${
                    uploadedCount === 1 ? "" : "s"
                  } attached`}
                >
                  {failedCount > 0 || skippedCount > 0
                    ? `${failedCount} failed, ${skippedCount} skipped. Fix those rows and add the files again.`
                    : "Every selected chart was attached to its crane."}
                </Alert>
              ) : null}

              {rows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No files added yet. Choose a batch to see the matches.
                </p>
              ) : (
                <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-slate-200">
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-10"> </TH>
                        <TH>File</TH>
                        <TH className="w-64">Crane</TH>
                        <TH className="w-28">Status</TH>
                        <TH>Detail</TH>
                        <TH className="w-10"> </TH>
                      </TR>
                    </THead>
                    <TBody>
                      {rows.map((row) => {
                        const crane = row.craneId ? craneById.get(row.craneId) : null;
                        const hasChart = Boolean(crane?.loadChart);
                        const badge = badgeFor(row, hasChart);
                        const locked = uploading || row.status !== "ready";
                        return (
                          <TR key={row.id}>
                            <TD>
                              <input
                                type="checkbox"
                                className="size-4 rounded border-slate-300"
                                checked={row.selected}
                                disabled={locked || !row.craneId}
                                onChange={() => toggle(row.id)}
                                aria-label={`Include ${row.file.name}`}
                              />
                            </TD>
                            <TD className="text-xs">
                              <p className="max-w-56 truncate font-medium text-slate-800" title={row.file.name}>
                                {row.file.name}
                              </p>
                              <p className="text-slate-500">{formatSize(row.file.size)}</p>
                            </TD>
                            <TD>
                              <select
                                className="field-input w-full py-1.5 text-xs"
                                value={row.craneId ?? ""}
                                disabled={locked}
                                onChange={(event) => assign(row.id, event.target.value || null)}
                                aria-label={`Crane for ${row.file.name}`}
                              >
                                <option value="">Choose crane…</option>
                                {activeCranes.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.serialRegistrationNo} · {option.make} {option.model}
                                    {option.loadChart ? " (has chart)" : ""}
                                  </option>
                                ))}
                              </select>
                            </TD>
                            <TD>
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            </TD>
                            <TD className="text-xs">
                              {row.message ? (
                                <p className="text-slate-600">{row.message}</p>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </TD>
                            <TD>
                              <button
                                type="button"
                                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-ink-800 hover:text-slate-700 disabled:opacity-40"
                                onClick={() => remove(row.id)}
                                disabled={locked}
                                aria-label={`Remove ${row.file.name}`}
                              >
                                <X className="size-3.5" aria-hidden />
                              </button>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <p className="text-xs text-slate-500">
                {selected.length > 0
                  ? `${selected.length} chart${selected.length === 1 ? "" : "s"} selected`
                  : "No charts selected"}
                {uploading ? ` · ${done.length} finished` : ""}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  onClick={close}
                  disabled={uploading}
                >
                  {finished ? "Done" : "Cancel"}
                </button>
                <button
                  type="button"
                  className="btn-primary px-3 py-2 text-sm"
                  onClick={startUpload}
                  disabled={uploading || finished || selected.length === 0}
                >
                  {uploading ? <Spinner /> : <Upload className="size-4" aria-hidden />}
                  {uploading
                    ? "Uploading…"
                    : selected.length > 0
                      ? `Upload ${selected.length} chart${selected.length === 1 ? "" : "s"}`
                      : "Upload charts"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

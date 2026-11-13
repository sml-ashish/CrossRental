import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, ListPlus, Upload, X } from "lucide-react";
import {
  downloadBulkEnquiryTemplate,
  importBulkLines,
  previewBulkLines,
  type BulkLineResult,
  type BulkLineRowResult,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Spinner } from "@/components/ui/spinner";

/**
 * Bulk add lines to one enquiry (sales and admin).
 *
 * Same two-step shape as the enquiry and crane uploads — choose the file,
 * **check** it, then import — with one important difference: the target is the
 * enquiry on screen, never a cell in the sheet. There is no `Enquiry no` column
 * to mistype, so a row cannot land on a different enquiry than the one the
 * upload was started from.
 *
 * The header columns of the template are ignored here: customer, site, state and
 * date already belong to the enquiry. A row only has to carry its line fields,
 * of which crane type and capacity are the required ones.
 */

const MAX_BYTES = 5 * 1024 * 1024;

function statusTone(status: BulkLineRowResult["status"]): BadgeTone {
  switch (status) {
    case "imported":
    case "valid":
      return "emerald";
    case "failed":
      return "red";
  }
}

function statusLabel(status: BulkLineRowResult["status"]): string {
  return status === "valid" ? "Ready" : status[0]!.toUpperCase() + status.slice(1);
}

function ReportTable({ rows }: { rows: BulkLineRowResult[] }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
      <Table>
        <THead>
          <TR>
            <TH className="w-16">Row</TH>
            <TH className="w-16">Line</TH>
            <TH className="w-24">Status</TH>
            <TH>Detail</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.row}>
              <TD className="text-xs tabular-nums text-slate-500">{row.row}</TD>
              <TD className="text-xs tabular-nums">{row.lineNo ?? "—"}</TD>
              <TD>
                <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
              </TD>
              <TD className="text-xs">
                {row.message ? <p className="text-slate-700">{row.message}</p> : null}
                {row.warnings.map((warning) => (
                  <p key={warning} className="mt-0.5 text-amber-700">
                    {warning}
                  </p>
                ))}
                {!row.message && row.warnings.length === 0 ? (
                  <span className="text-slate-400">—</span>
                ) : null}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function Summary({ result }: { result: BulkLineResult }) {
  const { summary } = result;
  const parts = [
    `${summary.total} row${summary.total === 1 ? "" : "s"}`,
    result.dryRun
      ? `${summary.valid} ready`
      : `${summary.imported} line${summary.imported === 1 ? "" : "s"} added`,
    `${summary.failed} failed`,
  ];
  return <p className="text-sm font-medium text-slate-800">{parts.join(" · ")}</p>;
}

export function EnquiryBulkLines({
  enquiryId,
  enquiryNo,
}: {
  enquiryId: string;
  enquiryNo: string;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkLineResult | null>(null);
  const [result, setResult] = useState<BulkLineResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const check = useMutation({
    mutationFn: (next: File) => previewBulkLines(enquiryId, next),
    onSuccess: (data) => setPreview(data),
  });

  const run = useMutation({
    mutationFn: (next: File) => importBulkLines(enquiryId, next),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ["enquiry", enquiryId] });
      void queryClient.invalidateQueries({ queryKey: ["enquiries"] });
    },
  });

  const template = useMutation({ mutationFn: downloadBulkEnquiryTemplate });

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setFileError(null);
    check.reset();
    run.reset();
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    setOpen(false);
    reset();
  }

  function choose(next: File | undefined) {
    if (!next) return;
    setFileError(null);
    setResult(null);
    setPreview(null);

    if (!next.name.toLowerCase().endsWith(".xlsx")) {
      setFileError("Choose an .xlsx file. Export or save your sheet as Excel first.");
      return;
    }
    if (next.size > MAX_BYTES) {
      setFileError("That file is larger than 5 MB. Split it into smaller uploads.");
      return;
    }

    setFile(next);
    check.mutate(next);
  }

  const ready = preview?.summary.valid ?? 0;
  const busy = check.isPending || run.isPending;

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <ListPlus className="size-3.5" aria-hidden />
        Add lines in bulk
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-lines-title"
            className="card w-full max-w-3xl overflow-hidden"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id="bulk-lines-title" className="text-sm font-semibold text-slate-900">
                  Add lines to {enquiryNo}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  One row per crane requirement. The customer, site and date come from this
                  enquiry, so the header columns in the sheet are ignored — only the line
                  columns are read. Up to 250 rows per upload.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-ink-800 hover:text-slate-700"
                aria-label="Close"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  onClick={() => template.mutate()}
                  disabled={template.isPending}
                >
                  <Download className="size-4" aria-hidden />
                  {template.isPending ? "Preparing…" : "Download template"}
                </button>
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  onClick={() => inputRef.current?.click()}
                  disabled={busy}
                >
                  <FileSpreadsheet className="size-4" aria-hidden />
                  {file ? "Choose a different file" : "Choose .xlsx file"}
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={(event) => choose(event.target.files?.[0])}
                />
                {file ? (
                  <span className="truncate text-xs text-slate-500" title={file.name}>
                    {file.name}
                  </span>
                ) : null}
              </div>

              {template.isError ? (
                <Alert title="The template could not be downloaded">
                  {(template.error as Error).message}
                </Alert>
              ) : null}

              {fileError ? <Alert title="That file cannot be used">{fileError}</Alert> : null}

              {check.isError ? (
                <Alert title="The file could not be checked">
                  {(check.error as Error).message}
                </Alert>
              ) : null}

              {check.isPending ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner /> Checking the sheet…
                </div>
              ) : null}

              {preview && !result ? (
                <div className="space-y-3">
                  <Summary result={preview} />
                  {preview.summary.valid === 0 ? (
                    <Alert tone="info" title="Nothing can be added from this file">
                      Fix the failed rows, then choose the corrected file.
                    </Alert>
                  ) : null}
                  <ReportTable rows={preview.rows} />
                </div>
              ) : null}

              {run.isError ? (
                <Alert title="The upload did not finish">{(run.error as Error).message}</Alert>
              ) : null}

              {result ? (
                <div className="space-y-3">
                  <Alert
                    tone={result.summary.failed > 0 ? "info" : "success"}
                    title={`Upload finished — ${result.summary.imported} line${
                      result.summary.imported === 1 ? "" : "s"
                    } added to ${result.enquiryNo}`}
                  >
                    Each valid row became a line on this enquiry. Rows that failed can be fixed
                    and uploaded again; the report below names the row and the column.
                  </Alert>
                  <Summary result={result} />
                  <ReportTable rows={result.rows} />
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={close}>
                {result ? "Done" : "Cancel"}
              </button>
              <button
                type="button"
                className="btn-primary px-3 py-2 text-sm"
                disabled={!file || !preview || ready === 0 || busy || Boolean(result)}
                onClick={() => file && run.mutate(file)}
              >
                <Upload className="size-4" aria-hidden />
                {run.isPending
                  ? "Adding…"
                  : ready > 0
                    ? `Add ${ready} line${ready === 1 ? "" : "s"}`
                    : "Add lines"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

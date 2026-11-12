import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { downloadSapSheet, loadSapSheet } from "@/lib/onboarding";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";

/**
 * The SAP vendor creation sheet (brief D3), admin only.
 *
 * SAP is parked, so this is the bridge: the same fields, in the same order as
 * the SAP-aligned form, on one page an admin can print or export. It reads a
 * dedicated endpoint rather than reusing the detail screen because it is the one
 * place that decrypted bank details are laid out for transcription.
 *
 * The surrounding app chrome is hidden when printing (see `print:` classes in
 * the layout), so what reaches paper is just the sheet.
 */
export function SapSheetPage() {
  const { vendorId } = useParams({ from: "/app/vendors/$vendorId/sap-sheet" });

  const sheet = useQuery({
    queryKey: ["sap-sheet", vendorId],
    queryFn: () => loadSapSheet(vendorId),
  });

  if (sheet.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Building the SAP creation sheet
      </div>
    );
  }

  if (sheet.error) {
    return <Alert title="Could not build this sheet">{(sheet.error as Error).message}</Alert>;
  }

  const data = sheet.data?.sheet;
  if (!data) return null;

  const exportExcel = async () => {
    const { blob, fileName } = await downloadSapSheet(vendorId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        className="print:hidden"
        back={{ to: `/app/vendors/${vendorId}`, label: "Back to the registration" }}
        title="SAP vendor creation sheet"
        mono
        description={
          <>
            {data.vendorName || "Vendor"}
            {data.sapVendorCode ? ` · code ${data.sapVendorCode}` : " · no SAP code assigned"}
          </>
        }
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden />
              Print
            </button>
            <button type="button" className="btn-primary" onClick={() => void exportExcel()}>
              <Download className="size-4" aria-hidden />
              Export to Excel
            </button>
          </>
        }
      />

      <article className="card p-6 print:border-0 print:shadow-none">
        <div className="space-y-5">
          {data.sections.map((section) => (
            <section key={section.title} className="break-inside-avoid">
              <h2 className="border-b border-slate-100 pb-1 text-sm font-semibold text-slate-800">
                {section.title}
              </h2>
              <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
                {section.rows.map((row, index) => (
                  <div key={`${section.title}-${row.label}-${index}`} className="flex gap-3 text-sm">
                    <dt className="w-56 shrink-0 text-slate-500">{row.label}</dt>
                    <dd className="min-w-0 flex-1 whitespace-pre-wrap text-slate-900">
                      {row.value === "" ? "—" : row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <footer className="mt-6 border-t border-slate-200 pt-3 text-xs text-slate-400">
          Generated {new Date(data.generatedAt).toLocaleString()}
        </footer>
      </article>
    </div>
  );
}

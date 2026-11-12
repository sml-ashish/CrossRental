import { Link } from "@tanstack/react-router";
import { Alert } from "@/components/ui/alert";
import type { AlertItem } from "@/lib/internalDashboard";

/**
 * P5 alert list. Each row links into the record it names; the server decides
 * what is in the list, this component only renders it.
 */
export function AlertList({ alerts }: { alerts: AlertItem[] }) {
  if (alerts.length === 0) {
    return (
      <Alert tone="success" title="Nothing needs attention">
        No overdue RFQs, expiring quotations or unanswered lines right now.
      </Alert>
    );
  }

  return (
    <ul className="space-y-2">
      {alerts.map((alert) => (
        <li key={alert.id}>
          <div
            className={
              alert.tone === "error"
                ? "rounded-lg border border-red-200 bg-red-50 p-3"
                : alert.tone === "warning"
                  ? "rounded-lg border border-amber-200 bg-amber-50 p-3"
                  : "rounded-lg border border-blue-200 bg-blue-50 p-3"
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{alert.title}</p>
                <p className="mt-0.5 text-xs text-slate-600">{alert.detail}</p>
              </div>
              <Link
                to={alert.to as never}
                className="shrink-0 text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
              >
                Open
              </Link>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

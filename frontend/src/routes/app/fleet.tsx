import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, FileUp, MapPin, Pencil, Plus, Search } from "lucide-react";
import {
  confirmCraneAccurate,
  CRANE_STATUS_LABELS,
  deactivateCrane,
  downloadLoadChart,
  fetchReferenceData,
  isSystemLocked,
  listCranes,
  reactivateCrane,
  uploadLoadChart,
  VENDOR_STATUSES,
  type Crane,
} from "@/lib/fleet";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Field, Select, TextInput } from "@/components/ui/form";
import { Badge, StatusBadge } from "@/components/ui/badge";

/**
 * The vendor's fleet (brief 7.4).
 *
 * This is the screen brief section 8 describes as replacing the shared
 * spreadsheet, so the four things a vendor does most — set a status, move the
 * crane, confirm the details are still true, retire a crane — are reachable from
 * the row itself rather than behind a form. Anything that needs thought (add,
 * edit, duplicate) goes to the crane form.
 *
 * A few deliberate rules:
 *
 * - Deactivated cranes are hidden by default. They stay readable behind the
 *   "Show deactivated" filter because a retired crane still has to be findable.
 * - A crane on an SML contract shows its status and a lock note, not an
 *   editable control. The backend refuses those changes anyway.
 * - Stale and due-for-update badges come from the server's freshness calculation,
 *   so the reminder windows are configurable without touching this screen.
 */

/**
 * One row action, with the same success and failure handling for each.
 *
 * Kept as a hook rather than four copies of a mutation so a refusal — the 409 on
 * a crane SML has booked, say — is reported the same way everywhere.
 */
function useRowAction({
  onDone,
  onSuccess,
  onError,
}: {
  onDone: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}) {
  return useMutation({
    mutationFn: (input: { run: () => Promise<unknown>; success: string }) =>
      input.run().then(() => input.success),
    onSuccess: (message: string) => {
      onError(""); 
      onSuccess(message);
      onDone();
    },
    onError: (error: unknown) => {
      onSuccess("");
      onError(error instanceof Error ? error.message : "That action could not be completed.");
    },
  });
}

export function FleetPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { notice?: string };

  const [status, setStatus] = useState("");
  const [typeOfCraneCode, setTypeOfCraneCode] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(search.notice ?? null);

  const reference = useQuery({
    queryKey: ["fleet", "reference-data"],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,
  });

  const fleet = useQuery({
    queryKey: ["fleet", "list", status, typeOfCraneCode, stateCode, query, includeInactive],
    queryFn: () =>
      listCranes({ status, typeOfCraneCode, stateCode, search: query, includeInactive }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["fleet"] });

  const confirmAccurate = useRowAction({ onDone: refresh, onError: setActionError, onSuccess: setNotice });
  const deactivate = useRowAction({ onDone: refresh, onError: setActionError, onSuccess: setNotice });
  const reactivate = useRowAction({ onDone: refresh, onError: setActionError, onSuccess: setNotice });
  const uploadChart = useMutation({
    mutationFn: ({ craneId, file }: { craneId: string; file: File }) => uploadLoadChart(craneId, file),
    onSuccess: () => {
      setActionError(null);
      setNotice("Load chart uploaded.");
      void refresh();
    },
    onError: (error: unknown) =>
      setActionError(error instanceof Error ? error.message : "The upload failed."),
  });

  const busy = confirmAccurate.isPending || deactivate.isPending || reactivate.isPending || uploadChart.isPending;

  const cranes = fleet.data?.cranes ?? [];
  const activeCranes = cranes.filter((c) => c.isActive);
  const staleCount = activeCranes.filter((c) => c.freshness.stale).length;
  const unverifiedCount = activeCranes.filter((c) => c.locationUnverified).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">My Fleet</h1>
          <p className="mt-1 text-sm text-slate-500">
            {fleet.isLoading
              ? "Loading your cranes…"
              : `${activeCranes.length} active ${activeCranes.length === 1 ? "crane" : "cranes"}` +
                (staleCount > 0 ? ` · ${staleCount} need a data update` : "") +
                (unverifiedCount > 0 ? ` · ${unverifiedCount} missing a map pin` : "")}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void navigate({ to: "/app/fleet/new", search: { duplicate: undefined, vendorId: undefined } })}
        >
          <Plus className="size-4" aria-hidden /> Add crane
        </button>
      </header>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      <div className="card p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchText.trim());
          }}
        >
          <Field label="Search" htmlFor="fleet-search" hint="Serial, location, make or model.">
            <TextInput
              id="fleet-search"
              value={searchText}
              onChange={setSearchText}
              placeholder="e.g. LTM 1100"
            />
          </Field>

          <Field label="Status" htmlFor="fleet-status">
            <Select
              id="fleet-status"
              value={status}
              onChange={setStatus}
              options={[
                ...VENDOR_STATUSES.map((s) => ({ value: s, label: CRANE_STATUS_LABELS[s] })),
                { value: "BOOKED", label: CRANE_STATUS_LABELS.BOOKED },
                { value: "HIRED", label: CRANE_STATUS_LABELS.HIRED },
              ]}
              placeholder="Any status"
            />
          </Field>

          <Field label="Type" htmlFor="fleet-type">
            <Select
              id="fleet-type"
              value={typeOfCraneCode}
              onChange={setTypeOfCraneCode}
              options={(reference.data?.craneTypes ?? []).map((c) => ({ value: c.code, label: c.name }))}
              placeholder="Any type"
            />
          </Field>

          <Field label="State" htmlFor="fleet-state">
            <Select
              id="fleet-state"
              value={stateCode}
              onChange={setStateCode}
              options={(reference.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }))}
              placeholder="Any state"
            />
          </Field>

          <div className="flex items-end gap-3 lg:col-span-4">
            <button type="submit" className="btn-secondary">
              <Search className="size-4" aria-hidden /> Apply
            </button>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
                className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Show deactivated
            </label>
          </div>
        </form>
      </div>

      {fleet.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500" role="status">
          <Spinner /> Loading your cranes
        </div>
      ) : fleet.isError ? (
        <Alert tone="error">{fleet.error instanceof Error ? fleet.error.message : "Could not load your fleet."}</Alert>
      ) : cranes.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No cranes to show</p>
          <p className="mt-1 text-sm text-slate-500">
            {query || status || typeOfCraneCode || stateCode
              ? "No crane matches these filters. Try clearing them."
              : "Add your first crane so SML can consider it for a job."}
          </p>
          {!query && !status && !typeOfCraneCode && !stateCode ? (
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={() => void navigate({ to: "/app/fleet/new", search: { duplicate: undefined, vendorId: undefined } })}
            >
              <Plus className="size-4" aria-hidden /> Add crane
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {cranes.map((crane) => (
            <li key={crane.id}>
              <CraneRow
                crane={crane}
                busy={busy}
                onConfirmAccurate={() =>
                  confirmAccurate.mutate({
                    run: () => confirmCraneAccurate(crane.id),
                    success: "Marked as still accurate.",
                  })
                }
                onDuplicate={() => void navigate({ to: "/app/fleet/new", search: { duplicate: crane.id, vendorId: undefined } })}
                onUploadChart={(file) => uploadChart.mutate({ craneId: crane.id, file })}
                onDownloadChart={() => {
                  void downloadLoadChart(crane).catch((error: unknown) =>
                    setActionError(error instanceof Error ? error.message : "The download failed."),
                  );
                }}
                onDeactivate={() =>
                  deactivate.mutate({
                    run: () => deactivateCrane(crane.id),
                    success: "Crane deactivated.",
                  })
                }
                onReactivate={() =>
                  reactivate.mutate({
                    run: () => reactivateCrane(crane.id),
                    success: "Crane reactivated.",
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CraneRow({
  crane,
  busy,
  onConfirmAccurate,
  onDuplicate,
  onUploadChart,
  onDownloadChart,
  onDeactivate,
  onReactivate,
}: {
  crane: Crane;
  busy: boolean;
  onConfirmAccurate: () => void;
  onDuplicate: () => void;
  onUploadChart: (file: File) => void;
  onDownloadChart: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-sm font-semibold text-slate-900">
              {crane.serialRegistrationNo}
            </h2>
            <StatusBadge status={crane.currentStatus} />
            {isSystemLocked(crane) ? (
              <span className="text-xs text-slate-500">Status managed by SML</span>
            ) : null}
            {crane.approvalStatus === "PENDING" ? (
              <Badge tone="amber">Awaiting review</Badge>
            ) : null}
            {crane.freshness.stale ? <Badge tone="red">Stale data</Badge> : null}
            {!crane.freshness.stale && crane.freshness.dueForUpdate ? (
              <Badge tone="amber">Update due</Badge>
            ) : null}
            {!crane.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
            {crane.updatedOnBehalf ? (
              <Badge tone="blue">Updated by SML on your behalf</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {crane.make} {crane.model} · {crane.capacityT}T · {crane.yom}
            {crane.typeOfCrane ? ` · ${crane.typeOfCrane.name}` : ""}
          </p>
          <p className="mt-0.5 text-sm text-slate-600">
            {crane.currentLocation}
            {crane.state ? `, ${crane.state.name}` : ""}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden />
              {crane.locationUnverified ? (
                <span className="text-amber-700">No map pin yet</span>
              ) : (
                `${crane.coordinateSource === "manual" ? "Pin corrected by you" : "Placed automatically"}` +
                  (crane.latitude !== null ? ` · ${crane.latitude.toFixed(4)}, ${crane.longitude?.toFixed(4)}` : "")
              )}
            </span>
            {crane.availableFrom ? (
              <span>Available from {formatDate(crane.availableFrom)}</span>
            ) : null}
            {crane.expectedReadyDate ? (
              <span>Expected ready {formatDate(crane.expectedReadyDate)}</span>
            ) : null}
            <span>
              Data last confirmed {crane.freshness.daysSinceUpdate}{" "}
              {crane.freshness.daysSinceUpdate === 1 ? "day" : "days"} ago
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/app/fleet/$craneId/edit"
            params={{ craneId: crane.id }}
            className="btn-secondary"
          >
            <Pencil className="size-3.5" aria-hidden /> Edit
          </Link>

          <button type="button" className="btn-secondary" onClick={onDuplicate} disabled={busy}>
            <Copy className="size-3.5" aria-hidden /> Duplicate
          </button>

          <button type="button" className="btn-secondary" onClick={onConfirmAccurate} disabled={busy}>
            <Check className="size-3.5" aria-hidden /> Still accurate
          </button>

          <label className="btn-secondary cursor-pointer">
            <FileUp className="size-3.5" aria-hidden /> Load chart
            <input
              type="file"
              className="sr-only"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUploadChart(file);
                event.target.value = "";
              }}
            />
          </label>

          {crane.loadChart ? (
            <button type="button" className="btn-secondary" onClick={onDownloadChart}>
              View chart
            </button>
          ) : null}

          {crane.isActive ? (
            <button
              type="button"
              className="btn-ghost text-red-700"
              onClick={() => {
                if (
                  window.confirm(
                    "Deactivate this crane? It stays in your records and can be reactivated later.",
                  )
                ) {
                  onDeactivate();
                }
              }}
              disabled={busy}
            >
              Deactivate
            </button>
          ) : (
            <button type="button" className="btn-ghost" onClick={onReactivate} disabled={busy}>
              Reactivate
            </button>
          )}
        </div>
      </div>

      {crane.loadChart ? (
        <p className="mt-2 text-xs text-slate-500">
          Load chart on file: <span className="font-medium">{crane.loadChart.fileName}</span>
        </p>
      ) : (
        <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
          <AlertCircle className="size-3.5" aria-hidden /> No load chart uploaded. SML asks for one before a hire.
        </p>
      )}
    </article>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented, SearchInput } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import {
  listApprovedVendors,
  listRfqs,
  sendRfq,
  type CandidateList,
  type CandidateMode,
  type RfqDetail,
  type RfqListRow,
} from "@/lib/rfqs";
import { TopCranesTable } from "./crane-table";
import { dayMonth } from "./datetime";
import {
  MODE_HINTS,
  PICKER_SORT_OPTIONS,
  type PickerSort,
  TOP_CRANES,
  buildContactedIndex,
  contactFor,
  craneRows,
  topCraneRows,
  vendorIdsOf,
} from "./picker-model";
import { ConfirmPinCard, SendBar, type SelectedVendor } from "./send-rail";

/**
 * Choosing vendors for a draft.
 *
 * The sales user comes here to do one thing: read the recommendation, tick the
 * cranes they like, and send. The recommendation is the ten best cranes for the
 * ranking they pick (Technical or Distance). If it is not good enough, the same
 * screen switches to every approved vendor to choose from by name. Sending is by
 * email only, from the bar at the bottom.
 */

export interface SendOutcome {
  sent: number;
  failed: number;
  failures: Array<{ vendorName: string; error: string }>;
}

const MODE_KEY = "sml.rfq.picker.mode";

function PickerSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-9 w-64" />
      <div className="space-y-2 rounded-xl border border-ink-800 p-4">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex gap-3">
            <Skeleton className="size-4" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function VendorPickerSection({
  rfq,
  alreadySent,
  disabled,
  mode,
  candidates,
  sendBlockedReason,
  onSent,
  onPinConfirmed,
}: {
  rfq: RfqDetail;
  alreadySent: string[];
  disabled: boolean;
  /** Set when the signed-in account lacks the `rfq:dispatch` capability. */
  sendBlockedReason?: string | null;
  mode: CandidateMode;
  /** Kept for the screen that owns the mode; the picker no longer switches it. */
  onModeChange?: (mode: CandidateMode) => void;
  candidates: UseQueryResult<{ candidates: CandidateList }, Error>;
  onSent: (outcome: SendOutcome) => void;
  onPinConfirmed: () => void;
}) {
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as { vendor?: string };
  // Read once, at mount. The RFQ screen rewrites its own `tab` search param, so
  // a live read could lose the vendor between render and the first preselection.
  const [requestedVendorId] = useState<string | null>(() => routeSearch.vendor ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  /** Cranes tagged to the RFQ. A vendor stays selected while any of them is. */
  const [selectedCranes, setSelectedCranes] = useState<string[]>([]);
  /** Set the moment the user changes the shortlist; stops any re-defaulting. */
  const [touched, setTouched] = useState(false);
  const preselectionApplied = useRef(false);
  const [view, setView] = useState<"recommended" | "approved">("recommended");
  const [vendorSearch, setVendorSearch] = useState("");
  const [sort, setSort] = useState<PickerSort>("best");
  const [announce, setAnnounce] = useState("");

  const summary = useQuery({
    queryKey: ["rfqs", "summary"],
    queryFn: () => listRfqs({}),
  });

  const approved = useQuery({
    queryKey: ["rfq-approved-vendors", vendorSearch],
    queryFn: () => listApprovedVendors(vendorSearch),
    // A vendor carried in from the Request window needs a name even when it is
    // not among the ranked candidates, so the list is loaded for that case too.
    enabled: view === "approved" || Boolean(requestedVendorId),
  });

  const contactedIndex = useMemo(
    () => buildContactedIndex((summary.data?.rfqs ?? []) as RfqListRow[], rfq),
    [summary.data, rfq],
  );

  const located = candidates.data?.candidates.located ?? [];
  const unverified = candidates.data?.candidates.unverified ?? [];
  const startDateTbc = candidates.data?.candidates.startDateTbc ?? rfq.startDateTbc;
  const distancesAvailable = candidates.data?.candidates.distancesAvailable ?? false;
  const notice = candidates.data?.candidates.notice ?? null;
  const startLabel = dayMonth(rfq.requiredStartDate);
  const deadlinePassed = new Date(rfq.submissionDeadline).getTime() <= Date.now();
  const hasPin =
    !rfq.siteLocationUnverified && rfq.siteLatitude !== null && rfq.siteLongitude !== null;

  // A vendor can be picked from the approved list and have no crane in the
  // recommendation, so names come from every source we have.
  const nameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of located) names.set(group.vendorId, group.vendorName);
    for (const crane of unverified) names.set(crane.vendorId, crane.vendorName);
    for (const vendor of approved.data?.vendors ?? []) names.set(vendor.id, vendor.name);
    return names;
  }, [located, unverified, approved.data]);

  const send = useMutation({
    // Email is the only channel RFQs go out on.
    mutationFn: () => sendRfq(rfq.id, selected, ["EMAIL"], selectedCranes),
    onSuccess: (result) => {
      const { sent, failed, results } = result.result;
      onSent({
        sent,
        failed,
        failures: results
          .filter((entry) => entry.status === "FAILED" || entry.error)
          .map((entry) => ({
            vendorName: nameById.get(entry.vendorId) ?? "A vendor",
            error: entry.error ?? "The email could not be delivered.",
          })),
      });
      setSelected([]);
      setSelectedCranes([]);
      setTouched(true);
      void queryClient.invalidateQueries({ queryKey: ["rfq", rfq.id] });
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void queryClient.invalidateQueries({ queryKey: ["rfq-candidates", rfq.id] });
    },
  });

  // The recommendation: the ten best cranes for the ranking in force.
  const topRows = useMemo(() => topCraneRows(located, mode, TOP_CRANES, sort), [located, mode, sort]);
  const totalCranes = useMemo(() => craneRows(located).length, [located]);
  const topVendorIds = useMemo(() => vendorIdsOf(topRows), [topRows]);

  const contactedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of located) {
      if (contactFor(contactedIndex, group.vendorName)) ids.add(group.vendorId);
    }
    return ids;
  }, [located, contactedIndex]);

  const vendorOfCrane = useMemo(() => {
    const map = new Map<string, string>();
    for (const { crane, group } of topRows) map.set(crane.craneId, group.vendorId);
    return map;
  }, [topRows]);

  const selectedVendors: SelectedVendor[] = selected.map((vendorId) => ({
    vendorId,
    vendorName: nameById.get(vendorId) ?? "Selected vendor",
    craneCount: selectedCranes.filter((craneId) => vendorOfCrane.get(craneId) === vendorId)
      .length,
  }));

  const contactedSelected = selectedVendors
    .filter((vendor) => contactedIds.has(vendor.vendorId))
    .map((vendor) => vendor.vendorName);

  const selectableTopCranes = topRows
    .filter(({ group }) => !alreadySent.includes(group.vendorId))
    .map(({ crane }) => crane.craneId);
  const allTopCranesSelected =
    selectableTopCranes.length > 0 &&
    selectableTopCranes.every((craneId) => selectedCranes.includes(craneId));

  const selectableTop = topVendorIds.filter((vendorId) => !alreadySent.includes(vendorId));

  const blockReason = disabled
    ? "This RFQ was cancelled and cannot be sent."
    : (sendBlockedReason ??
      (deadlinePassed ? "The deadline has passed. Edit the draft before sending." : null));
  const canSend = blockReason === null && selected.length > 0 && !send.isPending;

  function announceSelection(count: number) {
    setAnnounce(`${count} vendor${count === 1 ? "" : "s"} selected`);
  }

  /** Picking a vendor by name (the approved list) tags no particular crane. */
  function toggle(vendorId: string) {
    if (alreadySent.includes(vendorId)) return;
    setTouched(true);
    const dropping = selected.includes(vendorId);
    if (dropping) {
      setSelectedCranes((previous) =>
        previous.filter((craneId) => vendorOfCrane.get(craneId) !== vendorId),
      );
    }
    setSelected((previous) => {
      const next = dropping
        ? previous.filter((id) => id !== vendorId)
        : [...previous, vendorId];
      announceSelection(next.length);
      return next;
    });
  }

  /** One crane in, one crane out. The vendor follows its cranes. */
  function toggleCrane(craneId: string, vendorId: string) {
    if (alreadySent.includes(vendorId)) return;
    setTouched(true);
    const nextCranes = selectedCranes.includes(craneId)
      ? selectedCranes.filter((id) => id !== craneId)
      : [...selectedCranes, craneId];
    setSelectedCranes(nextCranes);
    const stillHasCrane = nextCranes.some((id) => vendorOfCrane.get(id) === vendorId);
    setSelected((previous) => {
      const has = previous.includes(vendorId);
      const next = stillHasCrane
        ? has
          ? previous
          : [...previous, vendorId]
        : previous.filter((id) => id !== vendorId);
      announceSelection(nextCranes.length);
      return next;
    });
  }

  function toggleAllTop() {
    setTouched(true);
    if (allTopCranesSelected) {
      setSelectedCranes((previous) =>
        previous.filter((craneId) => !selectableTopCranes.includes(craneId)),
      );
      setSelected((previous) => previous.filter((id) => !selectableTop.includes(id)));
    } else {
      setSelectedCranes((previous) => [...new Set([...previous, ...selectableTopCranes])]);
      setSelected((previous) => [...new Set([...previous, ...selectableTop])]);
    }
    announceSelection(allTopCranesSelected ? 0 : selectableTopCranes.length);
  }

  function clearSelection() {
    setTouched(true);
    setSelected([]);
    setSelectedCranes([]);
    setAnnounce("Selection cleared");
  }

  // Remember the ranking this user last chose. The selection is intentionally
  // not persisted: a half-made shortlist should not reappear days later.
  useEffect(() => {
    if (disabled) return;
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Private browsing; the picker still works without the memory.
    }
  }, [mode, disabled]);

  // Nothing is ticked for the user. The one exception is a vendor named in
  // `?vendor=` (from the "Request this crane" window): the person has already
  // chosen who they came to add.
  useEffect(() => {
    if (preselectionApplied.current || touched) return;
    if (!candidates.data) return;
    preselectionApplied.current = true;
    if (requestedVendorId && !alreadySent.includes(requestedVendorId)) {
      setSelected([requestedVendorId]);
      announceSelection(1);
    }
  }, [candidates.data, touched, requestedVendorId, alreadySent]);

  if (candidates.isLoading) return <PickerSkeleton />;

  if (candidates.isError) {
    return (
      <div className="space-y-3">
        <Alert title="Could not load cranes">{(candidates.error as Error).message}</Alert>
        <button
          type="button"
          className="btn-secondary px-3 py-2 text-[15px]"
          onClick={() => void candidates.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const approvedGroups = (approved.data?.vendors ?? []).map((vendor) => ({
    vendor,
    hasCrane: located.some((group) => group.vendorId === vendor.id),
    sendable: vendor.users.length > 0,
  }));

  return (
    <section aria-label="Choose vendors" className="space-y-4">
      {view === "approved" ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setView("recommended")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[15px] font-medium text-slate-600 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
              Back to recommended cranes
            </button>
            <p className="text-[15px] text-slate-500">
              {approvedGroups.filter((entry) => entry.sendable).length} can receive an RFQ
            </p>
          </div>

          <div className="mt-3">
            <SearchInput
              value={vendorSearch}
              onChange={setVendorSearch}
              placeholder="Search approved vendors"
              label="Search approved vendors"
              className="w-72 max-w-full"
            />
          </div>

          {approved.isLoading ? (
            <p className="mt-3 text-[15px] text-slate-500">Loading vendors…</p>
          ) : approved.isError ? (
            <div className="mt-3">
              <Alert title="Could not load approved vendors">
                {(approved.error as Error).message}
              </Alert>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
              {approvedGroups.map(({ vendor, hasCrane, sendable }) => {
                const already = alreadySent.includes(vendor.id);
                const checked = selected.includes(vendor.id);
                return (
                  <li
                    key={vendor.id}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3",
                      checked && "bg-accent-500/[0.07]",
                      (already || !sendable) && "opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={already || !sendable}
                      onChange={() => toggle(vendor.id)}
                      aria-label={`Select ${vendor.name}`}
                      className="mt-1 size-4 cursor-pointer rounded border-slate-400 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-medium text-slate-900">{vendor.name}</p>
                      <p className="mt-0.5 text-[14px] text-slate-500">
                        {vendor.operatingRegions.map((region) => region.state.name).join(", ") ||
                          "No operating regions set"}
                      </p>
                    </div>
                    <span className="shrink-0 text-[14px] text-slate-500">
                      {!sendable
                        ? "No active user"
                        : already
                          ? "Already sent"
                          : hasCrane
                            ? "Has a matching crane"
                            : "No matching crane"}
                    </span>
                  </li>
                );
              })}
              {approvedGroups.length === 0 ? (
                <li className="px-4 py-4 text-[15px] text-slate-500">
                  No approved vendor matches that search.
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={sort}
                onChange={setSort}
                label="Sort recommended cranes"
                options={PICKER_SORT_OPTIONS}
              />
              <p className="text-[15px] text-slate-500">
                {sort === "best"
                  ? MODE_HINTS[mode]
                  : `Same cranes, ordered by distance from the job site — ${
                      sort === "nearest" ? "nearest" : "farthest"
                    } first.`}
              </p>
            </div>
          </div>

          {!hasPin ? <ConfirmPinCard rfqId={rfq.id} onDone={onPinConfirmed} /> : null}

          {notice ? <p className="text-[14px] text-slate-500">{notice}</p> : null}

          {topRows.length === 0 ? (
            <div className="rounded-xl border border-ink-800 bg-ink-900 px-4 py-5">
              <p className="text-[15px] text-slate-700">
                {mode === "technical"
                  ? `No approved vendor has a crane of this type with ${rfq.capacityT} t or more.`
                  : "No approved vendor has a crane of this type on record."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-[14px]"
                  onClick={() => setView("approved")}
                >
                  Choose from all approved vendors
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
                <p className="text-slate-600 tabular-nums">
                  Top {topRows.length} of {totalCranes} matching crane
                  {totalCranes === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <button
                    type="button"
                    onClick={() => setView("approved")}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[14px] font-medium text-accent-400 transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                  >
                    Not right? Choose from all approved vendors
                    <ChevronRight className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={toggleAllTop}
                    disabled={selectableTopCranes.length === 0}
                    className="rounded-md px-2 py-1 text-[14px] font-medium text-slate-600 transition-colors hover:bg-ink-850 hover:text-white disabled:opacity-50"
                  >
                    {allTopCranesSelected ? "Clear these" : "Select all"}
                  </button>
                </div>
              </div>

              <TopCranesTable
                rows={topRows}
                requiredT={rfq.capacityT}
                startDateTbc={startDateTbc}
                startLabel={startLabel}
                showDistance={distancesAvailable}
                selectedCranes={selectedCranes}
                alreadySent={alreadySent}
                contacted={contactedIds}
                onToggleCrane={toggleCrane}
              />

              <p className="text-[14px] text-slate-500">
                Only the cranes you tick are tagged to this RFQ. The vendor is told which ones to quote.
              </p>
            </>
          )}

          {contactedIndex.otherDrafts.length > 0 ? (
            <p className="text-[14px] text-slate-500">
              {contactedIndex.otherDrafts.length} other draft
              {contactedIndex.otherDrafts.length === 1 ? " exists" : "s exist"} for this enquiry
              line: {contactedIndex.otherDrafts.map((row) => row.rfqNumber).join(", ")}. Only send
              one of them.
            </p>
          ) : null}
        </div>
      )}

      <SendBar
        selected={selectedVendors}
        deadline={rfq.submissionDeadline}
        canSend={canSend}
        blockReason={blockReason}
        pending={send.isPending}
        error={send.isError ? (send.error as Error).message : null}
        contacted={contactedSelected}
        onClear={clearSelection}
        onSend={() => send.mutate()}
      />

      {/* Live region: selection is visual everywhere else. */}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}

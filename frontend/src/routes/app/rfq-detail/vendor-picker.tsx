import { useEffect, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Mail,
  MessageCircle,
  Minus,
  MoreHorizontal,
  RotateCcw,
  Send,
  SlidersHorizontal,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented, SearchInput } from "@/components/ui/toolbar";
import { cn } from "@/lib/cn";
import {
  listApprovedVendors,
  listRfqs,
  sendRfq,
  type CandidateCrane,
  type CandidateGroup,
  type CandidateList,
  type CandidateMode,
  type MessageChannel,
  type RfqDetail,
  type RfqListRow,
} from "@/lib/rfqs";
import { deadlineRelative } from "@/lib/rfq-display";
import { AllCranesTable } from "./crane-table";
import { dayMonth } from "./datetime";
import {
  DISTANCE_BANDS,
  EMPTY_FILTERS,
  FAR_KM,
  RECOMMENDED_MAX_KM,
  RECOMMENDED_MAX_VENDORS,
  SORT_HINTS,
  SORT_LABELS,
  buildContactedIndex,
  contactFor,
  craneFilterCount,
  craneRows,
  filtersActive,
  narrowGroup,
  presetAvailable,
  presetNearest,
  presetWithin,
  recommendedVendorIds,
  selectionStats,
  sortGroups,
  vendorStats,
  type ContactedVendor,
  type DistanceBand,
  type PickerFilters,
  type SortMode,
} from "./picker-model";
import { SendRail, SiteCard, type ChecklistItem } from "./send-rail";
import { VendorCard } from "./vendor-row";

/**
 * Choosing vendors for a draft, in one screen.
 *
 * A sales user chooses vendors by the cranes they have, so the default view
 * shows each vendor's three best cranes without a click, and a second view
 * flattens the whole fleet into one sortable table. The rail holds the two
 * things that must never be guessed at: what is still missing, and what the
 * vendor will receive. Sending happens only there.
 */

export interface SendOutcome {
  sent: number;
  failed: number;
  failures: Array<{ vendorName: string; error: string }>;
}

const MODE_KEY = "sml.rfq.picker.mode";
/** Which vendor cards the user last expanded, remembered for this tab only. */
const EXPANDED_KEY = "sml.rfq.picker.cranes";

const RECOMMENDED_RULE = `A recommended vendor has a crane free on or before the start date, its nearest crane is within ${RECOMMENDED_MAX_KM} km of the site, and it has not already been contacted for this enquiry line. At most ${RECOMMENDED_MAX_VENDORS} are pre-selected. Vendors further than ${FAR_KM} km are never pre-selected.`;

function readExpanded(): Record<string, boolean> {
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

function Hint({ label }: { label: string }) {
  return (
    <span className="inline-flex text-slate-500" title={label} aria-label={label} role="img">
      <Info className="size-3.5" aria-hidden />
    </span>
  );
}

function PickerSkeleton() {
  return (
    <div className="grid gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-24" />
        </div>
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-2 border-b border-ink-800 py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-4" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-3 w-20" />
            </div>
            {[0, 1, 2].map((line) => (
              <div key={line} className="flex gap-3 pl-7">
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="hidden space-y-3 min-[1100px]:block">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
    </div>
  );
}

export function VendorPickerSection({
  rfq,
  alreadySent,
  disabled,
  mode,
  onModeChange,
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
  onModeChange: (mode: CandidateMode) => void;
  candidates: UseQueryResult<{ candidates: CandidateList }, Error>;
  onSent: (outcome: SendOutcome) => void;
  onPinConfirmed: () => void;
}) {
  const queryClient = useQueryClient();
  const routeSearch = useSearch({ strict: false }) as { vendor?: string };
  // Read once, at mount. The RFQ screen rewrites its own `tab` search param, so
  // a live read could lose the vendor between render and the first preselection.
  const [requestedVendorId] = useState<string | null>(() => routeSearch.vendor ?? null);
  const [sort, setSort] = useState<SortMode>("best");
  const [filters, setFilters] = useState<PickerFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  /** Set the moment the user changes the shortlist; stops any re-defaulting. */
  const [touched, setTouched] = useState(false);
  const preselectionApplied = useRef(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readExpanded);
  const [view, setView] = useState<"recommended" | "approved">("recommended");
  const [listView, setListView] = useState<"vendor" | "cranes">("vendor");
  const [vendorSearch, setVendorSearch] = useState("");
  const [channels, setChannels] = useState<MessageChannel[]>(["EMAIL"]);
  const [whatsappBlocked, setWhatsappBlocked] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
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

  const send = useMutation({
    mutationFn: () => sendRfq(rfq.id, selected, channels),
    onSuccess: (result) => {
      const { sent, failed, results } = result.result;
      const nameOf = new Map<string, string>();
      for (const group of candidates.data?.candidates.located ?? []) {
        nameOf.set(group.vendorId, group.vendorName);
      }
      for (const crane of candidates.data?.candidates.unverified ?? []) {
        nameOf.set(crane.vendorId, crane.vendorName);
      }
      for (const vendor of approved.data?.vendors ?? []) nameOf.set(vendor.id, vendor.name);

      onSent({
        sent,
        failed,
        failures: results
          .filter((entry) => entry.status === "FAILED" || entry.error)
          .map((entry) => ({
            vendorName: nameOf.get(entry.vendorId) ?? "A vendor",
            error: entry.error ?? "The message could not be delivered.",
          })),
      });
      setSelected([]);
      setTouched(true);
      setMobileOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["rfq", rfq.id] });
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      void queryClient.invalidateQueries({ queryKey: ["rfq-candidates", rfq.id] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "The RFQ could not be sent.";
      if (/whatsapp/i.test(message) && /configured/i.test(message)) {
        setWhatsappBlocked(message);
        setChannels(["EMAIL"]);
      }
    },
  });

  const located = candidates.data?.candidates.located ?? [];
  const unverified = candidates.data?.candidates.unverified ?? [];
  const startDateTbc = candidates.data?.candidates.startDateTbc ?? rfq.startDateTbc;
  const distancesAvailable = candidates.data?.candidates.distancesAvailable ?? false;
  const notice = candidates.data?.candidates.notice ?? null;
  const startLabel = dayMonth(rfq.requiredStartDate);
  const deadlinePassed = new Date(rfq.submissionDeadline).getTime() <= Date.now();
  const relative = deadlineRelative(rfq.submissionDeadline);

  const visible = useMemo(
    () =>
      sortGroups(
        located
          .map((group) => narrowGroup(group, filters, search))
          .filter((group): group is CandidateGroup => group !== null),
        sort,
      ),
    [located, filters, search, sort],
  );

  // The unlocated cranes obey the same filters as the ranked ones, except for
  // distance: they have none, so a distance band must not drop them.
  const visibleUnverified = useMemo(() => {
    const term = search.trim().toLowerCase();
    return unverified.filter((crane) => {
      if (filters.hideStale && crane.stale) return false;
      if (filters.availableOnly && !crane.availableInTime) return false;
      if (filters.chartOnly && !crane.loadChartFileName) return false;
      if (filters.state !== "" && crane.stateCode !== filters.state) return false;
      if (term === "") return true;
      return `${crane.vendorName} ${crane.make} ${crane.model}`.toLowerCase().includes(term);
    });
  }, [unverified, filters, search]);

  const shownCranes = visible.reduce((total, group) => total + group.cranes.length, 0);
  const totalCranes = located.reduce((total, group) => total + group.cranes.length, 0);
  const hiddenCranes = totalCranes - shownCranes;
  const states = useMemo(() => stateOptions(located), [located]);

  const selectableIds = visible
    .map((group) => group.vendorId)
    .filter((vendorId) => !alreadySent.includes(vendorId));
  const selectedVisible = selectableIds.filter((vendorId) => selected.includes(vendorId));
  const allSelected = selectableIds.length > 0 && selectedVisible.length === selectableIds.length;

  // A vendor can be picked from the approved list or the unverified cranes and
  // have no entry in `located`, so the rail is fed from the id list, not from
  // the ranked groups. Otherwise the count and the send would disagree.
  const nameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of located) names.set(group.vendorId, group.vendorName);
    for (const crane of unverified) names.set(crane.vendorId, crane.vendorName);
    for (const vendor of approved.data?.vendors ?? []) names.set(vendor.id, vendor.name);
    return names;
  }, [located, unverified, approved.data]);

  const selectedGroups = useMemo<CandidateGroup[]>(() => {
    const ranked = new Map(located.map((group) => [group.vendorId, group]));
    return selected.map(
      (vendorId) =>
        ranked.get(vendorId) ?? {
          vendorId,
          vendorName: nameById.get(vendorId) ?? "Selected vendor",
          nearestKm: null,
          distanceMethod: null,
          distanceApproximate: false,
          cranes: [],
        },
    );
  }, [located, selected, nameById]);

  const inPlay = selectionStats(selectedGroups);

  const selectedApproved =
    view === "approved"
      ? selected.filter((vendorId) => !located.some((group) => group.vendorId === vendorId))
      : [];

  const contactedSelected = selectedGroups
    .map((group) => contactFor(contactedIndex, group.vendorName))
    .filter((entry): entry is ContactedVendor => Boolean(entry));

  /**
   * The conservative default: never a mass-send, never a vendor already on this
   * enquiry line, never one beyond the named constants.
   */
  const recommendedIds = useMemo(
    () =>
      recommendedVendorIds(located, {
        distancesAvailable,
        contacted: (vendorName) => Boolean(contactFor(contactedIndex, vendorName)),
      }).filter((vendorId) => !alreadySent.includes(vendorId)),
    [located, distancesAvailable, contactedIndex, alreadySent],
  );

  const checklist: ChecklistItem[] = [
    deadlinePassed
      ? {
          key: "deadline",
          label: `Deadline has passed (${relative.label})`,
          tone: "blocked",
          detail: "edit the draft before sending",
        }
      : {
          key: "deadline",
          label: `Deadline ${relative.label} · ${formatDeadlineLabel(rfq.submissionDeadline)}`,
          tone: "ok",
        },
    rfq.siteLocationUnverified
      ? {
          key: "pin",
          label: "Site pin not confirmed",
          tone: "warn",
          detail: "distances and nearest-first ranking are hidden until it is",
        }
      : { key: "pin", label: "Site pin confirmed", tone: "ok" },
    startDateTbc
      ? { key: "start", label: "Start date to be confirmed", tone: "warn" }
      : { key: "start", label: `Start date ${startLabel}`, tone: "ok" },
    selected.length > 0
      ? {
          key: "vendors",
          label: `${selected.length} vendor${selected.length === 1 ? "" : "s"} selected`,
          tone: "ok",
        }
      : { key: "vendors", label: "Select at least one vendor", tone: "warn" },
    channels.length > 0
      ? {
          key: "channels",
          label: channels
            .map((channel) => (channel === "EMAIL" ? "Email" : "WhatsApp"))
            .join(" and "),
          tone: "ok",
        }
      : { key: "channels", label: "Choose at least one channel", tone: "warn" },
  ];

  if (contactedSelected.length > 0) {
    checklist.push({
      key: "contacted",
      label: "Already contacted for this line",
      tone: "warn",
      detail: selectedGroups
        .filter((group) => contactFor(contactedIndex, group.vendorName))
        .map((group) => group.vendorName)
        .join(", "),
    });
  }

  const blockReason =
    disabled
      ? "This RFQ was cancelled and cannot be sent."
      : sendBlockedReason ??
        (deadlinePassed
          ? "The deadline has passed. Edit the draft before sending."
          : selected.length === 0
            ? "Select at least one vendor."
            : channels.length === 0
              ? "Choose at least one channel."
              : null);
  const canSend = blockReason === null && !send.isPending;

  function announceSelection(count: number) {
    setAnnounce(`${count} vendor${count === 1 ? "" : "s"} selected`);
  }

  function toggle(vendorId: string) {
    if (alreadySent.includes(vendorId)) return;
    setTouched(true);
    setSelected((previous) => {
      const next = previous.includes(vendorId)
        ? previous.filter((id) => id !== vendorId)
        : [...previous, vendorId];
      announceSelection(next.length);
      return next;
    });
  }

  function selectAll() {
    setTouched(true);
    setSelected((previous) => {
      const next = allSelected
        ? previous.filter((vendorId) => !selectableIds.includes(vendorId))
        : [...new Set([...previous, ...selectableIds])];
      announceSelection(next.length);
      return next;
    });
  }

  function applyPreset(ids: string[]) {
    const next = ids.filter((vendorId) => !alreadySent.includes(vendorId));
    setTouched(true);
    setSelected(next);
    announceSelection(next.length);
    setMobileOpen(false);
  }

  function clearSelection() {
    setTouched(true);
    setSelected([]);
    setAnnounce("Selection cleared");
  }

  function toggleExpanded(vendorId: string) {
    setExpanded((previous) => ({ ...previous, [vendorId]: !previous[vendorId] }));
  }

  function setAllExpanded(open: boolean) {
    setExpanded((previous) => {
      const next = { ...previous };
      for (const group of visible) next[group.vendorId] = open;
      return next;
    });
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

  // Expansion is a reading preference, so it survives a tab switch but not the
  // browser session.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
    } catch {
      // Private browsing; expansion then only lives in memory.
    }
  }, [expanded]);

  // Pre-selection runs once, after both the fleet and the enquiry history have
  // settled, and never again once the user has touched the shortlist. A vendor
  // named in `?vendor=` (from the "Request this crane" window) wins over the
  // recommendation: the person has already chosen who they came to add.
  useEffect(() => {
    if (preselectionApplied.current || touched) return;
    if (!candidates.data || !summary.isSuccess) return;
    preselectionApplied.current = true;
    const initial =
      requestedVendorId && !alreadySent.includes(requestedVendorId)
        ? [requestedVendorId]
        : recommendedIds;
    setSelected(initial);
    announceSelection(initial.length);
  }, [
    candidates.data,
    summary.isSuccess,
    touched,
    recommendedIds,
    requestedVendorId,
    alreadySent,
  ]);

  // The mobile sheet holds the rail; Esc closes it like any other overlay.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  if (candidates.isLoading) return <PickerSkeleton />;

  if (candidates.isError) {
    return (
      <div className="space-y-3">
        <Alert title="Could not load candidates">{(candidates.error as Error).message}</Alert>
        <button
          type="button"
          className="btn-secondary px-3 py-2 text-[13px]"
          onClick={() => void candidates.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const noCandidates = located.length === 0 && unverified.length === 0;
  const approvedGroups = (approved.data?.vendors ?? []).map((vendor) => ({
    vendor,
    hasCrane: located.some((group) => group.vendorId === vendor.id),
    sendable: vendor.users.length > 0,
  }));
  const craneList = craneRows(visible);
  const showRecommendedLine =
    !touched &&
    recommendedIds.length > 0 &&
    selected.length === recommendedIds.length &&
    recommendedIds.every((vendorId) => selected.includes(vendorId));

  return (
    <section aria-label="Choose vendors" className="space-y-4 pb-24 min-[1100px]:pb-0">
      <div className="grid items-start gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          {view === "approved" ? (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setView("recommended")}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  <ChevronLeft className="size-3" aria-hidden />
                  Back to crane matches
                </button>
                <p className="text-[13px] text-slate-500">
                  {approvedGroups.filter((entry) => entry.sendable).length} can receive an RFQ
                </p>
              </div>

              <div className="mt-2">
                <SearchInput
                  value={vendorSearch}
                  onChange={setVendorSearch}
                  placeholder="Search approved vendors"
                  label="Search approved vendors"
                  className="w-64 max-w-full"
                />
              </div>

              {approved.isLoading ? (
                <p className="mt-3 text-[13px] text-slate-500">Loading vendors…</p>
              ) : approved.isError ? (
                <div className="mt-3">
                  <Alert title="Could not load approved vendors">
                    {(approved.error as Error).message}
                  </Alert>
                </div>
              ) : (
                <ul className="mt-2 divide-y divide-ink-800 border-y border-ink-800">
                  {approvedGroups.map(({ vendor, hasCrane, sendable }) => {
                    const already = alreadySent.includes(vendor.id);
                    const checked = selected.includes(vendor.id);
                    return (
                      <li
                        key={vendor.id}
                        className={cn(
                          "flex items-start gap-3 px-2 py-3",
                          (already || !sendable) && "opacity-60",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={already || !sendable}
                          onChange={() => toggle(vendor.id)}
                          aria-label={`Select ${vendor.name}`}
                          className="mt-1 size-4 cursor-pointer rounded border-slate-600 bg-ink-900 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-semibold text-slate-900">{vendor.name}</p>
                          <p className="mt-0.5 text-[13px] text-slate-600">
                            {vendor.operatingRegions.map((region) => region.state.name).join(", ") ||
                              "No operating regions set"}
                          </p>
                          <p className="mt-0.5 text-[12px] text-slate-500">
                            {!sendable
                              ? "No active user — cannot be sent to"
                              : !hasCrane
                                ? "No matching crane on record"
                                : already
                                  ? "Already a recipient of this RFQ"
                                  : "Has a matching crane"}
                          </p>
                        </div>
                        {!hasCrane && sendable && !already ? (
                          <span className="shrink-0 text-[12px] text-amber-600">Send anyway?</span>
                        ) : null}
                      </li>
                    );
                  })}
                  {approvedGroups.length === 0 && !approved.isLoading ? (
                    <li className="px-2 py-4 text-[13px] text-slate-500">
                      No approved vendor matches that search.
                    </li>
                  ) : null}
                </ul>
              )}

              <p className="mt-2 text-[12px] text-slate-500">
                Selections carry across both views; {selectedApproved.length} of {selected.length}{" "}
                selected {selected.length === 1 ? "vendor is" : "vendors are"} from this list.
              </p>
            </div>
          ) : (
            <>
              {/* --- view switch ------------------------------------------- */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented
                  value={listView}
                  onChange={setListView}
                  label="Crane list view"
                  options={[
                    { value: "vendor", label: "By vendor" },
                    { value: "cranes", label: "All cranes" },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setView("approved")}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  All approved vendors
                  <ChevronRight className="size-3" aria-hidden />
                </button>
              </div>

              {/* --- one filter row ---------------------------------------- */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Segmented
                  value={mode}
                  onChange={onModeChange}
                  label="Recommendation ranking"
                  options={[
                    { value: "technical", label: "Technical" },
                    { value: "distance", label: "Distance based" },
                  ]}
                />
                <Hint
                  label={
                    mode === "technical"
                      ? "Technical: cranes that meet the capacity requirement, smallest adequate first."
                      : "Distance: nearest cranes first, including lighter cranes."
                  }
                />

                <select
                  aria-label="Sort vendors"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortMode)}
                  className="field-input w-36 py-1 text-[12px]"
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map((key) => (
                    <option key={key} value={key}>
                      {SORT_LABELS[key]}
                    </option>
                  ))}
                </select>
                <Hint label={SORT_HINTS[sort]} />

                {distancesAvailable ? (
                  <select
                    aria-label="Distance from site"
                    value={String(filters.band)}
                    onChange={(event) =>
                      setFilters((previous) => ({
                        ...previous,
                        band: Number(event.target.value) as DistanceBand,
                      }))
                    }
                    className="field-input w-32 py-1 text-[12px]"
                  >
                    <option value="0">Any distance</option>
                    {DISTANCE_BANDS.filter((band) => band !== 0).map((band) => (
                      <option key={band} value={band}>
                        Within {band} km
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-[12px] text-amber-700">
                    No site pin, distances hidden
                  </span>
                )}

                {states.length > 1 ? (
                  <select
                    aria-label="Crane state"
                    value={filters.state}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, state: event.target.value }))
                    }
                    className="field-input w-32 py-1 text-[12px]"
                  >
                    <option value="">Any state</option>
                    {states.map((state) => (
                      <option key={state.code} value={state.code}>
                        {state.name}
                      </option>
                    ))}
                  </select>
                ) : null}

                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Vendor, make or model"
                  label="Search vendors, makes or models"
                  className="w-44"
                />

                <FilterPopover
                  label="Cranes"
                  icon={<SlidersHorizontal className="size-3.5" aria-hidden />}
                  badge={craneFilterCount(filters)}
                >
                  <CraneFilters
                    filters={filters}
                    onChange={setFilters}
                    startLabel={startLabel}
                  />
                </FilterPopover>

                <FilterPopover
                  label="Selection presets"
                  icon={<MoreHorizontal className="size-4" aria-hidden />}
                  iconOnly
                  menu
                >
                  <PresetMenu
                    distancesAvailable={distancesAvailable}
                    onNearest={() => applyPreset(presetNearest(visible, 3))}
                    onWithin={() => applyPreset(presetWithin(visible, 500))}
                    onAvailable={() => applyPreset(presetAvailable(visible))}
                    onClear={clearSelection}
                  />
                </FilterPopover>
              </div>

              {notice ? (
                <p className="mt-2 rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-[12px] text-slate-600">
                  {notice}
                </p>
              ) : null}

              {/* --- result line ------------------------------------------- */}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <p className="text-slate-600 tabular-nums">
                  {visible.length} vendor{visible.length === 1 ? "" : "s"} · {shownCranes} crane
                  {shownCranes === 1 ? "" : "s"}
                  {hiddenCranes > 0 ? (
                    <span className="text-slate-500"> · {hiddenCranes} hidden by filters</span>
                  ) : null}
                </p>
                {filtersActive(filters) || search !== "" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFilters(EMPTY_FILTERS);
                      setSearch("");
                    }}
                    className="inline-flex items-center gap-1 text-[12px] text-slate-500 transition-colors hover:text-white"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    Clear filters
                  </button>
                ) : null}
              </div>

              {noCandidates ? (
                <div className="mt-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-5">
                  <p className="text-[13px] text-slate-700">
                    {mode === "technical"
                      ? `No approved vendor has a crane of this type with ${rfq.capacityT} t or more.`
                      : "No approved vendor has a crane of this type on record."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {mode === "technical" ? (
                      <button
                        type="button"
                        className="btn-secondary px-3 py-1.5 text-[12px]"
                        onClick={() => onModeChange("distance")}
                      >
                        Switch to Distance based
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-secondary px-3 py-1.5 text-[12px]"
                      onClick={() => setView("approved")}
                    >
                      Choose from all approved vendors
                    </button>
                  </div>
                </div>
              ) : null}

              {!noCandidates && visible.length === 0 ? (
                <p className="mt-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-4 text-[13px] text-slate-500">
                  Nothing matches these filters. Clear them, or switch to all approved vendors.
                </p>
              ) : null}

              {visible.length > 0 ? (
                <>
                  {showRecommendedLine ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <p className="text-slate-600">
                        {recommendedIds.length} recommended vendor
                        {recommendedIds.length === 1 ? "" : "s"} selected.{" "}
                        <span
                          tabIndex={0}
                          role="note"
                          aria-label={RECOMMENDED_RULE}
                          title={RECOMMENDED_RULE}
                          className="cursor-help text-slate-500 underline decoration-dotted underline-offset-2"
                        >
                          Why?
                        </span>
                      </p>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="text-[12px] font-medium text-slate-500 transition-colors hover:text-white"
                      >
                        Clear selection
                      </button>
                    </div>
                  ) : null}

                  {listView === "vendor" ? (
                    <>
                      <div className="mt-3 flex flex-wrap items-center gap-3 border-b border-ink-800 pb-2">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={
                            allSelected ? true : selectedVisible.length > 0 ? "mixed" : false
                          }
                          aria-label={`Select all ${selectableIds.length} vendors shown`}
                          onClick={selectAll}
                          className="inline-flex size-4 items-center justify-center rounded border border-slate-600 bg-ink-900 text-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                        >
                          {allSelected ? (
                            <Check className="size-3" aria-hidden />
                          ) : selectedVisible.length > 0 ? (
                            <Minus className="size-3" aria-hidden />
                          ) : null}
                        </button>
                        <p className="text-[13px] text-slate-600 tabular-nums">
                          {selectedVisible.length} of {selectableIds.length} selected
                          {alreadySent.length > 0 ? (
                            <span className="text-slate-500">
                              {" "}
                              · {alreadySent.length} already a recipient
                            </span>
                          ) : null}
                        </p>
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setAllExpanded(true)}
                            className="rounded-md px-2 py-1 text-[12px] text-slate-500 transition-colors hover:bg-ink-850 hover:text-white"
                          >
                            Expand all
                          </button>
                          <button
                            type="button"
                            onClick={() => setAllExpanded(false)}
                            className="rounded-md px-2 py-1 text-[12px] text-slate-500 transition-colors hover:bg-ink-850 hover:text-white"
                          >
                            Collapse all
                          </button>
                        </div>
                      </div>

                      <div data-vendor-list>
                        {visible.map((group) => (
                          <VendorCard
                            key={group.vendorId}
                            group={group}
                            stats={vendorStats(group)}
                            requiredT={rfq.capacityT}
                            startDateTbc={startDateTbc}
                            startLabel={startLabel}
                            showDistance={distancesAvailable}
                            checked={selected.includes(group.vendorId)}
                            alreadyRecipient={alreadySent.includes(group.vendorId)}
                            contacted={contactFor(contactedIndex, group.vendorName)}
                            expanded={expanded[group.vendorId] ?? false}
                            onToggleExpand={() => toggleExpanded(group.vendorId)}
                            onSelect={() => toggle(group.vendorId)}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 pb-2">
                        <p className="text-[13px] font-medium text-slate-700 tabular-nums">
                          {inPlay.vendors} vendor{inPlay.vendors === 1 ? "" : "s"} ·{" "}
                          {inPlay.cranes} crane{inPlay.cranes === 1 ? "" : "s"} in play
                        </p>
                        <p className="text-[12px] text-slate-500 tabular-nums">
                          {craneList.length} crane{craneList.length === 1 ? "" : "s"} shown
                        </p>
                      </div>
                      <p className="mt-1 text-[12px] text-slate-500">
                        The RFQ goes to the vendor, who chooses which crane to quote.
                      </p>
                      <AllCranesTable
                        rows={craneList}
                        requiredT={rfq.capacityT}
                        startDateTbc={startDateTbc}
                        startLabel={startLabel}
                        showDistance={distancesAvailable}
                        selected={selected}
                        onToggleVendor={toggle}
                      />
                    </>
                  )}
                </>
              ) : null}

              {/* --- unverified locations ---------------------------------- */}
              {visibleUnverified.length > 0 ? (
                <UnverifiedSection cranes={visibleUnverified} selected={selected} onToggle={toggle} />
              ) : null}

              {contactedIndex.otherDrafts.length > 0 ? (
                <p className="mt-3 text-[12px] text-slate-500">
                  {contactedIndex.otherDrafts.length} other draft
                  {contactedIndex.otherDrafts.length === 1 ? " exists" : "s exist"} for this enquiry
                  line: {contactedIndex.otherDrafts.map((row) => row.rfqNumber).join(", ")}. Only
                  send one of them.
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* --- the rail ---------------------------------------------------- */}
        <SendRail
          rfq={rfq}
          selected={selectedGroups}
          channels={channels}
          onToggleChannel={(channel) =>
            setChannels((previous) =>
              previous.includes(channel)
                ? previous.filter((entry) => entry !== channel)
                : [...previous, channel],
            )
          }
          whatsappBlocked={whatsappBlocked}
          checklist={checklist}
          canSend={canSend}
          blockReason={blockReason}
          pending={send.isPending}
          error={send.isError ? (send.error as Error).message : null}
          contacted={selectedGroups
            .filter((group) => contactFor(contactedIndex, group.vendorName))
            .map((group) => group.vendorName)}
          onSend={() => send.mutate()}
          onPinConfirmed={onPinConfirmed}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
      </div>

      {/* Live region: selection is visual everywhere else. */}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {/* --- mobile: map above the list, and a permanent send bar ---------- */}
      {candidates.data ? (
        <MobileChrome
          rfq={rfq}
          selected={selectedGroups}
          channels={channels}
          onPinConfirmed={onPinConfirmed}
          onReview={() => setMobileOpen(true)}
          relative={relative}
          deadlinePassed={deadlinePassed}
        />
      ) : null}
    </section>
  );
}

function formatDeadlineLabel(iso: string): string {
  return dayMonth(iso);
}

/**
 * A small popover anchored to a trigger.
 *
 * It closes on Escape and on a click outside, and it is not a menu unless it
 * says so, so the crane filters are not announced as commands.
 */
function FilterPopover({
  label,
  icon,
  badge,
  menu = false,
  iconOnly = false,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  badge?: number;
  menu?: boolean;
  iconOnly?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup={menu ? "menu" : "dialog"}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
          open
            ? "border-accent-500/60 bg-accent-500/10 text-slate-900"
            : "border-ink-800 text-slate-600 hover:border-ink-700 hover:text-white",
        )}
      >
        {icon}
        {iconOnly ? null : <span>{label}</span>}
        {badge ? (
          <span className="rounded-full bg-accent-500/20 px-1.5 text-[11px] text-accent-300 tabular-nums">
            {badge}
          </span>
        ) : null}
        {iconOnly ? null : (
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
        )}
      </button>
      {open ? (
        <div
          role={menu ? "menu" : "dialog"}
          aria-label={label}
          // A menu command is finished once chosen: the preset is applied, so
          // the menu closes instead of staying open over the new shortlist.
          onClick={(event) => {
            if (
              menu &&
              event.target instanceof Element &&
              event.target.closest('[role="menuitem"]')
            ) {
              setOpen(false);
            }
          }}
          className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-ink-800 bg-ink-900 p-3 shadow-xl"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function CraneFilters({
  filters,
  onChange,
  startLabel,
}: {
  filters: PickerFilters;
  onChange: React.Dispatch<React.SetStateAction<PickerFilters>>;
  startLabel: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        Crane filters
      </p>
      <label className="flex items-center justify-between gap-2 text-[13px] text-slate-600">
        Minimum capacity
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min={0}
            step={10}
            value={filters.minCapacity === 0 ? "" : filters.minCapacity}
            onChange={(event) =>
              onChange((previous) => ({
                ...previous,
                minCapacity: Math.max(0, Number(event.target.value) || 0),
              }))
            }
            placeholder="Any"
            aria-label="Minimum crane capacity in tonnes"
            className="field-input w-20 py-1 text-[12px]"
          />
          <span className="text-[12px] text-slate-500">t</span>
        </span>
      </label>
      <label className="flex items-center justify-between gap-2 text-[13px] text-slate-600">
        Year from
        <input
          type="number"
          min={0}
          step={1}
          value={filters.yearFrom === 0 ? "" : filters.yearFrom}
          onChange={(event) =>
            onChange((previous) => ({
              ...previous,
              yearFrom: Math.max(0, Number(event.target.value) || 0),
            }))
          }
          placeholder="Any"
          aria-label="Crane year from"
          className="field-input w-24 py-1 text-[12px]"
        />
      </label>
      <label className="flex items-center gap-2 text-[13px] text-slate-600">
        <input
          type="checkbox"
          checked={filters.availableOnly}
          onChange={(event) =>
            onChange((previous) => ({ ...previous, availableOnly: event.target.checked }))
          }
          className="size-4 rounded border-slate-600 bg-ink-900 accent-accent-500"
        />
        Available before start
        <span className="text-[12px] text-slate-500">({startLabel})</span>
      </label>
      <label className="flex items-center gap-2 text-[13px] text-slate-600">
        <input
          type="checkbox"
          checked={filters.chartOnly}
          onChange={(event) =>
            onChange((previous) => ({ ...previous, chartOnly: event.target.checked }))
          }
          className="size-4 rounded border-slate-600 bg-ink-900 accent-accent-500"
        />
        Load chart on file
      </label>
      <label className="flex items-center gap-2 text-[13px] text-slate-600">
        <input
          type="checkbox"
          checked={filters.hideStale}
          onChange={(event) =>
            onChange((previous) => ({ ...previous, hideStale: event.target.checked }))
          }
          className="size-4 rounded border-slate-600 bg-ink-900 accent-accent-500"
        />
        Hide stale crane records
      </label>
      <div className="border-t border-ink-800 pt-2">
        <button
          type="button"
          onClick={() =>
            onChange((previous) => ({
              ...previous,
              minCapacity: 0,
              yearFrom: 0,
              availableOnly: false,
              chartOnly: false,
              hideStale: false,
            }))
          }
          className="inline-flex items-center gap-1 text-[12px] text-slate-500 transition-colors hover:text-white"
        >
          <RotateCcw className="size-3" aria-hidden />
          Clear crane filters
        </button>
      </div>
    </div>
  );
}

/**
 * Quick presets replace the shortlist rather than adding to it, so "Nearest 3"
 * always means three vendors. The menu only offers distance presets when the
 * server produced distances.
 */
function PresetMenu({
  distancesAvailable,
  onNearest,
  onWithin,
  onAvailable,
  onClear,
}: {
  distancesAvailable: boolean;
  onNearest: () => void;
  onWithin: () => void;
  onAvailable: () => void;
  onClear: () => void;
}) {
  const item =
    "block w-full rounded-md px-2 py-1.5 text-left text-[13px] text-slate-600 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-500";
  return (
    <>
      {distancesAvailable ? (
        <>
          <button type="button" role="menuitem" className={item} onClick={onNearest}>
            Nearest 3
          </button>
          <button type="button" role="menuitem" className={item} onClick={onWithin}>
            Within 500 km
          </button>
        </>
      ) : null}
      <button type="button" role="menuitem" className={item} onClick={onAvailable}>
        Available before start
      </button>
      <button type="button" role="menuitem" className={item} onClick={onClear}>
        Clear selection
      </button>
    </>
  );
}

function stateOptions(groups: CandidateGroup[]): Array<{ code: string; name: string }> {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const crane of group.cranes) seen.set(crane.stateCode, crane.stateName);
  }
  return [...seen]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Cranes the map cannot place.
 *
 * They are listed rather than dropped: an unlocated crane can still do the job,
 * and hiding it would quietly shrink the market. The checkbox is per vendor
 * because sending is per vendor, so a vendor with two unlocated cranes gets one
 * checkbox and both cranes underneath.
 */
function UnverifiedSection({
  cranes,
  selected,
  onToggle,
}: {
  cranes: CandidateCrane[];
  selected: string[];
  onToggle: (vendorId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const byVendor = new Map<string, CandidateCrane[]>();
  for (const crane of cranes) {
    byVendor.set(crane.vendorId, [...(byVendor.get(crane.vendorId) ?? []), crane]);
  }

  return (
    <div className="mt-4 border-t border-ink-800 pt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-[13px] font-medium text-slate-700">
          Cranes without a verified location ({cranes.length})
        </span>
        <ChevronDown
          className={cn("size-3.5 text-slate-500 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      <p className="mt-1 text-[12px] text-slate-500">
        No pin on file, so no distance can be shown. {byVendor.size} vendor
        {byVendor.size === 1 ? "" : "s"}, listed separately so they are not silently hidden.
      </p>
      {open ? (
        <ul className="mt-2 divide-y divide-ink-800 border-y border-ink-800">
          {[...byVendor].map(([vendorId, list]) => (
            <li key={vendorId} className="px-2 py-2.5">
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={selected.includes(vendorId)}
                  onChange={() => onToggle(vendorId)}
                  aria-label={`Select ${list[0]?.vendorName ?? "vendor"}`}
                  className="mt-1 size-4 cursor-pointer rounded border-slate-600 bg-ink-900 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-slate-800">
                    {list[0]?.vendorName}
                    <span className="ml-1.5 font-normal text-slate-500">
                      · {list.length} crane{list.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="mt-0.5 block space-y-0.5">
                    {list.map((crane) => (
                      <span key={crane.craneId} className="block text-[12px] text-slate-600">
                        {crane.make} {crane.model} · {crane.capacityT} t · {crane.currentLocation},{" "}
                        {crane.stateName}
                      </span>
                    ))}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-slate-500">
                    Distance unavailable · location unverified
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The narrow-screen chrome: the map above the list and a send bar that never
 * scrolls away. Both are hidden at `[1100px]`, where the rail takes over.
 */
function MobileChrome({
  rfq,
  selected,
  channels,
  onPinConfirmed,
  onReview,
  relative,
  deadlinePassed,
}: {
  rfq: RfqDetail;
  selected: CandidateGroup[];
  channels: MessageChannel[];
  onPinConfirmed: () => void;
  onReview: () => void;
  relative: { label: string; tone: "neutral" | "soon" | "overdue" };
  deadlinePassed: boolean;
}) {
  const [mapOpen, setMapOpen] = useState(false);

  return (
    <div className="min-[1100px]:hidden">
      <div className="mt-3 border-y border-ink-800 py-2">
        <button
          type="button"
          onClick={() => setMapOpen((value) => !value)}
          aria-expanded={mapOpen}
          className="flex w-full items-center justify-between gap-2 text-[13px] text-slate-600"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Site map
          </span>
          <ChevronDown
            className={cn("size-3.5 transition-transform", mapOpen && "rotate-180")}
            aria-hidden
          />
        </button>
        {mapOpen ? (
          <div className="mt-2">
            <SiteCard rfq={rfq} selected={selected} onPinConfirmed={onPinConfirmed} />
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-900/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-slate-900 tabular-nums">
              {selected.length} vendor{selected.length === 1 ? "" : "s"} selected
            </p>
            <p
              className={cn(
                "text-[12px]",
                deadlinePassed
                  ? "text-red-500"
                  : relative.tone === "soon"
                    ? "text-amber-500"
                    : "text-slate-500",
              )}
            >
              {deadlinePassed ? "Deadline has passed" : `Deadline ${relative.label}`}
            </p>
          </div>
          <div className="flex items-center gap-2 text-slate-500" aria-label="Channels">
            {channels.includes("EMAIL") ? <Mail className="size-4" aria-label="Email" /> : null}
            {channels.includes("WHATSAPP") ? (
              <MessageCircle className="size-4" aria-label="WhatsApp" />
            ) : null}
          </div>
          <button
            type="button"
            onClick={onReview}
            className="btn-primary shrink-0 px-3 py-2 text-[13px]"
            aria-haspopup="dialog"
          >
            <Send className="size-3.5" aria-hidden />
            Review &amp; send
          </button>
        </div>
      </div>
    </div>
  );
}

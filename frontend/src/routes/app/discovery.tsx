import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  LogOut,
  MapPin,
  Ruler,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  discoveryFacets,
  searchDiscovery,
  type DiscoveryAvailability,
  type DiscoveryCrane,
  type DiscoveryFilters,
} from "@/lib/discovery";
import { formatDistance } from "@/lib/rfqs";
import { CraneMap } from "@/components/crane-map";
import { CRANE_PATH, craneFill, craneStatusLabel } from "@/components/crane-glyph";
import { DiscoveryCalendar } from "@/components/discovery-calendar";
import { roleLabel, useAuth } from "@/lib/auth";
import { Field, Select, TextInput } from "@/components/ui/form";
import { cn } from "@/lib/cn";

/**
 * Find cranes — manual vendor discovery (P4, BPD 6.8 / 5.9).
 *
 * A browse across every approved vendor's fleet with no enquiry in view, laid
 * out as a workspace rather than a page: the map is the screen, the list is a
 * rail beside it, and a crane is the same object whether it is a pin, a row or
 * the card floating over the map. The screen fills the viewport and hides the
 * application chrome, because a map squeezed into a 1440px column with a page
 * header above it is a map nobody can read.
 *
 * Filters apply live — there is no Search button in this workspace. Text is
 * debounced so typing does not fire a request per keystroke, and the previous
 * result set stays on screen while the next one loads, so the map does not blink
 * empty between two filter changes.
 *
 * The whole view is shareable: filters and the selected crane live in the URL.
 */

type RailView = "flat" | "grouped";

interface FilterState {
  /** Free text: city, state, make or model. */
  location: string;
  craneType: string;
  capacityT: string;
  capacityRule: "AT_LEAST" | "EXACT";
  availability: DiscoveryAvailability | "";
  vendorName: string;
  vendorRegion: string;
  companySize: string;
  fleetSizeMin: string;
  region: string;
  yomFrom: string;
  yomTo: string;
  siteLocation: string;
  sitePincode: string;
  availableFrom: string;
  availableTo: string;
}

const EMPTY_FILTERS: FilterState = {
  location: "",
  craneType: "",
  capacityT: "",
  capacityRule: "AT_LEAST",
  availability: "",
  vendorName: "",
  vendorRegion: "",
  companySize: "",
  fleetSizeMin: "",
  region: "",
  yomFrom: "",
  yomTo: "",
  siteLocation: "",
  sitePincode: "",
  availableFrom: "",
  availableTo: "",
};

/** The fields that live behind "More" — used for the badge on that button. */
const MORE_FIELDS: Array<keyof FilterState> = [
  "vendorName",
  "vendorRegion",
  "companySize",
  "fleetSizeMin",
  "region",
  "yomFrom",
  "yomTo",
  "siteLocation",
  "sitePincode",
  "availableFrom",
  "availableTo",
];

function toQuery(filters: FilterState): DiscoveryFilters {
  const query: DiscoveryFilters = {};
  if (filters.location.trim()) query.location = filters.location.trim();
  if (filters.craneType) query.craneType = filters.craneType;
  if (filters.capacityT) {
    query.capacityT = filters.capacityT;
    query.capacityRule = filters.capacityRule;
  }
  if (filters.availability) query.availability = filters.availability;
  if (filters.vendorName.trim()) query.vendorName = filters.vendorName.trim();
  if (filters.vendorRegion) query.vendorRegion = filters.vendorRegion;
  if (filters.companySize) query.companySize = filters.companySize;
  if (filters.fleetSizeMin) query.fleetSizeMin = filters.fleetSizeMin;
  if (filters.region) query.region = filters.region;
  if (filters.yomFrom) query.yomFrom = filters.yomFrom;
  if (filters.yomTo) query.yomTo = filters.yomTo;
  if (filters.siteLocation.trim()) query.siteLocation = filters.siteLocation.trim();
  if (filters.sitePincode.trim()) query.sitePincode = filters.sitePincode.trim();
  // The hire window is a pair. One date has no period to test a booking
  // against, so a half-filled window is simply not applied.
  if (filters.availableFrom && filters.availableTo) {
    query.availableFrom = filters.availableFrom;
    query.availableTo = filters.availableTo;
  }
  return query;
}

/**
 * The URL is the state, parsed once on mount.
 *
 * A shared link has to open the same search, so the query string is read into
 * the initial state rather than kept in sync afterwards; the view then writes
 * the URL back on every change. Reading it on every render would fight the
 * debounce, and a filter you are halfway through typing is not a filter yet.
 */
function fromSearch(search: Record<string, unknown>): FilterState {
  const next: FilterState = { ...EMPTY_FILTERS };
  const record = next as unknown as Record<string, string>;
  for (const key of Object.keys(EMPTY_FILTERS) as Array<keyof FilterState>) {
    const value = search[key];
    // The router parses the query string as JSON, so `?capacityT=400` arrives
    // as a number, not the text the input holds. Reading only strings silently
    // dropped every numeric filter a shared link carried.
    if (typeof value === "string" && value !== "") record[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) record[key] = String(value);
  }
  next.capacityRule = record.capacityRule === "EXACT" ? "EXACT" : "AT_LEAST";
  const availability = record.availability ?? "";
  next.availability = (
    ["AVAILABLE", "ENGAGED", "UNDER_MAINTENANCE"] as string[]
  ).includes(availability)
    ? (availability as DiscoveryAvailability)
    : "";
  return next;
}

function toSearch(filters: FilterState, craneId: string | null): Record<string, string> {
  const search: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (key === "capacityRule") continue;
    if ((key === "availableFrom" || key === "availableTo") && !filters.availableFrom) continue;
    if ((key === "availableFrom" || key === "availableTo") && !filters.availableTo) continue;
    search[key] = value;
  }
  if (filters.capacityT) search.capacityRule = filters.capacityRule;
  if (craneId) search.crane = craneId;
  return search;
}

/**
 * Identity of the part of the query string this screen owns, normalised through
 * the same parse/serialise pair the component uses, so a write of ours and the
 * router's echo of it compare equal.
 */
function searchKeyOf(search: Record<string, unknown>): string {
  const craneId = typeof search.crane === "string" ? search.crane : null;
  return JSON.stringify(toSearch(fromSearch(search), craneId));
}

function countMore(filters: FilterState): number {
  return MORE_FIELDS.filter((key) => {
    const value = filters[key];
    if (key === "availableFrom" || key === "availableTo") {
      return Boolean(filters.availableFrom && filters.availableTo);
    }
    return typeof value === "string" && value.trim() !== "";
  }).length;
}

type ResultData = Awaited<ReturnType<typeof searchDiscovery>>;

function flatten(data: ResultData | undefined): DiscoveryCrane[] {
  if (!data) return [];
  return [...data.groups.flatMap((group) => group.cranes), ...data.unverified];
}

/** `14 Nov` — a date on a card, not a deadline with a year in it. */
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function availabilityText(crane: DiscoveryCrane): string {
  if (crane.currentStatus === "AVAILABLE") return "Free now";
  if (crane.currentStatus === "UNDER_MAINTENANCE") {
    const ready = shortDate(crane.expectedReadyDate);
    return ready ? `Ready ${ready}` : "In maintenance";
  }
  const from = shortDate(crane.availableFrom);
  return from ? `Free from ${from}` : "Engaged";
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const TOP_NAV = [
  { to: "/app/discovery", label: "Find cranes" },
  { to: "/app/enquiries", label: "Enquiries" },
  { to: "/app/rfqs", label: "RFQs" },
  { to: "/app/approvals", label: "Vendors" },
] as const;

export function DiscoveryPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  /**
   * The router can render this screen before it commits the destination, so a
   * deep link from another screen (the enquiry's "Find cranes") arrives one
   * render late: the first read is still the previous screen's query string.
   * These refs let the screen tell "the URL changed underneath me" apart from
   * "I wrote this URL myself", so a late commit is followed rather than
   * overwritten — and back/forward follows the URL too.
   */
  const routeKey = searchKeyOf(routeSearch);
  const lastRouteKey = useRef(routeKey);
  const lastWrittenKey = useRef<string | null>(null);

  useEffect(() => {
    if (routeKey === lastRouteKey.current) return;
    lastRouteKey.current = routeKey;
    // Our own write coming back through the router; state already matches.
    if (routeKey === lastWrittenKey.current) return;
    const next = fromSearch(routeSearch);
    setFilters(next);
    setCommitted(next);
    setSelectedCraneId(
      typeof routeSearch.crane === "string" ? routeSearch.crane : null,
    );
  }, [routeKey, routeSearch]);

  const [filters, setFilters] = useState<FilterState>(() => fromSearch(routeSearch));
  const [committed, setCommitted] = useState<FilterState>(() => fromSearch(routeSearch));
  const [selectedCraneId, setSelectedCraneId] = useState<string | null>(() =>
    typeof routeSearch.crane === "string" ? routeSearch.crane : null,
  );
  const [hoveredCraneId, setHoveredCraneId] = useState<string | null>(null);
  const [rail, setRail] = useState<RailView>("flat");
  const [moreOpen, setMoreOpen] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Typing should not fire a request per keystroke, but a chip should feel
  // instant; 220ms is short enough to feel immediate and long enough to coalesce
  // a typed word.
  useEffect(() => {
    if (filters === committed) return;
    const timer = window.setTimeout(() => setCommitted(filters), 220);
    return () => window.clearTimeout(timer);
  }, [filters, committed]);

  // Shareable view. `replace` keeps a filter change from filling the back stack.
  //
  // A cross-screen deep link can render this screen before the destination is
  // committed, with the previous screen's location still current. Writing then
  // would replace the incoming URL with an empty one before it lands, so the
  // write only happens once this screen is the location.
  useEffect(() => {
    if (pathname !== "/app/discovery") return;
    const search = toSearch(committed, selectedCraneId);
    lastWrittenKey.current = JSON.stringify(search);
    void navigate({ to: "/app/discovery", search, replace: true });
  }, [committed, selectedCraneId, navigate, pathname]);

  const facets = useQuery({ queryKey: ["discovery", "facets"], queryFn: discoveryFacets });

  const committedQuery = useMemo(() => toQuery(committed), [committed]);
  const results = useQuery({
    queryKey: ["discovery", "search", committedQuery],
    queryFn: () => searchDiscovery(committedQuery),
    placeholderData: (previous) => previous,
  });

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const data = results.data;
  const cranes = useMemo(() => flatten(data), [data]);
  const highlightedCraneId = hoveredCraneId ?? selectedCraneId;
  const selectedCrane = cranes.find((crane) => crane.craneId === selectedCraneId) ?? null;

  const readyNow = cranes.filter((crane) => crane.currentStatus === "AVAILABLE").length;
  const moreCount = countMore(committed);
  const halfWindow = Boolean(filters.availableFrom) !== Boolean(filters.availableTo);
  const siteMissing = committed.siteLocation.trim() !== "" && data?.site === null;

  const clearAll = () => {
    setFilters(EMPTY_FILTERS);
    setCommitted(EMPTY_FILTERS);
    setSelectedCraneId(null);
  };

  const selectFromMap = (craneId: string | null) => {
    setSelectedCraneId(craneId);
    setHoveredCraneId(null);
    if (craneId) {
      document.getElementById(`crane-row-${craneId}`)?.scrollIntoView({ block: "nearest" });
    }
  };

  if (!user) return null;

  const displayName = user.vendorName ?? user.fullName?.split(" ")[0] ?? user.email.split("@")[0];
  const initials = (user.fullName ?? user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="theme-dark fixed inset-0 z-50 flex flex-col overflow-hidden bg-ink-950 text-neutral-200">
      {/* ---------------------------------------------------------------- top */}
      <header className="flex h-12 shrink-0 items-center gap-6 border-b border-ink-800 bg-ink-900 px-4">
        <Link to="/app/discovery" className="flex shrink-0 items-center gap-2">
          <span className="flex h-6 items-center gap-0.5" aria-hidden>
            <span className="block h-4 w-[3px] -skew-x-[18deg] rounded-full bg-accent-500" />
            <span className="block h-4 w-[3px] -skew-x-[18deg] rounded-full bg-accent-500/60" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-white">crossrentel</span>
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1">
          {TOP_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/app/discovery" }}
              className="rounded-md px-2.5 py-1.5 text-[13px] text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
              activeProps={{ className: "bg-ink-850 text-white" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCalendar((value) => !value)}
            aria-pressed={calendar}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
              calendar
                ? "bg-ink-850 text-white"
                : "text-neutral-400 hover:bg-ink-850 hover:text-white",
            )}
          >
            <CalendarDays className="size-3.5" aria-hidden />
            Calendar
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Account"
              className="flex size-8 items-center justify-center rounded-full bg-ink-700 text-[11px] font-semibold tracking-wide text-white transition-colors hover:bg-ink-800"
            >
              {initials || "U"}
            </button>

            {menuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close account menu"
                  className="fixed inset-0 z-[60] cursor-default"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute top-10 right-0 z-[70] w-60 rounded-xl border border-ink-800 bg-ink-900 p-2 shadow-2xl"
                >
                  <div className="px-2 py-2">
                    <p className="truncate text-sm font-medium text-white">
                      {user.fullName ?? user.email}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {roleLabel(user.role)}
                      {user.vendorName ? ` · ${user.vendorName}` : ""}
                    </p>
                  </div>
                  <div className="my-1 h-px bg-ink-800" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      logout();
                      void navigate({ to: "/auth/login" });
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
                  >
                    <LogOut className="size-4" aria-hidden />
                    Sign out
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ----------------------------------------------------------- sidebar */}
        <aside className="flex w-[420px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <div className="shrink-0 space-y-3 px-5 pt-5">
            <p className="text-[12px] text-neutral-500">
              {greeting()}, <span className="text-neutral-300">{displayName}</span>
            </p>
            <h1 className="text-[26px] leading-none font-semibold tracking-tight text-white">
              Where&rsquo;s the lift?
            </h1>

            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-accent-500"
                aria-hidden
              />
              <input
                type="search"
                value={filters.location}
                onChange={(event) => set("location", event.target.value)}
                placeholder="Job site, city, make or vendor"
                aria-label="Search cranes"
                className="w-full rounded-lg border border-transparent bg-ink-850 py-2.5 pr-3 pl-9 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:border-ink-700 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Select
                id="discovery-type"
                value={filters.craneType}
                onChange={(value) => set("craneType", value)}
                placeholder="Any crane type"
                options={(facets.data?.craneTypes ?? []).map((type) => ({
                  value: type.code,
                  label: type.name,
                }))}
              />
              <TextInput
                id="discovery-capacity"
                value={filters.capacityT}
                onChange={(value) => set("capacityT", value)}
                inputMode="decimal"
                placeholder="Min capacity (t)"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Chip active={filters.availability === ""} onClick={() => set("availability", "")}>
                All
              </Chip>
              <Chip
                active={filters.availability === "AVAILABLE"}
                onClick={() => set("availability", "AVAILABLE")}
              >
                Available
              </Chip>
              <Chip
                active={filters.availability === "ENGAGED"}
                onClick={() => set("availability", "ENGAGED")}
              >
                Engaged
              </Chip>
              <Chip
                active={filters.availability === "UNDER_MAINTENANCE"}
                onClick={() => set("availability", "UNDER_MAINTENANCE")}
              >
                Maintenance
              </Chip>
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                className={cn(
                  "ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  moreCount > 0
                    ? "border-accent-500/60 bg-accent-500/10 text-accent-400"
                    : "border-ink-700 text-neutral-400 hover:border-ink-700 hover:text-white",
                )}
                aria-haspopup="dialog"
              >
                <SlidersHorizontal className="size-3" aria-hidden />
                More
                {moreCount > 0 ? (
                  <span className="rounded-full bg-accent-500 px-1.5 text-[10px] font-semibold text-white">
                    {moreCount}
                  </span>
                ) : null}
              </button>
            </div>
          </div>

          <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border-y border-ink-800 px-5 py-2.5">
            <p className="text-[12px] text-neutral-400" aria-live="polite">
              <span className="font-semibold text-white tabular-nums">
                {data?.totalMatched ?? 0}
              </span>{" "}
              crane{(data?.totalMatched ?? 0) === 1 ? "" : "s"}
              <span className="mx-1.5 text-ink-700">·</span>
              <span className="font-semibold text-accent-400 tabular-nums">{readyNow}</span> ready
              now
            </p>
            <div
              role="group"
              aria-label="Group results"
              className="inline-flex shrink-0 items-center rounded-lg border border-ink-800 bg-ink-850 p-0.5"
            >
              <RailButton active={rail === "flat"} onClick={() => setRail("flat")}>
                All cranes
              </RailButton>
              <RailButton active={rail === "grouped"} onClick={() => setRail("grouped")}>
                By vendor
              </RailButton>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {results.isError ? (
              <div className="m-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[12px] text-red-200">
                <p className="font-medium">Could not run that search</p>
                <p className="mt-0.5 text-red-200/70">{(results.error as Error).message}</p>
                <button
                  type="button"
                  onClick={() => void results.refetch()}
                  className="mt-2 rounded-md border border-red-400/40 px-2 py-1 text-[11px] font-medium text-red-100 hover:bg-red-500/10"
                >
                  Try again
                </button>
              </div>
            ) : null}

            {siteMissing ? (
              <p className="mx-3 mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/90">
                Job site not found, so the list is not distance-sorted. Try a nearby town or a
                pincode.
              </p>
            ) : null}

            {results.isPending && !data ? (
              <SkeletonRows />
            ) : !data || cranes.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <p className="text-sm font-medium text-neutral-200">
                  No cranes match your filters
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Widen the capacity, clear the search, then try again.
                </p>
                <button
                  type="button"
                  onClick={clearAll}
                  className="mt-4 rounded-lg border border-ink-700 px-3 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
                >
                  Clear filters
                </button>
              </div>
            ) : rail === "grouped" ? (
              <GroupedRail
                data={data}
                selectedCraneId={highlightedCraneId}
                onHover={setHoveredCraneId}
                onSelect={setSelectedCraneId}
              />
            ) : (
              <ul>
                {cranes.map((crane) => (
                  <CraneRow
                    key={crane.craneId}
                    crane={crane}
                    selected={crane.craneId === highlightedCraneId}
                    onHover={setHoveredCraneId}
                    onSelect={setSelectedCraneId}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* --------------------------------------------------------------- map */}
        <main className="relative min-w-0 flex-1">
          {calendar ? (
            <div className="h-full overflow-y-auto bg-ink-950 p-4">
              <div className="rounded-xl bg-slate-100 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-slate-600">
                    <span className="font-semibold text-slate-900 tabular-nums">
                      {data?.totalMatched ?? 0}
                    </span>{" "}
                    crane{(data?.totalMatched ?? 0) === 1 ? "" : "s"} matched
                    {committed.availableFrom && committed.availableTo
                      ? ` · free from ${committed.availableFrom} to ${committed.availableTo}`
                      : ""}
                  </p>
                  <p className="text-xs text-slate-500">
                    Day states come from reservations; the crane&rsquo;s own status fills the rest
                  </p>
                </div>
                <DiscoveryCalendar filters={committedQuery} />
              </div>
            </div>
          ) : (
            <>
              <CraneMap
                className="h-full w-full"
                cranes={cranes}
                vendorPoints={data?.vendorPoints ?? []}
                site={data?.site ?? null}
                selectedCraneId={highlightedCraneId}
                onSelect={selectFromMap}
              />

              {selectedCrane ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[900] flex justify-center px-4">
                  <CraneCard
                    crane={selectedCrane}
                    onClose={() => setSelectedCraneId(null)}
                  />
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      {moreOpen ? (
        <MoreFilters
          filters={filters}
          set={set}
          facets={facets.data}
          halfWindow={halfWindow}
          activeCount={moreCount}
          onClear={clearAll}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-white text-ink-950"
          : "border border-ink-700 text-neutral-400 hover:border-ink-700 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function RailButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
        active ? "bg-ink-700 text-white" : "text-neutral-500 hover:text-neutral-200",
      )}
    >
      {children}
    </button>
  );
}

/**
 * One crane in the list.
 *
 * Three lines and a capacity badge: the badge is the thing being compared, so it
 * gets the largest type on the row. The selected row is lifted a shade and
 * carries a red left edge, and it is a button because clicking it selects —
 * there is no second action hidden on the row.
 */
function CraneRow({
  crane,
  selected,
  onHover,
  onSelect,
}: {
  crane: DiscoveryCrane;
  selected: boolean;
  onHover: (craneId: string | null) => void;
  onSelect: (craneId: string) => void;
}) {
  return (
    <li id={`crane-row-${crane.craneId}`}>
      <button
        type="button"
        onClick={() => onSelect(crane.craneId)}
        onMouseEnter={() => onHover(crane.craneId)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(crane.craneId)}
        onBlur={() => onHover(null)}
        aria-pressed={selected}
        className={cn(
          "flex w-full items-center gap-3 border-b border-l-[3px] border-ink-800/70 px-4 py-3 text-left transition-colors",
          selected
            ? "border-l-accent-500 bg-ink-850"
            : "border-l-transparent hover:bg-ink-850/50",
        )}
      >
        <span
          className={cn(
            "flex size-[54px] shrink-0 flex-col items-center justify-center rounded-xl border",
            selected
              ? "border-white bg-white text-ink-950"
              : "border-ink-700 bg-ink-850 text-white",
          )}
        >
          <span className="text-[17px] leading-none font-semibold tabular-nums">
            {Math.round(crane.capacityT)}
          </span>
          <span
            className={cn(
              "mt-1 text-[8px] font-semibold tracking-[0.16em]",
              selected ? "text-neutral-500" : "text-neutral-500",
            )}
          >
            TON
          </span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-neutral-100">
            {crane.make} {crane.model}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-neutral-400">
            {crane.typeOfCraneName} · {crane.currentLocation}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-neutral-500">
            {crane.vendorName}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-400">
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ backgroundColor: craneFill(crane.currentStatus) }}
          />
          {craneStatusLabel(crane.currentStatus)}
        </span>
      </button>
    </li>
  );
}

function GroupedRail({
  data,
  selectedCraneId,
  onHover,
  onSelect,
}: {
  data: ResultData;
  selectedCraneId: string | null;
  onHover: (craneId: string | null) => void;
  onSelect: (craneId: string) => void;
}) {
  return (
    <div>
      {data.groups.map((group) => (
        <section key={group.vendorId}>
          <div className="flex items-center justify-between gap-2 border-b border-ink-800/70 bg-ink-950/60 px-4 py-2">
            <div className="min-w-0">
              <h2 className="truncate text-[12px] font-semibold text-neutral-200">
                {group.vendorName}
              </h2>
              <p className="mt-0.5 text-[10px] text-neutral-500">
                {group.companySize ? `${group.companySize} · ` : ""}
                {group.fleetSize} crane{group.fleetSize === 1 ? "" : "s"} · nearest{" "}
                {formatDistance(group.nearestKm, group.distanceApproximate)}
              </p>
            </div>
            <Link
              to="/app/vendors/$vendorId"
              params={{ vendorId: group.vendorId }}
              className="shrink-0 text-[10px] font-medium text-accent-400 hover:text-accent-300"
            >
              Vendor
            </Link>
          </div>
          <ul>
            {group.cranes.map((crane) => (
              <CraneRow
                key={crane.craneId}
                crane={crane}
                selected={crane.craneId === selectedCraneId}
                onHover={onHover}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}

      {data.unverified.length > 0 ? (
        <section>
          <div className="border-b border-ink-800/70 bg-ink-950/60 px-4 py-2">
            <h2 className="text-[12px] font-semibold text-neutral-200">Location unverified</h2>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              No stored coordinates, so these cannot appear on the map.
            </p>
          </div>
          <ul>
            {data.unverified.map((crane) => (
              <CraneRow
                key={crane.craneId}
                crane={crane}
                selected={crane.craneId === selectedCraneId}
                onHover={onHover}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden className="animate-pulse">
      {Array.from({ length: 6 }, (_, index) => (
        <li
          key={index}
          className="flex items-center gap-3 border-b border-ink-800/70 px-4 py-3"
        >
          <span className="size-[54px] shrink-0 rounded-xl bg-ink-800" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-2.5 w-2/3 rounded bg-ink-800" />
            <span className="block h-2 w-1/2 rounded bg-ink-800/80" />
            <span className="block h-2 w-1/3 rounded bg-ink-800/60" />
          </span>
          <span className="h-2 w-14 shrink-0 rounded bg-ink-800" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The floating crane card.
 *
 * Bottom-centre of the map so it never covers the pins it is describing, and
 * only as tall as it needs to be. The CTA opens the crane's own screen: there is
 * no per-crane request endpoint, and inventing one on the client would promise a
 * request the server cannot take.
 */
function CraneCard({ crane, onClose }: { crane: DiscoveryCrane; onClose: () => void }) {
  return (
    <div className="pointer-events-auto w-[400px] overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)]">
      <div className="relative h-28 overflow-hidden border-b border-ink-800 bg-ink-900">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(#26282b 1px, transparent 1px), linear-gradient(90deg, #26282b 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
        <svg viewBox="0 0 200 84" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <radialGradient id="crane-card-glow" cx="50%" cy="70%" r="55%">
              <stop offset="0%" stopColor={craneFill(crane.currentStatus)} stopOpacity="0.22" />
              <stop offset="100%" stopColor={craneFill(crane.currentStatus)} stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width="200" height="84" fill="url(#crane-card-glow)" />
          <path
            d={CRANE_PATH}
            transform="translate(73 19) scale(1.5)"
            fill={craneFill(crane.currentStatus)}
            stroke="#ffffff"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close crane details"
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full border border-ink-700 bg-ink-900/90 text-neutral-300 transition-colors hover:text-white"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <div className="p-4">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-neutral-500 uppercase">
          {crane.typeOfCraneName}
        </p>
        <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-white">
          {crane.make} {crane.model}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          {Math.round(crane.capacityT)} t · {crane.yom}
        </p>

        <dl className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2.5">
          <CardFact icon={Building2} label="Vendor" value={crane.vendorName} />
          <CardFact
            icon={MapPin}
            label="Location"
            value={`${crane.currentLocation}, ${crane.stateName}`}
          />
          <CardFact
            icon={Ruler}
            label="Boom"
            value={crane.mainBoomM === null ? "—" : `${crane.mainBoomM} m main boom`}
          />
          <CardFact icon={CalendarDays} label="Availability" value={availabilityText(crane)} />
        </dl>

        <Link
          to="/app/cranes/$craneId"
          params={{ craneId: crane.craneId }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-600"
        >
          Request this crane
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function CardFact({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[10px] font-medium tracking-[0.08em] text-neutral-500 uppercase">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[12px] text-neutral-200">{value}</dd>
    </div>
  );
}

/**
 * "More" — the filters that do not earn a permanent place in the rail.
 *
 * The rail carries the three questions people actually arrive with (what, how
 * big, is it free); everything else is a refinement, and a fourteen-field form
 * beside a map is a form nobody fills in. Values apply live, like the rail, so
 * the footer only has to dismiss.
 */
function MoreFilters({
  filters,
  set,
  facets,
  halfWindow,
  activeCount,
  onClear,
  onClose,
}: {
  filters: FilterState;
  set: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  facets: Awaited<ReturnType<typeof discoveryFacets>> | undefined;
  halfWindow: boolean;
  activeCount: number;
  onClear: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1000] flex justify-end">
      <button
        type="button"
        aria-label="Close more filters"
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More filters"
        className="relative flex h-full w-[400px] flex-col border-l border-ink-800 bg-ink-900 shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-ink-800 px-5">
          <h2 className="text-sm font-semibold text-white">More filters</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close more filters"
            className="flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <fieldset className="space-y-3">
            <legend className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Hire window
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Free from" htmlFor="more-from">
                <TextInput
                  id="more-from"
                  type="date"
                  value={filters.availableFrom}
                  onChange={(value) => set("availableFrom", value)}
                />
              </Field>
              <Field label="Free to" htmlFor="more-to">
                <TextInput
                  id="more-to"
                  type="date"
                  value={filters.availableTo}
                  onChange={(value) => set("availableTo", value)}
                />
              </Field>
            </div>
            <p className="text-[11px] text-neutral-500">
              {halfWindow
                ? "Set both dates — one date has no period to test a booking against."
                : "A crane must be free for the whole window, not only on the first day."}
            </p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Job site
            </legend>
            <Field
              label="Site address"
              htmlFor="more-site"
              hint="Drops the red site pin and sorts the list by road distance."
            >
              <TextInput
                id="more-site"
                value={filters.siteLocation}
                onChange={(value) => set("siteLocation", value)}
                placeholder="e.g. Vadodara, Gujarat"
              />
            </Field>
            <Field label="Pincode" htmlFor="more-pin">
              <TextInput
                id="more-pin"
                value={filters.sitePincode}
                onChange={(value) => set("sitePincode", value)}
                inputMode="numeric"
                placeholder="e.g. 390001"
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Crane
            </legend>
            <Field label="Crane state" htmlFor="more-region">
              <Select
                id="more-region"
                value={filters.region}
                onChange={(value) => set("region", value)}
                placeholder="All states"
                options={(facets?.states ?? []).map((state) => ({
                  value: state.code,
                  label: state.name,
                }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="YOM from" htmlFor="more-yom-from">
                <TextInput
                  id="more-yom-from"
                  value={filters.yomFrom}
                  onChange={(value) => set("yomFrom", value)}
                  inputMode="numeric"
                  placeholder="2010"
                />
              </Field>
              <Field label="YOM to" htmlFor="more-yom-to">
                <TextInput
                  id="more-yom-to"
                  value={filters.yomTo}
                  onChange={(value) => set("yomTo", value)}
                  inputMode="numeric"
                  placeholder="2024"
                />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-neutral-300">
              <input
                type="checkbox"
                checked={filters.capacityRule === "EXACT"}
                onChange={(event) =>
                  set("capacityRule", event.target.checked ? "EXACT" : "AT_LEAST")
                }
                className="size-3.5 accent-accent-500"
              />
              Match the minimum capacity exactly
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[10px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Vendor
            </legend>
            <Field label="Vendor name" htmlFor="more-vendor">
              <TextInput
                id="more-vendor"
                value={filters.vendorName}
                onChange={(value) => set("vendorName", value)}
                placeholder="e.g. Sharma"
              />
            </Field>
            <Field label="Operating region" htmlFor="more-vendor-region">
              <Select
                id="more-vendor-region"
                value={filters.vendorRegion}
                onChange={(value) => set("vendorRegion", value)}
                placeholder="All states"
                options={(facets?.states ?? []).map((state) => ({
                  value: state.code,
                  label: state.name,
                }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Company size" htmlFor="more-size">
                <Select
                  id="more-size"
                  value={filters.companySize}
                  onChange={(value) => set("companySize", value)}
                  placeholder="Any"
                  options={(facets?.companySizes ?? []).map((size) => ({
                    value: size,
                    label: size,
                  }))}
                />
              </Field>
              <Field label="Fleet min" htmlFor="more-fleet">
                <TextInput
                  id="more-fleet"
                  value={filters.fleetSizeMin}
                  onChange={(value) => set("fleetSizeMin", value)}
                  inputMode="numeric"
                  placeholder="e.g. 5"
                />
              </Field>
            </div>
          </fieldset>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-ink-800 p-4">
          <button
            type="button"
            onClick={onClear}
            className="flex-1 rounded-lg border border-ink-700 px-3 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-600"
          >
            Done{activeCount > 0 ? ` · ${activeCount} applied` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

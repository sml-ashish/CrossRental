import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronDown,
  MapPin,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  discoveryFacets,
  formatDriveTime,
  formatKm,
  formatRouteDistance,
  cranesLocatedIn,
  getLineRoute,
  orderedRecommendationCranes,
  TOP_RECOMMENDED_CRANES,
  filterRecommended,
  searchDiscovery,
  toDisplayCrane,
  type DiscoveryAvailability,
  type DiscoveryCrane,
  type DiscoveryFilters,
  type RecommendationMode,
} from "@/lib/discovery";
import {
  GoogleCraneMap,
  type GoogleMapRoute,
  type GoogleMapMultiRoute,
} from "@/components/google-crane-map";
import { craneFill, craneStatusLabel } from "@/components/crane-glyph";
import { DiscoveryCalendar } from "@/components/discovery-calendar";
import {
  LinePanel,
  ThemeToggle,
  lineReference,
  useRaisableLines,
} from "@/components/discovery/line-panel";
import {
  RecommendationPanel,
  useLineRecommendations,
} from "@/components/discovery/recommendation-panel";
import { RouteCard, type RouteSummary } from "@/components/discovery/route-card";
import { useAuth } from "@/lib/auth";
import { Field, Select, TextInput } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { useDiscoveryTheme } from "@/lib/discoveryTheme";

/**
 * Find cranes — manual vendor discovery (P4, BPD 6.8 / 5.9).
 *
 * A browse across every approved vendor's fleet with no enquiry in view, laid
 * out as a workspace rather than a page: the map is the screen, the list is a
 * rail beside it, and a crane is the same object whether it is a pin, a row or
 * the card floating over the map. The screen fills the viewport below the shared
 * application header — which stays put, navigation and all — because a map
 * squeezed into a 1440px column with a page header above it is a map nobody can
 * read, but a screen that replaces the navigation strands the person on it.
 *
 * Filters apply live — there is no Search button in this workspace. Text is
 * debounced so typing does not fire a request per keystroke, and the previous
 * result set stays on screen while the next one loads, so the map does not blink
 * empty between two filter changes.
 *
 * The whole view is shareable: filters and the selected crane live in the URL.
 */

interface FilterState {
  /** "From": where the cranes are — a city or state. */
  location: string;
  craneType: string;
  capacityT: string;
  capacityRule: "AT_LEAST" | "EXACT";
  availability: DiscoveryAvailability | "";
  vendorName: string;
  yomFrom: string;
  yomTo: string;
  siteLocation: string;
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
  yomFrom: "",
  yomTo: "",
  siteLocation: "",
  availableFrom: "",
  availableTo: "",
};

/** The fields that live behind "More" — used for the badge on that button. */
const MORE_FIELDS: Array<keyof FilterState> = [
  "location",
  "vendorName",
  "yomFrom",
  "yomTo",
  "siteLocation",
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
  if (filters.yomFrom) query.yomFrom = filters.yomFrom;
  if (filters.yomTo) query.yomTo = filters.yomTo;
  if (filters.siteLocation.trim()) query.siteLocation = filters.siteLocation.trim();
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

function toSearch(
  filters: FilterState,
  craneId: string | null,
  lineId: string | null,
  mode: RecommendationMode,
): Record<string, string> {
  const search: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (key === "capacityRule") continue;
    if ((key === "availableFrom" || key === "availableTo") && !filters.availableFrom) continue;
    if ((key === "availableFrom" || key === "availableTo") && !filters.availableTo) continue;
    search[key] = value;
  }
  if (filters.capacityT) search.capacityRule = filters.capacityRule;
  // The enquiry choice is part of the shareable view, but only when it is on:
  // a plain browse must not grow a `mode=technical` it never asked for.
  if (lineId) {
    search.line = lineId;
    search.mode = mode;
  }
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
  const lineId = typeof search.line === "string" && search.line !== "" ? search.line : null;
  const mode: RecommendationMode = search.mode === "distance" ? "distance" : "technical";
  return JSON.stringify(toSearch(fromSearch(search), craneId, lineId, mode));
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

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function DiscoveryPage() {
  const { user } = useAuth();
  const [theme, toggleTheme] = useDiscoveryTheme();
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

  const [filters, setFilters] = useState<FilterState>(() => fromSearch(routeSearch));
  const [committed, setCommitted] = useState<FilterState>(() => fromSearch(routeSearch));
  const [selectedCraneId, setSelectedCraneId] = useState<string | null>(() =>
    typeof routeSearch.crane === "string" ? routeSearch.crane : null,
  );
  const [lineId, setLineId] = useState<string | null>(() =>
    typeof routeSearch.line === "string" && routeSearch.line !== "" ? routeSearch.line : null,
  );
  const [mode, setMode] = useState<RecommendationMode>(() =>
    routeSearch.mode === "distance" ? "distance" : "technical",
  );
  /** Which of the server's route options is highlighted. Null = the primary. */
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  /** Cranes ticked in the recommendation list, to send an RFQ to their vendors. */
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [availableOnly, setAvailableOnly] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [linePanelCollapsed, setLinePanelCollapsed] = useState(false);
  const [lineSheetOpen, setLineSheetOpen] = useState(false);

  // The phone/tablet sheet. Height is a percentage so it survives rotation and
  // the on-screen keyboard; dragging snaps to one of three sizes.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startPct: number;
    viewport: number;
  } | null>(null);
  const [sheetPct, setSheetPct] = useState(52);
  const [sheetDragging, setSheetDragging] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
  );
  const autoSelectedRef = useRef<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(query.matches);
    const onChange = () => setReduceMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  /**
   * One layout at a time.
   *
   * The desktop three-panel grid and the phone sheet both draw a Leaflet map.
   * Hiding one with CSS would still mount it, giving a second map with its own
   * tiles, markers and route fetch. The media query decides which branch mounts
   * at all.
   */
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    setIsDesktop(query.matches);
    const onChange = () => setIsDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Picking a crane on a phone collapses the list so the route is visible.
  useEffect(() => {
    if (selectedCraneId) setSheetPct(42);
  }, [selectedCraneId]);

  useEffect(() => {
    if (routeKey === lastRouteKey.current) return;
    lastRouteKey.current = routeKey;
    // Our own write coming back through the router; state already matches.
    if (routeKey === lastWrittenKey.current) return;
    const next = fromSearch(routeSearch);
    setFilters(next);
    setCommitted(next);
    setLineId(
      typeof routeSearch.line === "string" && routeSearch.line !== ""
        ? routeSearch.line
        : null,
    );
    setMode(routeSearch.mode === "distance" ? "distance" : "technical");
    setSelectedCraneId(
      typeof routeSearch.crane === "string" ? routeSearch.crane : null,
    );
  }, [routeKey, routeSearch]);

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
    const search = toSearch(committed, selectedCraneId, lineId, mode);
    lastWrittenKey.current = JSON.stringify(search);
    void navigate({ to: "/app/discovery", search, replace: true });
  }, [committed, selectedCraneId, lineId, mode, navigate, pathname]);

  const facets = useQuery({ queryKey: ["discovery", "facets"], queryFn: discoveryFacets });

  // The line picker and its recommendations. The panel and this screen share
  // the same query keys, so the list is fetched once and both see it.
  const raisable = useRaisableLines();
  const recommendationQuery = useLineRecommendations(lineId, mode);
  const recommendations = recommendationQuery.data?.recommendations;

  const committedQuery = useMemo(() => toQuery(committed), [committed]);
  const results = useQuery({
    queryKey: ["discovery", "search", committedQuery],
    queryFn: () => searchDiscovery(committedQuery),
    // A chosen line answers the question already; browsing behind it would
    // fetch a second, irrelevant fleet and fight the map's fitBounds.
    enabled: !lineId,
    placeholderData: (previous) => previous,
  });

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const data = results.data;
  const browseCranes = useMemo(() => flatten(data), [data]);
  const requiredT = raisable.data?.lines.find((item) => item.id === lineId)?.capacityT ?? null;
  const recommendedCranes = useMemo(
    () =>
      filterRecommended(
        cranesLocatedIn(orderedRecommendationCranes(recommendations, mode, requiredT), filters.location),
        availableOnly,
        searchText,
      )
        .slice(0, TOP_RECOMMENDED_CRANES)
        .map(toDisplayCrane),
    [recommendations, filters.location, mode, availableOnly, searchText, requiredT],
  );
  const cranes = lineId ? recommendedCranes : browseCranes;
  const highlightedCraneId = selectedCraneId;
  const selectedCrane = cranes.find((crane) => crane.craneId === selectedCraneId) ?? null;

  const selectedLine = useMemo(
    () => raisable.data?.lines.find((line) => line.id === lineId) ?? null,
    [raisable.data, lineId],
  );

  const sitePoint = useMemo(() => {
    if (recommendations) {
      const { latitude, longitude } = recommendations.site;
      if (typeof latitude === "number" && typeof longitude === "number") {
        return { latitude, longitude };
      }
      return null;
    }
    // A line answers its own site; a stale browse site must not leak into it.
    if (lineId) return null;
    return data?.site ?? null;
  }, [recommendations, data, lineId]);

  const craneHasPin =
    selectedCrane !== null &&
    Number.isFinite(Number(selectedCrane.latitude ?? NaN)) &&
    Number.isFinite(Number(selectedCrane.longitude ?? NaN));

  /**
   * The server draws the route, not the browser.
   *
   * The query only runs for a selected crane that has a pin and a pinned site,
   * and TanStack cancels a stale request through the `AbortSignal` when the
   * selection changes quickly. The previous response is kept as placeholder data
   * so the map can fade the old shape instead of blinking empty.
   */
  const routeQuery = useQuery({
    queryKey: ["discovery", "route", lineId, selectedCraneId],
    queryFn: ({ signal }) =>
      getLineRoute(lineId as string, selectedCraneId as string, signal),
    enabled: Boolean(lineId && selectedCraneId && craneHasPin && sitePoint),
    staleTime: 10 * 60_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const routeLoading = routeQuery.isFetching || routeQuery.isPlaceholderData;
  // Placeholder data belongs to the previous crane: useful as a faded map shape,
  // never as this crane's distance or labels.
  const currentRoute = routeQuery.isPlaceholderData ? undefined : routeQuery.data;
  const displayRoute = currentRoute ?? (routeQuery.isPlaceholderData ? routeQuery.data : undefined);
  const routeFailed = !routeLoading && routeQuery.isError;
  // A failed request (network, a 422 for a missing pin handled elsewhere, a 500)
  // is explained on the card the same way a server-side fallback is.
  const routeErrorReason = routeFailed
    ? `request_failed: ${routeQuery.error instanceof Error ? routeQuery.error.message : "the route request failed"}`
    : null;

  // A new line, crane or tab starts from the server's recommended option.
  useEffect(() => {
    setSelectedRouteId(null);
  }, [lineId, selectedCraneId, mode]);

  const selectedRoute = useMemo(() => {
    if (!currentRoute) return undefined;
    return (
      currentRoute.routes.find((option) => option.id === selectedRouteId) ??
      currentRoute.routes.find((option) => option.isPrimary) ??
      currentRoute.routes[0]
    );
  }, [currentRoute, selectedRouteId]);

  // Default to the primary option as soon as the response arrives.
  useEffect(() => {
    if (!currentRoute || currentRoute.routes.length === 0) return;
    if (selectedRouteId && currentRoute.routes.some((option) => option.id === selectedRouteId)) {
      return;
    }
    const primary =
      currentRoute.routes.find((option) => option.isPrimary) ?? currentRoute.routes[0];
    if (primary) setSelectedRouteId(primary.id);
  }, [currentRoute, selectedRouteId]);

  const routeMissing: "site" | "crane" | null = !lineId
    ? null
    : !sitePoint
      ? "site"
      : !craneHasPin
        ? "crane"
        : null;

  /**
   * The card's route block.
   *
   * Until the server answers, the crane's list distance is shown, clearly marked
   * approximate. A failed request falls back to a labelled straight line — never
   * to an unlabelled one — and a missing pin is its own message. The alternatives
   * are the server's options, formatted here only for display.
   */
  const routeSummary = useMemo<RouteSummary | null>(() => {
    if (!lineId || !selectedCrane) return null;
    const siteLabel = recommendations?.site.siteLocation ?? "Job site";
    const craneLabel = `${selectedCrane.make} ${selectedCrane.model}`;

    if (routeMissing) {
      return {
        craneId: selectedCrane.craneId,
        distanceLabel: "No route",
        methodLabel: "no pin",
        fallback: false,
        loading: false,
        siteLabel,
        craneLabel,
      };
    }

    if (currentRoute && selectedRoute) {
      const fallback = currentRoute.method === "straight_line";
      const alternatives = currentRoute.routes.map((option) => ({
        id: option.id,
        selected: option.id === selectedRoute.id,
        label: [option.via ? `via ${option.via}` : null, formatDriveTime(option.durationMin), formatKm(option.km)]
          .filter(Boolean)
          .join(" · "),
      }));
      return {
        craneId: selectedCrane.craneId,
        distanceLabel: fallback
          ? `~${formatKm(selectedRoute.km)}`
          : formatRouteDistance(selectedRoute.km, selectedRoute.durationMin),
        methodLabel: fallback ? "approx." : "road",
        fallback,
        fallbackReason: fallback ? (currentRoute.reason ?? null) : null,
        loading: routeLoading,
        siteLabel: currentRoute.siteLabel || siteLabel,
        craneLabel: currentRoute.craneLabel || craneLabel,
        via: selectedRoute.via,
        alternatives,
        onSelectRoute: (routeId) => setSelectedRouteId(routeId),
      };
    }

    const listKm = selectedCrane.distanceKm;
    return {
      craneId: selectedCrane.craneId,
      distanceLabel:
        listKm !== null
          ? `~${formatKm(listKm)}`
          : routeFailed
            ? "Road route unavailable"
            : "Distance unavailable",
      methodLabel:
        routeFailed ||
        selectedCrane.distanceApproximate ||
        selectedCrane.distanceMethod !== "road"
          ? "approx."
          : "road",
      fallback: routeFailed,
      fallbackReason: routeErrorReason,
      loading: routeLoading,
      siteLabel,
      craneLabel,
      onSelectRoute: (routeId) => setSelectedRouteId(routeId),
    };
  }, [
    lineId,
    selectedCrane,
    recommendations,
    routeMissing,
    currentRoute,
    selectedRoute,
    routeLoading,
    routeFailed,
    routeErrorReason,
  ]);

  /**
   * Two or more ticked cranes: draw a road from the job site to each, so the
   * person sees every mobilisation they are about to send an RFQ for. These
   * share the single-route cache key, so a crane already clicked costs nothing.
   */
  const checkedCranes = useMemo(
    () =>
      cranes.filter(
        (crane) =>
          checkedIds.has(crane.craneId) &&
          Number.isFinite(Number(crane.latitude ?? NaN)) &&
          Number.isFinite(Number(crane.longitude ?? NaN)),
      ),
    [cranes, checkedIds],
  );
  const multiActive = Boolean(lineId && sitePoint && checkedCranes.length >= 2);
  const multiQueries = useQueries({
    queries: checkedCranes.map((crane) => ({
      queryKey: ["discovery", "route", lineId, crane.craneId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getLineRoute(lineId as string, crane.craneId, signal),
      enabled: multiActive,
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const multiRoutes = useMemo<GoogleMapMultiRoute[] | null>(() => {
    if (!multiActive || !sitePoint) return null;
    return checkedCranes.map((crane, index) => {
      const query = multiQueries[index];
      return {
        craneId: crane.craneId,
        label: `${crane.make} ${crane.model}`,
        lat: Number(crane.latitude),
        lng: Number(crane.longitude),
        fallbackKm: crane.distanceKm ?? null,
        route: query?.data ?? null,
        loading: query?.isFetching ?? false,
        failed: query?.isError ?? false,
      };
    });
  }, [multiActive, sitePoint, checkedCranes, multiQueries]);

  const mapRoute = useMemo<GoogleMapRoute | null>(() => {
    if (multiActive) return null;
    if (!lineId || !selectedCrane || !sitePoint || !craneHasPin) return null;
    const active = displayRoute;
    // A failed request still gets a labelled dashed line, using the list
    // distance the server already returned. The client never measures.
    const failedOption =
      !active && routeFailed
        ? [
            {
              id: "r0",
              isPrimary: true,
              km: selectedCrane.distanceKm ?? 0,
              durationMin: null,
              via: null,
              encodedPolyline: null,
            },
          ]
        : [];
    const routes = active?.routes ?? failedOption;
    const selectedId =
      selectedRoute?.id ??
      routes.find((option) => option.isPrimary)?.id ??
      routes[0]?.id ??
      "r0";

    return {
      from: {
        lat: sitePoint.latitude,
        lng: sitePoint.longitude,
        label: recommendations?.site.siteLocation ?? "Job site",
      },
      to: {
        lat: Number(selectedCrane.latitude),
        lng: Number(selectedCrane.longitude),
        label: `${selectedCrane.make} ${selectedCrane.model}`,
        craneId: selectedCrane.craneId,
      },
      routes,
      selectedRouteId: selectedId,
      onSelectRoute: (routeId) => setSelectedRouteId(routeId),
      // A straight line is drawn only when the API says so or the request
      // failed; a pending route draws pins and waits for the road.
      fallback: active ? active.method === "straight_line" : routeFailed,
      loading: routeLoading,
    };
  }, [
    lineId,
    selectedCrane,
    sitePoint,
    craneHasPin,
    recommendations,
    displayRoute,
    selectedRoute,
    routeFailed,
    routeLoading,
    multiActive,
  ]);

  /**
   * Auto-select the nearest crane with a pin, once per (line, mode).
   *
   * A route on the map the moment the list appears is the whole point of the
   * screen. The ref keeps the auto-pick from fighting a later click: once the
   * pair has been auto-selected, only the person changes it.
   */
  useEffect(() => {
    if (!lineId || !recommendations || recommendations.lineId !== lineId) return;
    const key = `${lineId}:${mode}`;
    if (autoSelectedRef.current === key) return;
    autoSelectedRef.current = key;
    if (selectedCraneId) return;
    const nearest = orderedRecommendationCranes(recommendations, mode, requiredT)
      .slice(0, TOP_RECOMMENDED_CRANES)
      .filter((crane) => crane.latitude !== null && crane.longitude !== null)
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))[0];
    if (nearest) setSelectedCraneId(nearest.craneId);
  }, [lineId, mode, recommendations, selectedCraneId, requiredT]);

  // Esc closes the line sheet, then the calendar, then clears the crane. An open
  // dialog owns its own Escape handling, so it is left alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (lineSheetOpen) {
        setLineSheetOpen(false);
        return;
      }
      if (calendar) {
        setCalendar(false);
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;
      if (selectedCraneId) {
        setSelectedCraneId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lineSheetOpen, calendar, selectedCraneId]);

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
    if (craneId) {
      document.getElementById(`crane-row-${craneId}`)?.scrollIntoView({ block: "nearest" });
    }
  };

  if (!user) return null;

  const displayName =
    user.vendorName ?? user.fullName?.split(" ")[0] ?? user.email.split("@")[0] ?? "there";

  const toggleChecked = (craneId: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(craneId)) next.delete(craneId);
      else next.add(craneId);
      return next;
    });

  const pickLine = (nextLineId: string) => {
    setCheckedIds(new Set());
    setLineId(nextLineId);
    setMode("technical");
    setSelectedCraneId(null);
    setCalendar(false);
  };

  const clearLine = () => {
    setCheckedIds(new Set());
    setLineId(null);
    setMode("technical");
    setSelectedCraneId(null);
  };

  const changeMode = (nextMode: RecommendationMode) => {
    setCheckedIds(new Set());
    setMode(nextMode);
    setSelectedCraneId(null);
  };

  // ------------------------------------------------------------- drag sheet
  const sheetTransition = sheetDragging || reduceMotion ? "none" : "height 180ms ease";

  const onSheetPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startPct: sheetPct,
      viewport: window.innerHeight,
    };
    setSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onSheetPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaPct = ((drag.startY - event.clientY) / drag.viewport) * 100;
    setSheetPct(Math.min(88, Math.max(26, drag.startPct + deltaPct)));
  };

  const onSheetPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setSheetDragging(false);
    setSheetPct((value) => (value < 39 ? 38 : value < 70 ? 55 : 88));
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const linePanelProps = {
    lineId,
    lines: raisable.data?.lines,
    isPending: raisable.isPending,
    error: (raisable.error as Error | null) ?? null,
    greeting: greeting(),
    displayName,
    theme,
    onToggleTheme: toggleTheme,
    toText: filters.siteLocation,
    onToChange: (value: string) => set("siteLocation", value),
    onPickLine: pickLine,
    onClear: clearLine,
    onRetry: () => void raisable.refetch(),
  };

  const recommendationPanel = (
    <RecommendationPanel
      lineId={lineId as string}
      line={selectedLine}
      mode={mode}
      recommendations={recommendations}
      isPending={recommendationQuery.isPending}
      isError={recommendationQuery.isError}
      error={(recommendationQuery.error as Error | null) ?? null}
      route={routeSummary}
      selectedCraneId={selectedCraneId}
      fromText={filters.location}
      availableOnly={availableOnly}
      onAvailableOnlyChange={setAvailableOnly}
      searchText={searchText}
      onSearchChange={setSearchText}
      onFromChange={(value) => set("location", value)}
      onSelect={setSelectedCraneId}
      checkedIds={checkedIds}
      onToggleChecked={toggleChecked}
      onSetChecked={(ids) => setCheckedIds(new Set(ids))}
      onModeChange={changeMode}
      onClear={clearLine}
      onRetry={() => void recommendationQuery.refetch()}
    />
  );

  /* Browse mode: the filters and the crane list, unchanged by the line picker.
     It is the whole of panel 2 when no line is selected. */
  const browseRail = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[14px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
            Browse cranes
          </p>
          <button
            type="button"
            onClick={() => setCalendar((value) => !value)}
            aria-pressed={calendar}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[14px] transition-colors",
              calendar
                ? "bg-ink-850 text-white"
                : "text-neutral-400 hover:bg-ink-850 hover:text-white",
            )}
          >
            <CalendarDays className="size-3.5" aria-hidden />
            Calendar
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
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

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
              "ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[14px] font-medium transition-colors",
              moreCount > 0
                ? "border-accent-500/60 bg-accent-500/10 text-accent-400"
                : "border-ink-700 text-neutral-400 hover:border-ink-700 hover:text-white",
            )}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal className="size-3" aria-hidden />
            More
            {moreCount > 0 ? (
              <span className="rounded-full bg-accent-500 px-1.5 text-[13px] font-semibold text-[#fff]">
                {moreCount}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-y border-ink-800 px-4 py-2">
        <p className="text-[15px] text-neutral-400" aria-live="polite">
          <span className="font-semibold text-white tabular-nums">
            {data?.totalMatched ?? 0}
          </span>{" "}
          crane{(data?.totalMatched ?? 0) === 1 ? "" : "s"}
          <span className="mx-1.5 text-ink-700">·</span>
          <span className="font-semibold text-accent-400 tabular-nums">{readyNow}</span> ready now
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.isError ? (
          <div className="m-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[15px] text-red-700">
            <p className="font-medium">Could not run that search</p>
            <p className="mt-0.5 text-red-700/80">{(results.error as Error).message}</p>
            <button
              type="button"
              onClick={() => void results.refetch()}
              className="mt-2 rounded-md border border-red-400/40 px-2 py-1 text-[14px] font-medium text-red-700 hover:bg-red-500/10"
            >
              Try again
            </button>
          </div>
        ) : null}

        {siteMissing ? (
          <p className="mx-3 mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[14px] text-amber-700">
            The "To" location was not found, so the list is not distance-sorted. Try a nearby town.
          </p>
        ) : null}

        {results.isPending && !data ? (
          <SkeletonRows />
        ) : !data || cranes.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm font-medium text-neutral-200">No cranes match your filters</p>
            <p className="mt-1 text-xs text-neutral-500">
              Widen the capacity, clear the filters, then try again.
            </p>
            <button
              type="button"
              onClick={clearAll}
              className="mt-4 rounded-lg border border-ink-700 px-3 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-ink-850 hover:text-white"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ul>
            {cranes.map((crane) => (
              <CraneRow
                key={crane.craneId}
                crane={crane}
                selected={crane.craneId === highlightedCraneId}
                onSelect={setSelectedCraneId}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  /* The calendar is a view of the same result set, opened over the workspace.
     Kept as an overlay rather than swapping the map out so the map keeps its
     viewport — and its Leaflet instance — when the calendar closes. */
  const calendarOverlay = calendar ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Crane availability calendar"
      className="fixed inset-0 z-[1000] flex items-stretch justify-center bg-black/70 p-3 sm:items-center sm:p-6"
      onClick={() => setCalendar(false)}
    >
      <div
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-ink-800 bg-ink-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Availability
            </p>
            <p className="mt-0.5 truncate text-[16px] font-semibold text-white">
              {data?.totalMatched ?? 0} crane{(data?.totalMatched ?? 0) === 1 ? "" : "s"} matched
              {committed.availableFrom && committed.availableTo
                ? ` · free from ${committed.availableFrom} to ${committed.availableTo}`
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCalendar(false)}
            aria-label="Close calendar"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-800 text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="rounded-xl bg-slate-100 p-4">
            <p className="mb-3 text-xs text-slate-500">
              Day states come from reservations; the crane&rsquo;s own status fills the rest
            </p>
            <DiscoveryCalendar filters={committedQuery} />
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const craneCard = selectedCrane ? (
    <RouteCard
      crane={selectedCrane}
      route={lineId ? routeSummary : undefined}
      routeMissing={lineId ? routeMissing : undefined}
      docked
      onClose={() => setSelectedCraneId(null)}
    />
  ) : null;

  /* The phone summary strip: the same card, minus the artwork and the facts the
     list already showed, so the sheet can stay short while the route is read. */
  const mobileCraneCard = selectedCrane ? (
    <RouteCard
      crane={selectedCrane}
      route={lineId ? routeSummary : undefined}
      routeMissing={lineId ? routeMissing : undefined}
      compact
      onClose={() => setSelectedCraneId(null)}
    />
  ) : null;

  return (
    <div className={cn("isolate -mx-4 -my-6 flex h-[calc(100dvh-3rem)] flex-col overflow-hidden bg-ink-950 text-neutral-200 sm:-mx-6", theme === "light" ? "theme-light" : "theme-dark")}>
      {isDesktop ? (
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-sm",
            linePanelCollapsed ? "w-14" : "w-[320px]",
          )}
        >
          <LinePanel
            {...linePanelProps}
            collapsed={linePanelCollapsed}
            onToggleCollapsed={() => setLinePanelCollapsed((value) => !value)}
          />
        </aside>

        <aside className="flex min-h-0 w-[400px] shrink-0 flex-col overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-sm">
          {lineId ? recommendationPanel : browseRail}
        </aside>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-ink-800">
          <GoogleCraneMap
            key={theme}
            theme={theme}
            className="h-full w-full"
            cranes={cranes}
            site={sitePoint}
            siteLabel={lineId ? (recommendations?.site.siteLocation ?? null) : null}
            selectedCraneId={highlightedCraneId}
            route={mapRoute}
            multiRoutes={multiRoutes}
            onSelect={selectFromMap}
          />
          {craneCard ? (
            <div className="pointer-events-none absolute bottom-8 left-4 z-[900] w-[340px] max-w-[calc(100%-2rem)]">
              {craneCard}
            </div>
          ) : null}
        </main>
      </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 bg-ink-900 px-3 py-2">
          <button
            type="button"
            onClick={() => setLineSheetOpen(true)}
            aria-haspopup="dialog"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-ink-800 bg-ink-850 px-2.5 py-1.5 text-left"
          >
            <MapPin className="size-3.5 shrink-0 text-accent-400" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
                Enquiry line
              </span>
              <span className="block truncate text-[15px] font-medium text-neutral-100">
                {selectedLine ? lineReference(selectedLine) : "Pick a line · or browse all cranes"}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-neutral-500" aria-hidden />
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} className="border border-ink-800" />
          {lineId ? (
            <button
              type="button"
              onClick={clearLine}
              aria-label="Clear enquiry line"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-800 text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>

        <main className="relative min-h-0 flex-1">
          <GoogleCraneMap
            key={theme}
            theme={theme}
            className="h-full w-full"
            cranes={cranes}
            site={sitePoint}
            siteLabel={lineId ? (recommendations?.site.siteLocation ?? null) : null}
            selectedCraneId={highlightedCraneId}
            route={mapRoute}
            multiRoutes={multiRoutes}
            onSelect={selectFromMap}
          />
        </main>

        <div
          ref={sheetRef}
          className="relative z-[850] flex shrink-0 flex-col overflow-hidden rounded-t-2xl border-t border-ink-800 bg-ink-900 shadow-[0_-12px_30px_rgba(0,0,0,0.2)]"
          style={{ height: `${sheetPct}%`, transition: sheetTransition }}
        >
          <div
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerUp}
            role="separator"
            aria-label="Drag the crane list"
            aria-orientation="horizontal"
            className="flex shrink-0 cursor-grab touch-none justify-center py-2 active:cursor-grabbing"
          >
            <span className="h-1 w-10 rounded-full bg-ink-700" aria-hidden />
          </div>

          {selectedCrane ? (
            <div className="max-h-[46%] shrink-0 overflow-y-auto border-b border-ink-800 px-2.5 pb-2.5">
              {mobileCraneCard}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {lineId ? recommendationPanel : browseRail}
          </div>
        </div>
      </div>
      )}

      {calendarOverlay}

      {moreOpen ? (
        <MoreFilters
          filters={filters}
          set={set}
          enquirySite={selectedLine?.siteLocation ?? null}
          halfWindow={halfWindow}
          activeCount={moreCount}
          onClear={clearAll}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}

      {/* The line picker as a sheet on screens without room for three panels. */}
      {lineSheetOpen && !isDesktop ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Pick an enquiry line"
          className="fixed inset-0 z-[1000] flex items-end bg-black/60 xl:hidden"
          onClick={() => setLineSheetOpen(false)}
        >
          <div
            className="h-[85dvh] w-full overflow-hidden rounded-t-2xl border-t border-ink-800 bg-ink-900"
            onClick={(event) => event.stopPropagation()}
          >
            <LinePanel
              {...linePanelProps}
              collapsed={false}
              onToggleCollapsed={() => setLineSheetOpen(false)}
              onPicked={() => setLineSheetOpen(false)}
            />
          </div>
        </div>
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
        "rounded-full px-3 py-1 text-[14px] font-medium transition-colors",
        active
          ? "bg-white text-ink-950"
          : "border border-ink-700 text-neutral-400 hover:border-ink-700 hover:text-white",
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
  onSelect,
}: {
  crane: DiscoveryCrane;
  selected: boolean;
  onSelect: (craneId: string) => void;
}) {
  return (
    <li id={`crane-row-${crane.craneId}`}>
      <button
        type="button"
        onClick={() => onSelect(crane.craneId)}
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
              "mt-1 text-[12px] font-semibold tracking-[0.16em]",
              selected ? "text-neutral-500" : "text-neutral-500",
            )}
          >
            TON
          </span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold text-neutral-100">
            {crane.make} {crane.model}
          </span>
          <span className="mt-0.5 block truncate text-[14px] text-neutral-400">
            {crane.typeOfCraneName} · {crane.currentLocation}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-neutral-500">
            {crane.vendorName}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 text-[14px] text-neutral-400">
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
 * only as tall as it needs to be. The CTA opens the request window, which lists
 * the live RFQs and lines this crane can be offered against; "Open crane" inside
 * that window still reaches the crane's own screen.
 */
function MoreFilters({
  filters,
  set,
  enquirySite,
  halfWindow,
  activeCount,
  onClear,
  onClose,
}: {
  filters: FilterState;
  set: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  /** The selected enquiry's site, when one is picked; it then fills "To". */
  enquirySite: string | null;
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
            <legend className="text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
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
            <p className="text-[14px] text-neutral-500">
              {halfWindow
                ? "Set both dates — one date has no period to test a booking against."
                : "A crane must be free for the whole window, not only on the first day."}
            </p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Route
            </legend>
            <Field
              label="From"
              htmlFor="more-from-location"
              hint="Only cranes located here are listed, e.g. Pune."
            >
              <TextInput
                id="more-from-location"
                value={filters.location}
                onChange={(value) => set("location", value)}
                placeholder="Crane location, e.g. Pune"
              />
            </Field>
            <Field
              label="To"
              htmlFor="more-to-location"
              hint={
                enquirySite
                  ? "Taken from the selected enquiry."
                  : "The enquiry site. Drops the red site pin and sorts the list by road distance."
              }
            >
              <TextInput
                id="more-to-location"
                value={enquirySite ?? filters.siteLocation}
                onChange={(value) => set("siteLocation", value)}
                disabled={Boolean(enquirySite)}
                placeholder="Enquiry site, e.g. Vadodara, Gujarat"
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
              Crane
            </legend>
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
            <label className="flex cursor-pointer items-center gap-2 text-[15px] text-neutral-300">
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
            <legend className="text-[13px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
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
            className="flex-1 rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-[#fff] transition-colors hover:bg-accent-600"
          >
            Done{activeCount > 0 ? ` · ${activeCount} applied` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}



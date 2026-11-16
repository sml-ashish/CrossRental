import { useEffect, useMemo, useRef, useState } from "react";
import { MarkerClusterer, type Renderer } from "@googlemaps/markerclusterer";
import {
  formatDriveTime,
  formatKm,
  type DiscoveryCrane,
  type DiscoveryVendorPoint,
  type LineRouteOption,
} from "@/lib/discovery";
import {
  hasGoogleMapsAuthFailed,
  isGoogleMapsConfigured,
  loadGoogleMaps,
  onGoogleMapsAuthFailure,
  type GoogleMapsApi,
} from "@/lib/google-maps";
import { CraneMap } from "@/components/crane-map";
import { craneClusterSvg, craneFill, cranePillSvg } from "@/components/crane-glyph";
import { cn } from "@/lib/cn";

/**
 * Find cranes on Google Maps.
 *
 * The page keeps its Leaflet map as a fallback, but the route experience —
 * real roads, clickable alternatives, time/distance bubbles — is what a person
 * comparing mobilisations needs, and that is what the Maps JavaScript API
 * draws. Nothing here computes a distance or a duration: every number on a
 * bubble or in the card comes from the server.
 *
 * The map is created once and later changed by clearing and redrawing overlays.
 * Markers and clusters are rebuilt when the crane set changes; the route is
 * rebuilt when the selection or the chosen alternative changes, so a pending
 * request never leaves the previous shape half-removed.
 */

export interface GoogleMapRoute {
  /** The job site. */
  from: { lat: number; lng: number; label: string };
  /** The selected crane. */
  to: { lat: number; lng: number; label: string; craneId?: string };
  /** Primary first, straight from the server. */
  routes: LineRouteOption[];
  selectedRouteId: string;
  onSelectRoute: (routeId: string) => void;
  /** True only for the labelled straight-line fallback. */
  fallback: boolean;
  /** True while a fresh route is in flight; the previous one stays, faded. */
  loading?: boolean;
}

export interface GoogleCraneMapProps {
  cranes: DiscoveryCrane[];
  vendorPoints: DiscoveryVendorPoint[];
  site: { latitude: number; longitude: number } | null;
  /** The site's text label, for the map's own marker. */
  siteLabel?: string | null;
  selectedCraneId?: string | null;
  onSelect?: (craneId: string | null) => void;
  /** The route from the job site to the selected crane, when a line is open. */
  route?: GoogleMapRoute | null;
  className?: string;
}

interface MapPoint {
  crane: DiscoveryCrane;
  lat: number;
  lng: number;
}

const INDIA_CENTER = { lat: 22.5, lng: 79 };
const INDIA_ZOOM = 5;
/** The site marker shares the marker map, with a key no crane id can collide with. */
const SITE_MARKER_KEY = "__site__";
const MAP_ID = (import.meta.env.VITE_GOOGLE_MAP_ID ?? "").trim() || "DEMO_MAP_ID";

const NOT_CONFIGURED =
  "Google Maps is not configured, showing the basic map. Routes are unavailable.";

/**
 * Distinct from a missing key on purpose: a present key that Google refuses
 * (API not enabled, referrer restriction, billing) used to wear the same
 * "not configured" label, which sent people looking in the wrong place.
 */
const LOAD_FAILED =
  "Google Maps could not load, showing the basic map. Routes are unavailable. Check the browser key, its referrer restrictions and the Maps JavaScript API.";

/**
 * Google accepted the script but rejected the key, so the map would render in
 * its "for development purposes only" mode. The console line starting with
 * "Google Maps JavaScript API error" names the exact cause.
 */
const AUTH_FAILED =
  "Google Maps rejected the browser key (billing, API not enabled, referrer or invalid key), showing the basic map. Routes are unavailable. See the browser console for the exact error.";

const ROUTE_BLUE = "#1a73e8";
const ROUTE_ALT = "#8ea7c9";

/** Route colours that read on the dark basemap without shouting. */
const HEAT_COLOURS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];

export function GoogleCraneMap({
  cranes,
  vendorPoints,
  site,
  siteLabel,
  selectedCraneId = null,
  onSelect,
  route = null,
  className,
}: GoogleCraneMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const overlaysRef = useRef<{
    lines: google.maps.Polyline[];
    markers: google.maps.marker.AdvancedMarkerElement[];
  }>({ lines: [], markers: [] });
  const heatRef = useRef<google.maps.Circle[]>([]);
  const fittedRef = useRef(false);

  // The map's click handler is installed once, so it reads the latest callbacks
  // and selection through refs rather than capturing the first render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selectedCraneId);
  selectedRef.current = selectedCraneId;

  const [api, setApi] = useState<GoogleMapsApi | null>(null);
  const [failure, setFailure] = useState<string | null>(() =>
    !isGoogleMapsConfigured()
      ? NOT_CONFIGURED
      : hasGoogleMapsAuthFailed()
        ? AUTH_FAILED
        : null,
  );
  const [ready, setReady] = useState(false);
  const [showHeat, setShowHeat] = useState(false);
  const [heatMode, setHeatMode] = useState<"cranes" | "vendors">("cranes");

  const points = useMemo<MapPoint[]>(
    () =>
      cranes
        .filter(
          (crane): crane is DiscoveryCrane & { latitude: number; longitude: number } =>
            crane.latitude !== null && crane.longitude !== null,
        )
        .map((crane) => ({ crane, lat: crane.latitude, lng: crane.longitude })),
    [cranes],
  );

  const sitePoint = useMemo(
    () => (site ? { lat: site.latitude, lng: site.longitude } : null),
    [site],
  );

  const statesLive = useMemo(
    () => new Set(points.map((point) => point.crane.stateName).filter(Boolean)).size,
    [points],
  );

  // ------------------------------------------------------------ load the SDK
  useEffect(() => {
    if (!isGoogleMapsConfigured()) return;
    let cancelled = false;
    loadGoogleMaps()
      .then((libraries) => {
        if (!cancelled) setApi(libraries);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Keep the real reason in the console; the on-map note stays short.
        console.warn("[Google Maps]", error);
        setFailure(LOAD_FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A rejected key is reported after the script loads, so it needs its own
  // listener: the load promise above resolves fine.
  useEffect(() => onGoogleMapsAuthFailure(() => setFailure(AUTH_FAILED)), []);

  // ---------------------------------------------------------------- the map
  useEffect(() => {
    const container = containerRef.current;
    if (!api || !container || mapRef.current) return;

    const map = new api.maps.Map(container, {
      center: INDIA_CENTER,
      zoom: INDIA_ZOOM,
      mapId: MAP_ID,
      colorScheme: "DARK",
      backgroundColor: "#0a0b0d",
      gestureHandling: "greedy",
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      zoomControl: true,
      clickableIcons: false,
    });
    mapRef.current = map;

    map.addListener("click", () => onSelectRef.current?.(null));

    // Clusters are drawn by the map's own renderer below; the instance lives
    // across marker rebuilds so its projection work is not thrown away.
    const renderer: Renderer = {
      render: (cluster) => {
        const artwork = craneClusterSvg(cluster.count);
        const content = centeredCircleArtwork(artwork);
        const position = cluster.position;
        const marker = new api.marker.AdvancedMarkerElement({
          position: position ?? null,
          content,
          title: `${cluster.count} cranes`,
          gmpClickable: true,
          zIndex: 200,
        });
        marker.addListener("gmp-click", () => {
          map.setZoom(Math.min(zoomOf(map) + 2, 18));
          if (position) map.panTo(position);
        });
        return marker;
      },
    };
    clustererRef.current = new MarkerClusterer({ map, markers: [], renderer });

    setReady(true);

    return () => {
      setReady(false);
      fittedRef.current = false;
      markersRef.current.forEach((marker) => {
        marker.map = null;
      });
      markersRef.current.clear();
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
      clearOverlays(overlaysRef.current);
      clearHeat(heatRef.current);
      heatRef.current = [];
      google.maps.event.clearInstanceListeners(map);
      mapRef.current = null;
      container.innerHTML = "";
    };
  }, [api]);

  // A new result set is a new frame of reference, so the next marker pass may
  // frame the map again.
  useEffect(() => {
    fittedRef.current = false;
  }, [points]);

  // ------------------------------------------------------------ the markers
  useEffect(() => {
    const map = mapRef.current;
    const clusterer = clustererRef.current;
    if (!api || !ready || !map || !clusterer) return;

    markersRef.current.forEach((marker) => {
      marker.map = null;
    });
    markersRef.current.clear();
    clusterer.clearMarkers();

    if (sitePoint) {
      const marker = new api.marker.AdvancedMarkerElement({
        position: sitePoint,
        content: siteMarkerContent(siteLabel ?? "Job site"),
        title: siteLabel ?? "Job site",
        zIndex: 500,
      });
      marker.map = map;
      markersRef.current.set(SITE_MARKER_KEY, marker);
    }

    // With a route open, the destination is the red pin: its capacity pill
    // would sit exactly underneath it and hide the pin's point.
    const destinationCraneId = route?.to.craneId ?? null;

    const markers: google.maps.marker.AdvancedMarkerElement[] = [];
    for (const point of points) {
      if (point.crane.craneId === destinationCraneId) continue;
      const selected = point.crane.craneId === selectedCraneId;
      const artwork = cranePillSvg(point.crane.currentStatus, point.crane.capacityT, selected);
      const content = document.createElement("div");
      content.innerHTML = artwork.html;
      content.style.cursor = "pointer";

      const marker = new api.marker.AdvancedMarkerElement({
        position: { lat: point.lat, lng: point.lng },
        content,
        title: `${point.crane.make} ${point.crane.model} · ${point.crane.vendorName}`,
        gmpClickable: true,
        zIndex: selected ? 1000 : 100,
      });
      marker.addListener("gmp-click", () => {
        onSelectRef.current?.(point.crane.craneId);
      });
      markersRef.current.set(point.crane.craneId, marker);
      markers.push(marker);
    }
    clusterer.addMarkers(markers);

    // Frame the results once per result set, unless a route owns the viewport.
    if (!route && !fittedRef.current && points.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      for (const point of points) bounds.extend({ lat: point.lat, lng: point.lng });
      if (sitePoint) bounds.extend(sitePoint);
      fitBounds(map, api, bounds, 56);
      fittedRef.current = true;
    }
    // `route` is intentionally read, but a route change must not rebuild pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ready, points, selectedCraneId, sitePoint, siteLabel, route?.to.craneId]);

  // Bring the selected crane into view. A crane hidden inside a cluster has no
  // map of its own, so selecting it zooms until the cluster splits.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedCraneId) return;
    const point = points.find((candidate) => candidate.crane.craneId === selectedCraneId);
    if (!point) return;

    const position = { lat: point.lat, lng: point.lng };
    const bounds = map.getBounds();
    const marker = markersRef.current.get(selectedCraneId);
    const hidden = !marker || marker.map === null;
    if (!bounds?.contains(position)) {
      map.panTo(position);
      if (zoomOf(map) < 10) map.setZoom(10);
    } else if (hidden) {
      map.setZoom(Math.max(zoomOf(map) + 2, 10));
      map.panTo(position);
    }
  }, [ready, selectedCraneId, points, route?.to.craneId]);

  // ----------------------------------------------------------------- routes
  useEffect(() => {
    const map = mapRef.current;
    if (!api || !ready || !map) return;

    clearOverlays(overlaysRef.current);
    overlaysRef.current = { lines: [], markers: [] };
    if (!route) return;

    const lines: google.maps.Polyline[] = [];
    const markers: google.maps.marker.AdvancedMarkerElement[] = [];
    const bounds = new google.maps.LatLngBounds();

    bounds.extend(route.from);
    bounds.extend(route.to);

    const decoded = route.routes.map((option) => {
      const path =
        option.encodedPolyline && !route.fallback
          ? api.geometry.encoding.decodePath(option.encodedPolyline)
          : null;
      if (path) {
        for (const point of path) bounds.extend(point);
      }
      return { option, path };
    });

    // Endpoints are always drawn, even before the first route arrives: the
    // question "where are the two ends" has an answer before the road does.
    // The job site's white dot is the map's own site marker, so only the
    // destination needs drawing here.
    markers.push(destinationPin(api, map, route.to, route.loading === true));

    const fade = route.loading === true;

    decoded.forEach(({ option, path }, index) => {
      const selected = option.id === route.selectedRouteId;
      const fallbackLine = route.fallback || !path || path.length < 2;
      const pointsOnPath = fallbackLine
        ? [route.from, route.to]
        : path;

      if (fallbackLine) {
        const dashed = new api.maps.Polyline({
          path: pointsOnPath,
          strokeOpacity: 0,
          zIndex: selected ? 50 : 20,
          clickable: true,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeOpacity: fade ? 0.4 : 0.9,
                strokeColor: selected ? ROUTE_BLUE : ROUTE_ALT,
                scale: 3,
              },
              offset: "0",
              repeat: "14px",
            },
          ],
        });
        dashed.addListener("click", (event: google.maps.MapMouseEvent) => {
          event.stop();
          route.onSelectRoute(option.id);
        });
        dashed.setMap(map);
        lines.push(dashed);
      } else {
        const casing = new api.maps.Polyline({
          path: pointsOnPath,
          strokeColor: "#ffffff",
          strokeOpacity: fade ? 0.25 : selected ? 0.92 : 0.5,
          strokeWeight: selected ? 9 : 7,
          zIndex: selected ? 40 : 10,
          clickable: false,
        });
        casing.setMap(map);
        lines.push(casing);

        const line = new api.maps.Polyline({
          path: pointsOnPath,
          strokeColor: selected ? ROUTE_BLUE : ROUTE_ALT,
          strokeOpacity: fade ? 0.35 : selected ? 1 : 0.72,
          strokeWeight: selected ? 6 : 5,
          zIndex: selected ? 50 : 20,
          clickable: true,
        });
        line.addListener("click", (event: google.maps.MapMouseEvent) => {
          event.stop();
          route.onSelectRoute(option.id);
        });
        line.setMap(map);
        lines.push(line);
      }

      // A bubble on every option, spread along the path so two labels for two
      // nearly identical roads do not sit on top of each other.
      const fraction = selected ? 0.5 : index === 1 ? 0.38 : 0.64;
      const position = pointAtFraction(api, pointsOnPath, fraction);
      const bubble = new api.marker.AdvancedMarkerElement({
        position,
        content: bubbleContent(option, selected, route.fallback, route.loading === true),
        title: option.via ?? option.id,
        gmpClickable: true,
        zIndex: selected ? 120 : 110,
      });
      bubble.addListener("gmp-click", () => route.onSelectRoute(option.id));
      bubble.map = map;
      markers.push(bubble);
    });

    fitBounds(map, api, bounds, 72, route ? 220 : 72);

    overlaysRef.current = { lines, markers };
  }, [api, ready, route]);

  // ------------------------------------------------------------------- heat
  useEffect(() => {
    const map = mapRef.current;
    if (!api || !ready || !map) return;

    clearHeat(heatRef.current);
    heatRef.current = [];
    if (!showHeat) return;

    const groups = heatGroups(
      heatMode === "vendors"
        ? vendorPoints.map((vendor) => ({
            lat: vendor.latitude,
            lng: vendor.longitude,
            key: vendor.stateName ?? vendor.stateCode ?? "Unknown",
          }))
        : points.map((point) => ({
            lat: point.lat,
            lng: point.lng,
            key: point.crane.stateName || "Unknown",
          })),
    );
    if (groups.length === 0) return;

    const max = groups.reduce((value, group) => Math.max(value, group.count), 1);
    const circles = groups.map((group) => {
      const level = Math.min(
        HEAT_COLOURS.length - 1,
        Math.floor((group.count / max) * HEAT_COLOURS.length),
      );
      const circle = new api.maps.Circle({
        center: { lat: group.lat, lng: group.lng },
        radius: 45_000 + 30_000 * Math.sqrt(group.count),
        fillColor: HEAT_COLOURS[level],
        fillOpacity: 0.24,
        strokeOpacity: 0,
        clickable: false,
        zIndex: 5,
      });
      circle.setMap(map);
      return circle;
    });
    heatRef.current = circles;
  }, [api, ready, showHeat, heatMode, points, vendorPoints]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!api || !map || points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const point of points) bounds.extend({ lat: point.lat, lng: point.lng });
    if (sitePoint) bounds.extend(sitePoint);
    fitBounds(map, api, bounds, 56);
  };

  // The key is missing or the script failed: the screen keeps a map, just not
  // this one. No route is drawn on the fallback — its dashed line would be a
  // route the server never returned.
  if (failure) {
    return (
      <div className={cn("relative overflow-hidden bg-ink-950", className)}>
        <CraneMap
          className="h-full w-full"
          cranes={cranes}
          vendorPoints={vendorPoints}
          site={site}
          selectedCraneId={selectedCraneId}
          onSelect={onSelect}
        />
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[900] flex justify-center px-3">
          <p className="max-w-md rounded-xl border border-amber-500/35 bg-ink-900/95 px-3 py-1.5 text-center text-[11px] leading-snug text-amber-200 shadow-lg backdrop-blur">
            {failure}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden bg-ink-950", className)}>
      <div ref={containerRef} className="h-full w-full" />

      {!ready ? (
        <div className="absolute inset-0 z-[700] flex items-center justify-center bg-ink-950">
          <p className="rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-[11px] text-neutral-400 shadow-lg">
            Loading the map…
          </p>
        </div>
      ) : null}

      <div className="absolute top-3 right-3 z-[800] flex flex-col items-end gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-900/95 px-2.5 py-1.5 text-[11px] text-neutral-400 shadow-lg backdrop-blur">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showHeat}
              onChange={(event) => setShowHeat(event.target.checked)}
              className="accent-accent-500"
            />
            Heat
          </label>
          <div
            className="inline-flex items-center rounded-md border border-ink-800 bg-ink-850 p-0.5"
            role="group"
            aria-label="Heat map basis"
          >
            <HeatModeButton
              active={heatMode === "cranes"}
              onClick={() => setHeatMode("cranes")}
              label="Cranes"
            />
            <HeatModeButton
              active={heatMode === "vendors"}
              onClick={() => setHeatMode("vendors")}
              label="Vendors"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={fitAll}
          className="rounded-lg border border-ink-800 bg-ink-900/95 px-2.5 py-1.5 text-[11px] font-medium text-neutral-300 shadow-lg backdrop-blur hover:text-white"
        >
          Fit all
        </button>
      </div>

      <div className="pointer-events-none absolute top-3 left-3 z-[800] flex flex-col items-start gap-2">
        <div className="rounded-full border border-ink-800 bg-ink-900/95 px-3 py-1.5 text-[11px] font-medium text-neutral-300 shadow-lg backdrop-blur">
          India · {statesLive} state{statesLive === 1 ? "" : "s"} live
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-900/95 px-3 py-2 text-[11px] text-neutral-400 shadow-lg backdrop-blur">
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LegendItem status="AVAILABLE" label="Available" />
            <LegendItem status="ENGAGED" label="Engaged" />
            <LegendItem status="UNDER_MAINTENANCE" label="Maintenance" />
            <li className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-accent-500 ring-2 ring-ink-900" />
              Job site
            </li>
          </ul>
          {points.length < cranes.length ? (
            <p className="mt-1 text-neutral-500">
              {points.length} of {cranes.length} cranes placed
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function LegendItem({ status, label }: { status: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-sm ring-1 ring-ink-700"
        style={{ backgroundColor: craneFill(status) }}
      />
      {label}
    </li>
  );
}

function HeatModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
        active ? "bg-ink-700 text-white" : "text-neutral-500 hover:text-neutral-200",
      )}
    >
      {label}
    </button>
  );
}

function clearOverlays(overlays: {
  lines: google.maps.Polyline[];
  markers: google.maps.marker.AdvancedMarkerElement[];
}) {
  for (const line of overlays.lines) line.setMap(null);
  for (const marker of overlays.markers) marker.map = null;
}

function clearHeat(circles: google.maps.Circle[]) {
  for (const circle of circles) circle.setMap(null);
}

/**
 * The default AdvancedMarkerElement anchor is the bottom centre of its content,
 * so a round artwork is wrapped in a box half its height: the box's bottom
 * centre then lands on the circle's centre.
 */
function centeredCircleArtwork(artwork: { html: string; width: number; height: number }) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `position:relative;width:${artwork.width}px;height:${
    artwork.height / 2
  }px;cursor:pointer;`;
  const inner = document.createElement("div");
  inner.style.cssText = "position:absolute;top:0;left:0;";
  inner.innerHTML = artwork.html;
  wrapper.appendChild(inner);
  return wrapper;
}

function siteMarkerContent(label: string) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;width:22px;height:11px;";
  wrapper.innerHTML =
    `<span style="position:absolute;top:0;left:0;width:22px;height:22px;border-radius:9999px;` +
    `background:#ffffff;border:3px solid #111827;box-sizing:border-box;` +
    `box-shadow:0 0 0 3px rgba(255,255,255,0.45);"></span>` +
    `<span style="position:absolute;left:50%;bottom:26px;transform:translateX(-50%);` +
    `white-space:nowrap;background:#111827;color:#ffffff;border:1px solid #3f3f46;` +
    `border-radius:9999px;padding:2px 7px;font:600 10px/1.3 system-ui,sans-serif;` +
    `box-shadow:0 4px 12px rgba(0,0,0,0.5);">${escapeHtml(label)}</span>`;
  return wrapper;
}

function destinationPin(
  api: GoogleMapsApi,
  map: google.maps.Map,
  to: GoogleMapRoute["to"],
  faded: boolean,
) {
  const pin = new api.marker.PinElement({
    background: "#ea4335",
    borderColor: "#b31412",
    glyphColor: "#ffffff",
    scale: 1.05,
  });
  const marker = new api.marker.AdvancedMarkerElement({
    position: { lat: to.lat, lng: to.lng },
    content: pin.element,
    title: to.label,
    zIndex: 600,
  });
  if (faded) marker.element.style.opacity = "0.55";
  marker.map = map;
  return marker;
}

const CAR_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M19 17h2l.64-2.54a6 6 0 0 0-1.65-5.28' +
  'L18 6.5 16 5H8L6 6.5 4.01 9.18a6 6 0 0 0-1.65 5.28L3 17h2"/><path d="M14 17H9"/>' +
  '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>';

function bubbleContent(
  option: LineRouteOption,
  selected: boolean,
  fallback: boolean,
  faded: boolean,
) {
  const time = fallback
    ? "Approx."
    : (formatDriveTime(option.durationMin) ?? formatKm(option.km));
  const distance = fallback ? `~${formatKm(option.km)}` : formatKm(option.km);
  const detail = fallback ? `${distance} · no road route` : distance;

  const card = document.createElement("div");
  card.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:12px;" +
    `cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.45);border:1px solid ${
      selected ? "#1a73e8" : "#e5e7eb"
    };background:${selected ? ROUTE_BLUE : "#ffffff"};color:${selected ? "#ffffff" : "#111827"};` +
    `opacity:${faded ? "0.55" : "1"};font-family:system-ui,sans-serif;`;
  card.innerHTML =
    `<span style="display:flex;align-items:center;justify-content:center;width:18px;height:18px;">` +
    CAR_ICON +
    `</span><span style="display:block;text-align:left;line-height:1.15;">` +
    `<span style="display:block;font-size:11px;font-weight:700;white-space:nowrap;">${escapeHtml(
      time,
    )}</span>` +
    `<span style="display:block;font-size:9px;font-weight:500;white-space:nowrap;opacity:0.8;">${escapeHtml(
      detail,
    )}</span></span>`;
  return card;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A point roughly `fraction` along a decoded path, found by walking it. ~50% is
 * a useful place for a label: far enough from both ends that it does not cover
 * the job site or the crane.
 */
function pointAtFraction(
  api: GoogleMapsApi,
  path: Array<google.maps.LatLng | google.maps.LatLngLiteral>,
  fraction: number,
): google.maps.LatLngLiteral {
  if (path.length === 0) return { lat: 0, lng: 0 };
  if (path.length === 1) return coordinate(path[0]!);

  const segments: number[] = [];
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    const between = api.geometry.spherical.computeDistanceBetween(
      path[index - 1] as google.maps.LatLng,
      path[index] as google.maps.LatLng,
    );
    segments.push(between);
    total += between;
  }
  if (total <= 0) return coordinate(path[0]!);

  let target = total * Math.min(0.92, Math.max(0.08, fraction));
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (target <= segment) {
      const start = coordinate(path[index]!);
      const end = coordinate(path[index + 1]!);
      const ratio = segment === 0 ? 0 : target / segment;
      return {
        lat: start.lat + (end.lat - start.lat) * ratio,
        lng: start.lng + (end.lng - start.lng) * ratio,
      };
    }
    target -= segment;
  }
  return coordinate(path[path.length - 1]!);
}

/**
 * A `LatLng` exposes `lat()`; a `LatLngLiteral` exposes `lat`. Decoded paths
 * are `LatLng`s and the fallback is literals, so both are read through here.
 */
function coordinate(point: google.maps.LatLng | google.maps.LatLngLiteral): {
  lat: number;
  lng: number;
} {
  return {
    lat: typeof point.lat === "function" ? point.lat() : point.lat,
    lng: typeof point.lng === "function" ? point.lng() : point.lng,
  };
}

/** Google's `getZoom` may be undefined before the first idle event. */
function zoomOf(map: google.maps.Map): number {
  return map.getZoom() ?? INDIA_ZOOM;
}

/**
 * Fits the map with room for the floating chrome. The bottom padding is larger
 * than the top because the summary card sits over the bottom of the map.
 */
function fitBounds(
  map: google.maps.Map,
  api: GoogleMapsApi,
  bounds: google.maps.LatLngBounds,
  padding: number,
  bottomPadding = padding,
) {
  if (bounds.isEmpty()) return;
  const northEast = bounds.getNorthEast();
  const southWest = bounds.getSouthWest();
  if (northEast.equals(southWest)) {
    map.setCenter(northEast);
    map.setZoom(11);
    return;
  }
  map.fitBounds(bounds, {
    top: padding,
    right: padding,
    bottom: bottomPadding,
    left: padding,
  });
  // `fitBounds` on a vector map can land too tight at the largest zoom; the
  // screen is for a journey, not a street.
  const zoom = map.getZoom();
  if (typeof zoom === "number" && zoom > 14) map.setZoom(14);
  void api;
}

interface HeatGroup {
  lat: number;
  lng: number;
  count: number;
}

/** One blob per state, sized by the number of points it covers. */
function heatGroups(
  points: Array<{ lat: number; lng: number; key: string }>,
): HeatGroup[] {
  const buckets = new Map<string, { lat: number; lng: number; count: number }>();
  for (const point of points) {
    const bucket = buckets.get(point.key);
    if (bucket) {
      bucket.lat += point.lat;
      bucket.lng += point.lng;
      bucket.count += 1;
    } else {
      buckets.set(point.key, { lat: point.lat, lng: point.lng, count: 1 });
    }
  }
  return [...buckets.values()].map((bucket) => ({
    lat: bucket.lat / bucket.count,
    lng: bucket.lng / bucket.count,
    count: bucket.count,
  }));
}


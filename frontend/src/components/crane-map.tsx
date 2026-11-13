import { useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DiscoveryCrane, DiscoveryVendorPoint } from "@/lib/discovery";
import { craneClusterSvg, craneFill, cranePillSvg } from "@/components/crane-glyph";
import { TILE_PANE_CLASS, TILES_ATTRIBUTION, TILES_MAX_ZOOM, TILES_URL } from "@/lib/map-tiles";
import { cn } from "@/lib/cn";

/**
 * Discovery map (P4, BPD 6.8) on Leaflet and OpenStreetMap tiles.
 *
 * Basemap configuration lives in `lib/map-tiles.ts` and is shared with the
 * enquiry screen's site map, so both maps are dark in the same way and both
 * switch providers from the same environment variables.
 *
 * A crane is a capacity pill with a status dot, clustered by screen grid rather
 * than by a plugin: a cluster is a count, and the grid dissolves on zoom with no
 * extra dependency. The heat layer is a canvas baked into an `imageOverlay`,
 * because a per-pixel canvas redraw on every pan is not worth it and Leaflet
 * repositions overlays for free.
 */

interface MapPoint {
  crane: DiscoveryCrane;
  lat: number;
  lng: number;
}

interface HeatPoint {
  lat: number;
  lng: number;
}

/** Cluster cell in screen pixels. Below this, two cranes are one marker. */
const CLUSTER_CELL = 72;

/** Where the map opens before any data arrives: the middle of India. */
const INDIA_CENTER: L.LatLngTuple = [22.5, 79];
const INDIA_ZOOM = 5;

function craneIcon(status: string, capacityT: number, selected: boolean): L.DivIcon {
  const artwork = cranePillSvg(status, capacityT, selected);
  return L.divIcon({
    className: selected ? "crane-pin crane-pin-selected" : "crane-pin",
    html: artwork.html,
    iconSize: [artwork.width, artwork.height],
    // The tail's tip is the crane's position on the ground.
    iconAnchor: [artwork.width / 2, artwork.anchorY],
  });
}

function clusterIcon(count: number): L.DivIcon {
  const artwork = craneClusterSvg(count);
  return L.divIcon({
    className: "crane-pin",
    html: artwork.html,
    iconSize: [artwork.width, artwork.height],
    iconAnchor: [artwork.width / 2, artwork.anchorY],
  });
}

/**
 * Grid clustering in screen space.
 *
 * Buckets are measured in pixels at the current zoom, so a cluster is "these
 * cranes are within 72px of each other on this screen" — which is exactly what
 * the eye is asking when it sees overlapping pins. Zooming in splits them
 * automatically because the same cranes project further apart.
 */
function clusterPoints(points: MapPoint[], map: L.Map, zoom: number) {
  const buckets = new Map<string, MapPoint[]>();
  for (const point of points) {
    const projected = map.project([point.lat, point.lng], zoom);
    const key = `${Math.floor(projected.x / CLUSTER_CELL)}:${Math.floor(
      projected.y / CLUSTER_CELL,
    )}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  return [...buckets.values()].map((members) => ({
    cranes: members.map((member) => member.crane),
    lat: members.reduce((sum, member) => sum + member.lat, 0) / members.length,
    lng: members.reduce((sum, member) => sum + member.lng, 0) / members.length,
  }));
}

export interface CraneMapProps {
  cranes: DiscoveryCrane[];
  /** One dot per vendor, placed from the vendor's address by the server. */
  vendorPoints: DiscoveryVendorPoint[];
  site: { latitude: number; longitude: number } | null;
  /** The crane highlighted in the sidebar, or `null` for none. */
  selectedCraneId?: string | null;
  onSelect?: (craneId: string | null) => void;
  className?: string;
}

export function CraneMap({
  cranes,
  vendorPoints,
  site,
  selectedCraneId = null,
  onSelect,
  className,
}: CraneMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const heatRef = useRef<L.ImageOverlay | null>(null);
  const markersRef = useRef(new Map<string, L.Marker>());
  const fittedRef = useRef(false);

  // The map's click handler is installed once, so it reads the latest callback
  // and selection through refs rather than capturing the first render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selectedCraneId);
  selectedRef.current = selectedCraneId;

  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(INDIA_ZOOM);
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
    () => (site ? ([site.latitude, site.longitude] as L.LatLngTuple) : null),
    [site],
  );

  // "8 states live" on the map chip is the spread of the cranes actually on
  // screen, not of the fleet: it has to move when a filter does.
  const statesLive = useMemo(
    () => new Set(points.map((point) => point.crane.stateName).filter(Boolean)).size,
    [points],
  );

  // Create the map once. StrictMode mounts effects twice in development, so the
  // instance lives in a ref and the cleanup removes it before a second mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: INDIA_CENTER,
      zoom: INDIA_ZOOM,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    });

    L.tileLayer(TILES_URL, {
      attribution: TILES_ATTRIBUTION,
      maxZoom: TILES_MAX_ZOOM,
    }).addTo(map);

    if (TILE_PANE_CLASS) container.classList.add(TILE_PANE_CLASS);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.on("zoomend", () => setZoom(map.getZoom()));
    map.on("click", () => onSelectRef.current?.(null));

    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);
    setReady(true);

    return () => {
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      heatRef.current = null;
      markersRef.current = new Map();
      fittedRef.current = false;
    };
  }, []);

  // A new result set is a new frame of reference, so the next marker pass may
  // fit the bounds again. Without this, "Fit all" would only ever run once and a
  // search that returns cranes elsewhere would leave the map looking at nothing.
  useEffect(() => {
    fittedRef.current = false;
  }, [points]);

  // Markers and the job-site pin. Rebuilt when the result set or the zoom
  // changes — never on selection, which only swaps an icon.
  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!ready || !map || !layer) return;

    layer.clearLayers();
    markersRef.current = new Map();

    if (sitePoint) {
      L.circleMarker(sitePoint, {
        radius: 8,
        color: "#ffffff",
        weight: 2,
        fillColor: "#dc2626",
        fillOpacity: 1,
      })
        .bindTooltip("Job site", { direction: "top" })
        .addTo(layer);
    }

    const clusters = clusterPoints(points, map, map.getZoom());
    for (const cluster of clusters) {
      if (cluster.cranes.length === 1) {
        const crane = cluster.cranes[0]!;
        const selected = crane.craneId === selectedRef.current;
        const marker = L.marker([cluster.lat, cluster.lng], {
          icon: craneIcon(crane.currentStatus, crane.capacityT, selected),
          title: `${crane.serialRegistrationNo} · ${crane.vendorName}`,
          riseOnHover: true,
          zIndexOffset: selected ? 1000 : 0,
          alt: `${crane.serialRegistrationNo}, ${crane.vendorName}`,
        });
        marker.on("click", () => onSelectRef.current?.(crane.craneId));
        marker.addTo(layer);
        markersRef.current.set(crane.craneId, marker);
      } else {
        const marker = L.marker([cluster.lat, cluster.lng], {
          icon: clusterIcon(cluster.cranes.length),
          title: `${cluster.cranes.length} cranes`,
          keyboard: false,
        });
        marker.on("click", () => {
          map.setView(
            [cluster.lat, cluster.lng],
            Math.min(map.getZoom() + 2, TILES_MAX_ZOOM),
            { animate: true },
          );
        });
        marker.addTo(layer);
      }
    }

    // Frame the results once per result set, not on every zoom.
    if (!fittedRef.current && points.length > 0) {
      const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as L.LatLngTuple));
      if (sitePoint) bounds.extend(sitePoint);
      map.fitBounds(bounds, { padding: [56, 56], maxZoom: 12 });
      fittedRef.current = true;
    }
  }, [ready, points, zoom, sitePoint]);

  // Selection: grow the pin, raise it, and bring it into view if the cluster
  // grid has hidden it.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;

    for (const [craneId, marker] of markersRef.current) {
      const crane = cranes.find((candidate) => candidate.craneId === craneId);
      if (!crane) continue;
      const selected = craneId === selectedCraneId;
      marker.setIcon(craneIcon(crane.currentStatus, crane.capacityT, selected));
      marker.setZIndexOffset(selected ? 1000 : 0);
    }

    if (!selectedCraneId) return;
    const selected = points.find((point) => point.crane.craneId === selectedCraneId);
    if (!selected) return;

    const position = L.latLng(selected.lat, selected.lng);
    const marker = markersRef.current.get(selectedCraneId);
    if (marker) {
      if (!map.getBounds().pad(-0.12).contains(position)) map.panTo(position);
      return;
    }

    // Clustered or off-screen: zoom to the crane so it exists as its own pin.
    if (!map.getBounds().pad(-0.12).contains(position) || map.getZoom() < 9) {
      map.setView(position, Math.max(map.getZoom(), 10), { animate: true });
    }
  }, [ready, selectedCraneId, points, cranes]);

  // Heat layer, rebuilt only when its basis or the data changes.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;

    heatRef.current?.remove();
    heatRef.current = null;

    const heat = buildHeatImage(
      heatMode === "vendors"
        ? vendorPoints.map((vendor) => ({ lat: vendor.latitude, lng: vendor.longitude }))
        : points,
    );
    if (!heat) return;
    heatRef.current = L.imageOverlay(heat.url, heat.bounds, {
      opacity: 0.72,
      interactive: false,
      className: "crane-heat",
    });
  }, [ready, points, vendorPoints, heatMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (showHeat && heatRef.current) heatRef.current.addTo(map);
    else heatRef.current?.remove();
  }, [showHeat, heatMode, points, vendorPoints, ready]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as L.LatLngTuple));
    if (sitePoint) bounds.extend(sitePoint);
    map.fitBounds(bounds, { padding: [56, 56], maxZoom: 12 });
  };

  return (
    <div className={cn("relative overflow-hidden bg-ink-950", className)}>
      <div ref={containerRef} className="h-full w-full" />

      {/* Controls float over the map: the map is the page, so the chrome has to
          be small and out of the way. */}
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

      {/* Top-left: where the results are, then what the colours mean. The bottom
          of the map belongs to the crane card. */}
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

const HEAT_SIZE = 512;
const HEAT_RADIUS = 64;

/** Blue → cyan → green → yellow → red, the conventional density ramp. */
const HEAT_RAMP: Array<[at: number, r: number, g: number, b: number]> = [
  [0, 0, 0, 255],
  [0.35, 0, 255, 255],
  [0.55, 0, 255, 0],
  [0.75, 255, 255, 0],
  [1, 255, 0, 0],
];

function heatColour(value: number): [number, number, number] {
  for (let i = 1; i < HEAT_RAMP.length; i += 1) {
    const previous = HEAT_RAMP[i - 1]!;
    const next = HEAT_RAMP[i]!;
    if (value <= next[0]) {
      const span = next[0] - previous[0] || 1;
      const t = (value - previous[0]) / span;
      return [
        Math.round(previous[1] + (next[1] - previous[1]) * t),
        Math.round(previous[2] + (next[2] - previous[2]) * t),
        Math.round(previous[3] + (next[3] - previous[3]) * t),
      ];
    }
  }
  return [255, 0, 0];
}

/**
 * Builds the heat layer as a PNG plus the lat/lng rectangle it covers.
 *
 * Radial blobs are accumulated additively, then each pixel's accumulated alpha
 * is mapped through the ramp. An `imageOverlay` carries the result, so Leaflet
 * handles positioning and scaling as the map moves; there is no per-pan redraw.
 */
function buildHeatImage(
  points: HeatPoint[],
): { url: string; bounds: L.LatLngBoundsExpression } | null {
  const first = points[0];
  if (!first) return null;

  let minLat = first.lat;
  let maxLat = first.lat;
  let minLng = first.lng;
  let maxLng = first.lng;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }

  // A single crane, or a tight cluster, would give a zero-area rectangle. The
  // padding also leaves room for the blob's edge.
  const latPad = Math.max((maxLat - minLat) * 0.25, 0.25);
  const lngPad = Math.max((maxLng - minLng) * 0.25, 0.25);
  const south = minLat - latPad;
  const north = maxLat + latPad;
  const west = minLng - lngPad;
  const east = maxLng + lngPad;
  const latSpan = north - south;
  const lngSpan = east - west;

  const canvas = document.createElement("canvas");
  canvas.width = HEAT_SIZE;
  canvas.height = HEAT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, HEAT_SIZE, HEAT_SIZE);

  // Additive compositing is what turns overlapping cranes into a hotter pixel.
  context.globalCompositeOperation = "lighter";
  for (const point of points) {
    const x = ((point.lng - west) / lngSpan) * HEAT_SIZE;
    const y = ((north - point.lat) / latSpan) * HEAT_SIZE;
    const gradient = context.createRadialGradient(x, y, 0, x, y, HEAT_RADIUS);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.6)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, HEAT_RADIUS, 0, Math.PI * 2);
    context.fill();
  }

  const image = context.getImageData(0, 0, HEAT_SIZE, HEAT_SIZE);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const intensity = data[i + 3]! / 255;
    if (intensity <= 0.02) {
      data[i + 3] = 0;
      continue;
    }
    const [r, g, b] = heatColour(Math.min(1, intensity * 1.25));
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.min(235, Math.round(90 + intensity * 165));
  }
  context.globalCompositeOperation = "source-over";
  context.putImageData(image, 0, 0);

  return {
    url: canvas.toDataURL("image/png"),
    bounds: [
      [south, west],
      [north, east],
    ],
  };
}

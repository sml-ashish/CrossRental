import { useEffect, useMemo, useRef, useState } from "react";
import { MarkerClusterer, type Renderer } from "@googlemaps/markerclusterer";
import type { DiscoveryCrane } from "@/lib/discovery";
import { Panel } from "@/components/ui/page-header";

/**
 * Discovery map (P4, BPD 6.8) on the Google Maps JavaScript API.
 *
 * The map has two layers over the same data: a marker per crane with stored
 * coordinates, and a heat layer that shows where cranes are concentrated. A red
 * marker is the job site the distances were measured from.
 *
 * The heat layer is rendered here rather than with `visualization.HeatmapLayer`:
 * Google removed that library from the Maps JavaScript API in v3.65. Instead a
 * georeferenced `GroundOverlay` is built from a canvas — radial intensity per
 * crane, colourised through a blue-to-red ramp — and Google positions it on the
 * map, so it pans and zooms with the base map like any other overlay.
 *
 * The browser key is optional. Without it — or if Google fails to load — the
 * component renders the tile-less plot it replaced, so the screen still works
 * and says why. The key is a build-time `VITE_*` value and must be restricted
 * by HTTP referrer; the server geocoding/routing key never reaches the bundle.
 */

type GoogleMapsApi = typeof google.maps;

const browserKey = (import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "").trim();

let loaderPromise: Promise<GoogleMapsApi> | null = null;

function loadedMaps(): GoogleMapsApi | undefined {
  return (window as Window & { google?: { maps?: GoogleMapsApi } }).google?.maps;
}

function loadGoogleMaps(): Promise<GoogleMapsApi> {
  const already = loadedMaps();
  if (already?.Map) return Promise.resolve(already);
  if (loaderPromise) return loaderPromise;
  if (!browserKey) return Promise.reject(new Error("missing-browser-key"));

  loaderPromise = new Promise<GoogleMapsApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(browserKey)}` +
      "&v=weekly&region=IN";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const maps = loadedMaps();
      if (maps?.Map) resolve(maps);
      else reject(new Error("maps-unavailable"));
    };
    script.onerror = () => reject(new Error("maps-script-failed"));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    // Let a later mount retry rather than caching the failure forever.
    loaderPromise = null;
    throw err;
  });

  return loaderPromise;
}

interface MapPoint {
  crane: DiscoveryCrane;
  lat: number;
  lng: number;
}

/**
 * A cluster's badge. Cranes at the same yard sit on top of each other at
 * national zoom, so a count is more informative than the marker underneath —
 * and it keeps the map readable when the whole demo fleet is shown.
 */
const clusterRenderer: Renderer = {
  render({ count, position }) {
    const size = count >= 10 ? 52 : count >= 4 ? 44 : 36;
    return new google.maps.Marker({
      position,
      title: `${count} cranes`,
      label: {
        text: String(count),
        color: "#ffffff",
        fontSize: count >= 10 ? "15px" : "13px",
        fontWeight: "600",
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: size / 2,
        fillColor: "#0f766e",
        fillOpacity: 0.92,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      },
      zIndex: 1000 + count,
    });
  },
};

export interface CraneMapProps {
  cranes: DiscoveryCrane[];
  site: { latitude: number; longitude: number } | null;
}

export function CraneMap({ cranes, site }: CraneMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapsRef = useRef<GoogleMapsApi | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const heatRef = useRef<google.maps.GroundOverlay | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    browserKey ? "loading" : "unavailable",
  );
  const [showHeat, setShowHeat] = useState(true);

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

  // Create the map once. StrictMode runs this effect twice in development, so
  // the instance is kept in a ref and reused rather than created twice on the
  // same DOM node.
  useEffect(() => {
    if (!browserKey) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;

    if (mapRef.current) {
      setStatus("ready");
      return;
    }

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        mapsRef.current = maps;
        mapRef.current = new maps.Map(containerRef.current, {
          center: { lat: 22.5, lng: 79 },
          zoom: 4,
          mapTypeControl: false,
          streetViewControl: false,
          clickableIcons: false,
        });
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Markers, job-site pin and heat layer, rebuilt whenever the result set moves.
  useEffect(() => {
    if (status !== "ready") return;
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!maps || !map) return;

    for (const marker of markersRef.current) marker.setMap(null);
    markersRef.current = [];
    clustererRef.current?.clearMarkers();
    clustererRef.current = null;
    heatRef.current?.setMap(null);
    heatRef.current = null;

    const info = infoRef.current ?? new maps.InfoWindow();
    infoRef.current = info;
    const bounds = new maps.LatLngBounds();
    const craneMarkers: google.maps.Marker[] = [];

    if (sitePoint) {
      const siteMarker = new maps.Marker({
        map,
        position: sitePoint,
        title: "Job site",
        zIndex: 10,
        icon: {
          path: maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: "#dc2626",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      siteMarker.addListener("click", () => {
        info.setContent(
          popup(
            "Job site",
            `${site?.latitude.toFixed(4)}, ${site?.longitude.toFixed(4)}`,
          ),
        );
        info.open({ map, anchor: siteMarker });
      });
      markersRef.current.push(siteMarker);
      bounds.extend(sitePoint);
    }

    for (const point of points) {
      // No `map` here: the clusterer owns placement, so a crane joins whichever
      // cluster (or stands alone) at the current zoom.
      const marker = new maps.Marker({
        position: { lat: point.lat, lng: point.lng },
        title: `${point.crane.serialRegistrationNo} · ${point.crane.vendorName}`,
      });
      const { crane } = point;
      marker.addListener("click", () => {
        info.setContent(
          popup(
            `${crane.serialRegistrationNo} · ${crane.capacityT} t`,
            [
              crane.vendorName,
              `${crane.typeOfCraneName} · ${crane.make} ${crane.model} (${crane.yom})`,
              `${crane.currentLocation}, ${crane.stateName}`,
            ].join("\n"),
          ),
        );
        info.open({ map, anchor: marker });
      });
      craneMarkers.push(marker);
      markersRef.current.push(marker);
      bounds.extend(marker.getPosition() as google.maps.LatLng);
    }

    clustererRef.current = new MarkerClusterer({
      map,
      markers: craneMarkers,
      renderer: clusterRenderer,
    });

    const heat = buildHeatImage(points);
    if (heat) {
      heatRef.current = new maps.GroundOverlay(heat.url, heat.bounds, {
        map: showHeat ? map : null,
        opacity: 0.75,
        clickable: false,
      });
    }

    if (!bounds.isEmpty()) map.fitBounds(bounds, 64);
    // `showHeat` is intentionally not a dependency: toggling it only changes
    // layer visibility, handled below, and must not rebuild the markers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, points, sitePoint, site]);

  // Toggle the heat layer without rebuilding the map.
  useEffect(() => {
    heatRef.current?.setMap(showHeat && status === "ready" ? mapRef.current : null);
  }, [showHeat, status, points]);

  useEffect(
    () => () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
      for (const marker of markersRef.current) marker.setMap(null);
      markersRef.current = [];
      heatRef.current?.setMap(null);
      heatRef.current = null;
    },
    [],
  );

  if (status === "unavailable") {
    return (
      <FallbackMap
        cranes={cranes}
        site={site}
        reason={
          browserKey
            ? "Google Maps could not load. Showing the stored coordinates instead."
            : "Google Maps is not configured (VITE_GOOGLE_MAPS_BROWSER_KEY is empty). Showing the stored coordinates instead."
        }
      />
    );
  }

  return (
    <Panel
      title="Map and crane density"
      description={`${points.length} of ${cranes.length} cranes have coordinates. The heat layer shows where cranes are concentrated; the red pin is the job site.`}
      actions={
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showHeat}
            onChange={(event) => setShowHeat(event.target.checked)}
          />
          Heat map
        </label>
      }
    >
      <div className="relative">
        <div
          ref={containerRef}
          className="h-96 w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100"
        />
        {status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70 text-sm text-slate-500">
            Loading map…
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** A DOM node rather than an HTML string: vendor text is never parsed as markup. */
function popup(title: string, detail: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.maxWidth = "260px";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const body = document.createElement("div");
  body.style.marginTop = "4px";
  body.style.whiteSpace = "pre-line";
  body.textContent = detail;

  wrapper.append(heading, body);
  return wrapper;
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
 * is mapped through the ramp. A `GroundOverlay` carries the result, so Google
 * handles positioning and scaling as the map moves; there is no per-pan redraw.
 */
function buildHeatImage(
  points: MapPoint[],
): { url: string; bounds: google.maps.LatLngBoundsLiteral } | null {
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
    bounds: { north, south, east, west },
  };
}

/**
 * The tile-less plot shown when Google Maps is not configured or cannot load.
 * It draws the India bounding box the database already enforces, so it never
 * pretends to know more than the stored coordinates.
 */
function FallbackMap({
  cranes,
  site,
  reason,
}: {
  cranes: DiscoveryCrane[];
  site: { latitude: number; longitude: number } | null;
  reason: string;
}) {
  const LAT_MIN = 6;
  const LAT_MAX = 38;
  const LNG_MIN = 68;
  const LNG_MAX = 98;

  const points = cranes.filter(
    (crane): crane is DiscoveryCrane & { latitude: number; longitude: number } =>
      crane.latitude !== null && crane.longitude !== null,
  );

  const x = (lng: number) => ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * 100;
  const y = (lat: number) => ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * 100;

  return (
    <Panel title="Map" description={`${reason} ${points.length} of ${cranes.length} cranes have coordinates.`}>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        <svg viewBox="0 0 100 100" className="h-96 w-full" role="img" aria-label="Crane locations">
          <rect x="0" y="0" width="100" height="100" fill="#f8fafc" />
          {[0, 25, 50, 75, 100].map((line) => (
            <g key={line}>
              <line x1={line} y1="0" x2={line} y2="100" stroke="#e2e8f0" strokeWidth="0.2" />
              <line x1="0" y1={line} x2="100" y2={line} stroke="#e2e8f0" strokeWidth="0.2" />
            </g>
          ))}
          {site ? (
            <circle cx={x(site.longitude)} cy={y(site.latitude)} r="1.6" fill="#dc2626">
              <title>Job site</title>
            </circle>
          ) : null}
          {points.map((crane) => (
            <circle
              key={crane.craneId}
              cx={x(crane.longitude)}
              cy={y(crane.latitude)}
              r="1.1"
              fill="#2563eb"
            >
              <title>
                {crane.vendorName} · {crane.serialRegistrationNo} · {crane.currentLocation}
              </title>
            </circle>
          ))}
        </svg>
      </div>
    </Panel>
  );
}

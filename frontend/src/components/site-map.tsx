import { useEffect, useRef } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { TILE_PANE_CLASS, TILES_ATTRIBUTION, TILES_MAX_ZOOM, TILES_URL } from "@/lib/map-tiles";
import { cn } from "@/lib/cn";

/**
 * A small, quiet map of one job site.
 *
 * The enquiry screen needs to say *where* the lift is without turning into a
 * second discovery workspace: one pin, no zoom buttons, no clustering, no
 * scroll hijacking. Panning is left on because dragging a map is how people
 * confirm a location; zooming is wheel-off and button-less so a page scroll
 * never gets trapped.
 *
 * Tiles and the dark treatment come from `lib/map-tiles.ts`, the same
 * configuration the discovery map uses.
 */
export function SiteMap({
  latitude,
  longitude,
  label,
  className,
  onOpen,
}: {
  latitude: number;
  longitude: number;
  /** Read out to screen readers; the visible chip carries the city name. */
  label: string;
  className?: string;
  onOpen?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: [latitude, longitude],
      zoom: 11,
      zoomControl: false,
      attributionControl: true,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });

    L.tileLayer(TILES_URL, {
      attribution: TILES_ATTRIBUTION,
      maxZoom: TILES_MAX_ZOOM,
    }).addTo(map);

    if (TILE_PANE_CLASS) container.classList.add(TILE_PANE_CLASS);

    // The halo is what makes a single pin readable on a dark basemap at 140px
    // tall; a bare dot disappears into the street grid.
    const icon = L.divIcon({
      className: "site-pin-wrap",
      html: '<span class="site-pin"><span class="site-pin-halo"></span><span class="site-pin-dot"></span></span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    const marker = L.marker([latitude, longitude], {
      icon,
      keyboard: false,
      interactive: true,
    }).addTo(map);
    marker.on("click", () => onOpenRef.current?.());

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // The map is created once; coordinate changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    marker.setLatLng([latitude, longitude]);
    map.setView([latitude, longitude], map.getZoom(), { animate: false });
  }, [latitude, longitude]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      className={cn("site-map h-[140px] w-full", className)}
    />
  );
}

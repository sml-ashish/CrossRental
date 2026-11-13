/**
 * Basemap configuration, shared by every map in the portal.
 *
 * The browser map is keyless by default: OpenStreetMap raster tiles, darkened
 * with a CSS filter on the tile pane only (see `styles/index.css`). That keeps
 * the marker colours true and costs nothing to run.
 *
 * A paid provider is configuration, not code — point `VITE_MAP_TILES_URL` at
 * MapTiler, Stadia or CARTO and set `VITE_MAP_TILES_INVERTED=false` to get a
 * native dark basemap without touching a component. Attribution is required by
 * the OSM tile policy and is rendered by Leaflet.
 *
 * Geocoding is a separate, server-side seam (`GEO_PROVIDER`); these components
 * never geocode, they only plot coordinates the API already resolved.
 */

export const TILES_URL =
  (import.meta.env.VITE_MAP_TILES_URL ?? "").trim() ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const TILES_ATTRIBUTION =
  (import.meta.env.VITE_MAP_TILES_ATTRIBUTION ?? "").trim() ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const TILES_MAX_ZOOM = Number(import.meta.env.VITE_MAP_TILES_MAX_ZOOM ?? 19) || 19;

/**
 * The OSM raster tiles are drawn for a light page, so the dark workspace
 * inverts them. A provider that serves dark tiles already should set
 * `VITE_MAP_TILES_INVERTED=false`.
 */
export const TILES_INVERTED = (import.meta.env.VITE_MAP_TILES_INVERTED ?? "true") !== "false";

/** The class that turns the tile pane dark; empty when tiles are already dark. */
export const TILE_PANE_CLASS = TILES_INVERTED ? "map-tiles-inverted" : "";

/**
 * Basemap configuration, shared by every map in the portal.
 *
 * The browser map is keyless and English-labelled by default: Esri's World
 * Street Map raster tiles, darkened with a CSS filter on the tile pane only
 * (see `styles/index.css`). The keyless OSM tile policy is not the only reason
 * for the switch — OSM renders each place in its local script and language,
 * which turns a cross-border sourcing map into a guessing game. Esri's global
 * basemap transliterates place names to Latin script, so "Ahmedabad", "Osaka"
 * and "Cairo" are readable without knowing the local alphabet.
 *
 * A paid provider is configuration, not code — point `VITE_MAP_TILES_URL` at
 * MapTiler, Stadia or CARTO and set `VITE_MAP_TILES_INVERTED=false` to get a
 * native dark basemap without touching a component. Attribution is supplied by
 * the provider and is required; Leaflet renders it over the map.
 *
 * Geocoding is a separate, server-side seam (`GEO_PROVIDER`); these components
 * never geocode, they only plot coordinates the API already resolved.
 */

export const TILES_URL =
  (import.meta.env.VITE_MAP_TILES_URL ?? "").trim() ||
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";

export const TILES_ATTRIBUTION =
  (import.meta.env.VITE_MAP_TILES_ATTRIBUTION ?? "").trim() ||
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS User Community';

export const TILES_MAX_ZOOM = Number(import.meta.env.VITE_MAP_TILES_MAX_ZOOM ?? 19) || 19;

/**
 * The default raster tiles are drawn for a light page, so the dark workspace
 * inverts them. A provider that serves dark tiles already should set
 * `VITE_MAP_TILES_INVERTED=false`.
 */
export const TILES_INVERTED = (import.meta.env.VITE_MAP_TILES_INVERTED ?? "true") !== "false";

/** The class that turns the tile pane dark; empty when tiles are already dark. */
export const TILE_PANE_CLASS = TILES_INVERTED ? "map-tiles-inverted" : "";

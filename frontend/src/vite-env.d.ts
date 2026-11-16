/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base path for API calls. Defaults to the dev proxy's /api. */
  readonly VITE_API_BASE_URL?: string;
  /** Backend origin the dev proxy forwards /api to (read by vite.config.ts). */
  readonly VITE_API_PROXY?: string;
  /**
   * Google Maps JavaScript API browser key. Empty means the discovery map
   * falls back to the Leaflet map, with a notice and no routes.
   */
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
  /**
   * A Maps JavaScript API map ID, needed for the dark colour scheme and for
   * cloud-styled maps. Defaults to `DEMO_MAP_ID`, which is fine for
   * development; production should set a real ID.
   */
  readonly VITE_GOOGLE_MAP_ID?: string;
  /** Leaflet tile URL template. Defaults to Esri World Street Map. */
  readonly VITE_MAP_TILES_URL?: string;
  /** Attribution HTML shown over every map. */
  readonly VITE_MAP_TILES_ATTRIBUTION?: string;
  /** "false" when the provider already serves a dark basemap. */
  readonly VITE_MAP_TILES_INVERTED?: string;
  /** Highest tile zoom the provider serves. */
  readonly VITE_MAP_TILES_MAX_ZOOM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base path for API calls. Defaults to the dev proxy's /api. */
  readonly VITE_API_BASE_URL?: string;
  /** Backend origin the dev proxy forwards /api to (read by vite.config.ts). */
  readonly VITE_API_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
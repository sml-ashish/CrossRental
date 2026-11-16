/**
 * The Maps JavaScript API bootstrap, once.
 *
 * The official loader snippet is small enough that a dependency (`@googlemaps/
 * js-api-loader`) would be a package to audit for what is one script element.
 *
 * **The subtle part** is *when* the API is ready. `maps/api/js` answers with a
 * small bootstrap that defines `google.maps.Load` and then loads the core
 * modules in a second request; `importLibrary` only exists once that second
 * request finishes. Waiting for the `<script>` tag's `load` event is therefore
 * too early — `google.maps.importLibrary` is still undefined there, which
 * looks exactly like a missing key. The documented bootstrap solves it with
 * `callback=google.maps.__ib__`: Google calls that function after the core is
 * ready, and `importLibrary` is guaranteed to exist from then on. This module
 * ports that snippet rather than improvising one.
 *
 * The libraries the screen actually uses are imported explicitly:
 *
 * - `maps` for `Map`, `Polyline`, `Circle` and `event`.
 * - `marker` for `AdvancedMarkerElement` and `PinElement`.
 * - `geometry` for `encoding.decodePath`, which turns the server's encoded
 *   polyline into coordinates. Decoding stays on the client, so the server
 *   never ships an inflated vertex array.
 *
 * The promise is cached: a second map on the page (none today, but the enquiry
 * screen may gain one) reuses the same script and the same libraries. A failed
 * load clears the cache so a retry after a network blip is possible rather than
 * permanently remembering the failure.
 */

export interface GoogleMapsApi {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
  geometry: google.maps.GeometryLibrary;
}

/** The libraries this screen needs, requested in the first script URL. */
const LIBRARIES = ["maps", "marker", "geometry"] as const;

/**
 * How long the core modules get before the screen gives up and shows the
 * fallback map. Long enough for a slow 3G round trip, short enough that a
 * blocked or misconfigured key does not leave "Loading the map…" forever.
 */
const LOAD_TIMEOUT_MS = 20_000;

type ImportLibrary = (library: string) => Promise<unknown>;

interface BootstrapNamespace {
  maps?: {
    importLibrary?: ImportLibrary;
    __ib__?: () => void;
  };
}

function googleNamespace(): typeof google | undefined {
  return (window as unknown as { google?: typeof google }).google;
}

export function googleMapsBrowserKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "").trim();
}

export function isGoogleMapsConfigured(): boolean {
  return googleMapsBrowserKey() !== "";
}

/**
 * Installs the official bootstrap: a stub `importLibrary` that collects the
 * libraries asked for, injects the API script once, and only resolves a
 * library request after the core (and the real `importLibrary`) is in place.
 *
 * Safe to call when the API is already present — it does nothing then.
 */
function installBootstrap(key: string): void {
  const win = window as unknown as { google?: BootstrapNamespace };
  const google = (win.google ??= {});
  const maps = (google.maps ??= {});

  // A previous mount, an HMR reload, or another screen already bootstrapped it.
  if (maps.importLibrary) return;

  const requested = new Set<string>(LIBRARIES);
  let started: Promise<void> | null = null;

  const start = (): Promise<void> => {
    if (started) return started;
    started = new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({
        key,
        v: "weekly",
        region: "IN",
        libraries: [...requested].join(","),
        callback: "google.maps.__ib__",
      });

      const timer = window.setTimeout(() => {
        reject(
          new Error(
            "Google Maps did not finish loading. Check that the Maps JavaScript API is enabled for this key.",
          ),
        );
      }, LOAD_TIMEOUT_MS);

      // Google calls this once the core modules are ready, which is the first
      // moment `importLibrary` actually exists.
      maps.__ib__ = () => {
        window.clearTimeout(timer);
        resolve();
      };

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.async = true;
      script.dataset.googleMapsLoader = "true";
      script.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          reject(
            new Error(
              "Google Maps could not be loaded. Check the browser key and its HTTP referrer restrictions.",
            ),
          );
        },
        { once: true },
      );
      document.head.appendChild(script);
    });
    return started;
  };

  function stub(library: string): Promise<unknown> {
    requested.add(library);
    return start().then(() => {
      const real = maps.importLibrary;
      if (!real || real === stub) {
        throw new Error("The Maps JavaScript API loaded without a library loader.");
      }
      return real(library);
    });
  }

  maps.importLibrary = stub;
}

let pending: Promise<GoogleMapsApi> | null = null;

export function loadGoogleMaps(): Promise<GoogleMapsApi> {
  if (pending) return pending;

  const key = googleMapsBrowserKey();
  if (!key) {
    return Promise.reject(
      new Error("Google Maps is not configured: VITE_GOOGLE_MAPS_BROWSER_KEY is empty."),
    );
  }

  installBootstrap(key);

  const maps = googleNamespace()?.maps;
  if (!maps?.importLibrary) {
    return Promise.reject(
      new Error("The Maps JavaScript API bootstrap could not be installed."),
    );
  }

  pending = Promise.all([
    maps.importLibrary("maps"),
    maps.importLibrary("marker"),
    maps.importLibrary("geometry"),
  ])
    .then(([mapsLibrary, markerLibrary, geometryLibrary]) => ({
      maps: mapsLibrary,
      marker: markerLibrary,
      geometry: geometryLibrary,
    }))
    // Never remember a failure: the screen shows its Leaflet fallback now, and a
    // later mount should get a fresh attempt rather than the same rejection.
    .catch((error: unknown) => {
      pending = null;
      throw error instanceof Error
        ? error
        : new Error("Google Maps libraries could not be loaded.");
    });

  return pending;
}

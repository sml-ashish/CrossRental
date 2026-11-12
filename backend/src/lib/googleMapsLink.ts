import { isInsideIndia, type GeoPoint } from "./geo";

/**
 * Reading a "Google Maps location" cell from a crane upload sheet.
 *
 * The cell is whatever someone pasted out of Google Maps, and there are three
 * shapes worth handling:
 *
 * - a **link that already carries coordinates** (`…/@23.0225,72.5714,17z`,
 *   `?q=23.02,72.57`, `!3d…!4d…`). These are parsed offline and cost nothing;
 * - a **short link** (`maps.app.goo.gl/…`), which has to be followed once to see
 *   where it points;
 * - a **place name or address**, which is handed back as `query` for the
 *   geocoder — the same provider seam (`GeoProvider`) the rest of the portal
 *   uses.
 *
 * Coordinates outside India are rejected here rather than stored and caught by
 * the database CHECK later: a link pasted from the wrong project should read as
 * "no usable location", not as a failed import.
 *
 * Nothing here throws. A broken link is a row-level note, not a reason to lose
 * the rest of the sheet.
 */

export interface MapsCellResult {
  /** A usable point, already inside India, or null. */
  point: GeoPoint | null;
  /** Text to geocode when the cell carried no coordinates. */
  query: string | null;
  /**
   * The human-readable place the link names, when it names one — even if it also
   * carries coordinates. The import only needs `query`; the crane form's
   * "fill from link" reads this to suggest a location, state and pincode.
   */
  placeText: string | null;
  /** Why no point was produced, for the import report. */
  note: string | null;
}

const SHORT_LINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);

/** The query parameters Google uses to carry a place or a point. */
const POINT_PARAMS = ["q", "query", "ll", "center", "destination", "daddr", "address"];

function pointOf(latText: string, lngText: string): GeoPoint | null {
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const point = { lat, lng };
  return isInsideIndia(point) ? point : null;
}

/** `"22.3072,73.1812"` — the bare pair Google puts in `?q=` and in the path. */
function parsePointParam(value: string): GeoPoint | null {
  const match = value.match(/^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  return match?.[1] && match[2] ? pointOf(match[1], match[2]) : null;
}

/** Coordinates embedded anywhere in a full Maps URL. */
function pointFromUrlText(text: string): GeoPoint | null {
  const patterns = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match[2]) {
      const point = pointOf(match[1], match[2]);
      if (point) return point;
    }
  }
  return null;
}

function decodeText(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // A malformed escape is kept as typed rather than thrown away.
  }
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * Follows a share link once. Google answers with a redirect to the full URL, so
 * this is a single request; the body is discarded as soon as the final URL is
 * known.
 */
async function followShortLink(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "crossrentel-bulk-import/1.0" },
    });
    const finalUrl = response.url || "";
    await response.body?.cancel().catch(() => undefined);
    return finalUrl && finalUrl !== url ? finalUrl : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeMapsUrl(text: string): boolean {
  return /^(https?:\/\/)?([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl)\//i.test(text)
    || /maps\.app\.goo\.gl/i.test(text);
}

/** A point carried in a query parameter (`?q=23.02,72.57`). */
function pointFromParams(url: URL): GeoPoint | null {
  for (const key of POINT_PARAMS) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const point = parsePointParam(value);
    if (point) return point;
  }
  return null;
}

/**
 * The place the URL names: `/place/<text>`, or a query parameter that is text
 * rather than a coordinate. A coordinate-looking segment is skipped so a link
 * that only carries a pin does not suggest "23.0225,72.5714" as a location.
 */
function placeTextFromUrl(url: URL): string | null {
  const place = url.pathname.match(/\/place\/([^/]+)/);
  if (place?.[1]) {
    const text = decodeText(place[1]);
    if (text && !parsePointParam(text)) return text;
  }
  for (const key of POINT_PARAMS) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const text = decodeText(value);
    if (text && !parsePointParam(text)) return text;
  }
  return null;
}

export async function readMapsCell(
  raw: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MapsCellResult> {
  const text = (raw ?? "").trim();
  if (!text) return { point: null, query: null, placeText: null, note: null };

  // A bare "lat,lng" typed straight into the cell.
  const bare = parsePointParam(text);
  if (bare) return { point: bare, query: null, placeText: null, note: null };

  if (!looksLikeMapsUrl(text)) {
    if (/^https?:\/\//i.test(text)) {
      return {
        point: null,
        query: null,
        placeText: null,
        note: "That link is not a Google Maps link",
      };
    }
    // A place name or address: hand it to the geocoder.
    const place = text.replace(/\s+/g, " ").trim();
    return { point: null, query: place, placeText: place, note: null };
  }

  let candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const note: string | null = null;

  let url: URL | null = null;
  try {
    url = new URL(candidate);
  } catch {
    return {
      point: null,
      query: null,
      placeText: null,
      note: "That Google Maps link could not be read",
    };
  }

  if (SHORT_LINK_HOSTS.has(url.hostname)) {
    const resolved = await followShortLink(candidate, options);
    if (!resolved) {
      return {
        point: null,
        query: null,
        placeText: null,
        note: "The short Google Maps link could not be opened — paste the full link or the place name",
      };
    }
    candidate = resolved;
    try {
      url = new URL(candidate);
    } catch {
      return {
        point: null,
        query: null,
        placeText: null,
        note: "That Google Maps link could not be read",
      };
    }
  }

  const point = pointFromUrlText(candidate) ?? pointFromParams(url);
  const placeText = placeTextFromUrl(url);

  if (point) return { point, query: null, placeText, note };
  if (placeText) return { point: null, query: placeText, placeText, note };

  return {
    point: null,
    query: null,
    placeText: null,
    note: "That Google Maps link has no coordinates or place name in it",
  };
}

import { prisma } from "../lib/database";
import { readMapsCell } from "../lib/googleMapsLink";
import { tryGeocode, tryReverseGeocode, type GeoPoint } from "../lib/geo";

/**
 * Turning a pasted Google Maps link into crane form fields (brief 6.3).
 *
 * The vendor pastes the link Google's "Share" button gave them and the form
 * fills in what the link actually knows: the pin, the place, the state and the
 * pincode. Nothing here writes to the database — it is a preview the vendor
 * reviews and can override before saving.
 *
 * The work is split the same way the import is:
 *
 * 1. parse the link offline (coordinates and the place text) — free;
 * 2. read the state and pincode straight out of the place text;
 * 3. only when a piece is still missing, ask the map provider — geocode the
 *    place text when the link had no pin, and reverse geocode the pin when the
 *    text did not name the state or pincode.
 *
 * A provider that cannot reverse geocode (the stub, or the production default
 * before a key is configured) simply leaves those fields empty. It never
 * invents an address for a real pin.
 */

export interface LocationSuggestion {
  latitude: number | null;
  longitude: number | null;
  currentLocation: string | null;
  stateCode: string | null;
  stateName: string | null;
  pincode: string | null;
  /** How the pin was found, for the note and for tests. */
  source: "maps_link" | "place_text" | "none";
  /** A vendor-facing sentence about what was and was not filled. */
  note: string | null;
}

interface StateRef {
  code: string;
  name: string;
}

/** Indian pincodes are six digits and never start with zero. */
const PINCODE = /\b([1-9]\d{5})\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A state code is only trusted as a standalone token, not inside a word. */
function matchState(text: string, states: StateRef[]): StateRef | null {
  if (!text) return null;

  for (const state of states) {
    const pattern = new RegExp(
      `(^|[^A-Za-z])${escapeRegExp(state.code)}([^A-Za-z]|$)`,
      "i",
    );
    if (pattern.test(text)) return state;
  }

  const lower = text.toLowerCase();
  // Longest name first so a name cannot shadow a longer one that contains it.
  return (
    [...states]
      .sort((a, b) => b.name.length - a.name.length)
      .find((state) => state.name && lower.includes(state.name.toLowerCase())) ?? null
  );
}

function pincodeFromText(text: string): string | null {
  return text.match(PINCODE)?.[1] ?? null;
}

/** The first comma-separated part of a place string — usually the yard or area. */
function leadSegment(text: string): string | null {
  const first = text.split(",")[0]?.trim();
  return first ? first : null;
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(7));
}

function buildNote(input: {
  currentLocation: string | null;
  stateCode: string | null;
  pincode: string | null;
}): string {
  const filled: string[] = [];
  if (input.currentLocation) filled.push("location");
  if (input.stateCode) filled.push("state");
  if (input.pincode) filled.push("pincode");
  filled.push("map pin");

  const missing: string[] = [];
  if (!input.currentLocation) missing.push("location");
  if (!input.stateCode) missing.push("state");
  if (!input.pincode) missing.push("pincode");

  if (missing.length === 0) {
    return `Filled ${filled.join(", ")} from the link. Check the pin before saving.`;
  }
  return `Filled ${filled.join(", ")}. Could not tell the ${missing.join(
    " or ",
  )} from the link — add it by hand.`;
}

export async function previewCraneLocation(raw: string): Promise<LocationSuggestion> {
  const maps = await readMapsCell(raw);
  const placeText = maps.placeText ?? maps.query ?? "";

  const empty: LocationSuggestion = {
    latitude: null,
    longitude: null,
    currentLocation: null,
    stateCode: null,
    stateName: null,
    pincode: null,
    source: "none",
    note: null,
  };

  if (!maps.point && !placeText) {
    return {
      ...empty,
      note: maps.note ?? "Paste a Google Maps link or a place name.",
    };
  }

  const states = await prisma.state.findMany({ select: { code: true, name: true } });
  const fromText = matchState(placeText, states);

  let point: GeoPoint | null = maps.point;
  let source: LocationSuggestion["source"] = point ? "maps_link" : "none";

  // A place name with no pin is geocoded once. The state read from the text, if
  // any, anchors the lookup so "Pune" does not land outside India.
  if (!point && placeText) {
    const lookup = await tryGeocode({
      location: placeText,
      state: fromText?.code ?? "",
      pincode: pincodeFromText(placeText),
    });
    if (lookup.ok) {
      point = lookup.point;
      source = "place_text";
    }
  }

  let currentLocation = leadSegment(placeText) ?? null;
  let stateCode = fromText?.code ?? null;
  let stateName = fromText?.name ?? null;
  let pincode = pincodeFromText(placeText);

  // Fill only what the link itself did not name.
  if (point && (!currentLocation || !stateCode || !pincode)) {
    const reverse = await tryReverseGeocode(point);
    if (reverse.ok) {
      currentLocation = currentLocation ?? reverse.address.currentLocation;
      if (!stateCode) {
        // Only accept a state the portal actually knows, so the dropdown and the
        // save-time validation cannot disagree.
        const resolved = matchState(
          [reverse.address.stateName, reverse.address.stateCode].filter(Boolean).join(" "),
          states,
        );
        stateCode = resolved?.code ?? null;
        stateName = resolved?.name ?? null;
      }
      pincode = pincode ?? reverse.address.pincode;
    }
  }

  if (!point) {
    return {
      ...empty,
      currentLocation,
      stateCode,
      stateName,
      pincode,
      note:
        maps.note ??
        "No pin was found. Paste a full Google Maps link or enter the coordinates by hand.",
    };
  }

  return {
    latitude: roundCoordinate(point.lat),
    longitude: roundCoordinate(point.lng),
    currentLocation,
    stateCode,
    stateName,
    pincode,
    source,
    note: buildNote({ currentLocation, stateCode, pincode }),
  };
}

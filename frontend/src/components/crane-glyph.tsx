/**
 * The crane silhouette and the map's marker artwork.
 *
 * The silhouette is one hand-drawn path, reused as the hero illustration on the
 * discovery card. The map itself does not use it: at map scale a crane shape is
 * unreadable, so a pin is a capacity pill — a status dot and the tonnage — which
 * is the thing being searched for. A cluster is a count in an accent ring.
 *
 * Everything is inline SVG rather than a PNG: the pin carries the crane's status
 * colour, so a raster would need a variant per state plus a 2x copy and would
 * still soften on a 3x screen.
 */

/** Tracks, body, cab, counterweight, lattice boom, hanging hook line. */
export const CRANE_PATH = [
  "M5 34 H31 V38 H5 Z",
  "M8 22 H26 V34 H8 Z",
  "M10 15 H20 V22 H10 Z",
  "M2 24 H8 V32 H2 Z",
  "M20 22 L32 2 L35 4 L23 24 Z",
  "M32.6 4 H33.6 V15 H32.6 Z",
].join(" ");

export const CRANE_VIEWBOX = {
  width: 36,
  height: 40,
  /** Bottom centre of the tracks — where the marker's position lands. */
  anchorX: 18,
  anchorY: 38,
} as const;

/**
 * Status colours, from the approved discovery brief.
 *
 * Deliberately the same three words the list uses, so a crane is never "green on
 * the map, amber in the list". Maintenance is grey rather than red: on a dark
 * map a red pin reads as an error, and the word next to it already says what it
 * is.
 */
const FILLS: Record<string, string> = {
  AVAILABLE: "#3ecf8e",
  ENGAGED: "#f5a623",
  UNDER_MAINTENANCE: "#8a8d94",
};

/** Cranes in a state discovery does not colour (Booked, Hired) get a neutral grey. */
const DEFAULT_FILL = "#8a8d94";

export function craneFill(status: string): string {
  return FILLS[status] ?? DEFAULT_FILL;
}

/** The human word for a status, so colour is never the only signal. */
export function craneStatusLabel(status: string): string {
  switch (status) {
    case "AVAILABLE":
      return "Available";
    case "ENGAGED":
      return "Engaged";
    case "UNDER_MAINTENANCE":
      return "Maintenance";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  }
}

export interface MarkerArtwork {
  html: string;
  width: number;
  height: number;
  /** Distance from the artwork's top edge to the point that sits on the map. */
  anchorY: number;
}

/**
 * A crane pin: `● 220t` in a rounded pill with a short tail.
 *
 * The tail is part of the outline rather than a separate triangle, so the border
 * runs unbroken around the whole shape. A selected pin inverts to white with a
 * cool outline and grows a step — the same treatment the selected list row gets.
 */
export function cranePillSvg(
  status: string,
  capacityT: number,
  selected = false,
): MarkerArtwork {
  const label = `${Math.round(capacityT)}t`;
  const height = selected ? 30 : 26;
  const fontSize = selected ? 12 : 11;
  const dotR = selected ? 4 : 3.5;
  const textWidth = label.length * fontSize * 0.62;
  const width = Math.round(10 + dotR * 2 + 6 + textWidth + 11);

  const r = height / 2;
  const cx = width / 2;
  const tailW = 5;
  const tailH = 5;

  const outline = [
    `M ${r} 0`,
    `H ${width - r}`,
    `A ${r} ${r} 0 0 1 ${width} ${r}`,
    `V ${height - r}`,
    `A ${r} ${r} 0 0 1 ${width - r} ${height}`,
    `H ${cx + tailW}`,
    `L ${cx} ${height + tailH}`,
    `L ${cx - tailW} ${height}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${height - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join(" ");

  const fill = selected ? "#ffffff" : "#202223";
  const border = selected ? "#9db8ff" : "#3a3d42";
  const ink = selected ? "#14151a" : "#f2f3f4";
  const dotX = 10 + dotR;
  const textX = dotX + dotR + 6;

  const html =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + tailH}" ` +
    `viewBox="0 0 ${width} ${height + tailH}" aria-hidden="true">` +
    `<path d="${outline}" fill="${fill}" stroke="${border}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<circle cx="${dotX}" cy="${r}" r="${dotR}" fill="${craneFill(status)}"/>` +
    `<text x="${textX}" y="${r}" dominant-baseline="central" font-family="system-ui, sans-serif" ` +
    `font-size="${fontSize}" font-weight="600" fill="${ink}">${label}</text>` +
    `</svg>`;

  return { html, width, height: height + tailH, anchorY: height + tailH };
}

/**
 * A cluster: how many cranes are stacked here.
 *
 * A count in a ring rather than a stack of tiny cranes — at cluster zoom the
 * question is "how many", not "which one", and the number has to survive being
 * 36px wide.
 */
export function craneClusterSvg(count: number): MarkerArtwork {
  const size = count >= 100 ? 48 : count >= 10 ? 42 : 36;
  const r = size / 2;
  const fontSize = count >= 100 ? 13 : 14;

  const html =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
    `<circle cx="${r}" cy="${r}" r="${r - 2}" fill="#202223" stroke="#c4443f" stroke-width="2"/>` +
    `<text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" ` +
    `fill="#ffffff">${count}</text>` +
    `</svg>`;

  return { html, width: size, height: size, anchorY: size / 2 };
}

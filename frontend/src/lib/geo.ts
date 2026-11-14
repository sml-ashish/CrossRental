/**
 * A deliberately coarse pincode → state check.
 *
 * The site is free text and the state is a dropdown, so the two can disagree —
 * the seed data has "Pune, Gujarat" against 412101, which is a Maharashtra
 * pincode. The screen should say so rather than print a contradiction.
 *
 * This table is not a postal database. It groups the first two digits into the
 * states that actually share them and keeps both when a prefix straddles a
 * border (13 is Haryana/Punjab/Chandigarh, 40 is Maharashtra/Goa). A mismatch is
 * reported only when the state code is outside that set, so an unusual but valid
 * address stays quiet instead of being flagged wrongly.
 */

const STATE_NAMES: Record<string, string> = {
  AN: "Andaman & Nicobar",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CG: "Chhattisgarh",
  CH: "Chandigarh",
  DL: "Delhi",
  GA: "Goa",
  GJ: "Gujarat",
  HP: "Himachal Pradesh",
  HR: "Haryana",
  JH: "Jharkhand",
  JK: "Jammu & Kashmir",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  MH: "Maharashtra",
  ML: "Meghalaya",
  MN: "Manipur",
  MP: "Madhya Pradesh",
  MZ: "Mizoram",
  NL: "Nagaland",
  OD: "Odisha",
  PB: "Punjab",
  PY: "Puducherry",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TR: "Tripura",
  TS: "Telangana",
  UP: "Uttar Pradesh",
  UT: "Uttarakhand",
  WB: "West Bengal",
};

interface PinRange {
  from: number;
  to: number;
  states: string[];
}

const PIN_RANGES: PinRange[] = [
  { from: 11, to: 11, states: ["DL"] },
  { from: 12, to: 13, states: ["HR", "PB", "CH"] },
  { from: 14, to: 16, states: ["PB", "CH"] },
  { from: 17, to: 17, states: ["HP"] },
  { from: 18, to: 19, states: ["JK", "LA"] },
  { from: 20, to: 23, states: ["UP"] },
  { from: 24, to: 26, states: ["UP", "UT"] },
  { from: 27, to: 28, states: ["UP"] },
  { from: 30, to: 34, states: ["RJ"] },
  { from: 36, to: 39, states: ["GJ"] },
  { from: 40, to: 40, states: ["MH", "GA"] },
  { from: 41, to: 44, states: ["MH"] },
  { from: 45, to: 48, states: ["MP"] },
  { from: 49, to: 49, states: ["CG"] },
  { from: 50, to: 50, states: ["TS"] },
  { from: 51, to: 53, states: ["AP"] },
  { from: 56, to: 59, states: ["KA"] },
  { from: 60, to: 66, states: ["TN", "PY"] },
  { from: 67, to: 69, states: ["KL"] },
  { from: 70, to: 73, states: ["WB"] },
  { from: 74, to: 74, states: ["WB", "AN"] },
  { from: 75, to: 77, states: ["OD"] },
  { from: 78, to: 78, states: ["AS"] },
  {
    from: 79,
    to: 79,
    states: ["AR", "MN", "ML", "MZ", "NL", "TR", "SK"],
  },
  { from: 80, to: 85, states: ["BR", "JH"] },
];

/** "MH" → "Maharashtra"; unknown codes read as themselves. */
export function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return STATE_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/**
 * The state the pincode belongs to, when it clearly disagrees with the chosen
 * one. Returns `null` for a missing/invalid pincode, an unknown prefix, or a
 * state that is plausible for that prefix — silence is the safe answer.
 */
export function pincodeStateMismatch(
  pincode: string | null | undefined,
  siteStateCode: string | null | undefined,
): { expected: string } | null {
  if (!pincode || !siteStateCode) return null;
  const text = pincode.trim();
  if (!/^\d{6}$/.test(text)) return null;

  const prefix = Number(text.slice(0, 2));
  if (!Number.isFinite(prefix)) return null;

  const range = PIN_RANGES.find((entry) => prefix >= entry.from && prefix <= entry.to);
  if (!range || range.states.length === 0) return null;

  const code = siteStateCode.toUpperCase();
  if (range.states.includes(code)) return null;

  const expected = range.states.map((state) => STATE_NAMES[state] ?? state).join(" / ");
  return { expected };
}

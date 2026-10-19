import { api, apiUpload, getStoredToken } from "@/lib/api";

/**
 * Client for the M3 fleet endpoints (brief 7.4).
 *
 * The screens never build a URL or decide what a vendor may see — the backend
 * owns both (brief 6.6). In particular there is no `vendorId` in any payload
 * here, because the server derives it from the token and ignores one that is
 * sent anyway.
 */

/** The three a vendor may set. BOOKED and HIRED are moved by SML, not the vendor. */
export const VENDOR_STATUSES = ["AVAILABLE", "ENGAGED", "UNDER_MAINTENANCE"] as const;
export type VendorCraneStatus = (typeof VENDOR_STATUSES)[number];

/** The full enum, including the two system-only statuses, for display purposes. */
export type CraneStatus = VendorCraneStatus | "BOOKED" | "HIRED";

export const CRANE_STATUS_LABELS: Record<CraneStatus, string> = {
  AVAILABLE: "Available",
  ENGAGED: "Engaged",
  UNDER_MAINTENANCE: "Under maintenance",
  BOOKED: "Booked (SML)",
  HIRED: "Hired",
};

export type CraneApprovalStatus = "APPROVED" | "PENDING";

export interface CraneFreshness {
  daysSinceUpdate: number;
  dueForUpdate: boolean;
  stale: boolean;
  staleSince: string | null;
}

export interface LoadChart {
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
}

export interface Crane {
  id: string;
  vendorId: string;
  typeOfCraneCode: string;
  typeOfCrane: { code: string; name: string } | null;
  capacityT: number;
  currentStatus: CraneStatus;
  currentLocation: string;
  stateCode: string;
  state: { code: string; name: string } | null;
  make: string;
  model: string;
  yom: number;
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  serialRegistrationNo: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinateSource: "auto" | "manual" | null;
  geocodedBy: string | null;
  geocodedAt: string | null;
  locationUnverified: boolean;
  freshness: CraneFreshness;
  availableFrom: string | null;
  /** Brief D4: when an under-maintenance crane is expected back. */
  expectedReadyDate: string | null;
  /** Brief D1: last change was made by SML on this vendor's behalf. */
  updatedOnBehalf: boolean;
  loadChart: LoadChart | null;
  ownershipType: string;
  isActive: boolean;
  approvalStatus: CraneApprovalStatus;
  remarks: string | null;
  statusUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  /** Present for internal readers, so a queue can say whose crane it is. */
  vendorName?: string | null;
}

/** A crane locked by an SML contract. The UI explains rather than offering a change. */
export function isSystemLocked(crane: Crane): boolean {
  return crane.currentStatus === "BOOKED" || crane.currentStatus === "HIRED";
}

/** The form as edited. Empty optional lengths are sent as null, not "". */
export interface CraneForm {
  typeOfCraneCode: string;
  capacityT: string;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  make: string;
  model: string;
  yom: string;
  mainBoomM: string;
  fixedJibM: string;
  luffingJibM: string;
  windJibM: string;
  serialRegistrationNo: string;
  pincode: string;
  latitude: string;
  longitude: string;
  remarks: string;
  /** Only meaningful while UNDER_MAINTENANCE (brief D4). */
  expectedReadyDate: string;
}

export const EMPTY_CRANE_FORM: CraneForm = {
  typeOfCraneCode: "",
  capacityT: "",
  currentStatus: "AVAILABLE",
  currentLocation: "",
  stateCode: "",
  make: "",
  model: "",
  yom: "",
  mainBoomM: "",
  fixedJibM: "",
  luffingJibM: "",
  windJibM: "",
  serialRegistrationNo: "",
  pincode: "",
  latitude: "",
  longitude: "",
  remarks: "",
  expectedReadyDate: "",
};

export interface ReferenceOption {
  code: string;
  name: string;
}

export function fetchReferenceData(): Promise<{ states: ReferenceOption[]; craneTypes: ReferenceOption[] }> {
  // Authenticated: unlike the public onboarding list, this is the vendor's own
  // dropdown data and the route is already behind a login.
  return api("/vendors/reference-data");
}

/** Shapes the form for editing, turning null lengths back into empty inputs. */
export function craneToForm(crane: Crane): CraneForm {
  return {
    typeOfCraneCode: crane.typeOfCraneCode,
    capacityT: String(crane.capacityT),
    currentStatus: crane.currentStatus,
    currentLocation: crane.currentLocation,
    stateCode: crane.stateCode,
    make: crane.make,
    model: crane.model,
    yom: String(crane.yom),
    mainBoomM: crane.mainBoomM === null ? "" : String(crane.mainBoomM),
    fixedJibM: crane.fixedJibM === null ? "" : String(crane.fixedJibM),
    luffingJibM: crane.luffingJibM === null ? "" : String(crane.luffingJibM),
    windJibM: crane.windJibM === null ? "" : String(crane.windJibM),
    serialRegistrationNo: crane.serialRegistrationNo,
    pincode: crane.pincode ?? "",
    latitude: crane.latitude === null ? "" : String(crane.latitude),
    longitude: crane.longitude === null ? "" : String(crane.longitude),
    remarks: crane.remarks ?? "",
    expectedReadyDate: crane.expectedReadyDate
      ? crane.expectedReadyDate.slice(0, 10)
      : "",
  };
}

/** One serialisation of the form, so create and edit cannot drift apart. */
function toPayload(form: CraneForm) {
  const optionalLength = (value: string) => {
    const text = value.trim();
    if (text === "" || /^n\/?a$/i.test(text)) return null;
    return Number(text);
  };
  const coordinate = (value: string) => {
    const text = value.trim();
    return text === "" ? null : Number(text);
  };

  return {
    typeOfCraneCode: form.typeOfCraneCode,
    capacityT: Number(form.capacityT),
    currentStatus: form.currentStatus,
    currentLocation: form.currentLocation.trim(),
    stateCode: form.stateCode,
    make: form.make.trim(),
    model: form.model.trim(),
    yom: Number(form.yom),
    mainBoomM: Number(form.mainBoomM),
    fixedJibM: optionalLength(form.fixedJibM),
    luffingJibM: optionalLength(form.luffingJibM),
    windJibM: optionalLength(form.windJibM),
    serialRegistrationNo: form.serialRegistrationNo.trim(),
    pincode: form.pincode.trim() || null,
    latitude: coordinate(form.latitude),
    longitude: coordinate(form.longitude),
    remarks: form.remarks.trim() || null,
    // Only meaningful while under maintenance; cleared otherwise so a stale
    // date does not linger next to an Available crane.
    expectedReadyDate:
      form.currentStatus === "UNDER_MAINTENANCE" && form.expectedReadyDate.trim()
        ? form.expectedReadyDate.trim()
        : null,
  };
}

export interface ListCranesFilters {
  status?: string;
  typeOfCraneCode?: string;
  stateCode?: string;
  search?: string;
  includeInactive?: boolean;
  /** Internal readers only: narrow the list to one vendor (brief D1). */
  vendorId?: string;
}

export function listCranes(filters: ListCranesFilters = {}): Promise<{ cranes: Crane[] }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "" && value !== false) {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return api(`/cranes${query ? `?${query}` : ""}`);
}

export function getCrane(craneId: string): Promise<{ crane: Crane }> {
  return api(`/cranes/${craneId}`);
}

/**
 * Creates a crane.
 *
 * - An SML user passes `vendorId` to write on a vendor's behalf (brief D1); a
 *   vendor omits it and the backend takes it from the token.
 * - `availableFrom` is carried separately because it is required only when the
 *   status is Engaged, and is not part of the crane form itself.
 */
export function createCrane(
  form: CraneForm,
  extra: { vendorId?: string; availableFrom?: string | null } = {},
): Promise<{ crane: Crane }> {
  const body: Record<string, unknown> = { ...toPayload(form) };
  if (extra.vendorId) body.vendorId = extra.vendorId;
  if (extra.availableFrom !== undefined) body.availableFrom = extra.availableFrom;
  return api("/cranes", { method: "POST", body });
}

/**
 * Edits a crane.
 *
 * `availableFrom` is carried separately for the same reason as `createCrane`:
 * it is required only while the status is Engaged and is not part of the crane
 * form, so `toPayload` would otherwise drop a date the vendor just set.
 */
export function updateCrane(
  craneId: string,
  form: CraneForm,
  extra: { availableFrom?: string | null } = {},
): Promise<{ crane: Crane }> {
  const body: Record<string, unknown> = { ...toPayload(form) };
  if (extra.availableFrom !== undefined) body.availableFrom = extra.availableFrom;
  return api(`/cranes/${craneId}`, { method: "PUT", body });
}

export interface QuickUpdate {
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  availableFrom?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function quickUpdateCrane(craneId: string, input: QuickUpdate): Promise<{ crane: Crane }> {
  return api(`/cranes/${craneId}/status-location`, { method: "PATCH", body: input });
}

/** Returns a prefill for the add form. The vendor still reviews and submits it. */
export function duplicateCrane(craneId: string): Promise<{ prefill: Partial<CraneForm> }> {
  return api(`/cranes/${craneId}/duplicate`);
}

export function confirmCraneAccurate(craneId: string): Promise<{ crane: Crane }> {
  return api(`/cranes/${craneId}/confirm-accurate`, { method: "POST" });
}

export function deactivateCrane(craneId: string): Promise<{ crane: Crane }> {
  return api(`/cranes/${craneId}/deactivate`, { method: "POST" });
}

export function reactivateCrane(craneId: string): Promise<{ crane: Crane }> {
  return api(`/cranes/${craneId}/reactivate`, { method: "POST" });
}

export function uploadLoadChart(craneId: string, file: File): Promise<{ crane: Crane }> {
  return apiUpload(`/cranes/${craneId}/load-chart`, file, { method: "POST" });
}

/**
 * Downloads the chart through the authenticated API.
 *
 * A plain link would not carry the bearer token, so the bytes are fetched here
 * and handed to the browser as an object URL.
 */
export async function downloadLoadChart(crane: Crane): Promise<void> {
  const base = import.meta.env.VITE_API_BASE_URL ?? "/api";
  const response = await fetch(`${base}/cranes/${crane.id}/load-chart`, {
    headers: { Authorization: `Bearer ${getStoredToken() ?? ""}` },
  });
  if (!response.ok) throw new Error("The load chart could not be downloaded.");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = crane.loadChart?.fileName ?? "load-chart";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
import { api } from "@/lib/api";

/**
 * Client for the booking calendar endpoint (P2, brief 6.17).
 *
 * The calendar answers one question — what is this crane doing on this day —
 * across SML and vendor cranes. Reservations win the day: a booking is a
 * commitment, so it reads RESERVED or HIRED before a crane's own status is
 * consulted. Nothing here writes; blocking and releasing live with the
 * reservation endpoints.
 */

export type CalendarDayState =
  | "FREE"
  | "RESERVED"
  | "HIRED"
  | "BLOCKED"
  | "UNAVAILABLE";

export type CalendarOwnershipType = "SML" | "VENDOR";

export interface CalendarDay {
  date: string;
  state: CalendarDayState;
  reservationId: string | null;
}

export interface CalendarCrane {
  craneId: string;
  craneLabel: string;
  vendorId: string;
  vendorName: string;
  ownershipType: CalendarOwnershipType;
  craneTypeCode: string;
  craneTypeName: string;
  capacityT: number;
  stateCode: string;
  stateName: string;
  currentLocation: string;
  currentStatus: string;
  days: CalendarDay[];
}

export interface CalendarView {
  from: string;
  to: string;
  /** One column header per day in the range. */
  days: string[];
  cranes: CalendarCrane[];
}

export interface CalendarFilters {
  from: string;
  to: string;
  ownershipType?: CalendarOwnershipType;
  craneType?: string;
  vendorId?: string;
  region?: string;
  location?: string;
}

export function getBookingCalendar(filters: CalendarFilters): Promise<{ calendar: CalendarView }> {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.ownershipType) params.set("ownershipType", filters.ownershipType);
  if (filters.craneType) params.set("craneType", filters.craneType);
  if (filters.vendorId) params.set("vendorId", filters.vendorId);
  if (filters.region) params.set("region", filters.region);
  if (filters.location) params.set("location", filters.location);
  return api(`/reservations/calendar?${params.toString()}`);
}

/** The badge tone for a day's state, shared with the calendar screen. */
export const DAY_STATE_TONES: Record<CalendarDayState, string> = {
  FREE: "bg-white text-slate-400",
  RESERVED: "bg-blue-100 text-blue-700",
  HIRED: "bg-emerald-100 text-emerald-700",
  BLOCKED: "bg-amber-100 text-amber-700",
  UNAVAILABLE: "bg-red-100 text-red-700",
};

export const DAY_STATE_LABELS: Record<CalendarDayState, string> = {
  FREE: "Free",
  RESERVED: "Reserved",
  HIRED: "Hired",
  BLOCKED: "Blocked",
  UNAVAILABLE: "Under maintenance",
};

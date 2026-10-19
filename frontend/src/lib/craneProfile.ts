import { api } from "@/lib/api";
import type { Crane } from "@/lib/fleet";
import type { CalendarView } from "@/lib/calendar";

/**
 * Client for the crane detail screen (P4, BPD 6.11).
 *
 * The fleet read (`getCrane`) carries the crane's own fields; this endpoint adds
 * what a detail screen needs around it: the booking calendar, the maintenance
 * flags that explain why a crane is not simply "available", the transport-cost
 * assumption behind a mobilisation estimate, and the next date the crane is
 * free once its reservations are considered.
 */

export interface MaintenanceFlag {
  code: string;
  label: string;
  detail: string | null;
}

export interface CraneReservation {
  id: string;
  type: "BOOKED" | "BLOCKED";
  status: string;
  startDate: string;
  endDate: string;
  badge: "BOOKED" | "HIRED" | null;
}

export interface CraneProfile {
  crane: Crane;
  calendar: CalendarView;
  maintenanceFlags: MaintenanceFlag[];
  transportAssumptions: { ratePerKm: number | null; note: string };
  nextAvailableDate: string | null;
  reservations: CraneReservation[];
}

export function getCraneProfile(craneId: string): Promise<{ profile: CraneProfile }> {
  return api(`/cranes/${craneId}/profile`);
}

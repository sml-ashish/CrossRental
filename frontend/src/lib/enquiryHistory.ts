import { api } from "@/lib/api";

/**
 * Client for the audit trail viewer (P4, BPD 5.14).
 *
 * Every status move, internal check, RFQ action, quotation mark and award is in
 * the audit log; this reads them back for one enquiry, its lines, its RFQs and
 * its quotations, in order, so the sourcing journey can be reconstructed.
 */

export interface HistoryChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEntry {
  id: string;
  at: string;
  entity: string;
  entityId: string;
  action: string;
  actor: { id: string | null; name: string | null; role: string | null } | null;
  onBehalfOfVendor: boolean;
  craneId: string | null;
  changes: HistoryChange[];
  oldValue: unknown;
  newValue: unknown;
}

export interface EnquiryHistory {
  enquiryId: string;
  entries: HistoryEntry[];
}

export function getEnquiryHistory(enquiryId: string): Promise<{ history: EnquiryHistory }> {
  return api(`/enquiries/${enquiryId}/history`);
}

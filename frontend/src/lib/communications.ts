import { api } from "@/lib/api";

/**
 * Client for the communication history (P4, BPD 6.21).
 *
 * Built on the email log, so every entry is outbound: the platform records what
 * it sent, not what a vendor wrote back (inbound capture arrives with P6). Each
 * entry says whether it carried a business event, so the trail reads as sourcing
 * activity rather than a mailbox.
 */

export interface CommunicationMessage {
  id: string;
  channel: "EMAIL";
  direction: "OUTBOUND";
  template: string;
  templateLabel: string;
  subject: string;
  toEmail: string;
  ccEmail: string | null;
  status: string;
  sentAt: string;
  entity: string | null;
  entityId: string | null;
  businessEvent: string | null;
}

export interface CommunicationHistory {
  scope: {
    enquiryId?: string;
    lineId?: string;
    rfqId?: string;
    quotationId?: string;
  };
  messages: CommunicationMessage[];
  /** False today: only outbound messages are logged; inbound is P6 work. */
  inboundCaptured: boolean;
}

export interface CommunicationScope {
  enquiryId?: string;
  lineId?: string;
  rfqId?: string;
  quotationId?: string;
}

export function getCommunicationHistory(
  scope: CommunicationScope,
): Promise<{ history: CommunicationHistory }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) {
    if (value) params.set(key, value);
  }
  return api(`/communications?${params.toString()}`);
}

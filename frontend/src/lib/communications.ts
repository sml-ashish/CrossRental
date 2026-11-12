import { api } from "@/lib/api";

/**
 * Client for the communication history (P4, BPD 6.21).
 *
 * Built on the email log, which P6 widened to inbound email and WhatsApp replies.
 * Each entry says whether it carried a business event, so the trail reads as
 * sourcing activity rather than a mailbox.
 */

export interface CommunicationMessage {
  id: string;
  channel: "EMAIL" | "WHATSAPP";
  direction: "OUTBOUND" | "INBOUND";
  template: string;
  templateLabel: string;
  subject: string;
  fromAddress: string | null;
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
  /** True from P6: inbound email and WhatsApp replies are captured. */
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

import { z } from "zod";
import { emailField, mobileField } from "./vendorFields";

/**
 * The three fields SML captures when it invites a vendor to register.
 *
 * Kept in one place so the single invite and the bulk upload validate exactly
 * the same way: a company name, a real email address, and a 10-digit mobile.
 * The email is what the invitation link is sent to, so it is the field that
 * matters most — `emailField` trims and lower-cases it before the duplicate
 * checks run.
 */
export const inviteVendorSchema = z.object({
  /** The vendor's company name, prefilled onto the onboarding form. */
  name: z
    .string()
    .trim()
    .min(2, "Enter the vendor name")
    .max(200, "Vendor name must be 200 characters or fewer"),
  email: emailField,
  contactNumber: mobileField,
});

export type InviteVendorInput = z.infer<typeof inviteVendorSchema>;

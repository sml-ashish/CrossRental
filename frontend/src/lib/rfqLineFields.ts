import type { EnquiryLine } from "./enquiries";

/**
 * The line-item fields a sales user may choose to send into an RFQ.
 *
 * This mirrors the backend allow-list in `validation/enquiryFields.ts`. Core
 * sourcing facts (crane, capacity, quantity, site, dates, duration) are not
 * here because an RFQ cannot be raised without them; they are always copied.
 * Internal-only fields never appear, so there is nothing in this picker that
 * could leak the customer or the rental budget to a vendor.
 */
export const RFQ_LINE_FIELD_KEYS = [
  "applicationDescription",
  "loadDescription",
  "liftLoadT",
  "workingRadiusM",
  "capacityNote",
  "requiredMainBoomM",
  "requiredFixedJibM",
  "requiredLuffingJibM",
  "requiredWindJibM",
  "configurationNotes",
  "workingDaysPerMonth",
  "mobilisationTerms",
  "demobilisationTerms",
  "otCharges",
  "breakdownTerms",
  "dieselScope",
  "workingHoursShift",
  "accommodationConveyance",
  "paymentTerms",
  "craneAgeCriteriaYears",
  "supportCraneScope",
  "steelMatsGroundPrepScope",
  "ehsHrCompliance",
  "insuranceTerms",
  "extensionClause",
  "otherTerms",
  "additionalManpowerScope",
  "intraSiteMovementScope",
  "prereleaseTerms",
  "ppeScope",
  "rowScope",
] as const;

export type RfqLineFieldKey = (typeof RFQ_LINE_FIELD_KEYS)[number];

export interface RfqLineFieldDef {
  key: RfqLineFieldKey;
  label: string;
  group: string;
}

/** Grouped the way the enquiry form and the CR template present the rows. */
export const RFQ_LINE_FIELDS: RfqLineFieldDef[] = [
  { key: "applicationDescription", label: "Application", group: "Job and load" },
  { key: "loadDescription", label: "Load details", group: "Job and load" },
  { key: "liftLoadT", label: "Lift load (t)", group: "Job and load" },
  { key: "workingRadiusM", label: "Working radius (m)", group: "Job and load" },
  { key: "capacityNote", label: "Capacity note", group: "Job and load" },

  { key: "requiredMainBoomM", label: "Main boom (m)", group: "Configuration" },
  { key: "requiredFixedJibM", label: "Fixed jib (m)", group: "Configuration" },
  { key: "requiredLuffingJibM", label: "Luffing jib (m)", group: "Configuration" },
  { key: "requiredWindJibM", label: "Wind jib (m)", group: "Configuration" },
  { key: "configurationNotes", label: "Configuration notes", group: "Configuration" },
  { key: "workingDaysPerMonth", label: "Working days per month", group: "Configuration" },

  { key: "mobilisationTerms", label: "Mobilisation terms", group: "Mobilisation" },
  { key: "demobilisationTerms", label: "Demobilisation terms", group: "Mobilisation" },

  { key: "otCharges", label: "OT charges", group: "Commercial terms" },
  { key: "breakdownTerms", label: "Breakdown terms", group: "Commercial terms" },
  { key: "dieselScope", label: "Diesel scope", group: "Commercial terms" },
  { key: "workingHoursShift", label: "Working hours / shift", group: "Commercial terms" },
  { key: "accommodationConveyance", label: "Accommodation and conveyance", group: "Commercial terms" },
  { key: "paymentTerms", label: "Payment terms", group: "Commercial terms" },
  { key: "craneAgeCriteriaYears", label: "Maximum crane age (years)", group: "Commercial terms" },

  { key: "supportCraneScope", label: "Support crane scope", group: "Scopes and other" },
  {
    key: "steelMatsGroundPrepScope",
    label: "Steel mats / ground prep scope",
    group: "Scopes and other",
  },
  { key: "ehsHrCompliance", label: "EHS / HR compliance", group: "Scopes and other" },
  { key: "insuranceTerms", label: "Insurance terms", group: "Scopes and other" },
  { key: "extensionClause", label: "Extension clause", group: "Scopes and other" },
  { key: "otherTerms", label: "Other terms", group: "Scopes and other" },
  { key: "additionalManpowerScope", label: "Additional manpower scope", group: "Scopes and other" },
  { key: "intraSiteMovementScope", label: "Intra-site movement scope", group: "Scopes and other" },
  { key: "prereleaseTerms", label: "Pre-release terms", group: "Scopes and other" },
  { key: "ppeScope", label: "PPE scope", group: "Scopes and other" },
  { key: "rowScope", label: "ROW scope", group: "Scopes and other" },
];

export interface RfqLineFieldOption extends RfqLineFieldDef {
  /** The line's value, formatted for the picker, or null when not filled in. */
  value: string | null;
}

function formatValue(key: RfqLineFieldKey, value: string | number): string {
  if (typeof value === "number") {
    if (key === "liftLoadT") return `${value} t`;
    if (key === "craneAgeCriteriaYears") return `${value} years`;
    if (key === "workingDaysPerMonth") return `${value} days / month`;
    return `${value} m`;
  }
  return value.trim();
}

/** Only fields with a real value are offered — an empty box has nothing to send. */
export function rfqLineFieldOptions(line: EnquiryLine): RfqLineFieldOption[] {
  return RFQ_LINE_FIELDS.flatMap((field) => {
    const raw = line[field.key];
    if (raw === null || raw === undefined) return [];
    if (typeof raw === "string" && raw.trim() === "") return [];
    return [{ ...field, value: formatValue(field.key, raw) }];
  });
}

/** All populated fields are checked to start with; the user unchecks as needed. */
export function defaultRfqLineFields(line: EnquiryLine): RfqLineFieldKey[] {
  return rfqLineFieldOptions(line).map((field) => field.key);
}

export function groupRfqLineFields(
  fields: RfqLineFieldOption[],
): Array<{ group: string; fields: RfqLineFieldOption[] }> {
  const groups: Array<{ group: string; fields: RfqLineFieldOption[] }> = [];
  for (const field of fields) {
    let bucket = groups.find((entry) => entry.group === field.group);
    if (!bucket) {
      bucket = { group: field.group, fields: [] };
      groups.push(bucket);
    }
    bucket.fields.push(field);
  }
  return groups;
}

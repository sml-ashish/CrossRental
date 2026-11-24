import type { EnquiryLine } from "./enquiries";

/**
 * The line-item fields a sales user may choose to send into an RFQ.
 *
 * This mirrors the backend allow-list in `validation/enquiryFields.ts`. Core
 * sourcing facts (crane, capacity, site, dates and duration) are not here
 * because an RFQ cannot be raised without them; they are always copied. Vendor
 * terms that are not captured on the enquiry are chosen on the RFQ itself.
 */
export const RFQ_LINE_FIELD_KEYS = [
  "applicationDescription",
  "liftLoadT",
  "liftHeightM",
  "craneConfiguration",
  "workingDaysPerMonth",
  "otCharges",
  "breakdownTerms",
  "dieselScope",
  "workingHoursShift",
  "craneAgeCriteriaYears",
  "supportCraneScope",
  "steelMatsGroundPrepScope",
  "ehsHrCompliance",
  "insuranceTerms",
  "additionalManpowerScope",
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
  { key: "liftLoadT", label: "Weight to be lifted (t)", group: "Job and load" },
  { key: "liftHeightM", label: "Height to be lifted (m)", group: "Job and load" },

  { key: "craneConfiguration", label: "Crane configuration", group: "Configuration" },
  { key: "workingDaysPerMonth", label: "Working days per month", group: "Configuration" },

  { key: "otCharges", label: "OT charges", group: "Commercial terms" },
  { key: "breakdownTerms", label: "Breakdown Charges", group: "Commercial terms" },
  { key: "dieselScope", label: "Diesel scope", group: "Commercial terms" },
  { key: "workingHoursShift", label: "Working hours / shift", group: "Commercial terms" },
  { key: "craneAgeCriteriaYears", label: "Maximum crane age (years)", group: "Commercial terms" },

  { key: "supportCraneScope", label: "Support crane scope", group: "Scopes and other terms" },
  {
    key: "steelMatsGroundPrepScope",
    label: "Steel mats / ground prep scope",
    group: "Scopes and other terms",
  },
  { key: "ehsHrCompliance", label: "EHS / HR compliance", group: "Scopes and other terms" },
  { key: "insuranceTerms", label: "Insurance Coverage", group: "Scopes and other terms" },
  {
    key: "additionalManpowerScope",
    label: "Additional manpower scope",
    group: "Scopes and other terms",
  },
  { key: "rowScope", label: "ROW scope", group: "Scopes and other terms" },
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

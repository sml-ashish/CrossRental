import { MapPin, Mail, Phone } from "lucide-react";
import { Panel } from "@/components/ui/page-header";
import { ReadOnlyValue } from "@/components/ui/form";
import { extraTermRows, type VendorRfqDetail } from "@/lib/quotations";
import { formatCalendarDate } from "@/lib/format";
import {
  durationLabel,
  expectedEndDate,
  mapsUrl,
  mobilisationWindow,
  shortDate,
} from "./rfq-utils";

/**
 * The requirement, grouped by the questions a dispatcher actually asks:
 * what machine, for what job, where and when, and who pays for what. Every
 * field the screen had is still here — only the order and the labels' company
 * changed. Terms are printed exactly as the server sent them; no parsing.
 */
export function Requirement({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const start = rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate);
  const end = expectedEndDate(rfq);
  const mobilise = mobilisationWindow(rfq);

  return (
    <>
      <Panel
        title="Requirement"
        description="As SML issued it. These details are read-only."
        className="print:border-0"
        bodyClassName="space-y-5 p-4"
      >
          <Group title="Machine">
            <ReadOnlyValue label="Crane type" value={rfq.craneTypeName} />
            <ReadOnlyValue
              label="Capacity"
              value={`${rfq.capacityT} t (${rfq.capacityRule === "EXACT" ? "exact" : "at least"})`}
            />
            <ReadOnlyValue label="Quantity" value={String(rfq.quantity)} />
            {rfq.capacityNote ? (
              <ReadOnlyValue label="Capacity note" value={rfq.capacityNote} />
            ) : null}
            {rfq.configuration ? (
              <ReadOnlyValue label="Configuration" value={rfq.configuration} />
            ) : null}
            {rfq.mainBoomM !== null ? (
              <ReadOnlyValue label="Main boom required" value={`${rfq.mainBoomM} m`} />
            ) : null}
            {rfq.jibLengthM !== null ? (
              <ReadOnlyValue label="Jib length required" value={`${rfq.jibLengthM} m`} />
            ) : null}
          </Group>

          {rfq.applicationDescription || rfq.loadDescription || rfq.notes ? (
            <Group title="Job">
              {rfq.applicationDescription ? (
                <ReadOnlyValue label="Application" value={rfq.applicationDescription} />
              ) : null}
              {rfq.loadDescription ? (
                <ReadOnlyValue label="Load details" value={rfq.loadDescription} />
              ) : null}
            </Group>
          ) : null}

          {rfq.notes ? (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
              <p className="text-xs font-medium text-amber-700">Notes from SML</p>
              <p className="mt-1 text-sm whitespace-pre-wrap text-amber-800">{rfq.notes}</p>
            </div>
          ) : null}

          <Group title="Site and schedule">
            <ReadOnlyValue label="Site" value={rfq.siteLocation} />
            <ReadOnlyValue label="State" value={rfq.siteStateName} />
            {rfq.sitePincode ? (
              <ReadOnlyValue label="PIN code" value={rfq.sitePincode} mono />
            ) : null}
            <ReadOnlyValue label="Required start" value={start} />
            <ReadOnlyValue label="Duration" value={durationLabel(rfq)} />
            {end ? <ReadOnlyValue label="Expected end" value={shortDate(end)} /> : null}
            {mobilise ? <ReadOnlyValue label="Mobilisation" value={mobilise} /> : null}
          </Group>
      </Panel>

      <CommercialTerms rfq={rfq} />
      <ContactPanel rfq={rfq} />
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold tracking-[0.08em] text-slate-500 uppercase">
        {title}
      </h3>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        {children}
      </dl>
    </section>
  );
}

type TermRow = { label: string; value: string };

/**
 * Commercial terms as "who pays / what is expected" rather than one long list.
 * Empty groups disappear; the text itself is never split or rewritten.
 */
function CommercialTerms({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const terms = rfq.commercialTerms;
  const extraRows = extraTermRows(terms.extra);
  const extra = (keys: string[]) => extraRows.filter((row) => keys.includes(row.key));

  const costs = compact([
    { label: "O.T. charges", value: terms.otCharges },
    { label: "Diesel", value: terms.dieselScope },
    { label: "Accommodation / conveyance", value: terms.accommodationConveyance },
    { label: "Mobilisation / demobilisation", value: terms.mobilisationTerms },
    { label: "Support crane", value: terms.supportCrane },
    { label: "Steel mats / ground prep", value: terms.steelMatsGroundPrep },
    ...extra(["demobilisationTerms", "additionalManpowerScope", "intraSiteMovementScope"]),
  ]);

  const operations = compact([
    { label: "Working hours", value: terms.workingHoursShift },
    { label: "Breakdown", value: terms.breakdownTerms },
    { label: "Extension clause", value: terms.extensionClause },
    ...extra(["prereleaseTerms"]),
  ]);

  const compliance = compact([
    { label: "EHS / HR", value: terms.ehsHrRequirements },
    { label: "Insurance", value: terms.insuranceTerms },
    { label: "Payment terms", value: terms.paymentTerms },
    ...extra(["ppeScope", "rowScope"]),
  ]);

  const other = extraRows.filter(
    (row) =>
      ![
        "demobilisationTerms",
        "additionalManpowerScope",
        "intraSiteMovementScope",
        "prereleaseTerms",
        "ppeScope",
        "rowScope",
      ].includes(row.key),
  );
  if (other.length > 0) costs.push(...other);

  if (costs.length === 0 && operations.length === 0 && compliance.length === 0) return null;

  return (
    <Panel
      title="Who pays / what's expected"
      description="Commercial terms as SML wrote them. Nothing here is reworded."
      bodyClassName="space-y-4 p-4"
    >
      <TermGroup title="Costs and scope" rows={costs} />
      <TermGroup title="Operations" rows={operations} />
      <TermGroup title="Compliance and payment" rows={compliance} />
    </Panel>
  );
}

function TermGroup({ title, rows }: { title: string; rows: TermRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Group title={title}>
      {rows.map((row) => (
        <ReadOnlyValue key={row.label + row.value} label={row.label} value={row.value} />
      ))}
    </Group>
  );
}

function compact(rows: Array<{ label: string; value: string | null }>): TermRow[] {
  return rows.flatMap((row) => (row.value && row.value.trim() !== "" ? [{ label: row.label, value: row.value }] : []));
}

/**
 * The SML person to call. Buttons are `tel:`/`mailto:` and a plain Maps search
 * built from the site — no API key, no new endpoint.
 */
function ContactPanel({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const { name, email, mobile } = rfq.smlContact;
  if (!name && !email && !mobile) return null;
  const tel = mobile?.replace(/[^+\d]/g, "") ?? null;

  return (
    <Panel title="SML contact">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {name ? <p className="text-sm font-medium text-slate-900">{name}</p> : null}
          <p className="mt-0.5 text-sm text-slate-600">
            {[mobile, email].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tel ? (
            <a href={`tel:${tel}`} className="btn-secondary min-h-10 px-3 py-1.5 text-xs">
              <Phone className="size-3.5" aria-hidden /> Call
            </a>
          ) : null}
          {email ? (
            <a href={`mailto:${email}`} className="btn-secondary min-h-10 px-3 py-1.5 text-xs">
              <Mail className="size-3.5" aria-hidden /> Email
            </a>
          ) : null}
          <a
            href={mapsUrl(rfq)}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary min-h-10 px-3 py-1.5 text-xs"
          >
            <MapPin className="size-3.5" aria-hidden /> Open site in Maps
          </a>
        </div>
      </div>
    </Panel>
  );
}



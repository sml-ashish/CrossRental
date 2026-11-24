import { CalendarDays, ChevronDown, Clock, MapPin, Mail, Phone, Truck } from "lucide-react";
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
 * Structured machine measures, in template order. Every row is an explicit
 * "null means not sent" value, so a field SML did not select is never shown to
 * the vendor — including through the derived jib-length fit check.
 */
function machineMeasureRows(rfq: VendorRfqDetail["rfq"]): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [
    ["Weight to be lifted", rfq.liftLoadT !== null ? `${rfq.liftLoadT} t` : null],
    ["Height to be lifted", rfq.liftHeightM !== null ? `${rfq.liftHeightM} m` : null],
    ["Working radius", rfq.workingRadiusM !== null ? `${rfq.workingRadiusM} m` : null],
    ["Main boom required", rfq.mainBoomM !== null ? `${rfq.mainBoomM} m` : null],
    ["Fixed jib required", rfq.fixedJibM !== null ? `${rfq.fixedJibM} m` : null],
    ["Luffing jib required", rfq.luffingJibM !== null ? `${rfq.luffingJibM} m` : null],
    ["Wind jib required", rfq.windJibM !== null ? `${rfq.windJibM} m` : null],
    ["Jib length required", rfq.jibLengthM !== null ? `${rfq.jibLengthM} m` : null],
  ];
  return rows.filter((row): row is [string, string] => row[1] !== null);
}

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
  const hasMachine =
    rfq.capacityNote ||
    rfq.configuration ||
    machineMeasureRows(rfq).length > 0;
  const hasJob = rfq.applicationDescription || rfq.loadDescription;

  return (
    <div className="space-y-3">
      <section className="card overflow-hidden print:border-0">
        <div className="border-b border-ink-800 bg-ink-900 px-5 py-4">
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            What SML needs
          </p>
          <p className="mt-1 text-[22px] leading-7 font-semibold tracking-tight text-slate-900">
            {rfq.capacityT} t{rfq.capacityRule === "EXACT" ? "" : "+"} {rfq.craneTypeName}
            {rfq.quantity > 1 ? ` × ${rfq.quantity}` : ""}
          </p>
        </div>

        <dl className="space-y-4 px-5 py-4">
          <Fact
            icon={MapPin}
            label="Site"
            value={[rfq.siteLocation, rfq.siteStateName, rfq.sitePincode].filter(Boolean).join(", ")}
          />
          <Fact
            icon={CalendarDays}
            label="Starts"
            value={start}
          />
          <Fact
            icon={Clock}
            label="Duration"
            value={`${durationLabel(rfq)}${end ? ` · to ${shortDate(end)}` : ""}`}
          />
          {mobilise ? <Fact icon={Truck} label="Mobilisation" value={mobilise} /> : null}
        </dl>

        {rfq.notes ? (
          <div className="mx-5 mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
            <p className="text-xs font-medium text-amber-700">Note from SML</p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-amber-800">{rfq.notes}</p>
          </div>
        ) : null}
      </section>

      {hasMachine || hasJob ? (
        <Disclosure title="Machine and job">
          <dl className="space-y-3">
            {rfq.capacityNote ? <ReadOnlyValue label="Capacity note" value={rfq.capacityNote} /> : null}
            {rfq.configuration ? <ReadOnlyValue label="Configuration" value={rfq.configuration} /> : null}
            {machineMeasureRows(rfq).map(([label, value]) => (
              <ReadOnlyValue key={label} label={label} value={value} />
            ))}
            {rfq.applicationDescription ? (
              <ReadOnlyValue label="Application" value={rfq.applicationDescription} />
            ) : null}
            {rfq.loadDescription ? (
              <ReadOnlyValue label="Load details" value={rfq.loadDescription} />
            ) : null}
          </dl>
        </Disclosure>
      ) : null}

      <CommercialTerms rfq={rfq} />
      <ContactPanel rfq={rfq} />
    </div>
  );
}

/**
 * The whole requirement, laid out to be read. A vendor prices from these
 * details, so this is the first thing on the page — not a sidebar — and it ends
 * in the way forward rather than leaving the vendor to find the quote form.
 */
export function RequirementFull({
  rfq,
  canQuote,
  onQuote,
}: {
  rfq: VendorRfqDetail["rfq"];
  canQuote: boolean;
  onQuote: () => void;
}) {
  const start = rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate);
  const end = expectedEndDate(rfq);
  const mobilise = mobilisationWindow(rfq);
  const { costs, operations, compliance } = termGroupsOf(rfq);
  const hasTerms = costs.length + operations.length + compliance.length > 0;
  const hasMachine =
    rfq.capacityNote ||
    rfq.configuration ||
    machineMeasureRows(rfq).length > 0;
  const hasJob = rfq.applicationDescription || rfq.loadDescription;

  return (
    <div className="space-y-5">
      <section className="card overflow-hidden print:border-0">
        <div className="border-b border-ink-800 bg-ink-900 px-6 py-5">
          <p className="text-[12px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            What SML needs
          </p>
          <p className="mt-1 text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
            {rfq.capacityT} t{rfq.capacityRule === "EXACT" ? "" : "+"} {rfq.craneTypeName}
            {rfq.quantity > 1 ? ` × ${rfq.quantity}` : ""}
          </p>
          <p className="mt-0.5 text-[14px] text-slate-500">
            Capacity {rfq.capacityRule === "EXACT" ? "exactly" : "at least"} {rfq.capacityT} t ·{" "}
            {rfq.quantity === 1 ? "one crane" : `${rfq.quantity} cranes`}
          </p>
        </div>
        <dl className="grid gap-5 px-6 py-5 sm:grid-cols-2">
          <Fact
            icon={MapPin}
            label="Site"
            value={[rfq.siteLocation, rfq.siteStateName, rfq.sitePincode].filter(Boolean).join(", ")}
          />
          <Fact icon={CalendarDays} label="Starts" value={start} />
          <Fact
            icon={Clock}
            label="Duration"
            value={`${durationLabel(rfq)}${end ? ` · to ${shortDate(end)}` : ""}`}
          />
          {mobilise ? <Fact icon={Truck} label="Mobilisation" value={mobilise} /> : null}
        </dl>
        {rfq.notes ? (
          <div className="mx-6 mb-5 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3.5">
            <p className="text-xs font-medium text-amber-700">Note from SML</p>
            <p className="mt-1 text-[15px] whitespace-pre-wrap text-amber-800">{rfq.notes}</p>
          </div>
        ) : null}
      </section>

      {hasMachine || hasJob ? (
        <Block title="Machine and job">
          <div className="space-y-5">
            {hasMachine ? (
              <Group title="Machine" wide>
                {rfq.capacityNote ? (
                  <ReadOnlyValue label="Capacity note" value={rfq.capacityNote} />
                ) : null}
                {rfq.configuration ? (
                  <ReadOnlyValue label="Configuration" value={rfq.configuration} />
                ) : null}
                {machineMeasureRows(rfq).map(([label, value]) => (
                  <ReadOnlyValue key={label} label={label} value={value} />
                ))}
              </Group>
            ) : null}
            {hasJob ? (
              <Group title="Job" wide>
                {rfq.applicationDescription ? (
                  <ReadOnlyValue label="Application" value={rfq.applicationDescription} />
                ) : null}
                {rfq.loadDescription ? (
                  <ReadOnlyValue label="Load details" value={rfq.loadDescription} />
                ) : null}
              </Group>
            ) : null}
          </div>
        </Block>
      ) : null}

      {hasTerms ? (
        <Block
          title="Commercial terms"
          hint="As SML wrote them. By quoting you accept these unless you note a deviation."
        >
          <div className="space-y-5">
            <TermGroup title="Costs and scope" rows={costs} wide />
            <TermGroup title="Operations" rows={operations} wide />
            <TermGroup title="Compliance and payment" rows={compliance} wide />
          </div>
        </Block>
      ) : null}

      <ContactPanel rfq={rfq} />

      {canQuote ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent-500/40 bg-accent-500/[0.06] px-6 py-4 print:hidden">
          <div>
            <p className="text-[16px] font-semibold text-slate-900">Ready to quote?</p>
            <p className="text-[14px] text-slate-500">
              You can keep this requirement open beside the quote form.
            </p>
          </div>
          <button type="button" className="btn-primary min-h-11 px-5 text-[15px]" onClick={onQuote}>
            Continue to quote
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden print:border-0">
      <div className="border-b border-ink-800 px-6 py-4">
        <h2 className="text-[17px] font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-[14px] text-slate-500">{hint}</p> : null}
      </div>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-slate-600">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <dt className="text-[12px] font-medium tracking-[0.06em] text-slate-500 uppercase">
          {label}
        </dt>
        <dd className="text-[15px] text-slate-900">{value}</dd>
      </div>
    </div>
  );
}

/** Open by default so nothing is hidden and a print shows every term. */
function Disclosure({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <details open className="card overflow-hidden [&[open]>summary_svg]:rotate-180 print:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-3.5 print:pointer-events-none">
        <span className="text-[15px] font-semibold text-slate-900">
          {title}
          {count ? (
            <span className="ml-2 rounded-full bg-ink-800 px-2 py-0.5 text-[12px] font-medium text-slate-600">
              {count}
            </span>
          ) : null}
        </span>
        <ChevronDown className="size-4 text-slate-500 transition-transform" aria-hidden />
      </summary>
      <div className="border-t border-ink-800 px-5 py-4">{children}</div>
    </details>
  );
}

function Group({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section>
      <h3 className="text-[12px] font-semibold tracking-[0.08em] text-slate-500 uppercase">
        {title}
      </h3>
      <dl
        className={
          wide ? "mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2" : "mt-2 space-y-3"
        }
      >
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
function termGroupsOf(rfq: VendorRfqDetail["rfq"]) {
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

  return { costs, operations, compliance };
}

function CommercialTerms({ rfq }: { rfq: VendorRfqDetail["rfq"] }) {
  const { costs, operations, compliance } = termGroupsOf(rfq);
  if (costs.length === 0 && operations.length === 0 && compliance.length === 0) return null;

  return (
    <Disclosure
      title="Commercial terms"
      count={costs.length + operations.length + compliance.length}
    >
      <div className="space-y-5">
        <TermGroup title="Costs and scope" rows={costs} />
        <TermGroup title="Operations" rows={operations} />
        <TermGroup title="Compliance and payment" rows={compliance} />
      </div>
    </Disclosure>
  );
}

function TermGroup({
  title,
  rows,
  wide,
}: {
  title: string;
  rows: TermRow[];
  wide?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <Group title={title} wide={wide}>
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
    <Disclosure title="SML contact">
      <div className="space-y-3">
        <div className="min-w-0">
          {name ? <p className="text-[15px] font-medium text-slate-900">{name}</p> : null}
          <p className="mt-0.5 text-sm break-words text-slate-600">
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
            <MapPin className="size-3.5" aria-hidden /> Site in Maps
          </a>
        </div>
      </div>
    </Disclosure>
  );
}

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  discoveryFacets,
  searchDiscovery,
  type DiscoveryAvailability,
  type DiscoveryCrane,
  type DiscoveryFilters,
} from "@/lib/discovery";
import { formatDistance } from "@/lib/rfqs";
import { formatDate } from "@/lib/enquiries";
import { formatCalendarDate } from "@/routes/app/rfqs";
import { CraneMap } from "@/components/crane-map";
import { DiscoveryCalendar } from "@/components/discovery-calendar";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/toolbar";
import { Spinner } from "@/components/ui/spinner";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, Select, TextInput } from "@/components/ui/form";

/**
 * Manual vendor discovery (P4, BPD 6.8 / 5.9).
 *
 * A browse across every approved vendor's fleet with no enquiry in view. There
 * is no SML set to merge here — SML has no fleet (open item 2) — so every row is
 * a vendor crane. The map plots the stored coordinates, with a Google heat layer
 * for crane density; a job-site address turns the list into a distance ranking.
 */

type ViewMode = "grouped" | "flat" | "map" | "calendar";

interface FilterState {
  craneType: string;
  capacityT: string;
  capacityRule: "AT_LEAST" | "EXACT";
  location: string;
  region: string;
  vendorName: string;
  vendorRegion: string;
  companySize: string;
  fleetSizeMin: string;
  yomFrom: string;
  yomTo: string;
  availability: DiscoveryAvailability | "";
  availableFrom: string;
  availableTo: string;
  siteLocation: string;
  sitePincode: string;
}

const EMPTY_FILTERS: FilterState = {
  craneType: "",
  capacityT: "",
  capacityRule: "AT_LEAST",
  location: "",
  region: "",
  vendorName: "",
  vendorRegion: "",
  companySize: "",
  fleetSizeMin: "",
  yomFrom: "",
  yomTo: "",
  availability: "",
  availableFrom: "",
  availableTo: "",
  siteLocation: "",
  sitePincode: "",
};

/**
 * The hire window is a pair, not two independent filters.
 *
 * One date alone has no period to test a booking against, and a reversed range
 * would silently match nothing, so the form refuses both before searching. The
 * backend applies the same rule.
 */
function windowError(filters: FilterState): string | null {
  const { availableFrom, availableTo } = filters;
  if (!availableFrom && !availableTo) return null;
  if (!availableFrom || !availableTo) return "Give both dates";
  if (availableTo < availableFrom) return "Available to must be on or after available from";
  return null;
}

function toQuery(filters: FilterState): DiscoveryFilters {
  const query: DiscoveryFilters = {};
  if (filters.craneType) query.craneType = filters.craneType;
  if (filters.capacityT) query.capacityT = filters.capacityT;
  if (filters.capacityT) query.capacityRule = filters.capacityRule;
  if (filters.location.trim()) query.location = filters.location.trim();
  if (filters.region) query.region = filters.region;
  if (filters.vendorName.trim()) query.vendorName = filters.vendorName.trim();
  if (filters.vendorRegion) query.vendorRegion = filters.vendorRegion;
  if (filters.companySize) query.companySize = filters.companySize;
  if (filters.fleetSizeMin) query.fleetSizeMin = filters.fleetSizeMin;
  if (filters.yomFrom) query.yomFrom = filters.yomFrom;
  if (filters.yomTo) query.yomTo = filters.yomTo;
  if (filters.availability) query.availability = filters.availability;
  if (filters.availableFrom && filters.availableTo) {
    query.availableFrom = filters.availableFrom;
    query.availableTo = filters.availableTo;
  }
  if (filters.siteLocation.trim()) query.siteLocation = filters.siteLocation.trim();
  if (filters.sitePincode.trim()) query.sitePincode = filters.sitePincode.trim();
  return query;
}

export function DiscoveryPage() {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [committed, setCommitted] = useState<FilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<ViewMode>("grouped");

  const facets = useQuery({ queryKey: ["discovery", "facets"], queryFn: discoveryFacets });

  // The applied filters as the API sees them. Memoised on `committed` so the
  // calendar tab gets a stable object: otherwise every render would hand it a
  // fresh value and clear its selected day.
  const committedQuery = useMemo(() => toQuery(committed), [committed]);
  const results = useQuery({
    queryKey: ["discovery", "search", committedQuery],
    queryFn: () => searchDiscovery(committedQuery),
  });

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  // Shown under the window fields and blocks the search, so an incomplete pair
  // never reaches the API as a half-applied filter.
  const windowIssue = windowError(filters);
  const windowFromError = windowIssue && !filters.availableFrom ? windowIssue : null;
  const windowToError = windowIssue && filters.availableFrom ? windowIssue : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vendor discovery"
        description="Find cranes across approved vendors without an enquiry. Filter, then open a crane or a vendor to start sourcing."
        actions={
          <Link to="/app/enquiries" className="btn-secondary">
            Start from an enquiry
          </Link>
        }
      />

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Filters</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Leave a field empty to ignore it. Search applies the whole form at once.
            </p>
          </div>
          <Segmented
            value={view}
            onChange={setView}
            label="Result view"
            options={[
              { value: "grouped", label: "By vendor" },
              { value: "flat", label: "Flat list" },
              { value: "map", label: "Map and heat map" },
              { value: "calendar", label: "Calendar" },
            ]}
          />
        </div>

        <div className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Crane type" htmlFor="d-type">
            <Select
              id="d-type"
              value={filters.craneType}
              onChange={(v) => set("craneType", v)}
              placeholder="All types"
              options={(facets.data?.craneTypes ?? []).map((t) => ({
                value: t.code,
                label: t.name,
              }))}
            />
          </Field>
          <Field label="Capacity (t)" htmlFor="d-capacity">
            <div className="flex gap-2">
              <TextInput
                id="d-capacity"
                value={filters.capacityT}
                onChange={(v) => set("capacityT", v)}
                inputMode="decimal"
                placeholder="e.g. 100"
              />
              <Select
                id="d-capacity-rule"
                value={filters.capacityRule}
                onChange={(v) => set("capacityRule", v as FilterState["capacityRule"])}
                options={[
                  { value: "AT_LEAST", label: "At least" },
                  { value: "EXACT", label: "Exact" },
                ]}
              />
            </div>
          </Field>
          <Field label="Location (free text)" htmlFor="d-location" hint="Matches location, state, make or model.">
            <TextInput
              id="d-location"
              value={filters.location}
              onChange={(v) => set("location", v)}
              placeholder="e.g. Pune"
            />
          </Field>
          <Field
            label="Job site address"
            htmlFor="d-site"
            hint="Optional. Sorts the list by road distance from this site."
          >
            <TextInput
              id="d-site"
              value={filters.siteLocation}
              onChange={(v) => set("siteLocation", v)}
              placeholder="e.g. Vadodara, Gujarat"
            />
          </Field>
          <Field label="Site pincode" htmlFor="d-site-pin">
            <TextInput
              id="d-site-pin"
              value={filters.sitePincode}
              onChange={(v) => set("sitePincode", v)}
              inputMode="numeric"
              placeholder="e.g. 390001"
            />
          </Field>
          <Field label="Crane state" htmlFor="d-region">
            <Select
              id="d-region"
              value={filters.region}
              onChange={(v) => set("region", v)}
              placeholder="All states"
              options={(facets.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }))}
            />
          </Field>
          <Field label="Vendor name" htmlFor="d-vendor">
            <TextInput
              id="d-vendor"
              value={filters.vendorName}
              onChange={(v) => set("vendorName", v)}
              placeholder="e.g. Sharma"
            />
          </Field>
          <Field label="Vendor operating region" htmlFor="d-vendor-region">
            <Select
              id="d-vendor-region"
              value={filters.vendorRegion}
              onChange={(v) => set("vendorRegion", v)}
              placeholder="All states"
              options={(facets.data?.states ?? []).map((s) => ({ value: s.code, label: s.name }))}
            />
          </Field>
          <Field label="Company size" htmlFor="d-size">
            <Select
              id="d-size"
              value={filters.companySize}
              onChange={(v) => set("companySize", v)}
              placeholder="Any size"
              options={(facets.data?.companySizes ?? []).map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label="Fleet size (min)" htmlFor="d-fleet">
            <TextInput
              id="d-fleet"
              value={filters.fleetSizeMin}
              onChange={(v) => set("fleetSizeMin", v)}
              inputMode="numeric"
              placeholder="e.g. 5"
            />
          </Field>
          <Field label="YOM from" htmlFor="d-yom-from">
            <TextInput
              id="d-yom-from"
              value={filters.yomFrom}
              onChange={(v) => set("yomFrom", v)}
              inputMode="numeric"
              placeholder="e.g. 2010"
            />
          </Field>
          <Field label="YOM to" htmlFor="d-yom-to">
            <TextInput
              id="d-yom-to"
              value={filters.yomTo}
              onChange={(v) => set("yomTo", v)}
              inputMode="numeric"
              placeholder="e.g. 2024"
            />
          </Field>
          <Field label="Availability" htmlFor="d-availability">
            <Select
              id="d-availability"
              value={filters.availability}
              onChange={(v) => set("availability", v as FilterState["availability"])}
              placeholder="Any status"
              options={[
                { value: "AVAILABLE", label: "Available" },
                { value: "ENGAGED", label: "Engaged" },
                { value: "UNDER_MAINTENANCE", label: "Under maintenance" },
              ]}
            />
          </Field>
          <Field
            label="Available from"
            htmlFor="d-available-from"
            error={windowFromError}
            hint="Both dates are needed. Matches cranes free for that whole window."
          >
            <TextInput
              id="d-available-from"
              type="date"
              value={filters.availableFrom}
              onChange={(v) => set("availableFrom", v)}
            />
          </Field>
          <Field label="Available to" htmlFor="d-available-to" error={windowToError}>
            <TextInput
              id="d-available-to"
              type="date"
              value={filters.availableTo}
              onChange={(v) => set("availableTo", v)}
            />
          </Field>
        </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              className="btn-primary"
              onClick={() => setCommitted(filters)}
              disabled={windowIssue !== null}
            >
              <Search className="size-4" aria-hidden />
              Search
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setCommitted(EMPTY_FILTERS);
              }}
            >
              Clear
            </button>
            <p className="ml-auto text-xs text-slate-500">
              {results.isPending
                ? "Searching…"
                : `${results.data?.totalMatched ?? 0} cranes match the applied filters`}
            </p>
          </div>
        </div>
      </section>

      {results.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : results.isError ? (
        <Alert tone="error">Could not run that search.</Alert>
      ) : (
        <Results
          data={results.data}
          view={view}
          filters={committedQuery}
          siteUnresolved={committed.siteLocation.trim() !== "" && results.data.site === null}
          window={
            committed.availableFrom && committed.availableTo
              ? { from: committed.availableFrom, to: committed.availableTo }
              : null
          }
        />
      )}
    </div>
  );
}

type ResultData = Awaited<ReturnType<typeof searchDiscovery>>;

function Results({
  data,
  view,
  filters,
  siteUnresolved,
  window,
}: {
  data: ResultData;
  view: ViewMode;
  filters: DiscoveryFilters;
  siteUnresolved: boolean;
  window: { from: string; to: string } | null;
}) {
  // Memoised on `data`: React Query keeps the same object when the payload is
  // unchanged, so opening the map does not rebuild every marker and the heat
  // canvas on an unrelated re-render.
  const cranes = useMemo(
    () => [...data.groups.flatMap((group) => group.cranes), ...data.unverified],
    [data],
  );
  const routed = cranes.some((crane) => crane.distanceMethod === "road");

  return (
    <>
      {siteUnresolved ? (
        <Alert tone="info" title="Job site not found">
          We could not locate that address, so the list is not distance-sorted. Try a nearby town
          or a pincode.
        </Alert>
      ) : null}

      <div className="card flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900 tabular-nums">{data.totalMatched}</span>{" "}
          crane{data.totalMatched === 1 ? "" : "s"} matched
          {window ? (
            <>
              {" "}
              · free {formatCalendarDate(window.from)} – {formatCalendarDate(window.to)}
            </>
          ) : null}
        </p>
        <p className="text-xs text-slate-500">
          {view === "calendar"
            ? "Day states come from reservations; the crane's own status fills the rest"
            : data.distancesAvailable
              ? routed
                ? "Sorted by road distance from the job site"
                : "Straight-line distances; no routed distance was available"
              : "Give a job site address to sort by road distance"}
        </p>
      </div>

      {view === "grouped" ? <GroupedView data={data} /> : null}
      {view === "flat" ? <FlatView data={data} /> : null}
      {view === "map" ? <CraneMap cranes={cranes} site={data.site} /> : null}
      {view === "calendar" ? <DiscoveryCalendar filters={filters} /> : null}
    </>
  );
}

function CraneRow({ crane }: { crane: DiscoveryCrane }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-900">
            {crane.serialRegistrationNo}
          </span>
          <StatusBadge status={crane.currentStatus} />
          {crane.stale ? <Badge tone="amber">Stale</Badge> : null}
          {crane.locationUnverified ? <Badge tone="neutral">No coordinates</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-slate-700">
          {crane.typeOfCraneName} · {crane.capacityT} t · {crane.make} {crane.model} ·{" "}
          {crane.yom}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {crane.currentLocation}, {crane.stateName} ·{" "}
          {formatDistance(crane.distanceKm, crane.distanceApproximate)}
          {crane.availableFrom && crane.currentStatus === "ENGAGED"
            ? ` · available ${formatDate(crane.availableFrom)}`
            : ""}
        </p>
      </div>
      <Link
        to="/app/cranes/$craneId"
        params={{ craneId: crane.craneId }}
        className="btn-secondary px-3 py-1.5 text-xs"
      >
        Crane detail
      </Link>
    </li>
  );
}

function GroupedView({ data }: { data: ResultData }) {
  if (data.groups.length === 0 && data.unverified.length === 0) {
    return (
      <section className="card">
        <EmptyState
          icon={<Search className="size-4" aria-hidden />}
          title="No cranes match these filters"
          description="Widen the capacity or clear the location filters, then search again."
        />
      </section>
    );
  }
  return (
    <div className="space-y-5">
      {data.groups.map((group) => (
        <section key={group.vendorId} className="card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{group.vendorName}</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {group.companySize ? `${group.companySize} · ` : ""}
                {group.fleetSize} crane{group.fleetSize === 1 ? "" : "s"} · nearest{" "}
                {formatDistance(group.nearestKm, group.distanceApproximate)}
              </p>
            </div>
            <Link
              to="/app/vendors/$vendorId"
              params={{ vendorId: group.vendorId }}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              Vendor detail
            </Link>
          </div>
          <ul className="divide-y divide-slate-100 px-4">
            {group.cranes.map((crane) => (
              <CraneRow key={crane.craneId} crane={crane} />
            ))}
          </ul>
        </section>
      ))}

      {data.unverified.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Location unverified</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              These cranes have no stored coordinates, so they cannot be distance-sorted.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 px-4">
            {data.unverified.map((crane) => (
              <CraneRow key={crane.craneId} crane={crane} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function FlatView({ data }: { data: ResultData }) {
  const cranes = [...data.groups.flatMap((g) => g.cranes), ...data.unverified];
  if (cranes.length === 0) {
    return (
      <section className="card">
        <EmptyState
          icon={<Search className="size-4" aria-hidden />}
          title="No cranes match these filters"
          description="Widen the capacity or clear the location filters, then search again."
        />
      </section>
    );
  }
  return (
    <section className="card overflow-hidden">
      <Table>
        <THead>
          <tr>
            <TH>Vendor</TH>
            <TH>Crane</TH>
            <TH align="right">Capacity</TH>
            <TH>Location</TH>
            <TH>Status</TH>
            <TH>Distance</TH>
            <TH />
          </tr>
        </THead>
        <TBody>
          {cranes.map((crane) => (
            <TR key={crane.craneId}>
              <TD>{crane.vendorName}</TD>
              <TD>
                <span className="font-mono text-xs font-medium text-slate-700">
                  {crane.serialRegistrationNo}
                </span>
                <p className="text-[11px] text-slate-500">
                  {crane.typeOfCraneName} · {crane.make} {crane.model} · {crane.yom}
                </p>
              </TD>
              <TD align="right" className="tabular-nums">
                {crane.capacityT} t
              </TD>
              <TD>
                {crane.currentLocation}
                <p className="text-[11px] text-slate-500">{crane.stateName}</p>
              </TD>
              <TD>
                <StatusBadge status={crane.currentStatus} />
              </TD>
              <TD className="whitespace-nowrap text-xs">
                {formatDistance(crane.distanceKm, crane.distanceApproximate)}
              </TD>
              <TD align="right">
                <Link
                  to="/app/cranes/$craneId"
                  params={{ craneId: crane.craneId }}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  Open
                </Link>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}


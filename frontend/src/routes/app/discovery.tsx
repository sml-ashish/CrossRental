import { useState } from "react";
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
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Field, Select, TextInput } from "@/components/ui/form";

/**
 * Manual vendor discovery (P4, BPD 6.8 / 5.9).
 *
 * A browse across every approved vendor's fleet with no enquiry in view. There
 * is no SML set to merge here — SML has no fleet (open item 2) — so every row is
 * a vendor crane. The map plots the stored coordinates only: geocoding is a stub
 * today (open item 13), so there are no tiles and no live positions.
 */

type ViewMode = "grouped" | "flat" | "map";

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
  ownershipType: "" | "SML" | "VENDOR";
  availability: DiscoveryAvailability | "";
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
  ownershipType: "",
  availability: "",
};

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
  if (filters.ownershipType) query.ownershipType = filters.ownershipType;
  if (filters.availability) query.availability = filters.availability;
  return query;
}

export function DiscoveryPage() {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [committed, setCommitted] = useState<FilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<ViewMode>("grouped");

  const facets = useQuery({ queryKey: ["discovery", "facets"], queryFn: discoveryFacets });
  const results = useQuery({
    queryKey: ["discovery", "search", committed],
    queryFn: () => searchDiscovery(toQuery(committed)),
  });

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Vendor discovery</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Find cranes across approved vendors without an enquiry. Filter, then open a crane or a
            vendor to start sourcing.
          </p>
        </div>
        <Link to="/app/enquiries" className="btn-secondary px-3 py-2 text-sm">
          Start from an enquiry
        </Link>
      </div>

      <section className="card p-5">
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
          <Field label="Ownership" htmlFor="d-ownership">
            <Select
              id="d-ownership"
              value={filters.ownershipType}
              onChange={(v) => set("ownershipType", v as FilterState["ownershipType"])}
              placeholder="Any"
              options={(facets.data?.ownershipTypes ?? ["VENDOR"]).map((o) => ({
                value: o,
                label: o === "SML" ? "SML" : "Vendor",
              }))}
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
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            onClick={() => setCommitted(filters)}
          >
            <Search className="size-4" aria-hidden />
            Search
          </button>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setCommitted(EMPTY_FILTERS);
            }}
          >
            Clear
          </button>
          <div className="ml-auto flex rounded-md border border-slate-200 text-xs" role="group" aria-label="View">
            {(["grouped", "flat", "map"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`px-2.5 py-1.5 capitalize ${
                  view === mode ? "bg-slate-100 font-medium text-slate-800" : "text-slate-500"
                } ${mode !== "map" ? "border-r border-slate-200" : ""}`}
                onClick={() => setView(mode)}
              >
                {mode === "map" ? "Map (stub)" : mode}
              </button>
            ))}
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
        <>
          <p className="text-sm text-slate-500">
            {results.data.totalMatched} crane{results.data.totalMatched === 1 ? "" : "s"} matched
            {results.data.distancesAvailable
              ? " · distances are straight-line estimates from the geocoding stub"
              : " · give a site pin to sort by distance"}
          </p>

          {view === "grouped" ? <GroupedView data={results.data} /> : null}
          {view === "flat" ? <FlatView data={results.data} /> : null}
          {view === "map" ? <MapStub data={results.data} /> : null}
        </>
      )}
    </div>
  );
}

type ResultData = Awaited<ReturnType<typeof searchDiscovery>>;

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
      <section className="card p-5">
        <p className="text-sm text-slate-500">No cranes match these filters.</p>
      </section>
    );
  }
  return (
    <div className="space-y-5">
      {data.groups.map((group) => (
        <section key={group.vendorId} className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
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
          <ul className="mt-3 divide-y divide-slate-100">
            {group.cranes.map((crane) => (
              <CraneRow key={crane.craneId} crane={crane} />
            ))}
          </ul>
        </section>
      ))}

      {data.unverified.length > 0 ? (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-slate-900">Location unverified</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            These cranes have no stored coordinates, so they cannot be distance-sorted.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
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
      <section className="card p-5">
        <p className="text-sm text-slate-500">No cranes match these filters.</p>
      </section>
    );
  }
  return (
    <section className="card overflow-x-auto p-5">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3 font-medium">Vendor</th>
            <th className="py-2 pr-3 font-medium">Crane</th>
            <th className="py-2 pr-3 font-medium">Capacity</th>
            <th className="py-2 pr-3 font-medium">Location</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Distance</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cranes.map((crane) => (
            <tr key={crane.craneId}>
              <td className="py-2.5 pr-3 text-slate-700">{crane.vendorName}</td>
              <td className="py-2.5 pr-3">
                <span className="font-mono text-xs text-slate-600">
                  {crane.serialRegistrationNo}
                </span>
                <p className="text-xs text-slate-500">
                  {crane.typeOfCraneName} · {crane.make} {crane.model} · {crane.yom}
                </p>
              </td>
              <td className="py-2.5 pr-3 text-slate-700">{crane.capacityT} t</td>
              <td className="py-2.5 pr-3 text-slate-700">
                {crane.currentLocation}
                <p className="text-xs text-slate-500">{crane.stateName}</p>
              </td>
              <td className="py-2.5 pr-3">
                <StatusBadge status={crane.currentStatus} />
              </td>
              <td className="py-2.5 pr-3 text-slate-700">
                {formatDistance(crane.distanceKm, crane.distanceApproximate)}
              </td>
              <td className="py-2.5">
                <Link
                  to="/app/cranes/$craneId"
                  params={{ craneId: crane.craneId }}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * A plot of the stored coordinates on a plain SVG. Deliberately tile-less: the
 * geocoding/mapping provider is on hold (open item 13), so this draws the
 * India bounding box the database already enforces and nothing it does not have.
 */
function MapStub({ data }: { data: ResultData }) {
  const LAT_MIN = 6;
  const LAT_MAX = 38;
  const LNG_MIN = 68;
  const LNG_MAX = 98;

  const points = [
    ...data.groups.flatMap((g) => g.cranes),
    ...data.unverified,
  ].filter(
    (crane): crane is DiscoveryCrane & { latitude: number; longitude: number } =>
      crane.latitude !== null && crane.longitude !== null,
  );

  const x = (lng: number) => ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * 100;
  const y = (lat: number) => ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * 100;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-slate-900">Map</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Stored coordinates only — no tiles and no live positions while the mapping provider is on
        hold (open item 13). {points.length} of {data.totalMatched} cranes have coordinates.
      </p>
      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        <svg viewBox="0 0 100 100" className="h-96 w-full" role="img" aria-label="Crane locations">
          <rect x="0" y="0" width="100" height="100" fill="#f8fafc" />
          {[0, 25, 50, 75, 100].map((line) => (
            <g key={line}>
              <line x1={line} y1="0" x2={line} y2="100" stroke="#e2e8f0" strokeWidth="0.2" />
              <line x1="0" y1={line} x2="100" y2={line} stroke="#e2e8f0" strokeWidth="0.2" />
            </g>
          ))}
          {points.map((crane) => (
            <circle
              key={crane.craneId}
              cx={x(crane.longitude)}
              cy={y(crane.latitude)}
              r="1.1"
              fill="#2563eb"
            >
              <title>
                {crane.vendorName} · {crane.serialRegistrationNo} · {crane.currentLocation}
              </title>
            </circle>
          ))}
        </svg>
      </div>
    </section>
  );
}

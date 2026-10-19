import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { getCraneProfile } from "@/lib/craneProfile";
import { CRANE_STATUS_LABELS, type CraneStatus } from "@/lib/fleet";
import { DAY_STATE_LABELS, DAY_STATE_TONES, type CalendarDayState } from "@/lib/calendar";
import { formatDate } from "@/lib/enquiries";
import { formatInr } from "@/lib/quotations";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ReadOnlyValue, Section } from "@/components/ui/form";

/**
 * Crane detail (P4, BPD 6.11), internal only.
 *
 * The fleet read already carries the crane's own fields; this adds the booking
 * calendar, the maintenance flags, the transport-cost assumption behind a
 * mobilisation estimate and the next date the crane is free. Back-links point to
 * where the reader came from — discovery or the vendor's fleet.
 */

export function CraneDetailPage() {
  const { craneId } = useParams({ from: "/app/cranes/$craneId" });

  const profile = useQuery({
    queryKey: ["crane-profile", craneId],
    queryFn: () => getCraneProfile(craneId),
  });

  if (profile.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (profile.isError) {
    return <Alert tone="error">Could not load that crane.</Alert>;
  }

  const { crane, calendar, maintenanceFlags, transportAssumptions, nextAvailableDate, reservations } =
    profile.data.profile;
  const days = calendar.cranes[0]?.days ?? [];

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/app/discovery"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Discovery
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold text-slate-900">
            {crane.serialRegistrationNo}
          </h1>
          <StatusBadge status={crane.currentStatus} />
          <Badge tone={crane.ownershipType === "SML" ? "purple" : "neutral"}>
            {crane.ownershipType === "SML" ? "SML owned" : "Vendor owned"}
          </Badge>
          {!crane.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
          {crane.approvalStatus === "PENDING" ? <Badge tone="amber">Awaiting approval</Badge> : null}
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          {crane.vendorName ? (
            <Link
              to="/app/vendors/$vendorId"
              params={{ vendorId: crane.vendorId }}
              className="text-brand-700 hover:underline"
            >
              {crane.vendorName}
            </Link>
          ) : (
            "The vendor"
          )}{" "}
          · {crane.typeOfCrane?.name ?? crane.typeOfCraneCode} · {crane.capacityT} t
        </p>
      </div>

      {maintenanceFlags.length > 0 ? (
        <Alert tone="info" title="Flags">
          <ul className="list-disc space-y-0.5 pl-4">
            {maintenanceFlags.map((flag) => (
              <li key={flag.code}>
                {flag.label}
                {flag.detail ? ` — ${flag.detail}` : ""}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Section title="Identity and specification">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue label="Crane ID" value={crane.id} mono />
          <ReadOnlyValue label="Type" value={crane.typeOfCrane?.name ?? crane.typeOfCraneCode} />
          <ReadOnlyValue label="Capacity" value={`${crane.capacityT} t`} />
          <ReadOnlyValue label="Make" value={crane.make} />
          <ReadOnlyValue label="Model" value={crane.model} />
          <ReadOnlyValue label="Year of manufacture" value={String(crane.yom)} />
          <ReadOnlyValue
            label="Main boom"
            value={crane.mainBoomM !== null ? `${crane.mainBoomM} m` : ""}
          />
          <ReadOnlyValue
            label="Fixed jib"
            value={crane.fixedJibM !== null ? `${crane.fixedJibM} m` : ""}
          />
          <ReadOnlyValue
            label="Luffing jib"
            value={crane.luffingJibM !== null ? `${crane.luffingJibM} m` : ""}
          />
          <ReadOnlyValue
            label="Wind jib"
            value={crane.windJibM !== null ? `${crane.windJibM} m` : ""}
          />
          <ReadOnlyValue
            label="Coordinates"
            value={
              crane.latitude !== null && crane.longitude !== null
                ? `${crane.latitude}, ${crane.longitude}`
                : ""
            }
            mono
          />
          <ReadOnlyValue
            label="Location source"
            value={crane.coordinateSource ?? ""}
          />
        </dl>
      </Section>

      <Section title="Location and availability">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue label="Current location" value={crane.currentLocation} />
          <ReadOnlyValue label="State" value={crane.state?.name ?? crane.stateCode} />
          <ReadOnlyValue label="Status" value={CRANE_STATUS_LABELS[crane.currentStatus as CraneStatus] ?? crane.currentStatus} />
          <ReadOnlyValue
            label="Available from"
            value={crane.availableFrom ? formatDate(crane.availableFrom) : ""}
          />
          <ReadOnlyValue
            label="Expected ready"
            value={crane.expectedReadyDate ? formatDate(crane.expectedReadyDate) : ""}
          />
          <ReadOnlyValue
            label="Next available"
            value={nextAvailableDate ? formatDate(nextAvailableDate) : "No availability recorded"}
          />
          <ReadOnlyValue
            label="Data confirmed"
            value={`${formatDate(crane.statusUpdatedAt)} · ${crane.freshness.daysSinceUpdate} day(s) ago`}
          />
        </dl>
      </Section>

      <Section
        title="Transport cost assumption"
        description="The estimate behind a mobilisation figure; the same rate table the recommendation engine uses."
      >
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue
            label="Rate per km"
            value={transportAssumptions.ratePerKm === null ? "" : formatInr(transportAssumptions.ratePerKm)}
          />
          <div className="sm:col-span-2">
            <ReadOnlyValue label="Basis" value={transportAssumptions.note} />
          </div>
        </dl>
      </Section>

      {reservations.length > 0 ? (
        <Section title="Reservations">
          <ul className="divide-y divide-slate-100">
            {reservations.map((reservation) => (
              <li key={reservation.id} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    {reservation.type === "BOOKED" ? "Booked" : "Blocked"}
                    {reservation.badge ? ` · ${reservation.badge}` : ""}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDate(reservation.startDate)} → {formatDate(reservation.endDate)}
                  </p>
                </div>
                <Badge tone={reservation.type === "BOOKED" ? "blue" : "amber"}>
                  {reservation.status}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Booking calendar (next 90 days)">
        {days.length === 0 ? (
          <p className="text-sm text-slate-500">No calendar days to show.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {days.map((day) => (
                <span
                  key={day.date}
                  title={`${day.date}: ${DAY_STATE_LABELS[day.state as CalendarDayState] ?? day.state}`}
                  className={`inline-block size-5 rounded-sm border border-slate-200 ${
                    DAY_STATE_TONES[day.state as CalendarDayState] ?? "bg-white"
                  }`}
                />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
              {(Object.keys(DAY_STATE_LABELS) as CalendarDayState[]).map((state) => (
                <span key={state} className="inline-flex items-center gap-1.5">
                  <span
                    className={`inline-block size-3 rounded-sm border border-slate-200 ${DAY_STATE_TONES[state]}`}
                    aria-hidden
                  />
                  {DAY_STATE_LABELS[state]}
                </span>
              ))}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

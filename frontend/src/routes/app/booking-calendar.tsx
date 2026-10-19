import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Field, TextInput, Select } from "@/components/ui/form";
import {
  DAY_STATE_LABELS,
  DAY_STATE_TONES,
  getBookingCalendar,
  type CalendarDayState,
  type CalendarOwnershipType,
} from "@/lib/calendar";

/**
 * The booking calendar (P2, brief 6.17 / BPD 6.17).
 *
 * One row per crane — SML's fleet and vendor cranes on the same grid, because
 * this is an internal planning surface — and one column per day. A day answers
 * exactly one question, "what is this crane doing", and reservations win: a
 * booking reads RESERVED or HIRED before the crane's own maintenance status is
 * consulted. The state of a day is derived by the server; this screen only
 * paints it.
 *
 * The window is capped server-side at 92 days (validation), so the picker here
 * defaults to 30 and never offers an unbounded range.
 */

const DAY_MS = 86_400_000;

const STATE_LABELS = DAY_STATE_LABELS;

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

/** A UTC date-only string for each day in [from, to], inclusive. */
function dayKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (cursor <= end && keys.length < 92) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return keys;
}

const STATE_TONE_KEYS: Record<CalendarDayState, string> = DAY_STATE_TONES;

export function BookingCalendarPage() {
  const [from, setFrom] = useState(() => isoDaysFromToday(0));
  const [to, setTo] = useState(() => isoDaysFromToday(29));
  const [ownershipType, setOwnershipType] = useState<"" | CalendarOwnershipType>("");
  const [craneType, setCraneType] = useState("");

  const calendar = useQuery({
    queryKey: ["booking-calendar", from, to, ownershipType, craneType],
    queryFn: () =>
      getBookingCalendar({
        from,
        to,
        ownershipType: ownershipType === "" ? undefined : ownershipType,
        craneType: craneType.trim() === "" ? undefined : craneType.trim(),
      }),
  });

  const days = useMemo(() => dayKeys(from, to), [from, to]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Booking calendar</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Free, reserved, hired, blocked or under maintenance, for every crane in the window.
        </p>
      </div>

      <section className="card p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="cal-from">
            <TextInput id="cal-from" type="date" value={from} onChange={setFrom} />
          </Field>
          <Field label="To" htmlFor="cal-to">
            <TextInput id="cal-to" type="date" value={to} onChange={setTo} />
          </Field>
          <Field label="Ownership" htmlFor="cal-ownership">
            <Select
              id="cal-ownership"
              value={ownershipType}
              onChange={(value) => setOwnershipType(value as "" | CalendarOwnershipType)}
              placeholder="All"
              options={[
                { value: "VENDOR", label: "Vendor" },
                { value: "SML", label: "SML" },
              ]}
            />
          </Field>
          <Field label="Crane type" htmlFor="cal-type" hint="Code, e.g. CRAWLER">
            <TextInput
              id="cal-type"
              value={craneType}
              onChange={setCraneType}
              placeholder="All"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          {(Object.keys(STATE_LABELS) as CalendarDayState[]).map((state) => (
            <span key={state} className="inline-flex items-center gap-1.5">
              <span
                className={`inline-block size-3 rounded-sm border border-slate-200 ${STATE_TONE_KEYS[state]}`}
                aria-hidden
              />
              {STATE_LABELS[state]}
            </span>
          ))}
        </div>
      </section>

      {calendar.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : calendar.isError ? (
        <Alert tone="error">Could not load the calendar.</Alert>
      ) : (
        <section className="card overflow-x-auto p-5">
          {calendar.data.calendar.cranes.length === 0 ? (
            <p className="text-sm text-slate-500">No cranes match these filters.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white py-2 pr-3 text-left font-medium text-slate-700">
                    Crane
                  </th>
                  {days.map((day) => (
                    <th
                      key={day}
                      className="px-0.5 pb-2 text-center font-medium text-slate-500"
                      title={day}
                    >
                      {Number(day.slice(8, 10))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calendar.data.calendar.cranes.map((crane) => (
                  <tr key={crane.craneId} className="border-t border-slate-100">
                    <td className="sticky left-0 bg-white py-1.5 pr-3 whitespace-nowrap">
                      <span className="text-sm font-medium text-slate-800">
                        {crane.craneLabel}
                      </span>
                      <span className="ml-1.5 text-xs text-slate-500">
                        {crane.craneTypeName} {crane.capacityT} t ·{" "}
                        {crane.ownershipType === "SML" ? "SML" : crane.vendorName} ·{" "}
                        {crane.stateCode}
                      </span>
                    </td>
                    {crane.days.map((day) => (
                      <td key={day.date} className="px-0.5 py-1.5">
                        <div
                          className={`mx-auto size-5 rounded-sm border border-slate-200 ${STATE_TONE_KEYS[day.state]}`}
                          title={`${day.date}: ${STATE_LABELS[day.state]}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

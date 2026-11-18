import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Field, Select, TextInput } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { todayKey } from "@/lib/availability";
import {
  fetchReferenceData,
  isBusyStatus,
  isSystemLocked,
  quickUpdateCrane,
  type Crane,
  type VendorCraneStatus,
} from "@/lib/fleet";

/**
 * Mid-quote location fix (the "we don't know where this crane is" case).
 *
 * A crane can be perfectly quotable and still have no city, state or map pin.
 * Asking the vendor to leave the RFQ and find it on My Fleet is how that data
 * stays missing, so the fix lives beside the crane picker and goes through the
 * same `PATCH /cranes/:id/status-location` endpoint as the fleet screen. The
 * server still owns status rules, geocoding and the audit entry.
 *
 * Only location fields are edited here. Status and its availability date are
 * carried across unchanged, because this form is not a second status editor.
 */
export function craneNeedsLocation(crane: Crane): boolean {
  if (isSystemLocked(crane)) return false;
  return (
    !crane.currentLocation?.trim() ||
    !crane.stateCode?.trim() ||
    crane.locationUnverified
  );
}

export function CraneLocationFix({ crane }: { crane: Crane }) {
  const queryClient = useQueryClient();
  const reference = useQuery({
    queryKey: ["fleet", "reference-data"],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,
  });

  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(crane.currentLocation ?? "");
  const [stateCode, setStateCode] = useState(crane.stateCode ?? "");
  const [pincode, setPincode] = useState(crane.pincode ?? "");

  // The quick-update schema requires busy cranes to carry an availability date
  // that is today or later. A stale crane often has a date in the past; carrying
  // it across verbatim would make a pure location fix fail for a reason the
  // vendor cannot see here. Refresh it to today and say so in the form.
  const storedFrom = crane.availableFrom?.slice(0, 10) ?? "";
  const refreshAvailability =
    isBusyStatus(crane.currentStatus) && (!storedFrom || storedFrom < todayKey());
  const availabilityDate = refreshAvailability
    ? todayKey()
    : crane.availableFrom ?? null;

  const update = useMutation({
    mutationFn: () =>
      quickUpdateCrane(crane.id, {
        currentStatus: crane.currentStatus as VendorCraneStatus,
        currentLocation,
        stateCode,
        pincode: pincode || null,
        // Carry the status fields across untouched: the quick-update schema
        // validates the whole status/location pair, so omitting them would
        // clear a date the vendor never edited.
        availableFrom: availabilityDate,
        expectedReadyDate: crane.expectedReadyDate ?? null,
      }),
    onSuccess: () => {
      setSaved(true);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["cranes"] });
    },
  });

  const error = update.error as ApiError | null;
  const canSave = currentLocation.trim().length >= 3 && stateCode !== "";
  const states = (reference.data?.states ?? []).map((state) => ({
    value: state.code,
    label: state.name,
  }));

  if (saved) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px] text-emerald-800">
        Location updated for this crane. The quote will use the details you just saved.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium text-amber-900">
            SML needs this crane&apos;s location
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            Its city, state or map pin is missing. You can add them now, then continue with the quote.
          </p>
          {refreshAvailability ? (
            <p className="mt-0.5 text-xs text-amber-800">
              Its saved availability date has passed, so it will be refreshed to today when you save.
            </p>
          ) : null}
        </div>
        {!open ? (
          <button
            type="button"
            className="btn-secondary min-h-9 px-3 py-1.5 text-xs"
            onClick={() => setOpen(true)}
          >
            Update location
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 space-y-3">
          {error ? <Alert title="Could not save the location">{error.message}</Alert> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label="City / current location"
              htmlFor="location-fix-city"
              required
              error={error?.fieldError("currentLocation")}
            >
              <TextInput
                id="location-fix-city"
                value={currentLocation}
                onChange={setCurrentLocation}
                placeholder="e.g. Ahmedabad Yard"
                invalid={Boolean(error?.fieldError("currentLocation"))}
              />
            </Field>
            <Field
              label="State"
              htmlFor="location-fix-state"
              required
              error={error?.fieldError("stateCode")}
            >
              <Select
                id="location-fix-state"
                value={stateCode}
                onChange={setStateCode}
                options={states}
                placeholder="Select a state"
                invalid={Boolean(error?.fieldError("stateCode"))}
              />
            </Field>
            <Field
              label="Pincode (optional)"
              htmlFor="location-fix-pincode"
              error={error?.fieldError("pincode")}
            >
              <TextInput
                id="location-fix-pincode"
                value={pincode}
                onChange={setPincode}
                inputMode="numeric"
                placeholder="Six digits"
                invalid={Boolean(error?.fieldError("pincode"))}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary min-h-10 px-3 py-1.5 text-xs"
              disabled={!canSave || update.isPending}
              onClick={() => update.mutate()}
            >
              {update.isPending ? "Saving…" : "Save location"}
            </button>
            <button
              type="button"
              className="btn-secondary min-h-10 px-3 py-1.5 text-xs"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

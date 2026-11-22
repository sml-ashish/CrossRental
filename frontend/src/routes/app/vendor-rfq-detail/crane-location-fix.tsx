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
  previewLocationFromLink,
  quickUpdateCrane,
  type Crane,
  type VendorCraneStatus,
} from "@/lib/fleet";

/**
 * Mid-quote crane location card.
 *
 * Every quote now shows where SML will understand the crane to be, so the vendor
 * can confirm it or correct it before sending. When the location is missing or
 * unverified the card is amber and asks for it; when it is on file the card is
 * neutral and offers "Confirm location" / "Update location".
 *
 * Original purpose (the "we don't know where this crane is" case):
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
const PINCODE_RE = /^[1-9]\d{5}$/;

export function craneNeedsLocation(crane: Crane): boolean {
  if (isSystemLocked(crane)) return false;
  return (
    !crane.currentLocation?.trim() ||
    !crane.stateCode?.trim() ||
    // The pincode is compulsory: SML uses it to price distance and mobilisation.
    !PINCODE_RE.test(crane.pincode?.trim() ?? "") ||
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
  const [saved, setSaved] = useState<null | "confirmed" | "updated">(null);
  const [currentLocation, setCurrentLocation] = useState(crane.currentLocation ?? "");
  const [stateCode, setStateCode] = useState(crane.stateCode ?? "");
  const [pincode, setPincode] = useState(crane.pincode ?? "");
  // The pin is never shown to the vendor. It is only set when a Google Maps link
  // supplied it, and it is only sent when it did; typing an address by hand
  // leaves the pin to the server, so a stale pin is never saved against it.
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [mapsLink, setMapsLink] = useState("");
  const [linkNote, setLinkNote] = useState<{ text: string; failed: boolean } | null>(null);

  // Reads the pasted Google Maps link on the server and fills whatever it
  // knows. Values the link does not know are left exactly as the vendor typed.
  const fillFromLink = useMutation({
    mutationFn: () => previewLocationFromLink(mapsLink.trim()),
    onSuccess: ({ location }) => {
      if (location.currentLocation) setCurrentLocation(location.currentLocation);
      if (location.stateCode) setStateCode(location.stateCode);
      if (location.pincode) setPincode(location.pincode);
      if (location.latitude !== null && location.longitude !== null) {
        setPin({ latitude: location.latitude, longitude: location.longitude });
      }
      setLinkNote({
        text: location.note ?? "Filled from the link. Please check the details below.",
        failed: false,
      });
    },
    onError: (err: unknown) =>
      setLinkNote({
        text: err instanceof Error ? err.message : "That link could not be read.",
        failed: true,
      }),
  });

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

  const needsFix = craneNeedsLocation(crane);
  const locked = isSystemLocked(crane);
  // A location the vendor can confirm as it stands: city and state are on file,
  // and the pincode is either blank (the server stores that as "not given") or
  // well-formed. A malformed pincode would be rejected on re-save, and a missing
  // city or state leaves nothing to confirm, so those must be changed instead.
  const storedPincode = crane.pincode?.trim() ?? "";
  const hasDetails =
    Boolean(crane.currentLocation?.trim()) &&
    Boolean(crane.stateCode?.trim()) &&
    (storedPincode === "" || PINCODE_RE.test(storedPincode));
  const pincodeMissing = storedPincode === "";

  // `confirm` re-saves the values already on file so the crane's last-updated
  // date moves forward; `edit` saves what the vendor typed in the form.
  const update = useMutation({
    mutationFn: (kind: "confirm" | "edit") =>
      quickUpdateCrane(crane.id, {
        currentStatus: crane.currentStatus as VendorCraneStatus,
        currentLocation: kind === "confirm" ? (crane.currentLocation ?? "") : currentLocation,
        stateCode: kind === "confirm" ? (crane.stateCode ?? "") : stateCode,
        pincode: (kind === "confirm" ? crane.pincode ?? "" : pincode).trim() || null,
        ...(kind === "edit" && pin ? pin : {}),
        // Carry the status fields across untouched: the quick-update schema
        // validates the whole status/location pair, so omitting them would
        // clear a date the vendor never edited.
        availableFrom: availabilityDate,
        expectedReadyDate: crane.expectedReadyDate ?? null,
      }),
    onSuccess: (_data, kind) => {
      setSaved(kind === "confirm" ? "confirmed" : "updated");
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["cranes"] });
    },
  });

  const error = update.error as ApiError | null;
  const pincodeValid = PINCODE_RE.test(pincode.trim());
  const canSave = currentLocation.trim().length >= 3 && stateCode !== "" && pincodeValid;
  const states = (reference.data?.states ?? []).map((state) => ({
    value: state.code,
    label: state.name,
  }));

  const stateName =
    states.find((state) => state.value === (crane.stateCode ?? ""))?.label ?? crane.stateCode ?? "";
  const onFile = [crane.currentLocation?.trim(), stateName, crane.pincode?.trim()]
    .filter(Boolean)
    .join(", ");

  if (saved) {
    const shown = [currentLocation.trim(), states.find((s) => s.value === stateCode)?.label, pincode.trim()]
      .filter(Boolean)
      .join(", ");
    return (
      <div className="card mt-4 p-4">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          {saved === "confirmed" ? "Current location confirmed" : "Current location changed"}
        </p>
        <p className="mt-1 text-[15px] font-medium text-slate-900">{shown || onFile}</p>
        <p className="mt-1 text-sm text-slate-500">The quote will use these details.</p>
      </div>
    );
  }

  return (
    <div className="card mt-4">
      <div className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 sm:justify-start">
            <p className="text-sm font-medium text-slate-500">Crane current location</p>
            <p className="flex items-center gap-1.5 text-sm text-slate-600">
              <span
                className={`size-1.5 rounded-full ${needsFix ? "bg-amber-500" : "bg-emerald-500"}`}
                aria-hidden
              />
              {needsFix ? "Needs details" : locked ? "Managed by SML" : "On file"}
            </p>
          </div>
          <p className="mt-1 break-words text-[15px] font-medium text-slate-900">
            {onFile || "Not set yet"}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {needsFix
              ? hasDetails
                ? pincodeMissing
                  ? "The pincode is missing. Confirm this is where the crane is now, or change the location to add the pincode, before you send the quote."
                  : "We could not place this location on the map. Confirm it is where the crane is now, or change it, before you send the quote."
                : "The city, state or pincode is missing or not valid. Change the current location to fix it before you send the quote."
              : locked
                ? "This crane is on an active booking, so SML manages its location."
                : "Confirm this is where the crane is now and will be sent from, or change it if it has moved."}
          </p>
          {update.isError && !open ? (
            <p className="mt-1 text-sm text-red-600">{(update.error as ApiError).message}</p>
          ) : null}
          {refreshAvailability ? (
            <p className="mt-1 text-sm text-slate-500">
              Its saved availability date has passed, so it will be refreshed to today when you save.
            </p>
          ) : null}
        </div>

        {!open && !locked ? (
          <div className="flex flex-wrap gap-2">
            {hasDetails ? (
              <button
                type="button"
                className="btn-primary min-h-10 px-4 py-2 text-sm"
                disabled={update.isPending}
                onClick={() => update.mutate("confirm")}
              >
                {update.isPending ? "Saving…" : "Confirm current location"}
              </button>
            ) : null}
            <button
              type="button"
              className={`${hasDetails ? "btn-secondary" : "btn-primary"} min-h-10 px-4 py-2 text-sm`}
              disabled={update.isPending}
              onClick={() => setOpen(true)}
            >
              Change current location
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-ink-800 p-4">
          {error ? (
            <div className="mb-4">
              <Alert title="Could not save the location">{error.message}</Alert>
            </div>
          ) : null}

          <Field
            label="Google Maps link"
            htmlFor="location-fix-link"
            hint="Optional. Open the crane's spot in Google Maps, choose Share, and paste the link. We fill in the city, state and pincode."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1">
                <TextInput
                  id="location-fix-link"
                  value={mapsLink}
                  onChange={(value) => {
                    setMapsLink(value);
                    setLinkNote(null);
                  }}
                  placeholder="https://maps.app.goo.gl/…"
                />
              </div>
              <button
                type="button"
                className="btn-secondary shrink-0 px-4 py-2.5 text-sm"
                disabled={fillFromLink.isPending || mapsLink.trim() === ""}
                onClick={() => fillFromLink.mutate()}
              >
                {fillFromLink.isPending ? "Reading…" : "Fill from link"}
              </button>
            </div>
          </Field>
          {linkNote ? (
            <div className="mt-3">
              <Alert tone={linkNote.failed ? "error" : "info"}>{linkNote.text}</Alert>
            </div>
          ) : null}

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="City / location"
              htmlFor="location-fix-city"
              required
              error={error?.fieldError("currentLocation")}
            >
              <TextInput
                id="location-fix-city"
                value={currentLocation}
                onChange={setCurrentLocation}
                placeholder="e.g. Indore"
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
              label="Pincode"
              htmlFor="location-fix-pincode"
              required
              error={
                error?.fieldError("pincode") ??
                (pincode.trim() !== "" && !pincodeValid ? "Enter a valid six-digit pincode." : undefined)
              }
            >
              <TextInput
                id="location-fix-pincode"
                value={pincode}
                onChange={setPincode}
                inputMode="numeric"
                placeholder="6 digits"
                invalid={Boolean(error?.fieldError("pincode")) || (pincode.trim() !== "" && !pincodeValid)}
              />
            </Field>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary min-h-10 px-4 py-2 text-sm"
              disabled={!canSave || update.isPending}
              onClick={() => update.mutate("edit")}
            >
              {update.isPending ? "Saving…" : "Save current location"}
            </button>
            <button
              type="button"
              className="btn-secondary min-h-10 px-4 py-2 text-sm"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancel
            </button>
            {!canSave && !update.isPending ? (
              <span className="text-sm text-slate-500">
                {currentLocation.trim().length < 3 || stateCode === ""
                  ? "Add the city and state to save."
                  : "Enter a six-digit pincode to save."}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Mail, Send } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Field, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { confirmSitePin } from "@/lib/rfqs";
import { DEADLINE_ZONE_LABEL, formatDeadline } from "./datetime";

/**
 * The send bar: how many vendors are chosen, and the one button that sends.
 *
 * It is the only place that can send. It stays at the bottom of the screen
 * while the list scrolls, so the button never drifts away from the reason it is
 * disabled. RFQs go out by email only.
 */

export interface SelectedVendor {
  vendorId: string;
  vendorName: string;
  /** Cranes tagged for this vendor; 0 means the vendor may quote any crane. */
  craneCount?: number;
}

/** Confirms the job-site pin without touching the rest of the RFQ (brief 6.9). */
export function ConfirmPinCard({ rfqId, onDone }: { rfqId: string; onDone: () => void }) {
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  const confirm = useMutation({
    mutationFn: () => confirmSitePin(rfqId, Number(lat), Number(lng)),
    onSuccess: () => {
      setLat("");
      setLng("");
      onDone();
    },
  });

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-[15px] text-amber-700">
        The job site has no confirmed pin, so distances are hidden. Enter its coordinates to
        rank by distance.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          confirm.mutate();
        }}
      >
        <Field label="Latitude" htmlFor="pin-lat" className="w-32">
          <TextInput id="pin-lat" value={lat} onChange={setLat} inputMode="decimal" />
        </Field>
        <Field label="Longitude" htmlFor="pin-lng" className="w-32">
          <TextInput id="pin-lng" value={lng} onChange={setLng} inputMode="decimal" />
        </Field>
        <button
          type="submit"
          className="btn-secondary px-3 py-2 text-[15px]"
          disabled={confirm.isPending || lat === "" || lng === ""}
        >
          {confirm.isPending ? <Spinner /> : null}
          Confirm pin
        </button>
      </form>
      {confirm.isError ? (
        <div className="mt-2">
          <Alert title="Pin not saved">{(confirm.error as Error).message}</Alert>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The confirm step. Sending is irreversible in the vendor's inbox, so the last
 * click names the recipients and the deadline it promises.
 */
function SendConfirm({
  selected,
  deadline,
  contacted,
  pending,
  onCancel,
  onConfirm,
}: {
  selected: SelectedVendor[];
  deadline: string;
  contacted: string[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      // Sending is irreversible, so focus stays inside the dialog: Tab must not
      // walk back onto the page behind it.
      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === dialog.current)) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close confirmation"
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onCancel}
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-confirm-title"
        className="relative w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-4 shadow-2xl"
      >
        <h2 id="send-confirm-title" className="text-[17px] font-semibold text-slate-900">
          Send this RFQ to {selected.length} vendor{selected.length === 1 ? "" : "s"}?
        </h2>
        <p className="mt-1 text-[15px] text-slate-500">
          By email. Quotes are due {formatDeadline(deadline)} ({DEADLINE_ZONE_LABEL}).
        </p>

        <ul className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-ink-800">
          {selected.map((vendor) => (
            <li
              key={vendor.vendorId}
              className="border-b border-ink-800 px-3 py-2 text-[15px] text-slate-800 last:border-b-0"
            >
              {vendor.vendorName}
              <span className="ml-2 text-[13px] text-slate-500">
                {vendor.craneCount
                  ? `${vendor.craneCount} crane${vendor.craneCount === 1 ? "" : "s"} tagged`
                  : "any crane"}
              </span>
            </li>
          ))}
        </ul>

        {contacted.length > 0 ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[14px] text-amber-700">
            {contacted.join(", ")} {contacted.length === 1 ? "was" : "were"} already sent an RFQ
            for this enquiry line. Sending again will add a second email.
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary px-3 py-2 text-[15px]" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            className="btn-primary px-4 py-2 text-[15px]"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? <Spinner /> : <Send className="size-3.5" aria-hidden />}
            {pending ? "Sending…" : `Send to ${selected.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SendBar({
  selected,
  deadline,
  canSend,
  blockReason,
  pending,
  error,
  contacted,
  onClear,
  onSend,
}: {
  selected: SelectedVendor[];
  deadline: string;
  canSend: boolean;
  blockReason: string | null;
  pending: boolean;
  error: string | null;
  /** Names of selected vendors that were already sent this enquiry line. */
  contacted: string[];
  onClear: () => void;
  onSend: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const names = selected.map((vendor) => vendor.vendorName);

  return (
    <div className="sticky bottom-4 z-30">
      {error ? (
        <div className="mb-2">
          <Alert title="The RFQ was not sent">{error}</Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 shadow-xl">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold text-slate-900 tabular-nums">
            {selected.length === 0
              ? "No vendors selected"
              : `${selected.length} vendor${selected.length === 1 ? "" : "s"} selected`}
          </p>
          <p
            className={cn(
              "truncate text-[14px]",
              blockReason && selected.length > 0 ? "text-amber-600" : "text-slate-500",
            )}
            title={names.join(", ")}
          >
            {blockReason && selected.length > 0
              ? blockReason
              : selected.length === 0
                ? (blockReason ?? "Tick the cranes you want to send this RFQ to.")
                : names.join(", ")}
          </p>
        </div>

        <span className="inline-flex items-center gap-1.5 text-[14px] text-slate-500">
          <Mail className="size-4" aria-hidden />
          Email
        </span>

        {selected.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-md px-2 py-1 text-[14px] font-medium text-slate-500 transition-colors hover:text-white"
          >
            Clear
          </button>
        ) : null}

        <button
          type="button"
          className="btn-primary px-5 py-2.5 text-[16px]"
          onClick={() => setConfirming(true)}
          disabled={!canSend || pending}
        >
          {pending ? <Spinner /> : <Send className="size-4" aria-hidden />}
          {pending ? "Sending…" : "Send RFQ"}
        </button>
      </div>

      {confirming ? (
        <SendConfirm
          selected={selected}
          deadline={deadline}
          contacted={contacted}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onSend();
          }}
        />
      ) : null}
    </div>
  );
}

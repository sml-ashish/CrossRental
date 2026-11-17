import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Mail,
  MapPin,
  MessageCircle,
  Send,
  X,
  XCircle,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Field, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { SiteMap } from "@/components/site-map";
import { cn } from "@/lib/cn";
import { siteLabel } from "@/lib/format";
import { confirmSitePin, type CandidateGroup, type MessageChannel, type RfqDetail } from "@/lib/rfqs";
import { useMutation } from "@tanstack/react-query";
import { DEADLINE_ZONE_LABEL, formatDeadline, startDateLabel } from "./datetime";
import { selectionStats, shortDistance } from "./picker-model";

/**
 * The send rail: map, selection, channels, readiness and the one primary action.
 *
 * It is deliberately the only place that can send. The list is for choosing;
 * this column is for checking and committing, so the button never drifts away
 * from the reason it is disabled.
 */

export interface ChecklistItem {
  key: string;
  label: string;
  tone: "ok" | "warn" | "blocked";
  detail?: string;
}

/** Confirms the job-site pin without touching the rest of the RFQ (brief 6.9). */
export function ConfirmPinCard({
  rfqId,
  onDone,
  compact,
}: {
  rfqId: string;
  onDone: () => void;
  compact?: boolean;
}) {
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
    <div className={cn("rounded-lg border border-amber-500/30 bg-amber-500/5", compact ? "p-3" : "p-4")}>
      <p className="text-[15px] text-amber-700">
        The job site has no confirmed pin, so no distance can be shown for any crane.
        Enter the coordinates to switch the candidate list to a distance ranking.
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
 * The site map, or the pin-confirmation card that stands in for it.
 *
 * Candidate cranes carry no coordinates in the candidate payload, so the map
 * plots the site and names what the selection contains rather than inventing
 * crane pins. That is a data gap, not a drawing choice.
 */
export function SiteCard({
  rfq,
  selected,
  onPinConfirmed,
}: {
  rfq: RfqDetail;
  selected: CandidateGroup[];
  onPinConfirmed: () => void;
}) {
  const hasPin =
    !rfq.siteLocationUnverified && rfq.siteLatitude !== null && rfq.siteLongitude !== null;

  // The selection may lead with a vendor that has no crane distances (picked
  // from the approved list), so read the nearest of all of them, not the first.
  const nearest = selected.reduce<{ km: number; approximate: boolean } | null>(
    (best, group) => {
      if (group.nearestKm === null) return best;
      return best === null || group.nearestKm < best.km
        ? { km: group.nearestKm, approximate: group.distanceApproximate }
        : best;
    },
    null,
  );

  if (!hasPin) {
    return <ConfirmPinCard rfqId={rfq.id} onDone={onPinConfirmed} compact />;
  }

  return (
    <div className="space-y-2">
      <SiteMap
        latitude={rfq.siteLatitude as number}
        longitude={rfq.siteLongitude as number}
        label={`Job site map for ${siteLabel(rfq)}`}
        className="h-[220px] overflow-hidden rounded-lg border border-ink-800"
      />
      <div className="flex items-start gap-1.5 text-[14px] text-slate-500">
        <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />
        <p>
          {siteLabel(rfq)} ·{" "}
          {selected.length === 0
            ? "no vendors selected yet"
            : `${selected.length} vendor${selected.length === 1 ? "" : "s"} selected${
                nearest
                  ? `, nearest ${shortDistance(nearest.km, nearest.approximate)}`
                  : ""
              }`}
        </p>
      </div>
    </div>
  );
}

/**
 * What the send is committing to, in one block: how many vendors, how many
 * cranes stand behind them, how far away they are, and the two facts that need
 * a second look — a re-send, or a vendor beyond the far threshold.
 */
function InPlay({ selected, contacted }: { selected: CandidateGroup[]; contacted: string[] }) {
  const stats = selectionStats(selected);

  if (selected.length === 0) {
    return (
      <section aria-label="In play" className="border-t border-ink-800 pt-3">
        <p className="text-[15px] text-slate-500">Tick vendors in the list, or use a preset.</p>
      </section>
    );
  }

  return (
    <section aria-label="In play" className="border-t border-ink-800 pt-3">
      <p className="text-[17px] font-semibold text-slate-900 tabular-nums">
        {stats.vendors} vendor{stats.vendors === 1 ? "" : "s"} · {stats.cranes} crane
        {stats.cranes === 1 ? "" : "s"} in play
      </p>
      <ul className="mt-1 space-y-0.5">
        {selected.map((group) => (
          <li key={group.vendorId} className="text-[14px] text-slate-600">
            {group.vendorName}
            {stats.farNames.includes(group.vendorName) ? (
              <span className="text-slate-500"> · far from site</span>
            ) : null}
          </li>
        ))}
      </ul>
      {stats.nearestKm !== null ? (
        <p className="mt-1 text-[14px] text-slate-500 tabular-nums">
          Nearest {shortDistance(stats.nearestKm, stats.approximate)}
          {stats.farthestKm !== null && stats.farthestKm !== stats.nearestKm
            ? ` · Farthest ${shortDistance(stats.farthestKm, stats.approximate)}`
            : ""}
        </p>
      ) : null}
      {contacted.length > 0 || stats.farNames.length > 0 ? (
        <p className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[14px] text-amber-700">
          {contacted.length > 0 ? (
            <>
              Re-send: {contacted.join(", ")} already received an RFQ for this line.{" "}
            </>
          ) : null}
          {stats.farNames.length > 0 ? (
            <>Far from site: {stats.farNames.join(", ")}.</>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

/** A checklist row: tick, warning or blocker, always with words beside it. */
function ChecklistRow({ item }: { item: ChecklistItem }) {
  const Icon = item.tone === "ok" ? Check : item.tone === "warn" ? AlertTriangle : XCircle;
  return (
    <li className="flex items-start gap-2 py-1">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.tone === "ok"
            ? "text-emerald-500"
            : item.tone === "warn"
              ? "text-amber-500"
              : "text-red-500",
        )}
        aria-hidden
      />
      <span className="min-w-0 text-[15px] text-slate-600">
        {item.label}
        {item.detail ? <span className="text-slate-500"> — {item.detail}</span> : null}
      </span>
    </li>
  );
}

const CHANNELS: Array<{ value: MessageChannel; label: string; ready: string; Icon: typeof Mail }> = [
  {
    value: "EMAIL",
    label: "Email",
    ready: "Goes to each vendor's RFQ contacts.",
    Icon: Mail,
  },
  {
    value: "WHATSAPP",
    label: "WhatsApp",
    ready: "Uses the approved template and the contact mobile on file.",
    Icon: MessageCircle,
  },
];

function ChannelToggle({
  channel,
  active,
  disabled,
  disabledReason,
  onToggle,
}: {
  channel: (typeof CHANNELS)[number];
  active: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onToggle: () => void;
}) {
  const { Icon } = channel;
  return (
    <div>
      <button
        type="button"
        aria-pressed={active}
        disabled={disabled}
        onClick={onToggle}
        title={disabledReason ?? undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[15px] font-medium transition-colors",
          disabled && "cursor-not-allowed opacity-50",
          active
            ? "border-accent-500/60 bg-accent-500/10 text-slate-900"
            : "border-ink-800 text-slate-600 hover:border-ink-700 hover:text-white",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {channel.label}
        {active ? <Check className="ml-auto size-3.5 text-accent-400" aria-hidden /> : null}
      </button>
      <p className="mt-1 text-[14px] leading-snug text-slate-500">
        {disabled && disabledReason ? disabledReason : channel.ready}
      </p>
    </div>
  );
}

/** What the vendor will actually receive, built only from vendor-facing fields. */
function VendorPreview({ rfq }: { rfq: RfqDetail }) {
  const [open, setOpen] = useState(false);

  const terms = [
    ["Payment terms", rfq.paymentTerms],
    ["Mobilisation & demobilisation", rfq.mobilisationTerms],
    ["OT charges", rfq.otCharges],
    ["Breakdown charges", rfq.breakdownTerms],
    ["Diesel scope", rfq.dieselScope],
    ["Working hours / shift", rfq.workingHoursShift],
    ["Accommodation & conveyance", rfq.accommodationConveyance],
    ["Insurance", rfq.insuranceTerms],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 py-1 text-left text-[14px] font-medium tracking-[0.08em] text-slate-500 uppercase transition-colors hover:text-slate-800"
      >
        What vendors will see
        <ChevronDown
          className={cn("size-3.5 transition-transform duration-150", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-lg border border-ink-800 bg-ink-900 p-3">
          <dl className="space-y-1">
            {[
              [
                "Crane",
                `${rfq.craneTypeRef?.name ?? rfq.craneType} · ${rfq.capacityT} t ${
                  rfq.capacityRule === "EXACT" ? "exact" : "or more"
                }`,
              ],
              ["Quantity", String(rfq.quantity)],
              [
                "Site",
                siteLabel(rfq),
              ],
              [
                "Start",
                rfq.startDateTbc ? "To be confirmed" : startDateLabel(rfq.requiredStartDate),
              ],
              [
                "Duration",
                `${rfq.durationValue} ${rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}`,
              ],
              ["Quote by", formatDeadline(rfq.submissionDeadline)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 text-[15px]">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-right text-slate-700">{value}</dd>
              </div>
            ))}
          </dl>
          {terms.length > 0 ? (
            <div className="border-t border-ink-800 pt-2">
              <p className="text-[14px] text-slate-500">Key commercial terms</p>
              <dl className="mt-1 space-y-1">
                {terms.map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 text-[15px]">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="text-right text-slate-700">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {rfq.smlContactName || rfq.smlContactMobile || rfq.smlContactEmail ? (
            <div className="border-t border-ink-800 pt-2 text-[15px]">
              <p className="text-[14px] text-slate-500">SML contact</p>
              <p className="text-slate-700">
                {[rfq.smlContactName, rfq.smlContactMobile, rfq.smlContactEmail]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          ) : null}
          <p className="border-t border-ink-800 pt-2 text-[14px] text-slate-500">
            Customer name, site address and budget are not shared.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The confirm step. Sending is irreversible in the vendor's inbox, so the last
 * click names the recipients, the channels and the deadline it promises.
 */
function SendConfirm({
  selected,
  channels,
  deadline,
  contacted,
  pending,
  onCancel,
  onConfirm,
}: {
  selected: CandidateGroup[];
  channels: MessageChannel[];
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

  const channelText = channels
    .map((channel) => (channel === "EMAIL" ? "Email" : "WhatsApp"))
    .join(" and ");

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
          Through {channelText}. The deadline in the message is {formatDeadline(deadline)} (
          {DEADLINE_ZONE_LABEL}).
        </p>

        <ul className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-ink-800">
          {selected.map((group) => (
            <li
              key={group.vendorId}
              className="flex items-baseline justify-between gap-3 border-b border-ink-800 px-3 py-2 text-[15px] last:border-b-0"
            >
              <span className="text-slate-800">{group.vendorName}</span>
              <span className="text-slate-500 tabular-nums">
                {shortDistance(group.nearestKm, group.distanceApproximate)}
              </span>
            </li>
          ))}
        </ul>

        {contacted.length > 0 ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[14px] text-amber-700">
            {contacted.join(", ")} {contacted.length === 1 ? "was" : "were"} already sent an RFQ
            for this enquiry line. Sending again will add a second message.
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

export function SendRail({
  rfq,
  selected,
  channels,
  onToggleChannel,
  whatsappBlocked,
  checklist,
  canSend,
  blockReason,
  pending,
  error,
  contacted,
  onSend,
  onPinConfirmed,
  mobileOpen,
  onCloseMobile,
}: {
  rfq: RfqDetail;
  selected: CandidateGroup[];
  channels: MessageChannel[];
  onToggleChannel: (channel: MessageChannel) => void;
  whatsappBlocked: string | null;
  checklist: ChecklistItem[];
  canSend: boolean;
  blockReason: string | null;
  pending: boolean;
  error: string | null;
  contacted: string[];
  onSend: () => void;
  onPinConfirmed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  return (
    <div
      id="send-rail"
      {...(mobileOpen
        ? { role: "dialog", "aria-modal": true, "aria-label": "Review and send" }
        : {})}
      className={cn(
        "flex flex-col border-ink-800 bg-slate-50",
        // Below `lg` the rail becomes a bottom sheet, opened from the sticky bar.
        mobileOpen
          ? "fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] rounded-t-xl border-t px-4 pt-3 pb-4 shadow-2xl"
          : "hidden",
        "min-[1100px]:sticky min-[1100px]:top-[92px] min-[1100px]:z-0 min-[1100px]:flex min-[1100px]:max-h-[calc(100dvh-108px)] min-[1100px]:rounded-none min-[1100px]:border-0 min-[1100px]:px-0 min-[1100px]:pt-0 min-[1100px]:pb-0 min-[1100px]:shadow-none",
      )}
    >
      <div className="flex items-center justify-between gap-2 pb-2 min-[1100px]:hidden">
        <p className="text-[15px] font-medium text-slate-800">Review and send</p>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close send panel"
          className="rounded-md p-1 text-slate-500 hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto min-[1100px]:pr-1">
        <SiteCard rfq={rfq} selected={selected} onPinConfirmed={onPinConfirmed} />

        <InPlay selected={selected} contacted={contacted} />

        <section aria-label="Send through" className="border-t border-ink-800 pt-3">
          <p className="text-[14px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Send through
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 min-[1100px]:grid-cols-1">
            {CHANNELS.map((channel) => (
              <ChannelToggle
                key={channel.value}
                channel={channel}
                active={channels.includes(channel.value)}
                disabled={channel.value === "WHATSAPP" && Boolean(whatsappBlocked)}
                disabledReason={whatsappBlocked}
                onToggle={() => onToggleChannel(channel.value)}
              />
            ))}
          </div>
        </section>

        <section aria-label="Readiness" className="border-t border-ink-800 pt-3">
          <p className="text-[14px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Before you send
          </p>
          <ul className="mt-1.5">
            {checklist.map((item) => (
              <ChecklistRow key={item.key} item={item} />
            ))}
          </ul>
        </section>

        <div className="border-t border-ink-800 pt-3">
          <VendorPreview rfq={rfq} />
        </div>
      </div>

      <div className="mt-3 shrink-0 border-t border-ink-800 pt-3">
        {error ? (
          <div className="mb-2">
            <Alert title="The RFQ was not sent">{error}</Alert>
          </div>
        ) : null}
        <button
          type="button"
          className="btn-primary w-full justify-center px-4 py-2.5 text-[16px]"
          onClick={() => setConfirming(true)}
          disabled={!canSend || pending}
        >
          {pending ? <Spinner /> : <Send className="size-4" aria-hidden />}
          {pending
            ? "Sending…"
            : `Send to ${selected.length} vendor${selected.length === 1 ? "" : "s"}`}
        </button>
        {blockReason ? (
          <p className="mt-1.5 text-[14px] text-slate-500">{blockReason}</p>
        ) : (
          <p className="mt-1.5 text-[14px] text-slate-500">
            Every selected vendor is attempted on every chosen channel.
          </p>
        )}
      </div>

      {confirming ? (
        <SendConfirm
          selected={selected}
          channels={channels}
          deadline={rfq.submissionDeadline}
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


import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MapPin, Send } from "lucide-react";
import {
  ROLLUPE_STATUS_LABELS,
  awardQuotation,
  cancelRfq,
  confirmSitePin,
  extendDeadline,
  formatDistance,
  getCandidates,
  getRfq,
  listApprovedVendors,
  remindRfq,
  sendRfq,
  type CandidateCrane,
  type CandidateGroup,
  type ReceivedQuotation,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Field, ReadOnlyValue, Section, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import {
  DeliveryBadge,
  deadlineCountdown,
  formatCalendarDate,
  formatDate,
  formatDateTime,
} from "@/routes/app/rfqs";
import { useAuth } from "@/lib/auth";
import { VendorRfqDetailPage } from "@/routes/app/vendor-rfq-detail";

/**
 * One RFQ: pick vendors, dispatch, and track (brief 7.9).
 *
 * Drafts and sent RFQs share this screen deliberately. The requirement is
 * immutable once sent, so everything above the action bar is read-only from
 * then on; below it, the same vendor list and picker stay visible because
 * chasing a stalled RFQ means re-reading who was offered it and how far away
 * their cranes were.
 *
 * **The candidate snapshot is not recomputed here.** Brief 6.9 stores what the
 * sales user saw at send time, and this screen reads that stored copy for sent
 * RFQs rather than re-deriving it, because cranes move and re-deriving would
 * quietly rewrite history about what a vendor was offered. The live picker
 * below is for choosing recipients, and it says so.
 */

/**
 * `/app/rfqs/$rfqId` is one path for two audiences, so this picks the screen
 * before any query runs. The vendor must branch *here* rather than partway
 * down: the internal screen calls `/api/rfqs/:id`, which a vendor cannot read at
 * all, so a late branch would fire a request guaranteed to fail with a 403.
 */
export function RfqDetailPage() {
  const { user } = useAuth();

  if (user?.role === "vendor_user") {
    return <VendorRfqDetailPage />;
  }
  return <InternalRfqDetailPage />;
}

function InternalRfqDetailPage() {
  const { rfqId } = useParams({ from: "/app/rfqs/$rfqId" }) as { rfqId: string };
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const detail = useQuery({ queryKey: ["rfq", rfqId], queryFn: () => getRfq(rfqId) });
  const rfq = detail.data?.rfq;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["rfq", rfqId] });
    void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    void queryClient.invalidateQueries({ queryKey: ["rfq-candidates", rfqId] });
  };

  const countdown = rfq ? deadlineCountdown(rfq.submissionDeadline, rfq.status) : null;
  const isDraft = rfq?.status === "DRAFT";
  const isCancelled = rfq?.status === "CANCELLED";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold text-slate-900">
              {rfq?.rfqNumber ?? "RFQ"}
            </h1>
            {rfq ? <StatusBadge status={rfq.status} /> : null}
            {rfq?.rollupStatus ? (
              <Badge tone="blue">{ROLLUPE_STATUS_LABELS[rfq.rollupStatus]}</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            Enquiry {rfq?.enquiryNo}/{rfq?.lineNo} · created by{" "}
            {rfq?.createdBy?.fullName ?? rfq?.createdBy?.email ?? "—"}
          </p>
        </div>
        {rfq ? (
          <div className="text-right">
            <p className="text-xs font-medium text-slate-500">Submission deadline</p>
            <p className="text-sm text-slate-900">{formatDateTime(rfq.submissionDeadline)}</p>
            {countdown ? (
              <p
                className={
                  countdown.tone === "overdue"
                    ? "text-xs font-medium text-red-600"
                    : countdown.tone === "soon"
                      ? "text-xs font-medium text-amber-600"
                      : "text-xs text-slate-500"
                }
              >
                {countdown.label}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      {detail.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading the RFQ
        </div>
      ) : detail.error ? (
        <Alert title="Could not load this RFQ">{(detail.error as Error).message}</Alert>
      ) : !rfq ? null : (
        <>
          {rfq.status === "CANCELLED" && rfq.cancelReason ? (
            <Alert tone="info" title={`Cancelled${rfq.cancelledAt ? ` on ${formatDate(rfq.cancelledAt)}` : ""}`}>
              {rfq.cancelReason}
            </Alert>
          ) : null}

          <Section title="Requirement">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ReadOnlyValue label="Crane type" value={rfq.craneTypeRef?.name ?? rfq.craneType} />
              <ReadOnlyValue
                label="Capacity required"
                value={`${rfq.capacityT} t (${rfq.capacityRule === "EXACT" ? "exact" : "at least"})`}
              />
              <ReadOnlyValue label="Quantity" value={String(rfq.quantity)} />
              {rfq.capacityNote ? (
                <ReadOnlyValue label="Capacity note" value={rfq.capacityNote} />
              ) : null}
              {rfq.applicationDescription ? (
                <ReadOnlyValue label="Application" value={rfq.applicationDescription} />
              ) : null}
              {rfq.loadDescription ? (
                <ReadOnlyValue label="Load details" value={rfq.loadDescription} />
              ) : null}
              {rfq.mainBoomM !== null ? (
                <ReadOnlyValue label="Main boom required" value={`${rfq.mainBoomM} m`} />
              ) : null}
              {rfq.jibLengthM !== null ? (
                <ReadOnlyValue label="Jib length required" value={`${rfq.jibLengthM} m`} />
              ) : null}
              <ReadOnlyValue
                label="Job site"
                value={`${rfq.siteLocation}, ${rfq.siteState?.name ?? rfq.siteStateCode}`}
              />
              <ReadOnlyValue label="Pincode" value={rfq.sitePincode ?? "—"} mono />
              <ReadOnlyValue
                label="Required start"
                value={rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate)}
              />
              <ReadOnlyValue
                label="Duration"
                value={`${rfq.durationValue} ${rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}`}
              />
              <ReadOnlyValue label="Configuration" value={rfq.configuration ?? "—"} />
              <ReadOnlyValue label="Sent" value={rfq.sentAt ? formatDateTime(rfq.sentAt) : "Not sent yet"} />
            </dl>
          </Section>

          <Section title="Commercial terms">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ReadOnlyValue label="OT charges" value={rfq.otCharges ?? "—"} />
              <ReadOnlyValue label="Breakdown charges" value={rfq.breakdownTerms ?? "—"} />
              <ReadOnlyValue label="Diesel scope" value={rfq.dieselScope ?? "—"} />
              <ReadOnlyValue label="Working hours / shift" value={rfq.workingHoursShift ?? "—"} />
              <ReadOnlyValue
                label="Crane age criteria"
                value={rfq.craneAgeCriteriaYears === null ? "—" : `${rfq.craneAgeCriteriaYears} years`}
              />
              <ReadOnlyValue
                label="Accommodation & conveyance"
                value={rfq.accommodationConveyance ?? "—"}
              />
              <ReadOnlyValue label="Payment terms" value={rfq.paymentTerms ?? "—"} />
              <ReadOnlyValue
                label="Mobilisation & demobilisation"
                value={rfq.mobilisationTerms ?? "—"}
              />
              <ReadOnlyValue label="Support crane" value={rfq.supportCrane ?? "—"} />
              <ReadOnlyValue
                label="Steel mats & ground prep"
                value={rfq.steelMatsGroundPrep ?? "—"}
              />
              <ReadOnlyValue label="EHS / HR requirements" value={rfq.ehsHrRequirements ?? "—"} />
              <ReadOnlyValue label="Insurance" value={rfq.insuranceTerms ?? "—"} />
              <ReadOnlyValue label="Extension clause" value={rfq.extensionClause ?? "—"} />
              <ReadOnlyValue label="Notes" value={rfq.notes ?? "—"} />
            </dl>
            <div className="border-t border-slate-100 pt-3">
              <p className="text-xs font-medium text-slate-500">SML contact</p>
              <p className="mt-0.5 text-sm text-slate-900">
                {rfq.smlContactName ?? "—"}
                {rfq.smlContactMobile ? ` · ${rfq.smlContactMobile}` : ""}
                {rfq.smlContactEmail ? ` · ${rfq.smlContactEmail}` : ""}
              </p>
            </div>
            {rfq.attachments.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-slate-500">Attachments</p>
                <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                  {rfq.attachments.map((file) => (
                    <li key={file.id}>{file.fileName}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          <ActionBar
            rfqId={rfqId}
            isDraft={isDraft}
            isCancelled={isCancelled}
            hasRecipients={rfq.recipients.length > 0}
            onDone={invalidate}
          />

          {isDraft ? (
            <CandidatePickerSection
              rfqId={rfqId}
              alreadySent={rfq.recipients.map((r) => r.vendorId)}
              disabled={isCancelled}
            />
          ) : null}

          <RecipientsSection rfqId={rfqId} recipients={rfq.recipients} onDone={invalidate} />
          <QuotationsSection
            rfqId={rfqId}
            quotations={rfq.quotations}
            canAward={user?.role === "admin_user"}
            closed={isCancelled || rfq.status === "CLOSED"}
            startDateTbc={rfq.startDateTbc}
            defaultStartDate={rfq.requiredStartDate?.slice(0, 10) ?? ""}
            onDone={invalidate}
          />
        </>
      )}
    </div>
  );
}

// --- actions ---------------------------------------------------------------

function ActionBar({
  rfqId,
  isDraft,
  isCancelled,
  hasRecipients,
  onDone,
}: {
  rfqId: string;
  isDraft: boolean;
  isCancelled: boolean;
  hasRecipients: boolean;
  onDone: () => void;
}) {
  const [showExtend, setShowExtend] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  if (isCancelled) {
    return (
      <Alert tone="info" title="Cancelled">
        This RFQ was cancelled and the recipients were told. It can no longer be sent or
        have its deadline changed.
      </Alert>
    );
  }

  return (
    <Section
      title="Actions"
      description={
        hasRecipients
          ? "Sending again emails every recipient you have selected."
          : "Choose vendors below, then send."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {isDraft ? (
          <Link to="/app/rfqs/$rfqId/edit" params={{ rfqId }} className="btn-secondary px-4 py-2 text-sm">
            Edit draft
          </Link>
        ) : null}

        <Link to="/app/communications" search={{ rfqId }} className="btn-secondary px-4 py-2 text-sm">
          Communication history
        </Link>

        <button
          type="button"
          className="btn-secondary px-4 py-2 text-sm"
          onClick={() => setShowExtend((v) => !v)}
          disabled={isDraft}
          title={isDraft ? "Send the RFQ before changing its deadline" : undefined}
        >
          Extend deadline
        </button>

        <button
          type="button"
          className="btn-secondary px-4 py-2 text-sm"
          onClick={() => setShowCancel((v) => !v)}
        >
          Cancel RFQ
        </button>
      </div>

      {showExtend ? (
        <ExtendDeadlineForm
          rfqId={rfqId}
          onDone={() => {
            setShowExtend(false);
            onDone();
          }}
        />
      ) : null}

      {showCancel ? (
        <CancelForm
          rfqId={rfqId}
          onDone={() => {
            setShowCancel(false);
            onDone();
          }}
        />
      ) : null}
    </Section>
  );
}

function ExtendDeadlineForm({ rfqId, onDone }: { rfqId: string; onDone: () => void }) {
  const [deadline, setDeadline] = useState("");
  const [reason, setReason] = useState("");

  const extend = useMutation({
    mutationFn: () => extendDeadline(rfqId, deadline, reason),
    onSuccess: () => onDone(),
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs text-slate-600">
        Pending recipients are emailed about the new deadline. Only a later date is
        accepted — to move a deadline forward in time, cancel the RFQ instead.
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          extend.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New deadline" htmlFor="extend-deadline" required>
            <TextInput
              id="extend-deadline"
              type="datetime-local"
              value={deadline}
              onChange={setDeadline}
            />
          </Field>
          <Field label="Reason" htmlFor="extend-reason" hint="Included in the email.">
            <TextInput id="extend-reason" value={reason} onChange={setReason} />
          </Field>
        </div>
        {extend.isError ? <Alert title="Not extended">{(extend.error as Error).message}</Alert> : null}
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-sm"
          disabled={extend.isPending || deadline === ""}
        >
          {extend.isPending ? <Spinner /> : null}
          Extend and notify
        </button>
      </form>
    </div>
  );
}

function CancelForm({ rfqId, onDone }: { rfqId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const cancel = useMutation({
    mutationFn: () => cancelRfq(rfqId, reason),
    onSuccess: () => onDone(),
  });

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-xs text-red-800">
        Cancelling tells every recipient who has not yet declined. This is recorded and
        cannot be undone.
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          cancel.mutate();
        }}
      >
        <Field label="Reason" htmlFor="cancel-reason" required>
          <TextArea id="cancel-reason" value={reason} onChange={setReason} />
        </Field>
        {cancel.isError ? <Alert title="Not cancelled">{(cancel.error as Error).message}</Alert> : null}
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-sm"
          disabled={cancel.isPending || reason.trim().length < 3}
        >
          {cancel.isPending ? <Spinner /> : null}
          Cancel this RFQ
        </button>
      </form>
    </div>
  );
}

/** Confirms the job-site pin without touching the rest of the RFQ (brief 6.9). */
function ConfirmPinCard({ rfqId, onDone }: { rfqId: string; onDone: () => void }) {
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
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-xs text-amber-800">
        The job site has no confirmed pin, so no distance can be shown for any crane.
        Enter the coordinates to switch the candidate list to a distance ranking.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          confirm.mutate();
        }}
      >
        <Field label="Latitude" htmlFor="pin-lat" className="w-40">
          <TextInput id="pin-lat" value={lat} onChange={setLat} inputMode="decimal" />
        </Field>
        <Field label="Longitude" htmlFor="pin-lng" className="w-40">
          <TextInput id="pin-lng" value={lng} onChange={setLng} inputMode="decimal" />
        </Field>
        <button
          type="submit"
          className="btn-secondary px-4 py-2 text-sm"
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

// --- candidate picker ------------------------------------------------------

function CandidatePickerSection({
  rfqId,
  alreadySent,
  disabled,
}: {
  rfqId: string;
  alreadySent: string[];
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAllVendors, setShowAllVendors] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ["rfq-candidates", rfqId],
    queryFn: () => getCandidates(rfqId),
    enabled: !disabled,
  });

  const allVendors = useQuery({
    queryKey: ["rfq-approved-vendors"],
    queryFn: () => listApprovedVendors(),
    enabled: showAllVendors,
  });

  const send = useMutation({
    mutationFn: () => sendRfq(rfqId, selected),
    onSuccess: (result) => {
      const { sent, failed } = result.result;
      setOutcome(
        failed === 0
          ? `Sent to ${sent} vendor${sent === 1 ? "" : "s"}.`
          : `Sent to ${sent}, ${failed} failed. The failures are listed below and can be chased individually.`,
      );
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ["rfq", rfqId] });
      void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    },
  });

  const pickerVendors = candidates.data?.candidates.located ?? [];
  const unverified = candidates.data?.candidates.unverified ?? [];

  function toggle(vendorId: string) {
    setSelected((previous) =>
      previous.includes(vendorId)
        ? previous.filter((id) => id !== vendorId)
        : [...previous, vendorId],
    );
  }



  return (
    <Section
      title="Choose vendors to send to"
      description={
        candidates.data
          ? candidates.data.candidates.capacityRule
          : "Matching vendor cranes, nearest to the job site first."
      }
    >
      {candidates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Finding candidate cranes
        </div>
      ) : candidates.error ? (
        <Alert title="Could not load candidates">{(candidates.error as Error).message}</Alert>
      ) : candidates.data ? (
        <>
          {!candidates.data.candidates.distancesAvailable ? (
            <ConfirmPinCard
              rfqId={rfqId}
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: ["rfq-candidates", rfqId] });
                void queryClient.invalidateQueries({ queryKey: ["rfq", rfqId] });
              }}
            />
          ) : null}

          {candidates.data.candidates.notice ? (
            <Alert title="Start date to be confirmed">
              {candidates.data.candidates.notice}
            </Alert>
          ) : null}

          {candidates.data.candidates.distancesAvailable && pickerVendors.length === 0 && unverified.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
              No approved vendor has a matching crane right now. Check the crane type and
              capacity, or send to approved vendors without a matching crane.
            </div>
          ) : null}

          {pickerVendors.map((group) => (
            <VendorGroupCard
              key={group.vendorId}
              group={group}
              checked={selected.includes(group.vendorId)}
              alreadySent={alreadySent.includes(group.vendorId)}
              expanded={expanded[group.vendorId] ?? false}
              onToggleExpand={() =>
                setExpanded((previous) => ({
                  ...previous,
                  [group.vendorId]: !(previous[group.vendorId] ?? false),
                }))
              }
              onSelect={() => toggle(group.vendorId)}
            />
          ))}

          {unverified.length > 0 ? (
            <div className="rounded-lg border border-slate-200">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-800">Location unverified</p>
                  <p className="text-xs text-slate-500">
                    Matching cranes whose location has no pin, so they cannot be ranked by
                    distance. They are listed here rather than dropped — an unlocated crane
                    can still do the job.
                  </p>
                </div>
              </div>
              <ul className="divide-y divide-slate-100">
                {unverified.map((crane) => (
                  <li key={crane.craneId} className="px-4 py-2.5 text-sm">
                    <label className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-1 size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        checked={selected.includes(crane.vendorId)}
                        onChange={() => toggle(crane.vendorId)}
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-slate-800">{crane.vendorName}</span>
                        <span className="block text-xs text-slate-600">
                          {crane.typeOfCraneName} {crane.capacityT} t · {crane.make}{" "}
                          {crane.model} · {crane.currentLocation}, {crane.stateName}
                        </span>
                        <CraneChips crane={crane} />
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 hover:underline"
              onClick={() => setShowAllVendors((v) => !v)}
            >
              {showAllVendors ? "Hide" : "Choose from"} all approved vendors instead
            </button>
            {showAllVendors ? (
              <div className="mt-3 rounded-lg border border-slate-200">
                {allVendors.isLoading ? (
                  <p className="px-4 py-3 text-sm text-slate-500">Loading vendors…</p>
                ) : (
                  <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
                    {(allVendors.data?.vendors ?? []).map((vendor) => (
                      <li key={vendor.id} className="px-4 py-2.5 text-sm">
                        <label className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-1 size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                            checked={selected.includes(vendor.id)}
                            onChange={() => toggle(vendor.id)}
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-slate-800">{vendor.name}</span>
                            <span className="block text-xs text-slate-500">
                              {vendor.operatingRegions.map((r) => r.state.name).join(", ") ||
                                "No regions set"}
                              {vendor.users.length === 0 ? (
                                <span className="ml-1.5 text-red-600">
                                  no active user — cannot be sent to
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {send.isError ? (
        <Alert title="The RFQ was not sent">{(send.error as Error).message}</Alert>
      ) : null}
      {outcome ? (
        <Alert tone="success" title="Dispatched">
          {outcome}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="button"
          className="btn-primary px-5 py-2.5 text-sm"
          onClick={() => send.mutate()}
          disabled={send.isPending || selected.length === 0}
        >
          {send.isPending ? <Spinner /> : <Send className="size-4" aria-hidden />}
          {send.isPending
            ? "Sending"
            : `Send to ${selected.length} vendor${selected.length === 1 ? "" : "s"}`}
        </button>
        <p className="text-xs text-slate-500">
          {selected.length === 0
            ? "Select at least one vendor above."
            : "Emails go to each vendor's own active portal users."}
        </p>
      </div>
    </Section>
  );
}

function VendorGroupCard({
  group,
  checked,
  alreadySent,
  expanded,
  onToggleExpand,
  onSelect,
}: {
  group: CandidateGroup;
  checked: boolean;
  alreadySent: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onSelect}
          aria-label={`Select ${group.vendorName}`}
          className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-800">
            {group.vendorName}
            {alreadySent ? (
              <span className="ml-2 text-xs font-normal text-slate-500">already a recipient</span>
            ) : null}
          </p>
          <p className="text-xs text-slate-500">
            {group.cranes.length} matching crane{group.cranes.length === 1 ? "" : "s"} ·{" "}
            {formatDistance(group.nearestKm, group.distanceApproximate)}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary px-2.5 py-1.5 text-xs"
          onClick={onToggleExpand}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
      {expanded ? (
        <ul className="divide-y divide-slate-100">
          {group.cranes.map((crane) => (
            <li key={crane.craneId} className="px-4 py-2.5 text-sm">
              <p className="font-medium text-slate-800">
                {crane.typeOfCraneName} {crane.capacityT} t
              </p>
              <p className="text-xs text-slate-600">
                {crane.make} {crane.model}
                {crane.yom ? ` · ${crane.yom}` : ""} · {crane.currentLocation},{" "}
                {crane.stateName}
              </p>
              <CraneChips crane={crane} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The advisories that change a sales user's reading of a candidate (brief 6.9). */
function CraneChips({ crane }: { crane: CandidateCrane }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Badge tone={crane.currentStatus === "AVAILABLE" ? "emerald" : "amber"}>
        {crane.currentStatus.replaceAll("_", " ")}
      </Badge>
      <Badge tone="neutral">
        {formatDistance(crane.distanceKm, crane.distanceApproximate)}
      </Badge>
      {crane.availableInTime && crane.currentStatus === "ENGAGED" ? (
        <Badge tone="blue">free by the start date</Badge>
      ) : null}
      {crane.locationUnverified ? <Badge tone="amber">location unverified</Badge> : null}
      {crane.stale ? (
        <Badge tone="orange">stale · {crane.daysSinceUpdate} days</Badge>
      ) : null}
      {crane.loadChartFileName ? (
        <Badge tone="neutral">
          <MapPin className="size-3" aria-hidden /> load chart
        </Badge>
      ) : null}
    </div>
  );
}

// --- recipients and quotations --------------------------------------------

function RecipientsSection({
  rfqId,
  recipients,
  onDone,
}: {
  rfqId: string;
  recipients: Array<{
    recipientId: string;
    vendorId: string;
    vendorName: string;
    emails: string[];
    emailDeliveryStatus: string;
    emailDeliveryError: string | null;
    firstViewedAt: string | null;
    responseStatus: string;
    respondedAt: string | null;
    declineReason: string | null;
    declineNote: string | null;
    reminderCount: number;
    lastReminderAt: string | null;
  }>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const remind = useMutation({
    mutationFn: (recipientId: string) => remindRfq(rfqId, [recipientId]),
    onSuccess: () => onDone(),
    onSettled: () => setBusy(null),
  });

  const remindAll = useMutation({
    mutationFn: () => remindRfq(rfqId),
    onSuccess: () => onDone(),
  });

  const pending = recipients.filter((r) => r.responseStatus === "PENDING");

  if (recipients.length === 0) {
    return (
      <Section title="Recipients">
        <p className="text-sm text-slate-500">
          Nobody has been sent this RFQ yet. Pick vendors above and send.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Recipients"
      description="Delivery and response status per vendor. A failed delivery means the vendor was never reached."
    >
      {pending.length > 0 ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => remindAll.mutate()}
            disabled={remindAll.isPending}
          >
            {remindAll.isPending ? <Spinner /> : null}
            Remind all pending ({pending.length})
          </button>
          {remindAll.isError ? (
            <span className="text-xs text-red-600">{(remindAll.error as Error).message}</span>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Vendor</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Delivery</th>
              <th className="px-3 py-2 font-medium">Response</th>
              <th className="px-3 py-2 font-medium">First viewed</th>
              <th className="px-3 py-2 font-medium">Reminders</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {recipients.map((recipient) => (
              <tr key={recipient.recipientId} className="align-top">
                <td className="px-3 py-2.5">
                  <Link
                    to="/app/vendors/$vendorId"
                    params={{ vendorId: recipient.vendorId }}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {recipient.vendorName}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-600">
                  {recipient.emails.join(", ")}
                  {recipient.emailDeliveryError ? (
                    <p className="mt-0.5 text-red-600">{recipient.emailDeliveryError}</p>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  <DeliveryBadge status={recipient.emailDeliveryStatus} />
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={recipient.responseStatus} />
                  {recipient.responseStatus === "DECLINED" ? (
                    <div className="mt-1 text-xs text-slate-500">
                      {recipient.declineReason ? <p>{recipient.declineReason}</p> : null}
                      {recipient.declineNote ? (
                        <p className="mt-0.5 whitespace-pre-line">{recipient.declineNote}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {recipient.respondedAt ? (
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDate(recipient.respondedAt)}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-600">
                  {recipient.firstViewedAt ? formatDate(recipient.firstViewedAt) : "Not opened"}
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-600">
                  {recipient.reminderCount}
                  {recipient.lastReminderAt ? (
                    <p className="text-slate-500">{formatDate(recipient.lastReminderAt)}</p>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {recipient.responseStatus === "PENDING" ? (
                    <button
                      type="button"
                      className="btn-secondary px-2.5 py-1.5 text-xs"
                      onClick={() => {
                        setBusy(recipient.recipientId);
                        remind.mutate(recipient.recipientId);
                      }}
                      disabled={busy === recipient.recipientId}
                    >
                      {busy === recipient.recipientId ? <Spinner /> : null}
                      Remind
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/**
 * Received quotations (brief 7.9).
 *
 * Read-only for sales; the award action is admin-only (brief 6.7) and the
 * screen reflects that rather than guessing — the backend refuses the request
 * from a sales token regardless of what this UI shows. An award is final: it
 * books the winning crane, closes the RFQ and emails every vendor on the
 * invitation, so the confirm step names its consequences before it runs.
 */
function QuotationsSection({
  rfqId,
  quotations,
  canAward,
  closed,
  startDateTbc,
  defaultStartDate,
  onDone,
}: {
  rfqId: string;
  /**
   * `ReceivedQuotation` rather than a hand-written copy: an inline shape drifts
   * from the payload, and when it did, `warnings` was typed `string[]` while the
   * server sends `{ code, message }`. The copy typechecked, and React only found
   * out at runtime.
   */
  quotations: ReceivedQuotation[];
  canAward: boolean;
  closed: boolean;
  startDateTbc: boolean;
  defaultStartDate: string;
  onDone: () => void;
}) {
  const [awarding, setAwarding] = useState<string | null>(null);

  return (
    <Section
      title="Received quotations"
      description={
        closed
          ? "This RFQ is finalised. The vendors have been told the outcome."
          : "Comparison stays out of scope (brief 2); selection is the admin award action below."
      }
    >
      {quotations.length === 0 ? (
        <p className="text-sm text-slate-500">
          No quotations yet. They appear here as vendors submit them.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Vendor</th>
                <th className="px-3 py-2 font-medium">Crane</th>
                <th className="px-3 py-2 font-medium">Rate</th>
                <th className="px-3 py-2 font-medium">Mobilisation</th>
                <th className="px-3 py-2 font-medium">Demob.</th>
                <th className="px-3 py-2 font-medium">Tax</th>
                <th className="px-3 py-2 font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Distance</th>
                <th className="px-3 py-2 font-medium">Advisories</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {quotations.map((quotation) => (
                <tr key={quotation.quotationId} className="align-top">
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-slate-800">{quotation.vendorName}</p>
                    <p className="text-xs text-slate-500">
                      v{quotation.version}
                      {!quotation.isLatest ? " · superseded" : ""} ·{" "}
                      {formatDate(quotation.submittedAt)}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {quotation.craneDescription}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {quotation.rentalRate.toLocaleString("en-IN")}{" "}
                    <span className="text-slate-500">
                      {quotation.rateBasis.replaceAll("_", " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {quotation.mobilisationCharges.toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {quotation.demobilisationCharges.toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">
                    {quotation.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST"}
                  </td>
                  <td className="px-3 py-2.5 text-sm font-semibold text-slate-900">
                    {quotation.totalQuotedValue.toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    {formatDistance(quotation.distanceToSiteKm, quotation.distanceApproximate)}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {quotation.warnings.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <ul className="list-disc space-y-0.5 pl-4 text-amber-700">
                        {quotation.warnings.map((warning) => (
                          <li key={warning.code}>{warning.message}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={quotation.status} />
                    {canAward && !closed ? (
                      <AwardControl
                        rfqId={rfqId}
                        quotationId={quotation.quotationId}
                        awardable={quotation.isLatest && quotation.status === "SUBMITTED"}
                        startDateTbc={startDateTbc}
                        defaultStartDate={defaultStartDate}
                        open={awarding === quotation.quotationId}
                        onToggle={() =>
                          setAwarding(
                            awarding === quotation.quotationId ? null : quotation.quotationId,
                          )
                        }
                        onDone={() => {
                          setAwarding(null);
                          onDone();
                        }}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * The award affordance for one row. Superseded or non-Submitted versions cannot
 * be awarded (the backend refuses them), so the button appears on an awardable
 * row at all and disappears from the ones that are not.
 */
function AwardControl({
  rfqId,
  quotationId,
  awardable,
  startDateTbc,
  defaultStartDate,
  open,
  onToggle,
  onDone,
}: {
  rfqId: string;
  quotationId: string;
  awardable: boolean;
  startDateTbc: boolean;
  defaultStartDate: string;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState(startDateTbc ? defaultStartDate : "");
  const [endDate, setEndDate] = useState("");

  const award = useMutation({
    mutationFn: () =>
      awardQuotation(
        rfqId,
        quotationId,
        { reason, dates: startDateTbc ? { startDate, endDate } : undefined },
      ),
    onSuccess: (result) => {
      onDone();
      const detail = result.result.partial
        ? `Partial award (${result.result.awardedCount} of ${result.result.quantity}); the other quotations stay open.`
        : `${result.result.notAwardedCount} other quotation(s) marked Not Awarded and the RFQ finalised.`;
      window.alert(
        `Awarded. ${detail} ` +
          `${result.result.notifiedAwarded} award email(s) and ${result.result.notifiedNotAwarded} ` +
          `not-awarded email(s) sent.`,
      );
    },
  });

  if (open) {
    return (
      <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs text-slate-600">
          Selects this quotation, reserves the crane for the requirement window and emails
          the vendor. Other quotations stay open until the RFQ's quantity is awarded, when
          the RFQ is finalised.
        </p>
        {startDateTbc ? (
          <>
            <Field label="Reservation start" htmlFor={`award-start-${quotationId}`} required>
              <TextInput
                id={`award-start-${quotationId}`}
                type="date"
                value={startDate}
                onChange={setStartDate}
              />
            </Field>
            <Field label="Reservation end" htmlFor={`award-end-${quotationId}`} required>
              <TextInput
                id={`award-end-${quotationId}`}
                type="date"
                value={endDate}
                onChange={setEndDate}
              />
            </Field>
          </>
        ) : null}
        <Field label="Remarks" htmlFor={`award-reason-${quotationId}`} hint="Optional echo into the emails.">
          <TextInput
            id={`award-reason-${quotationId}`}
            value={reason}
            onChange={setReason}
          />
        </Field>
        {award.isError ? (
          <Alert title="Not awarded">{(award.error as Error).message}</Alert>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() => award.mutate()}
            disabled={award.isPending}
          >
            {award.isPending ? <Spinner /> : null}
            Confirm award
          </button>
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={onToggle}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className="btn-secondary px-2.5 py-1.5 text-xs"
        onClick={onToggle}
        disabled={!awardable}
        title={
          !awardable
            ? "Only the latest Submitted version can be awarded"
            : undefined
        }
      >
        Award
      </button>
    </div>
  );
}

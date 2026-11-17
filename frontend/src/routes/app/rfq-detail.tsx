import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MoreHorizontal, Moon, Sun, UserPlus } from "lucide-react";
import {
  DELIVERY_LABELS,
  RESPONSE_LABELS,
  ROLLUPE_STATUS_LABELS,
  awardQuotation,
  cancelRfq,
  extendDeadline,
  formatDistance,
  getCandidates,
  getRfq,
  remindRfq,
  type CandidateMode,
  type RfqRecipient,
  type RfqStatus,
  type ReceivedQuotation,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, ReadOnlyValue, Section, TextArea, TextInput } from "@/components/ui/form";
import { LifecycleStepper } from "@/components/ui/lifecycle-stepper";
import { Spinner } from "@/components/ui/spinner";
import { RFQ_STATUS_LABELS } from "@/lib/rfqs";
import { deadlineCountdown, statusTone } from "@/lib/rfq-display";
import { formatCalendarDate, formatDate, formatDateTime } from "@/lib/format";
import { cityOf, craneTypeLabel, siteLabel, titleCase } from "@/lib/format";
import { deadlineRelative } from "@/lib/rfq-display";
import { cn } from "@/lib/cn";
import { loadRfqReplies } from "@/lib/replies";
import { useAuth } from "@/lib/auth";
import { VendorRfqDetailPage } from "@/routes/app/vendor-rfq-detail";
import { DEADLINE_ZONE_LABEL, dayMonth, formatDeadline, formatDeadlineExact } from "./rfq-detail/datetime";
import { VendorPickerSection, type SendOutcome } from "./rfq-detail/vendor-picker";

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

/** The sections of the RFQ screen, in the order work moves through them. */
type DetailTab = "overview" | "vendors" | "replies" | "quotations";

const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "vendors", label: "Vendors" },
  { value: "replies", label: "Replies" },
  { value: "quotations", label: "Quotations" },
];

/** Status reads as a dot and a word, the same as it does in the list. */
function StatusWord({ status }: { status: RfqStatus }) {
  const tone = statusTone(status);
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      <span className={cn("text-[15px] font-medium", tone.text)}>
        {RFQ_STATUS_LABELS[status]}
      </span>
    </span>
  );
}

type RfqTheme = "light" | "dark";
const THEME_KEY = "crossrentel.rfq.theme";

/**
 * Light / dark for this screen. Dark stays the default so nobody's screen
 * changes under them; the choice is remembered per browser, and a browser that
 * blocks storage simply starts dark each time.
 */
function useRfqTheme(): [RfqTheme, () => void] {
  const [theme, setTheme] = useState<RfqTheme>(() => {
    try {
      return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  const toggle = () => {
    setTheme((current) => {
      const next: RfqTheme = current === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* unsaved is fine */
      }
      return next;
    });
  };

  return [theme, toggle];
}

function readStoredMode(): CandidateMode {
  try {
    return window.localStorage.getItem("sml.rfq.picker.mode") === "distance"
      ? "distance"
      : "technical";
  } catch {
    return "technical";
  }
}

function InternalRfqDetailPage() {
  const { rfqId } = useParams({ from: "/app/rfqs/$rfqId" }) as { rfqId: string };
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false }) as { tab?: string };

  const detail = useQuery({ queryKey: ["rfq", rfqId], queryFn: () => getRfq(rfqId) });
  const rfq = detail.data?.rfq;

  // The picker's ranking is remembered per browser; the shortlist is not, so a
  // stale selection can never be sent days later by accident.
  const [mode, setMode] = useState<CandidateMode>(readStoredMode);
  const [theme, toggleTheme] = useRfqTheme();
  const [addingVendors, setAddingVendors] = useState(false);
  const [actionForm, setActionForm] = useState<"cancel" | "extend" | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["rfq", rfqId] });
    void queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    void queryClient.invalidateQueries({ queryKey: ["rfq-candidates", rfqId] });
  };

  const isDraft = rfq?.status === "DRAFT";
  const isCancelled = rfq?.status === "CANCELLED";
  const isSent = rfq?.status === "SENT";

  // Sending is gated by the same capability the server checks (`rfq:dispatch`),
  // not by the role name: an admin holds it as an override, and a management
  // viewer holds no operational capability at all. Falling back to the roles
  // that hold it today covers an older `/auth/me` without the list.
  const canDispatch = user?.capabilities
    ? user.capabilities.includes("rfq:dispatch")
    : user?.role === "sales_user" || user?.role === "admin_user";

  // The same query the picker reads, owned here so the Vendors tab can say how
  // many vendors are available before the section below has rendered.
  const showPicker = Boolean(rfq) && (isDraft === true || addingVendors) && !isCancelled;
  const candidates = useQuery({
    queryKey: ["rfq-candidates", rfqId, mode],
    queryFn: () => getCandidates(rfqId, mode),
    enabled: showPicker,
  });
  const candidateCount = new Set([
    ...(candidates.data?.candidates.located ?? []).map((group) => group.vendorId),
    ...(candidates.data?.candidates.unverified ?? []).map((crane) => crane.vendorId),
  ]).size;

  // A draft opens on the vendor picker because that is the only thing standing
  // between it and a send; everything else opens on the requirement. The choice
  // is in the URL so a section can be linked to.
  const tab: DetailTab =
    DETAIL_TABS.find((entry) => entry.value === routeSearch.tab)?.value ??
    (isDraft ? "vendors" : "overview");

  const setTab = (next: DetailTab) => {
    void navigate({
      to: "/app/rfqs/$rfqId",
      params: { rfqId },
      search: { tab: next },
      replace: true,
    });
  };

  const tabBadge = (entry: DetailTab): string | null => {
    if (!rfq) return null;
    if (entry === "vendors") {
      if (isDraft) return candidateCount > 0 ? `${candidateCount} available` : null;
      return rfq.recipients.length > 0 ? String(rfq.recipients.length) : null;
    }
    if (entry === "quotations") {
      return rfq.quotations.length > 0 ? String(rfq.quotations.length) : null;
    }
    return null;
  };

  const deadlinePassed = rfq
    ? new Date(rfq.submissionDeadline).getTime() <= Date.now()
    : false;
  const relative = rfq
    ? isDraft
      ? deadlineRelative(rfq.submissionDeadline)
      : deadlineCountdown(rfq.submissionDeadline, rfq.status)
    : null;

  const steps = [
    { key: "draft", label: "Draft" },
    { key: "choose", label: "Choose vendors" },
    { key: "send", label: "Send" },
    { key: "replies", label: "Replies" },
    { key: "award", label: "Awarded" },
  ];
  // The stepper reports where the work actually is, not just the status:
  // a sent RFQ with no reply yet is still at "Send", and moves to "Replies" as
  // soon as one vendor answers.
  const stepIndex = !rfq
    ? 0
    : rfq.status === "DRAFT" || rfq.status === "CANCELLED"
      ? 0
      : rfq.status === "CLOSED"
        ? 4
        : rfq.recipients.some(
              (recipient) =>
                recipient.responseStatus === "QUOTED" || recipient.responseStatus === "DECLINED",
            )
          ? 3
          : 2;

  function handleSent(result: SendOutcome) {
    setOutcome(result);
    setAddingVendors(false);
    invalidate();
    // The recipients table replaces the picker once the refetch lands; bring it
    // into view rather than leaving the user at the top of a changed page.
    window.setTimeout(() => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document
        .getElementById("rfq-recipients")
        ?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    }, 350);
  }

  return (
    // The wrapper bleeds to the edges of the page so the light theme paints the
    // whole canvas, not just the column. The app bar above keeps its own chrome.
    <div
      className={cn(
        "-mx-4 -my-6 min-h-[calc(100dvh-3rem)] bg-slate-50 px-4 py-6 text-slate-700 sm:-mx-6 sm:px-6",
        theme === "light" ? "theme-light" : "theme-dark",
      )}
    >
      <div className="mx-auto w-full max-w-[1360px] space-y-4 pb-6">
        <PageHeader
          back={{ to: "/app/rfqs", label: "All RFQs" }}
          title={rfq?.rfqNumber ?? "RFQ"}
          mono
          titleClassName="text-2xl"
          description={
            rfq ? (
              <>
                {craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} · {rfq.capacityT} t
                {rfq.capacityRule === "AT_LEAST" ? "+" : ""} · qty {rfq.quantity} · {cityOf(rfq)}
                {rfq.siteState ? `, ${titleCase(rfq.siteState.name)}` : ""}
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
                  <Link
                    to="/app/enquiries"
                    search={{ q: rfq.enquiryNo }}
                    className="font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                  >
                    Enquiry {rfq.enquiryNo}/{rfq.lineNo}
                  </Link>
                  {rfq.enquiryLineId ? (
                    <Link
                      to="/app/enquiries/lines/$lineId/edit"
                      params={{ lineId: rfq.enquiryLineId }}
                      className="font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                    >
                      Open line item
                    </Link>
                  ) : null}
                </span>
              </>
            ) : undefined
          }
          meta={
            rfq ? (
              <>
                <StatusWord status={rfq.status} />
                {rfq.rollupStatus ? (
                  <span className="text-[15px] text-slate-500">
                    {ROLLUPE_STATUS_LABELS[rfq.rollupStatus]}
                  </span>
                ) : null}
                <span aria-hidden className="text-slate-400">
                  ·
                </span>
                <span className="text-[15px] text-slate-500">
                  Created {dayMonth(rfq.createdAt)} by{" "}
                  {rfq.createdBy?.fullName ?? rfq.createdBy?.email ?? "—"}
                </span>
              </>
            ) : null
          }
          actions={
            rfq ? (
              <div className="flex flex-col items-end gap-2">
                <div className="text-right" title={formatDeadlineExact(rfq.submissionDeadline)}>
                  <p className="text-[13px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                    Submission deadline
                  </p>
                  <p className="text-[17px] text-slate-900 tabular-nums">
                    {formatDeadline(rfq.submissionDeadline)}
                  </p>
                  <p
                    className={cn(
                      "text-[14px]",
                      relative?.tone === "overdue"
                        ? "font-medium text-red-500"
                        : relative?.tone === "soon"
                          ? "font-medium text-amber-500"
                          : "text-slate-500",
                    )}
                  >
                    {relative?.label} · {DEADLINE_ZONE_LABEL}
                  </p>
                  {deadlinePassed && isDraft ? (
                    <p className="max-w-[240px] text-[14px] text-red-500">
                      Deadline has passed. Edit the draft before sending.
                    </p>
                  ) : null}
                  {isDraft ? (
                    <Link
                      to="/app/rfqs/$rfqId/edit"
                      params={{ rfqId }}
                      className="mt-1 inline-block text-[14px] font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                    >
                      Edit deadline
                    </Link>
                  ) : null}
                </div>

                <RfqHeaderActions
                  rfqId={rfqId}
                  isDraft={isDraft}
                  isSent={isSent}
                  isCancelled={isCancelled}
                  onCancel={() => setActionForm(actionForm === "cancel" ? null : "cancel")}
                  onExtend={() => setActionForm(actionForm === "extend" ? null : "extend")}
                />
              </div>
            ) : null
          }
        />

        {rfq ? (
          <div className="border-y border-ink-800 py-2">
            <LifecycleStepper
              steps={steps}
              current={stepIndex}
              cancelled={isCancelled}
            />
            {isCancelled && rfq.cancelReason ? (
              <p className="mt-1 text-[14px] text-slate-500">{rfq.cancelReason}</p>
            ) : null}
          </div>
        ) : null}

        {actionForm === "cancel" ? (
          <div className="ml-auto max-w-xl">
            <CancelForm
              rfqId={rfqId}
              onDone={() => {
                setActionForm(null);
                invalidate();
              }}
            />
          </div>
        ) : null}
        {actionForm === "extend" ? (
          <div className="ml-auto max-w-xl">
            <ExtendDeadlineForm
              rfqId={rfqId}
              onDone={() => {
                setActionForm(null);
                invalidate();
              }}
            />
          </div>
        ) : null}

        {detail.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading the RFQ
          </div>
        ) : detail.error ? (
          <Alert title="Could not load this RFQ">{(detail.error as Error).message}</Alert>
        ) : !rfq ? null : (
          <>
            <div className="sticky top-[49px] z-20 bg-slate-50 pt-1">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
                title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
                className="absolute right-0 bottom-1.5 z-10 inline-flex size-8 items-center justify-center rounded-lg border border-ink-800 bg-ink-850 text-slate-600 transition-colors hover:border-ink-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                {theme === "light" ? (
                  <Moon className="size-4" aria-hidden />
                ) : (
                  <Sun className="size-4" aria-hidden />
                )}
              </button>
              <div
                role="tablist"
                aria-label="RFQ sections"
                className="flex gap-5 overflow-x-auto border-b border-slate-200 pr-12"
              >
                {DETAIL_TABS.map((entry) => {
                  const active = tab === entry.value;
                  const badge = tabBadge(entry.value);
                  return (
                    <button
                      key={entry.value}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setTab(entry.value)}
                      className={cn(
                        "-mb-px shrink-0 border-b-2 pb-2.5 text-[15px] whitespace-nowrap transition-colors duration-150",
                        active
                          ? "border-accent-500 font-medium text-slate-900"
                          : "border-transparent text-slate-500 hover:text-slate-900",
                      )}
                    >
                      {entry.label}
                      {badge ? (
                        <span className="ml-1.5 text-[14px] text-slate-500 tabular-nums">
                          {badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Every section stays mounted so a half-made vendor selection is not
                thrown away by looking at the quotes and coming back. */}
            <div className="space-y-5">
              <div className={cn("space-y-5", tab !== "overview" && "hidden")}>
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
                      value={siteLabel(rfq)}
                    />
                    <ReadOnlyValue label="Pincode" value={rfq.sitePincode ?? "—"} mono />
                    <ReadOnlyValue
                      label="Required start"
                      value={
                        rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate)
                      }
                    />
                    <ReadOnlyValue
                      label="Duration"
                      value={`${rfq.durationValue} ${rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}`}
                    />
                    <ReadOnlyValue label="Configuration" value={rfq.configuration ?? "—"} />
                    <ReadOnlyValue
                      label="Sent"
                      value={rfq.sentAt ? formatDateTime(rfq.sentAt) : "Not sent yet"}
                    />
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
                  <div className="border-t border-ink-800 pt-3">
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
              </div>

              <div className={cn("space-y-5", tab !== "vendors" && "hidden")}>
                {showPicker ? (
                  <VendorPickerSection
                    rfq={rfq}
                    alreadySent={rfq.recipients.map((recipient) => recipient.vendorId)}
                    disabled={isCancelled}
                    sendBlockedReason={
                      canDispatch ? null : "Your account cannot send RFQs."
                    }
                    mode={mode}
                    onModeChange={setMode}
                    candidates={candidates}
                    onSent={handleSent}
                    onPinConfirmed={invalidate}
                  />
                ) : null}

                {outcome ? (
                  <Alert
                    tone={outcome.failed > 0 ? "info" : "success"}
                    title={`Sent to ${outcome.sent} vendor${outcome.sent === 1 ? "" : "s"}`}
                  >
                    {outcome.failed > 0 ? (
                      <>
                        {outcome.failed} could not be delivered:
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          {outcome.failures.map((failure) => (
                            <li key={`${failure.vendorName}-${failure.error}`}>
                              {failure.vendorName} — {failure.error}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      "Every selected vendor was emailed."
                    )}
                  </Alert>
                ) : null}

                <RecipientsSection
                  rfqId={rfqId}
                  status={rfq.status}
                  recipients={rfq.recipients}
                  onDone={invalidate}
                  canAddMore={isSent && deadlinePassed === false}
                  adding={addingVendors}
                  onAddMore={() => {
                    setAddingVendors(true);
                    setOutcome(null);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  onStopAdding={() => setAddingVendors(false)}
                />
              </div>

              <div className={cn("space-y-5", tab !== "replies" && "hidden")}>
                <InboundRepliesSection rfqId={rfqId} />
              </div>

              <div className={cn("space-y-5", tab !== "quotations" && "hidden")}>
                <QuotationsSection
                  rfqId={rfqId}
                  quotations={rfq.quotations}
                  canAward={user?.role === "admin_user"}
                  closed={isCancelled || rfq.status === "CLOSED"}
                  startDateTbc={rfq.startDateTbc}
                  defaultStartDate={rfq.requiredStartDate?.slice(0, 10) ?? ""}
                  onDone={invalidate}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- actions ---------------------------------------------------------------

/**
 * The RFQ's quiet actions.
 *
 * Sending is the only button on this screen that should look like a button, so
 * everything that changes an RFQ that has already gone out lives behind a menu,
 * each with its own confirmation. A draft gets "Edit draft" instead of "Extend
 * deadline": a deadline that has not been promised to anyone is edited, not
 * extended.
 */
function RfqHeaderActions({
  rfqId,
  isDraft,
  isSent,
  isCancelled,
  onCancel,
  onExtend,
}: {
  rfqId: string;
  isDraft: boolean;
  isSent: boolean;
  isCancelled: boolean;
  onCancel: () => void;
  onExtend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const quiet =
    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[15px] font-medium text-slate-500 transition-colors hover:bg-ink-850 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

  return (
    <div className="flex flex-wrap items-center justify-end gap-0.5">
      {isDraft ? (
        <Link to="/app/rfqs/$rfqId/edit" params={{ rfqId }} className={quiet}>
          Edit draft
        </Link>
      ) : null}

      {isSent ? (
        <button type="button" className={quiet} onClick={onExtend}>
          <CalendarClock className="size-3.5" aria-hidden />
          Extend deadline
        </button>
      ) : null}

      <Link to="/app/communications" search={{ rfqId }} className={quiet}>
        Communication history
      </Link>

      {isCancelled ? null : (
        <div ref={menu} className="relative">
          <button
            type="button"
            className={quiet}
            aria-label="More RFQ actions"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          {open ? (
            <div
              role="menu"
              aria-label="RFQ actions"
              className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-ink-800 bg-ink-900 p-1 shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[15px] text-red-500 transition-colors hover:bg-red-500/10"
                onClick={() => {
                  setOpen(false);
                  onCancel();
                }}
              >
                Cancel RFQ
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
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

// --- recipients and quotations --------------------------------------------

/**
 * Delivery and response read as a dot and its word. Colour never carries the
 * meaning on its own, which matters on a screen where red means "this vendor was
 * never reached" and amber means "still waiting".
 */
function ToneWord({ tone, label }: { tone: { dot: string; text: string }; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      <span className={cn("text-[15px]", tone.text)}>{label}</span>
    </span>
  );
}

const DELIVERY_TONES: Record<string, { dot: string; text: string }> = {
  SENT: { dot: "bg-emerald-500", text: "text-emerald-600" },
  QUEUED: { dot: "bg-amber-500", text: "text-amber-600" },
  FAILED: { dot: "bg-red-500", text: "text-red-600" },
};

const RESPONSE_TONES: Record<string, { dot: string; text: string }> = {
  QUOTED: { dot: "bg-emerald-500", text: "text-emerald-600" },
  PENDING: { dot: "bg-amber-500", text: "text-amber-600" },
  DECLINED: { dot: "bg-red-500", text: "text-red-600" },
  EXPIRED: { dot: "bg-slate-500", text: "text-slate-500" },
  FINALISED: { dot: "bg-slate-500", text: "text-slate-500" },
};

const NEUTRAL_TONE = { dot: "bg-slate-500", text: "text-slate-500" };

/**
 * Who has the RFQ, and what has come back.
 *
 * This is the tracking half of the Vendors tab. It is only about delivery and
 * response: the commercial comparison lives under Quotations, so nothing here
 * repeats a rate.
 */
function RecipientsSection({
  rfqId,
  status,
  recipients,
  onDone,
  canAddMore,
  adding,
  onAddMore,
  onStopAdding,
}: {
  rfqId: string;
  status: string;
  recipients: RfqRecipient[];
  onDone: () => void;
  canAddMore: boolean;
  adding: boolean;
  onAddMore: () => void;
  onStopAdding: () => void;
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

  const pending = recipients.filter((recipient) => recipient.responseStatus === "PENDING");

  // A cancelled RFQ has nothing to chase, and the backend refuses the call
  // outright; a closed one has already been awarded. Offering the button would
  // only produce an error (or a pointless mail), so it is removed rather than
  // left to fail.
  const remindersOff = status === "CANCELLED" || status === "CLOSED";

  return (
    <Section
      id="rfq-recipients"
      title="Recipients"
      description={
        status === "CANCELLED"
          ? "Delivery and response status per vendor. This RFQ was cancelled, so reminders are switched off."
          : status === "CLOSED"
            ? "Delivery and response status per vendor. This RFQ is closed, so reminders are switched off."
            : "Delivery and response status per vendor. A failed delivery means the vendor was never reached."
      }
      actions={
        canAddMore ? (
          adding ? (
            <button type="button" className="btn-secondary px-3 py-1.5 text-[15px]" onClick={onStopAdding}>
              Stop adding
            </button>
          ) : (
            <button type="button" className="btn-secondary px-3 py-1.5 text-[15px]" onClick={onAddMore}>
              <UserPlus className="size-3.5" aria-hidden />
              Send to more vendors
            </button>
          )
        ) : null
      }
    >
      {recipients.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nobody has been sent this RFQ yet. Pick vendors above and send.
        </p>
      ) : (
        <>
          {!remindersOff && pending.length > 0 ? (
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
            <Table className="min-w-[52rem]">
              <THead>
                <tr>
                  <TH>Vendor</TH>
                  <TH>Email</TH>
                  <TH>Response</TH>
                  <TH>First viewed</TH>
                  <TH>Reminders</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {recipients.map((recipient) => (
                  <TR key={recipient.recipientId} className="align-top">
                    <TD>
                      <Link
                        to="/app/vendors/$vendorId"
                        params={{ vendorId: recipient.vendorId }}
                        className="font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                      >
                        {recipient.vendorName}
                      </Link>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {recipient.emails.length > 0
                          ? recipient.emails.join(", ")
                          : "No email on file"}
                      </p>
                    </TD>
                    <TD>
                      <ToneWord
                        tone={DELIVERY_TONES[recipient.emailDeliveryStatus] ?? NEUTRAL_TONE}
                        label={DELIVERY_LABELS[recipient.emailDeliveryStatus] ?? recipient.emailDeliveryStatus}
                      />
                      {recipient.emailDeliveryError ? (
                        <p className="mt-1 text-[14px] text-red-600">
                          {recipient.emailDeliveryError}
                        </p>
                      ) : null}
                    </TD>
                    <TD>
                      <ToneWord
                        tone={RESPONSE_TONES[recipient.responseStatus] ?? NEUTRAL_TONE}
                        label={RESPONSE_LABELS[recipient.responseStatus] ?? recipient.responseStatus}
                      />
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
                    </TD>
                    <TD className="text-xs text-slate-600">
                      {recipient.firstViewedAt ? formatDate(recipient.firstViewedAt) : "Not opened"}
                    </TD>
                    <TD className="text-xs text-slate-600">
                      <span className="tabular-nums">{recipient.reminderCount}</span>
                      {recipient.lastReminderAt ? (
                        <p className="text-slate-500">Last {formatDate(recipient.lastReminderAt)}</p>
                      ) : null}
                    </TD>
                    <TD align="right">
                      {!remindersOff && recipient.responseStatus === "PENDING" ? (
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
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </>
      )}
    </Section>
  );
}

function InboundRepliesSection({ rfqId }: { rfqId: string }) {
  const replies = useQuery({
    queryKey: ["rfq-replies", rfqId],
    queryFn: () => loadRfqReplies(rfqId, "ALL"),
  });

  const pending = replies.data?.replies.filter((reply) => reply.status === "PENDING").length ?? 0;

  return (
    <Section
      title="Inbound replies"
      description="Every email reply for this RFQ is shown here as it arrives."
    >
      {replies.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading replies
        </div>
      ) : replies.error ? (
        <Alert tone="error">{(replies.error as Error).message}</Alert>
      ) : (replies.data?.replies.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">
          No replies yet. Email answers from the invited vendors appear here once they are
          matched to this RFQ.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={pending > 0 ? "amber" : "neutral"}>{pending} pending</Badge>
            <span className="text-xs text-slate-500">
              {replies.data?.replies.length} repl
              {(replies.data?.replies.length ?? 0) === 1 ? "y" : "ies"} in this conversation
            </span>
          </div>

          <div className="space-y-3">
            {replies.data?.replies.map((reply) => (
              <article key={reply.id} className="overflow-hidden rounded-lg border border-slate-200">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {reply.vendor?.name ?? reply.fromAddress}
                    </p>
                    <p className="text-xs text-slate-500">
                      {reply.subject ?? "No subject"} ·{" "}
                      Email ·{" "}
                      {new Date(reply.receivedAt).toLocaleString("en-IN")}
                    </p>
                  </div>
                  <StatusBadge status={reply.status} />
                </div>
                <div className="space-y-3 px-4 py-3">
                  <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">
                    {reply.bodyText}
                  </pre>
                  <dl className="grid gap-3 border-t border-ink-800 pt-3 sm:grid-cols-3">
                    <ReadOnlyValue
                      label="Quoted rate"
                      value={
                        reply.parsedRentalRate === null
                          ? "—"
                          : `${reply.parsedRentalRate.toLocaleString("en-IN")} ${
                              reply.parsedRateBasis?.replaceAll("_", " ").toLowerCase() ?? ""
                            }`
                      }
                    />
                    <ReadOnlyValue
                      label="Validity"
                      value={
                        reply.parsedValidityDate
                          ? new Date(reply.parsedValidityDate).toLocaleDateString("en-IN")
                          : "—"
                      }
                    />
                    <ReadOnlyValue
                      label="Crane"
                      value={reply.crane?.serialRegistrationNo ?? "Not matched"}
                    />
                  </dl>
                  {reply.parseNote ? (
                    <p className="text-xs text-amber-700">{reply.parseNote}</p>
                  ) : null}
                  {reply.convertedQuotationId ? (
                    <p className="text-xs text-emerald-700">
                      Converted to quotation {reply.convertedQuotationId.slice(0, 8)}.
                    </p>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
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
        <div>
          <Table className="min-w-[62rem]">
            <THead>
              <tr>
                <TH>Vendor</TH>
                <TH>Source</TH>
                <TH>Crane</TH>
                <TH align="right">Rate</TH>
                <TH align="right">Mobilisation</TH>
                <TH align="right">Demob.</TH>
                <TH>Tax</TH>
                <TH align="right">Total</TH>
                <TH>Distance</TH>
                <TH>Advisories</TH>
                <TH>Outcome</TH>
              </tr>
            </THead>
            <TBody>
              {quotations.map((quotation) => (
                <TR key={quotation.quotationId} className="align-top">
                  <TD>
                    <p className="font-medium text-slate-800">{quotation.vendorName}</p>
                    <p className="text-[13px] text-slate-500">
                      v{quotation.version}
                      {!quotation.isLatest ? " · superseded" : ""} ·{" "}
                      {formatDate(quotation.submittedAt)}
                    </p>
                  </TD>
                  <TD>
                    <Badge tone="neutral">
                      {quotation.source === "PORTAL"
                        ? "Portal"
                        : quotation.source === "WHATSAPP"
                          ? "WhatsApp"
                          : quotation.source === "EMAIL"
                            ? "Email"
                            : "Manual"}
                    </Badge>
                  </TD>
                  <TD className="text-xs text-slate-700">{quotation.craneDescription}</TD>
                  <TD align="right" className="text-xs text-slate-700 tabular-nums">
                    {quotation.rentalRate.toLocaleString("en-IN")}{" "}
                    <span className="text-slate-500">
                      {quotation.rateBasis.replaceAll("_", " ").toLowerCase()}
                    </span>
                  </TD>
                  <TD align="right" className="text-xs text-slate-700 tabular-nums">
                    {quotation.mobilisationCharges.toLocaleString("en-IN")}
                  </TD>
                  <TD align="right" className="text-xs text-slate-700 tabular-nums">
                    {quotation.demobilisationCharges.toLocaleString("en-IN")}
                  </TD>
                  <TD className="text-xs text-slate-700">
                    {quotation.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST"}
                  </TD>
                  <TD align="right" className="text-sm font-semibold text-slate-900 tabular-nums">
                    {quotation.totalQuotedValue.toLocaleString("en-IN")}
                  </TD>
                  <TD className="text-xs text-slate-600">
                    {formatDistance(quotation.distanceToSiteKm, quotation.distanceApproximate)}
                  </TD>
                  <TD className="text-xs">
                    {quotation.warnings.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <ul className="list-disc space-y-0.5 pl-4 text-amber-700">
                        {quotation.warnings.map((warning) => (
                          <li key={warning.code}>{warning.message}</li>
                        ))}
                      </ul>
                    )}
                  </TD>
                  <TD>
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
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
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

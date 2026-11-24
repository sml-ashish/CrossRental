import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MoreHorizontal, Moon, Sun, UserPlus, X } from "lucide-react";
import {
  DELIVERY_LABELS,
  RESPONSE_LABELS,
  ROLLUPE_STATUS_LABELS,
  awardQuotation,
  cancelRfq,
  extendDeadline,
  getCandidates,
  getRfq,
  getRfqAudit,
  type RfqAuditEvent,
  remindRfq,
  type CandidateMode,
  type RfqDetail,
  type RfqRecipient,
  type RfqStatus,
  type ReceivedQuotation,
} from "@/lib/rfqs";
import { Alert } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/data-table";
import { Field, ReadOnlyValue, Section, TextArea, TextInput } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { RFQ_STATUS_LABELS } from "@/lib/rfqs";
import { extraTermRows } from "@/lib/quotations";
import { deadlineCountdown, statusTone } from "@/lib/rfq-display";
import { formatCalendarDate, formatDate, formatDateTime } from "@/lib/format";
import { cityOf, craneTypeLabel, siteLabel, titleCase } from "@/lib/format";
import { deadlineRelative } from "@/lib/rfq-display";
import { cn } from "@/lib/cn";
import { loadRfqReplies } from "@/lib/replies";
import { useAuth } from "@/lib/auth";
import { getRfqNegotiations, type NegotiationThread } from "@/lib/negotiations";
import { VendorRfqDetailPage } from "@/routes/app/vendor-rfq-detail";
import {
  CounterButton,
  NegotiationsSection,
} from "./rfq-detail/negotiations";
import { DEADLINE_ZONE_LABEL, dayMonth, formatDeadline, formatDeadlineExact } from "./rfq-detail/datetime";
import { VendorPickerSection, type SendOutcome } from "./rfq-detail/vendor-picker";
import { QuoteComparisonTable } from "./rfq-detail/quote-comparison";

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
type DetailTab =
  | "overview"
  | "vendors"
  | "replies"
  | "quotations"
  | "negotiations"
  | "audit";

const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "vendors", label: "Vendors" },
  { value: "replies", label: "Replies" },
  { value: "quotations", label: "Quotations" },
  { value: "negotiations", label: "Negotiations" },
  { value: "audit", label: "Audit trail" },
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

// The picker always recommends from the technical list now; distance is a sort
// on that list, so an old stored "distance" choice is ignored.
function readStoredMode(): CandidateMode {
  return "technical";
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
    void queryClient.invalidateQueries({ queryKey: ["rfq-audit", rfqId] });
    void queryClient.invalidateQueries({ queryKey: ["rfq-negotiations", rfqId] });
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

  // Negotiation powers both the counter action and the counter/accept/reject
  // controls. It is gated on quotation:counter — the same capability the backend
  // checks — with a role fallback for older /auth/me responses without the list.
  const canAward = user?.capabilities
    ? user.capabilities.includes("quotation:award")
    : user?.role === "admin_user";
  const canCounter = user?.capabilities
    ? user.capabilities.includes("quotation:counter")
    : user?.role === "sales_user" || user?.role === "admin_user";

  const negotiations = useQuery({
    queryKey: ["rfq-negotiations", rfqId],
    queryFn: () => getRfqNegotiations(rfqId),
    enabled: Boolean(rfq) && isSent,
  });
  const negotiationThreads: NegotiationThread[] = negotiations.data?.negotiations ?? [];
  const negotiatingQuotationIds = new Set(
    negotiationThreads
      .filter((thread) => ["AWAITING_VENDOR", "AWAITING_SML"].includes(thread.status))
      .map((thread) => thread.baseQuotation.quotationId),
  );

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
    if (entry === "negotiations") {
      if (negotiationThreads.length === 0) return null;
      const awaiting = negotiationThreads.filter(
        (thread) => thread.status === "AWAITING_SML",
      ).length;
      return awaiting > 0
        ? `${negotiationThreads.length} · ${awaiting} need a reply`
        : String(negotiationThreads.length);
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

  const responded = rfq
    ? rfq.recipients.filter(
        (recipient) =>
          recipient.responseStatus === "QUOTED" || recipient.responseStatus === "DECLINED",
      ).length
    : 0;

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
          back={{ to: "/app/rfqs", label: "Back" }}
          title={rfq?.rfqNumber ?? "RFQ"}
          mono
          titleClassName="text-2xl"
          description={
            rfq ? (
              <>
                {craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} · {rfq.capacityT} t
                {rfq.capacityRule === "AT_LEAST" ? "+" : ""} · qty {rfq.quantity} · {cityOf(rfq)}
                {rfq.siteState ? `, ${titleCase(rfq.siteState.name)}` : ""}
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
              <RfqHeaderActions
                rfqId={rfqId}
                isDraft={isDraft}
                isSent={isSent}
                isCancelled={isCancelled}
                onCancel={() => setActionForm(actionForm === "cancel" ? null : "cancel")}
                onExtend={() => setActionForm(actionForm === "extend" ? null : "extend")}
                onAudit={() => setTab("audit")}
              />
            ) : null
          }
        />

        {rfq ? (
          <NextStepBanner
            rfqId={rfqId}
            status={rfq.status}
            isDraft={isDraft}
            deadline={rfq.submissionDeadline}
            deadlinePassed={deadlinePassed}
            relative={relative}
            recipientCount={rfq.recipients.length}
            responded={responded}
            quotationCount={rfq.quotations.length}
            cancelReason={rfq.cancelReason}
            onGoTo={setTab}
          />
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
                className="mr-12 inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-ink-800 bg-ink-850 p-1"
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
                        "inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-1.5 text-[15px] whitespace-nowrap transition-colors duration-150",
                        active
                          ? "bg-ink-900 font-medium text-slate-900 shadow-sm ring-1 ring-ink-800"
                          : "text-slate-500 hover:text-slate-900",
                      )}
                    >
                      {entry.label}
                      {badge ? (
                        <span
                          className={cn(
                            "rounded-full px-1.5 text-[12px] font-medium tabular-nums",
                            active ? "bg-ink-800 text-slate-700" : "bg-ink-800/70 text-slate-500",
                          )}
                        >
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
                    <ReadOnlyValue label="Crane" value={craneTypeLabel(rfq.craneTypeRef?.name ?? rfq.craneType)} />
                    <ReadOnlyValue
                      label="Capacity"
                      value={`${rfq.capacityT} t (${rfq.capacityRule === "EXACT" ? "exact" : "at least"}) × ${rfq.quantity}`}
                    />
                    <ReadOnlyValue label="Job site" value={siteLabel(rfq)} />
                    <ReadOnlyValue
                      label="Start"
                      value={
                        rfq.startDateTbc ? "To be confirmed" : formatCalendarDate(rfq.requiredStartDate)
                      }
                    />
                    <ReadOnlyValue
                      label="Duration"
                      value={`${rfq.durationValue} ${rfq.durationUnit === "MONTHS" ? "month(s)" : "day(s)"}`}
                    />
                    <ReadOnlyValue
                      label="Submission deadline"
                      value={`${formatDeadline(rfq.submissionDeadline)} ${DEADLINE_ZONE_LABEL}`}
                    />
                  </dl>
                  {requirementExtras(rfq).length > 0 ? (
                    <dl className="grid gap-4 border-t border-ink-800 pt-3 sm:grid-cols-2 lg:grid-cols-3">
                      {requirementExtras(rfq).map(([label, value]) => (
                        <ReadOnlyValue key={label} label={label} value={value} />
                      ))}
                    </dl>
                  ) : null}
                  <p className="border-t border-ink-800 pt-3 text-[14px] text-slate-500">
                    Enquiry{" "}
                    <Link
                      to="/app/enquiries"
                      search={{ q: rfq.enquiryNo }}
                      className="font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                    >
                      {rfq.enquiryNo}/{rfq.lineNo}
                    </Link>
                    {rfq.enquiryLineId ? (
                      <>
                        {" · "}
                        <Link
                          to="/app/enquiries/lines/$lineId/edit"
                          params={{ lineId: rfq.enquiryLineId }}
                          className="font-medium text-accent-400 underline-offset-2 hover:text-accent-500 hover:underline"
                        >
                          Open line item
                        </Link>
                      </>
                    ) : null}
                    {" · "}
                    {rfq.sentAt ? `Sent ${formatDateTime(rfq.sentAt)}` : "Not sent yet"}
                  </p>
                </Section>

                <CommercialTerms rfq={rfq} />
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

              <div className={cn("space-y-5", tab !== "audit" && "hidden")}>
                <AuditTrailSection rfqId={rfqId} active={tab === "audit"} />
              </div>

              <div className={cn("space-y-5", tab !== "replies" && "hidden")}>
                <InboundRepliesSection rfqId={rfqId} />
              </div>

              <div className={cn("space-y-5", tab !== "negotiations" && "hidden")}>
                <NegotiationsSection
                  rfqId={rfqId}
                  negotiations={negotiationThreads}
                  loading={negotiations.isLoading}
                  canCounter={canCounter}
                  closed={isCancelled || rfq.status === "CLOSED"}
                  deadlinePassed={deadlinePassed}
                  submissionDeadline={rfq.submissionDeadline}
                  onDone={invalidate}
                  onStartCounter={() => {
                    setTab("quotations");
                    // The quotations panel is hidden until React applies the new
                    // tab, so let it mount before scrolling to the list.
                    window.setTimeout(() => {
                      const reduced = window.matchMedia(
                        "(prefers-reduced-motion: reduce)",
                      ).matches;
                      document
                        .getElementById("rfq-quotations-list")
                        ?.scrollIntoView({
                          block: "start",
                          behavior: reduced ? "auto" : "smooth",
                        });
                    }, 50);
                  }}
                />
              </div>

              <div className={cn("space-y-5", tab !== "quotations" && "hidden")}>
                <div id="rfq-quotations-list">
                  <QuotationsSection
                    rfqId={rfqId}
                    quotations={rfq.quotations}
                    canAward={canAward}
                    canCounter={canCounter}
                    negotiatingQuotationIds={negotiatingQuotationIds}
                    closed={isCancelled || rfq.status === "CLOSED"}
                    deadlinePassed={deadlinePassed}
                    startDateTbc={rfq.startDateTbc}
                    defaultStartDate={rfq.requiredStartDate?.slice(0, 10) ?? ""}
                    onDone={invalidate}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- summary ---------------------------------------------------------------

type RfqView = RfqDetail;

/** Optional requirement fields, shown only when the RFQ actually has them. */
function requirementExtras(rfq: RfqView): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [
    ["Capacity note", rfq.capacityNote],
    ["Application", rfq.applicationDescription],
    ["Load details", rfq.loadDescription],
    ["Weight to be lifted", rfq.liftLoadT !== null ? `${rfq.liftLoadT} t` : null],
    ["Height to be lifted", rfq.liftHeightM !== null ? `${rfq.liftHeightM} m` : null],
    ["Working radius", rfq.workingRadiusM !== null ? `${rfq.workingRadiusM} m` : null],
    ["Main boom", rfq.mainBoomM !== null ? `${rfq.mainBoomM} m` : null],
    ["Fixed jib", rfq.fixedJibM !== null ? `${rfq.fixedJibM} m` : null],
    ["Luffing jib", rfq.luffingJibM !== null ? `${rfq.luffingJibM} m` : null],
    ["Wind jib", rfq.windJibM !== null ? `${rfq.windJibM} m` : null],
    ["Jib length", rfq.jibLengthM !== null ? `${rfq.jibLengthM} m` : null],
    ["Configuration", rfq.configuration],
    ["Pincode", rfq.sitePincode],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

/**
 * Where this RFQ stands and what to do about it: one headline, one button, and
 * four counters that double as shortcuts to the matching section.
 */
function NextStepBanner({
  rfqId,
  status,
  isDraft,
  deadline,
  deadlinePassed,
  relative,
  recipientCount,
  responded,
  quotationCount,
  cancelReason,
  onGoTo,
}: {
  rfqId: string;
  status: RfqStatus;
  isDraft: boolean;
  deadline: string;
  deadlinePassed: boolean;
  relative: { label: string; tone: string } | null;
  recipientCount: number;
  responded: number;
  quotationCount: number;
  cancelReason: string | null;
  onGoTo: (tab: DetailTab) => void;
}) {
  let title: string;
  let body: string;
  let dot = "bg-amber-500";
  let action: { label: string; tab: DetailTab } | null = null;

  if (status === "CANCELLED") {
    title = "This RFQ was cancelled";
    body = cancelReason ?? "No further action is needed.";
    dot = "bg-slate-500";
  } else if (status === "CLOSED") {
    title = "Awarded";
    body = "A quotation was awarded and every vendor has been told.";
    dot = "bg-emerald-500";
    action = { label: "View quotations", tab: "quotations" };
  } else if (isDraft) {
    title = "Ready to choose vendors";
    body = deadlinePassed
      ? "The deadline has passed. Edit the draft before sending."
      : "Pick who should receive this RFQ, then send it.";
    dot = deadlinePassed ? "bg-red-500" : "bg-amber-500";
    action = { label: "Choose vendors", tab: "vendors" };
  } else if (quotationCount > 0) {
    title = `${quotationCount} quotation${quotationCount === 1 ? "" : "s"} ready to review`;
    body = `${responded} of ${recipientCount} vendors have responded.`;
    dot = "bg-emerald-500";
    action = { label: "Review quotations", tab: "quotations" };
  } else {
    title = "Waiting for vendors to reply";
    body = `${responded} of ${recipientCount} vendors have responded.`;
    action = { label: "See vendors", tab: "vendors" };
  }

  const overdue = relative?.tone === "overdue";
  const soon = relative?.tone === "soon";

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ink-800 bg-ink-900 px-5 py-4 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("size-2.5 shrink-0 rounded-full", dot)} aria-hidden />
          <div className="min-w-0">
            <p className="text-[18px] font-semibold tracking-tight text-slate-900">{title}</p>
            <p className="text-[15px] text-slate-500">{body}</p>
            {status === "CANCELLED" ? null : (
              <p
                title={formatDeadlineExact(deadline)}
                className={cn(
                  "mt-0.5 text-[14px]",
                  overdue
                    ? "font-medium text-red-500"
                    : soon
                      ? "font-medium text-amber-500"
                      : "text-slate-500",
                )}
              >
                Deadline {formatDeadline(deadline)} · {relative?.label}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDraft ? (
            <Link to="/app/rfqs/$rfqId/edit" params={{ rfqId }} className="btn-secondary px-3.5 py-2 text-[15px]">
              Edit draft
            </Link>
          ) : null}
          {action ? (
            <button
              type="button"
              className="btn-primary px-4 py-2 text-[15px]"
              onClick={() => onGoTo(action.tab)}
            >
              {action.label}
            </button>
          ) : null}
        </div>
      </div>

    </section>
  );
}

/** Commercial terms: only what was filled in, collapsed until wanted. */
function CommercialTerms({ rfq }: { rfq: RfqView }) {
  const rows: Array<[string, string | null]> = [
    ["Payment terms", rfq.paymentTerms],
    ["OT charges", rfq.otCharges],
    ["Breakdown charges", rfq.breakdownTerms],
    ["Mobilisation & demobilisation", rfq.mobilisationTerms],
    ["Diesel scope", rfq.dieselScope],
    ["Working hours / shift", rfq.workingHoursShift],
    [
      "Crane age criteria",
      rfq.craneAgeCriteriaYears === null ? null : `${rfq.craneAgeCriteriaYears} years`,
    ],
    ["Accommodation & conveyance", rfq.accommodationConveyance],
    ["Support crane", rfq.supportCrane],
    ["Steel mats & ground prep", rfq.steelMatsGroundPrep],
    ["EHS / HR requirements", rfq.ehsHrRequirements],
    ["Insurance", rfq.insuranceTerms],
    ["Extension clause", rfq.extensionClause],
    ["Notes", rfq.notes],
  ];
  for (const term of extraTermRows(rfq.commercialTermsExtra)) {
    rows.push([term.label, term.value]);
  }
  const filled = rows.filter((row): row is [string, string] => Boolean(row[1]));
  const hasContact = Boolean(rfq.smlContactName || rfq.smlContactMobile || rfq.smlContactEmail);

  return (
    <details className="card group overflow-hidden" open={filled.length > 0 && filled.length <= 4}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-slate-900">Commercial terms</span>
        <span className="text-[14px] text-slate-500">
          {filled.length === 0 ? "None specified" : `${filled.length} specified`}
        </span>
      </summary>
      <div className="space-y-4 border-t border-ink-800 p-4">
        {filled.length > 0 ? (
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filled.map(([label, value]) => (
              <ReadOnlyValue key={label} label={label} value={value} />
            ))}
          </dl>
        ) : (
          <p className="text-sm text-slate-500">No commercial terms were added to this RFQ.</p>
        )}
        {hasContact ? (
          <div className="border-t border-ink-800 pt-3">
            <p className="text-xs font-medium text-slate-500">SML contact</p>
            <p className="mt-0.5 text-sm text-slate-900">
              {[rfq.smlContactName, rfq.smlContactMobile, rfq.smlContactEmail]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : null}
        {rfq.attachments.length > 0 ? (
          <div className="border-t border-ink-800 pt-3">
            <p className="text-xs font-medium text-slate-500">Attachments</p>
            <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
              {rfq.attachments.map((file) => (
                <li key={file.id}>{file.fileName}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

// --- audit trail -----------------------------------------------------------

const AUDIT_FIELD_LABELS: Record<string, string> = {
  submissionDeadline: "Deadline",
  capacityT: "Capacity",
  quantity: "Quantity",
  siteLocation: "Site",
  requiredStartDate: "Start date",
  notes: "Notes",
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** One human sentence per event, plus an optional line of detail beneath it. */
function describeAudit(
  event: RfqAuditEvent,
  names: Record<string, string>,
): { title: string; detail?: string; tone: "neutral" | "good" | "warn" | "bad" } {
  const value = (event.newValue ?? {}) as Record<string, unknown>;
  const vendor = (event.vendorId ? names[event.vendorId] : null) ??
    (typeof value.vendorId === "string" ? names[value.vendorId] : null) ??
    "A vendor";

  if (event.entity === "negotiation") {
    const total =
      typeof value.totalQuotedValue === "number"
        ? `₹${value.totalQuotedValue.toLocaleString("en-IN")}`
        : null;
    const round = value.roundNumber ? `round ${String(value.roundNumber)}` : null;
    const detail = [round, total].filter(Boolean).join(" · ") || undefined;
    switch (event.action) {
      case "counter_sml":
        return { title: `SML countered ${vendor}`, detail, tone: "neutral" };
      case "counter_vendor":
        return { title: `${vendor} sent a counter-offer`, detail, tone: "neutral" };
      case "log_vendor_offer":
        return {
          title: `${vendor}'s offer was logged from ${String(value.channel ?? "an offline channel").toLowerCase()}`,
          detail,
          tone: "neutral",
        };
      case "accept":
        return { title: `${vendor}'s offer was accepted`, detail, tone: "good" };
      case "reject":
        return {
          title: `SML rejected ${vendor}'s counter`,
          detail: asString(value.reason) ?? undefined,
          tone: "bad",
        };
      case "decline":
        return {
          title: `${vendor} declined the counter`,
          detail: asString(value.reason) ?? undefined,
          tone: "bad",
        };
      case "expire":
        return { title: `Negotiation with ${vendor} expired`, tone: "warn" };
      case "cancel":
        return { title: `Negotiation with ${vendor} was closed`, tone: "neutral" };
      default:
        return {
          title: `Negotiation with ${vendor}: ${event.action.replaceAll("_", " ")}`,
          detail,
          tone: "neutral",
        };
    }
  }

  if (event.entity === "quotation") {
    const total =
      typeof value.totalQuotedValue === "number"
        ? `₹${value.totalQuotedValue.toLocaleString("en-IN")}`
        : null;
    switch (event.action) {
      case "submit":
        return { title: `${vendor} submitted a quotation`, detail: total ?? undefined, tone: "good" };
      case "inbound_capture":
        return {
          title: `A quotation from ${vendor} was captured from ${String(value.source ?? "a reply").toLowerCase()}`,
          detail: total ?? undefined,
          tone: "good",
        };
      case "revise":
        return {
          title: `${vendor} revised their quotation to v${event.quotationVersion ?? "?"}`,
          detail: total ?? undefined,
          tone: "neutral",
        };
      case "award":
        return {
          title: `Quotation from ${vendor} was awarded`,
          detail: value.partial
            ? `Partial award: ${String(value.awardedCount)} of ${String(value.quantity)}`
            : "RFQ closed",
          tone: "good",
        };
      default:
        return { title: `${vendor}: quotation ${event.action.replaceAll("_", " ")}`, tone: "neutral" };
    }
  }

  switch (event.action) {
    case "create":
      return { title: "RFQ created", tone: "neutral" };
    case "update":
      return { title: "Draft edited", tone: "neutral" };
    case "confirm_site_pin":
    case "site_pin":
      return { title: "Job-site pin confirmed", tone: "neutral" };
    case "send": {
      const sent = Array.isArray(value.vendors)
        ? (value.vendors as Array<{ vendorName?: string; craneIds?: string[]; status?: string }>)
        : [];
      const failures = typeof value.failures === "number" ? value.failures : 0;
      return {
        title: `Sent to ${plural(sent.length || Number(value.recipients ?? 0), "vendor")}`,
        detail:
          sent.length > 0
            ? sent
                .map((entry) => {
                  const count = entry.craneIds?.length ?? 0;
                  return `${entry.vendorName ?? "Vendor"}${count ? ` (${plural(count, "crane")} tagged)` : ""}`;
                })
                .join(", ") + (failures > 0 ? ` · ${failures} failed to deliver` : "")
            : failures > 0
              ? `${failures} failed to deliver`
              : undefined,
        tone: failures > 0 ? "warn" : "good",
      };
    }
    case "viewed":
      return { title: `${vendor} opened the RFQ`, tone: "neutral" };
    case "decline":
      return {
        title: `${vendor} declined`,
        detail: [asString(value.reason), asString(value.note)].filter(Boolean).join(" · ") || undefined,
        tone: "bad",
      };
    case "remind": {
      const ids = Array.isArray(value.vendorIds) ? (value.vendorIds as string[]) : [];
      return {
        title: `Reminder sent to ${plural(Number(value.recipients ?? ids.length), "vendor")}`,
        detail: ids.length > 0 ? ids.map((id) => names[id] ?? "A vendor").join(", ") : undefined,
        tone: "neutral",
      };
    }
    case "extend_deadline":
    case "extend": {
      const next = asString(value.submissionDeadline) ?? asString(value.deadline);
      return {
        title: "Deadline extended",
        detail: [next ? `New deadline ${formatDateTime(next)}` : null, asString(value.reason)]
          .filter(Boolean)
          .join(" · ") || undefined,
        tone: "neutral",
      };
    }
    case "cancel":
      return { title: "RFQ cancelled", detail: asString(value.reason) ?? undefined, tone: "bad" };
    case "expire":
    case "expire_pending":
      return { title: "Pending vendors expired at the deadline", tone: "warn" };
    default: {
      const changed = Object.keys(value)
        .map((key) => AUDIT_FIELD_LABELS[key] ?? null)
        .filter(Boolean);
      return {
        title: event.action.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()),
        detail: changed.length > 0 ? changed.join(", ") : undefined,
        tone: "neutral",
      };
    }
  }
}

/**
 * Everything that has happened to this RFQ, in place. It reads the same audit
 * log the rest of the portal writes to, so nothing here is a second source of
 * truth that could drift from what was actually recorded.
 */
function AuditTrailSection({ rfqId, active }: { rfqId: string; active: boolean }) {
  const audit = useQuery({
    queryKey: ["rfq-audit", rfqId],
    queryFn: () => getRfqAudit(rfqId),
    enabled: active,
    refetchOnMount: "always",
  });

  const events = audit.data?.events ?? [];
  const names = audit.data?.vendorNames ?? {};
  const dots = {
    neutral: "bg-slate-400",
    good: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-red-500",
  } as const;

  return (
    <Section
      title="Audit trail"
      description="Every action on this RFQ, newest first: who did it and when."
    >
      {audit.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading the audit trail
        </div>
      ) : audit.error ? (
        <Alert title="Could not load the audit trail">{(audit.error as Error).message}</Alert>
      ) : events.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing has been recorded for this RFQ yet.</p>
      ) : (
        <ol className="relative space-y-0 border-l border-ink-800 pl-6">
          {events.map((event) => {
            const info = describeAudit(event, names);
            return (
              <li key={event.id} className="relative pb-5 last:pb-0">
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-1.5 -left-[31px] size-2.5 rounded-full ring-4 ring-ink-850",
                    dots[info.tone],
                  )}
                />
                <p className="text-[15px] font-medium text-slate-900">{info.title}</p>
                {info.detail ? (
                  <p className="mt-0.5 text-[14px] text-slate-600">{info.detail}</p>
                ) : null}
                <p className="mt-0.5 text-[13px] text-slate-500">
                  {formatDateTime(event.at)}
                  {event.actor ? ` · ${event.actor}` : ""}
                  {event.onBehalfOfVendor ? " · on behalf of the vendor" : ""}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
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
  onAudit,
}: {
  rfqId: string;
  isDraft: boolean;
  isSent: boolean;
  isCancelled: boolean;
  onCancel: () => void;
  onExtend: () => void;
  onAudit: () => void;
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

      <button type="button" className={quiet} onClick={onAudit}>
        Audit trail
      </button>

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
const SOURCE_LABELS: Record<string, string> = {
  PORTAL: "Portal",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  MANUAL: "Manual",
  NEGOTIATED: "Negotiated",
};

function money(value: number): string {
  return value.toLocaleString("en-IN");
}

function QuotationsSection({
  rfqId,
  quotations,
  canAward,
  canCounter,
  negotiatingQuotationIds,
  closed,
  deadlinePassed,
  startDateTbc,
  defaultStartDate,
  onDone,
}: {
  rfqId: string;
  quotations: ReceivedQuotation[];
  canAward: boolean;
  canCounter: boolean;
  negotiatingQuotationIds: Set<string>;
  closed: boolean;
  deadlinePassed: boolean;
  startDateTbc: boolean;
  defaultStartDate: string;
  onDone: () => void;
}) {
  const [awarding, setAwarding] = useState<ReceivedQuotation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Current offers first, cheapest on top; superseded versions sink to the end.
  const sorted = [...quotations].sort((left, right) => {
    if (left.isLatest !== right.isLatest) return left.isLatest ? -1 : 1;
    return left.totalQuotedValue - right.totalQuotedValue;
  });
  const current = sorted.filter((quotation) => quotation.isLatest);
  const lowestId =
    current.length > 1 ? current[0]?.quotationId : null;
  const superseded = sorted.filter((quotation) => !quotation.isLatest);

  const renderActions = (quotation: ReceivedQuotation) => {
    const awardable = quotation.isLatest && quotation.status === "SUBMITTED";
    return (
      <>
        {canCounter && !closed && !deadlinePassed ? (
          <CounterButton
            rfqId={rfqId}
            quotation={quotation}
            disabled={!awardable || negotiatingQuotationIds.has(quotation.quotationId)}
            disabledReason={
              negotiatingQuotationIds.has(quotation.quotationId)
                ? "This quotation already has an open negotiation — respond in Negotiations above"
                : undefined
            }
            onDone={onDone}
          />
        ) : null}
        {canAward && !closed ? (
          <button
            type="button"
            className="btn-primary px-4 py-2 text-[15px]"
            disabled={!awardable}
            title={awardable ? undefined : "Only the latest Submitted version can be awarded"}
            onClick={() => {
              setNotice(null);
              setAwarding(quotation);
            }}
          >
            Award this quotation
          </button>
        ) : null}
      </>
    );
  };

  return (
    <div className="space-y-4">
      {notice ? (
        <Alert tone="success" title="Awarded">
          {notice}
        </Alert>
      ) : null}

      {quotations.length === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-[16px] font-medium text-slate-900">No quotations yet</p>
          <p className="mt-1 text-sm text-slate-500">
            They appear here as vendors submit them.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[17px] font-semibold text-slate-900">
              {current.length} quotation{current.length === 1 ? "" : "s"}
              <span className="ml-2 text-[14px] font-normal text-slate-500">
                {closed ? "This RFQ is finalised." : "Lowest total first."}
              </span>
            </h2>
          </div>

          {current.length > 0 ? (
            <QuoteComparisonTable
              quotations={current}
              lowestId={lowestId ?? null}
              sourceLabel={(quotation) => SOURCE_LABELS[quotation.source] ?? "Manual"}
              renderActions={renderActions}
            />
          ) : null}

          {superseded.length > 0 ? (
            <details className="group">
              <summary className="cursor-pointer text-[14px] font-medium text-slate-500 hover:text-slate-900">
                Superseded versions ({superseded.length})
                <span className="ml-2 text-[13px] font-normal text-slate-500">
                  Older quotes kept for the record — only the latest version can be countered or
                  awarded.
                </span>
              </summary>
              <div className="mt-2">
                <QuoteComparisonTable
                  quotations={superseded}
                  lowestId={null}
                  sourceLabel={(quotation) => SOURCE_LABELS[quotation.source] ?? "Manual"}
                  renderActions={renderActions}
                  muted
                />
              </div>
            </details>
          ) : null}
        </>
      )}

      {awarding ? (
        <AwardDialog
          rfqId={rfqId}
          quotation={awarding}
          startDateTbc={startDateTbc}
          defaultStartDate={defaultStartDate}
          onClose={() => setAwarding(null)}
          onDone={(message) => {
            setAwarding(null);
            setNotice(message);
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Awarding is final, so it gets its own confirmation instead of a form wedged
 * into a table cell. Rendered inside the page (not a portal) so it follows this
 * screen's light/dark choice.
 */
function AwardDialog({
  rfqId,
  quotation,
  startDateTbc,
  defaultStartDate,
  onClose,
  onDone,
}: {
  rfqId: string;
  quotation: ReceivedQuotation;
  startDateTbc: boolean;
  defaultStartDate: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState(startDateTbc ? defaultStartDate : "");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const award = useMutation({
    mutationFn: () =>
      awardQuotation(rfqId, quotation.quotationId, {
        reason,
        dates: startDateTbc ? { startDate, endDate } : undefined,
      }),
    onSuccess: (result) => {
      const detail = result.result.partial
        ? `Partial award (${result.result.awardedCount} of ${result.result.quantity}); the other quotations stay open.`
        : `${result.result.notAwardedCount} other quotation(s) marked Not Awarded and the RFQ finalised.`;
      onDone(
        `${detail} ${result.result.notifiedAwarded} award email(s) and ${result.result.notifiedNotAwarded} not-awarded email(s) sent.`,
      );
    },
  });

  const datesMissing = startDateTbc && (startDate === "" || endDate === "");

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[1px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="award-title"
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-800 bg-ink-900 shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-800 px-6 py-4">
          <div className="min-w-0">
            <h2 id="award-title" className="text-[18px] font-semibold text-slate-900">
              Award to {quotation.vendorName}
            </h2>
            <p className="mt-0.5 text-[14px] text-slate-500">
              {quotation.craneDescription} · ₹{money(quotation.totalQuotedValue)}{" "}
              {quotation.taxBasis === "INCLUSIVE_OF_GST" ? "incl. GST" : "excl. GST"}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-ink-800 bg-ink-850 text-slate-500 hover:text-slate-900"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-6 py-5">
          <ul className="space-y-1.5 text-[15px] text-slate-600">
            <li>• Reserves the crane for the requirement window</li>
            <li>• Emails the vendor about the award</li>
            <li>• Other quotations stay open until the full quantity is awarded</li>
          </ul>

          {startDateTbc ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reservation start" htmlFor="award-start" required>
                <TextInput id="award-start" type="date" value={startDate} onChange={setStartDate} />
              </Field>
              <Field label="Reservation end" htmlFor="award-end" required>
                <TextInput id="award-end" type="date" value={endDate} onChange={setEndDate} />
              </Field>
            </div>
          ) : null}

          <Field label="Remarks" htmlFor="award-reason" hint="Optional. Included in the emails.">
            <TextArea id="award-reason" value={reason} onChange={setReason} rows={2} />
          </Field>

          {award.isError ? (
            <Alert title="Not awarded">{(award.error as Error).message}</Alert>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-800 bg-ink-850 px-6 py-3">
          <button type="button" className="btn-secondary px-4 py-2 text-[15px]" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-[15px]"
            onClick={() => award.mutate()}
            disabled={award.isPending || datesMissing}
          >
            {award.isPending ? <Spinner /> : null}
            Confirm award
          </button>
        </div>
      </div>
    </div>
  );
}

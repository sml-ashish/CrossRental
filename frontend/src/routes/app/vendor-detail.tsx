import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Pencil, Plus, Send, ShieldCheck } from "lucide-react";
import {
  approveVendor,
  DOCUMENT_LABELS,
  downloadDocument,
  loadVendorDetail,
  rejectVendor,
  resendActivation,
} from "@/lib/onboarding";
import { listCranes } from "@/lib/fleet";
import { getVendorInsights } from "@/lib/vendorInsights";
import { reinstateVendor, suspendVendor } from "@/lib/admin";
import {
  MASTER_LIST_LABELS,
  SAP_MASTER_LIST_KEYS,
  loadMasterLists,
  type SapMasterListKey,
} from "@/lib/settings";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { Field, ReadOnlyValue, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { ForbiddenNotice } from "@/components/guards";
import { BulkCraneUpload } from "@/components/crane-bulk-upload";
import { BulkLoadCharts } from "@/components/bulk-load-charts";
import { ApiError } from "@/lib/api";

/**
 * The registration detail screen behind an approval decision (brief 7.3).
 *
 * The bank block is the reason this file is careful about roles. Only an admin
 * receives the decrypted account number and IFSC; for a sales user the backend
 * omits them entirely, so there is nothing here to hide — `bankVisible` is false
 * and the section is simply not rendered.
 */

const FACILITY_OPTIONS = [
  { value: "ADEQUATE", label: "Adequate" },
  { value: "NOT_ADEQUATE", label: "Not adequate" },
  { value: "NEEDS_IMPROVEMENT", label: "Needs improvement" },
] as const;

const MANPOWER_OPTIONS = [
  { value: "ADEQUATE", label: "Adequate" },
  { value: "NOT_ADEQUATE", label: "Not adequate" },
] as const;

export function VendorDetailPage() {
  const { vendorId } = useParams({ from: "/app/vendors/$vendorId" });

  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [sapVendorCode, setSapVendorCode] = useState("");
  const [adminRemarks, setAdminRemarks] = useState("");
  const [rejectionRemarks, setRejectionRemarks] = useState("");
  const [facilityStatus, setFacilityStatus] = useState("");
  const [manpowerStatus, setManpowerStatus] = useState("");
  const [improvementRequirement, setImprovementRequirement] = useState("");
  const [improvementPeriod, setImprovementPeriod] = useState("");
  // SAP office-use master-list picks (phase D3). Business vertical is excluded:
  // it is chosen on an enquiry, not on a vendor's SAP sheet.
  const [masterPicks, setMasterPicks] = useState<
    Record<SapMasterListKey, string>
  >({
    VENDOR_ORIGIN: "",
    VENDOR_TYPE: "",
    PURCHASE_ORG: "",
    PAYMENT_TERM: "",
    WITHHOLDING_TAX_TYPE: "",
    LEGAL_FORM: "",
  });
  const [suspendReason, setSuspendReason] = useState("");
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["vendors", "detail", vendorId],
    queryFn: () => loadVendorDetail(vendorId),
  });

  // The options come from admin-editable lists and may be empty; the selects
  // then only offer "Not set", which is the honest state until the owner's SAP
  // values are entered on the settings screen.
  //
  // Reading those lists needs the approve capability, so a sales user — who may
  // open this screen to see the fleet — must not ask for them. Without the
  // guard the page fires a request the backend rightly refuses, and the failed
  // call shows up as noise in the console on a page that is otherwise fine.
  const masterLists = useQuery({
    queryKey: ["settings", "master-lists"],
    queryFn: loadMasterLists,
    enabled: detail.data?.canApprove === true,
  });

  const pickFor = (key: SapMasterListKey) => ({
    value: masterPicks[key],
    onChange: (value: string) => setMasterPicks((prev) => ({ ...prev, [key]: value })),
    options: (masterLists.data?.[key] ?? []).map((v) => ({ value: v, label: v })),
  });

  const officeUse = {
    facilityStatus,
    manpowerStatus,
    improvementRequirement,
    improvementPeriod,
    vendorOrigin: masterPicks.VENDOR_ORIGIN,
    vendorType: masterPicks.VENDOR_TYPE,
    purchaseOrg: masterPicks.PURCHASE_ORG,
    paymentTerm: masterPicks.PAYMENT_TERM,
    withholdingTaxType: masterPicks.WITHHOLDING_TAX_TYPE,
    legalForm: masterPicks.LEGAL_FORM,
  };

  // Brief D1: an SML user opens any approved vendor's fleet and maintains it
  // with the same forms, on the vendor's behalf.
  const fleet = useQuery({
    queryKey: ["fleet", "list", "vendor", vendorId],
    queryFn: () => listCranes({ vendorId, includeInactive: true }),
  });

  // P4 BPD 6.10: the discovery view — categories and RFQ participation. Bank
  // details are not in this payload at all, so sales cannot reach them here.
  const insights = useQuery({
    queryKey: ["vendors", "insights", vendorId],
    queryFn: () => getVendorInsights(vendorId),
  });

  const approve = useMutation({
    mutationFn: () =>
      approveVendor(vendorId, {
        sapVendorCode: sapVendorCode.trim(),
        adminRemarks: adminRemarks.trim(),
        officeUse,
      }),
    onSuccess: async (result) => {
      setDecision(null);
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
      if (!result.activationEmailSent) {
        // The backend only reports this when it had to unwind after the fact,
        // so it is worth surfacing rather than silently reloading.
        window.alert(
          "The vendor was approved but the activation email did not send. Use Resend on the queue.",
        );
      }
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectVendor(vendorId, { remarks: rejectionRemarks.trim() }),
    onSuccess: async () => {
      setDecision(null);
      setRejectionRemarks("");
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
  });

  const resend = useMutation({
    mutationFn: () => resendActivation(vendorId),
    onSuccess: (result) =>
      window.alert(result.sent ? "A fresh activation link has been emailed." : "The email did not send."),
  });

  // P0 B2: suspend or reinstate the whole vendor from its detail screen.
  const suspend = useMutation({
    mutationFn: () => suspendVendor(vendorId, suspendReason.trim()),
    onSuccess: async () => {
      setSuspendReason("");
      setConfirmSuspend(false);
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
  });

  const reinstate = useMutation({
    mutationFn: () => reinstateVendor(vendorId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading registration
      </div>
    );
  }

  if (detail.error) {
    const error = detail.error as ApiError;
    if (error.isForbidden) {
      return <ForbiddenNotice>Your account cannot view vendor registrations.</ForbiddenNotice>;
    }
    return <Alert title="Could not load this registration">{error.message}</Alert>;
  }

  if (!detail.data) return null;

  const { vendor, missingDocuments, canApprove } = detail.data;
  const anyDecisionError = approve.error ?? reject.error;
  const deciding = approve.isPending || reject.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: "/app/approvals", label: "Back to approvals" }}
        title={vendor.name ?? "(no name yet)"}
        description={
          <>
            {vendor.sapVendorCode ? (
              <span className="font-mono">Vendor code {vendor.sapVendorCode}</span>
            ) : (
              "No vendor code assigned yet"
            )}
            {vendor.approvedAt
              ? ` · approved ${new Date(vendor.approvedAt).toLocaleDateString()}`
              : ""}
          </>
        }
        meta={<StatusBadge status={vendor.onboardingStatus} />}
        actions={
          <>
            {canApprove ? (
              <Link
                to="/app/vendors/$vendorId/sap-sheet"
                params={{ vendorId }}
                className="btn-secondary"
              >
                <FileSpreadsheet className="size-4" aria-hidden />
                SAP creation sheet
              </Link>
            ) : null}
            {canApprove && vendor.onboardingStatus === "APPROVED" ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => resend.mutate()}
                disabled={resend.isPending}
              >
                {resend.isPending ? <Spinner /> : <Send className="size-4" aria-hidden />}
                Resend activation link
              </button>
            ) : null}
          </>
        }
      />

      {missingDocuments.length > 0 ? (
        <Alert tone="info" title="Required documents outstanding">
          {missingDocuments.map((docType) => DOCUMENT_LABELS[docType] ?? docType).join(", ")}. The
          registration cannot be approved until all three are uploaded.
        </Alert>
      ) : null}

      {vendor.onboardingStatus === "REJECTED" && vendor.adminRemarks ? (
        <Alert title="Rejected">
          <p className="whitespace-pre-wrap">{vendor.adminRemarks}</p>
          <p className="mt-1.5 text-xs">
            The vendor can correct and resubmit through the original invitation link.
          </p>
        </Alert>
      ) : null}

      {anyDecisionError ? (
        <Alert title="That decision was not saved">
          {(anyDecisionError as Error).message}
        </Alert>
      ) : null}

      {canApprove && vendor.onboardingStatus === "APPROVED" ? (
        <Section title="Vendor access">
          {vendor.suspendedAt ? (
            <>
              <Alert tone="error" title="Suspended">
                <p>
                  This vendor cannot sign in or receive RFQs.
                  {vendor.suspendedAt
                    ? ` Suspended on ${new Date(vendor.suspendedAt).toLocaleDateString()}.`
                    : ""}
                </p>
                {vendor.suspendReason ? (
                  <p className="mt-1 whitespace-pre-wrap">{vendor.suspendReason}</p>
                ) : null}
              </Alert>
              <button
                type="button"
                className="btn-primary mt-3"
                onClick={() => reinstate.mutate()}
                disabled={reinstate.isPending}
              >
                {reinstate.isPending ? <Spinner /> : null}
                Reinstate vendor
              </button>
            </>
          ) : confirmSuspend ? (
            <>
              <Field
                label="Reason (optional)"
                htmlFor="suspend-reason"
                hint="Recorded in the audit trail and shown above while suspended."
              >
                <TextArea
                  id="suspend-reason"
                  value={suspendReason}
                  onChange={setSuspendReason}
                  rows={3}
                />
              </Field>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => suspend.mutate()}
                  disabled={suspend.isPending}
                >
                  {suspend.isPending ? <Spinner /> : null}
                  Confirm suspension
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setConfirmSuspend(false)}
                  disabled={suspend.isPending}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">
                Suspending blocks sign-in and removes the vendor from RFQ lists until
                reinstated.
              </p>
              <button
                type="button"
                className="btn-secondary mt-3"
                onClick={() => setConfirmSuspend(true)}
              >
                Suspend vendor
              </button>
            </>
          )}

          {suspend.isError ? (
            <Alert tone="error">{(suspend.error as Error).message}</Alert>
          ) : null}
          {reinstate.isError ? (
            <Alert tone="error">{(reinstate.error as Error).message}</Alert>
          ) : null}
        </Section>
      ) : null}

      <Section title="Company">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue label="Legal name" value={vendor.name ?? ""} />
          <ReadOnlyValue label="Nature of company" value={vendor.natureOfCompany ?? ""} />
          <ReadOnlyValue label="Email" value={vendor.email ?? ""} />
          <ReadOnlyValue label="Telephone" value={vendor.telephone ?? ""} />
          <ReadOnlyValue label="Fax" value={vendor.fax ?? ""} />
          <ReadOnlyValue label="Weekly off" value={vendor.weeklyOffDays ?? ""} />
          <ReadOnlyValue label="Company size" value={vendor.companySize ?? ""} />
          <div className="sm:col-span-2">
            <ReadOnlyValue
              label="Address"
              value={[
                vendor.addressLine1,
                vendor.addressLine2,
                [vendor.city, vendor.district, vendor.addressState?.name, vendor.pincode]
                  .filter(Boolean)
                  .join(" "),
              ]
                .filter(Boolean)
                .join(", ")}
            />
          </div>
          <ReadOnlyValue
            label="Operating regions"
            value={vendor.operatingRegions.join(", ")}
          />
        </dl>
      </Section>

      <Section title="Registration">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue label="PAN" value={vendor.pan ?? ""} mono />
          <ReadOnlyValue label="TAN" value={vendor.tan ?? ""} mono />
          <ReadOnlyValue label="CIN" value={vendor.cin ?? ""} mono />
          <ReadOnlyValue
            label="GST-registered"
            value={vendor.gstRegistered === true ? "Yes" : vendor.gstRegistered === false ? "No" : "—"}
          />
          <ReadOnlyValue label="GSTIN" value={vendor.gstn ?? ""} mono />
          <ReadOnlyValue
            label="GST registration type"
            value={(vendor.gstRegistrationType ?? "").replace(/_/g, " ").toLowerCase()}
          />
          <ReadOnlyValue label="GSTR-1 frequency" value={vendor.gstr1FilingFrequency ?? ""} />
          <ReadOnlyValue
            label="MSME-registered"
            value={vendor.msmeRegistered === true ? "Yes" : vendor.msmeRegistered === false ? "No" : "—"}
          />
          <ReadOnlyValue
            label="MSME category / reg. no."
            value={[vendor.msmeCategory, vendor.msmeRegNo].filter(Boolean).join(" · ")}
          />
          <ReadOnlyValue
            label="MSME exemption date"
            value={vendor.msmeExemptionDate ? new Date(vendor.msmeExemptionDate).toLocaleDateString() : ""}
          />
          <ReadOnlyValue
            label="Lower TDS deduction"
            value={vendor.tdsLowerDeduction === true ? "Yes" : vendor.tdsLowerDeduction === false ? "No" : "—"}
          />
          {vendor.tdsLowerDeduction ? (
            <>
              <ReadOnlyValue
                label="TDS certificate"
                value={[vendor.tdsCertificateNo, vendor.tdsValidFrom, vendor.tdsValidTo].filter(Boolean).join(" · ")}
              />
              <ReadOnlyValue
                label="TDS section / rate"
                value={[vendor.tdsSection, vendor.tdsRatePercent === 0 ? "0%" : vendor.tdsRatePercent ? `${vendor.tdsRatePercent}%` : ""].filter(Boolean).join(" · ")}
              />
            </>
          ) : null}
          <ReadOnlyValue
            label="Government registration"
            value={
              vendor.govtRegistrationType
                ? `${vendor.govtRegistrationType} ${vendor.govtRegistrationNo ?? ""}`.trim()
                : ""
            }
          />
        </dl>
        <div>
          <p className="text-xs font-medium text-slate-500">Fleet summary</p>
          <p className="mt-1 text-sm text-slate-800">{vendor.fleetSummary || "—"}</p>
        </div>
      </Section>

      <Section title="Contacts">
        <ul className="divide-y divide-ink-800">
          {vendor.contacts.map((contact, index) => (
            <li key={index} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {contact.name}
                  {contact.isPrimary ? (
                    <span className="ml-2">
                      <Badge tone="blue">Primary</Badge>
                    </span>
                  ) : null}
                  {contact.receivesRfqs ? (
                    <span className="ml-2">
                      <Badge tone="emerald">Receives RFQs</Badge>
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-slate-500">{contact.email || "—"}</p>
              </div>
              <p className="text-sm text-slate-600">{contact.mobile || "—"}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Participation"
        description="From RFQ invitations only — invitations, quotes and awards. Not a performance score."
      >
        {insights.isPending ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading participation
          </div>
        ) : insights.isError ? (
          <Alert title="Could not load participation">{(insights.error as Error).message}</Alert>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-4">
            <ReadOnlyValue label="RFQs received" value={String(insights.data.profile.rfqsReceived)} />
            <ReadOnlyValue
              label="Quotations submitted"
              value={String(insights.data.profile.quotationsSubmitted)}
            />
            <ReadOnlyValue
              label="Invitations"
              value={String(insights.data.profile.participation.invitations)}
            />
            <ReadOnlyValue label="Quoted" value={String(insights.data.profile.participation.quoted)} />
            <ReadOnlyValue label="Awarded" value={String(insights.data.profile.participation.awarded)} />
            <ReadOnlyValue
              label="Responsiveness"
              value={
                insights.data.profile.participation.responsivenessPct === null
                  ? "—"
                  : `${insights.data.profile.participation.responsivenessPct}%`
              }
            />
            <ReadOnlyValue
              label="Win ratio"
              value={
                insights.data.profile.participation.winPct === null
                  ? "—"
                  : `${insights.data.profile.participation.winPct}%`
              }
            />
            <ReadOnlyValue
              label="Categories"
              value={insights.data.profile.categories.map((c) => c.name).join(", ")}
            />
          </dl>
        )}
      </Section>

      <Section
        title="Fleet"
        description="Maintain this vendor's cranes here. Any change you make is recorded as on the vendor's behalf and they are notified."
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {fleet.isLoading
              ? "Loading cranes…"
              : `${fleet.data?.cranes.length ?? 0} crane${
                  (fleet.data?.cranes.length ?? 0) === 1 ? "" : "s"
                }`}
          </p>
          {vendor.onboardingStatus === "APPROVED" ? (
            <div className="flex flex-wrap items-center gap-2">
              <BulkCraneUpload vendorId={vendorId} vendorName={vendor.name ?? "this vendor"} />
              <BulkLoadCharts vendorId={vendorId} cranes={fleet.data?.cranes ?? []} />
              <Link
                to="/app/fleet/new"
                search={{ vendorId, duplicate: undefined }}
                className="btn-secondary px-3 py-2 text-sm"
              >
                <Plus className="size-4" aria-hidden />
                Add crane
              </Link>
            </div>
          ) : null}
        </div>

        {fleet.isError ? (
          <Alert title="Could not load this vendor's fleet">
            {(fleet.error as Error).message}
          </Alert>
        ) : !fleet.isLoading && (fleet.data?.cranes.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500">No cranes on record for this vendor.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {fleet.data?.cranes.map((crane) => (
              <li
                key={crane.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-slate-900">
                      {crane.serialRegistrationNo}
                    </span>
                    <StatusBadge status={crane.currentStatus} />
                    {!crane.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
                    {crane.updatedOnBehalf ? (
                      <Badge tone="blue">SML on behalf</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {crane.make} {crane.model} · {crane.capacityT}T · {crane.currentLocation}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Data last confirmed {new Date(crane.statusUpdatedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to="/app/cranes/$craneId"
                    params={{ craneId: crane.id }}
                    className="btn-secondary px-3 py-2 text-sm"
                  >
                    Detail
                  </Link>
                  <Link
                    to="/app/fleet/$craneId/edit"
                    params={{ craneId: crane.id }}
                    search={{ vendorId }}
                    className="btn-secondary px-3 py-2 text-sm"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    Edit
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {vendor.bankVisible ? (
        <Section
          title="Bank details"
          description="Decrypted for your review. Never shown to sales users."
        >
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <ReadOnlyValue label="Account holder" value={vendor.bankAccountHolderName ?? ""} />
            <ReadOnlyValue label="Bank" value={vendor.bankName ?? ""} />
            <ReadOnlyValue label="Branch" value={vendor.bankBranch ?? ""} />
            <ReadOnlyValue label="Account type" value={vendor.bankAccountType ?? ""} />
            <ReadOnlyValue label="Account number" value={vendor.bankAccountNo ?? ""} mono />
            <ReadOnlyValue label="IFSC" value={vendor.bankIfsc ?? ""} mono />
            <ReadOnlyValue label="MICR" value={vendor.bankMicr ?? ""} mono />
            <ReadOnlyValue label="IBAN" value={vendor.bankIban ?? ""} mono />
            <ReadOnlyValue label="SWIFT" value={vendor.bankSwift ?? ""} mono />
          </dl>
        </Section>
      ) : null}

      {vendor.communicationNotes ? (
        <Section title="Communication preferences">
          <ReadOnlyValue label="Notes" value={vendor.communicationNotes} />
        </Section>
      ) : null}

      <Section title="Documents">
        {vendor.documents.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing uploaded yet.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {vendor.documents.map((doc) => (
              <li key={`${doc.docType}-${doc.uploadedAt}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {doc.label ?? DOCUMENT_LABELS[doc.docType] ?? doc.docType}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {doc.fileName} · {new Date(doc.uploadedAt).toLocaleDateString()}
                  </p>
                </div>
                {canApprove ? (
                  <button
                    type="button"
                    className="btn-secondary px-2.5 py-1.5 text-xs"
                    onClick={() =>
                      void downloadDocument(
                        `/vendors/${vendorId}/documents/${doc.docType}`,
                      ).then(({ blob, fileName }) => {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = fileName;
                        link.click();
                        URL.revokeObjectURL(url);
                      })
                    }
                  >
                    <Download className="size-3.5" aria-hidden />
                    Download
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Declaration">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <ReadOnlyValue
            label="Code of conduct"
            value={vendor.codeOfConductAccepted ? "Accepted" : "Not accepted"}
          />
          <ReadOnlyValue label="Declared by" value={vendor.declarationName ?? ""} />
          <ReadOnlyValue label="Designation" value={vendor.declarationDesignation ?? ""} />
          <ReadOnlyValue
            label="Date"
            value={vendor.declarationDate ? new Date(vendor.declarationDate).toLocaleDateString() : ""}
          />
        </dl>
      </Section>

      <Section title="History">
        {vendor.decisions.length === 0 ? (
          <p className="text-sm text-slate-500">No decisions recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {vendor.decisions.map((item) => (
              <li key={item.id} className="border-l-2 border-slate-200 pl-3">
                <div className="flex items-center gap-2">
                  <Badge tone={item.outcome === "APPROVED" ? "emerald" : "red"}>{item.outcome}</Badge>
                  <span className="text-xs text-slate-500">
                    {new Date(item.createdAt).toLocaleString()} ·{" "}
                    {item.decidedBy?.fullName ?? item.decidedBy?.email ?? "Unknown"}
                  </span>
                </div>
                {item.remarks ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{item.remarks}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canApprove ? (
        <Section title="Office use — for SML staff only">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Facility status" htmlFor="facilityStatus">
              <Select
                id="facilityStatus"
                value={facilityStatus}
                onChange={setFacilityStatus}
                options={FACILITY_OPTIONS}
                placeholder="Not reviewed"
              />
            </Field>
            <Field label="Manpower status" htmlFor="manpowerStatus">
              <Select
                id="manpowerStatus"
                value={manpowerStatus}
                onChange={setManpowerStatus}
                options={MANPOWER_OPTIONS}
                placeholder="Not reviewed"
              />
            </Field>
            <Field label="Improvement required" htmlFor="improvementRequirement" className="sm:col-span-2">
              <TextArea
                id="improvementRequirement"
                value={improvementRequirement}
                onChange={setImprovementRequirement}
                placeholder="e.g. Quarantine area must be fenced."
              />
            </Field>
            <Field label="Improvement period" htmlFor="improvementPeriod">
              <TextInput
                id="improvementPeriod"
                value={improvementPeriod}
                onChange={setImprovementPeriod}
                placeholder="e.g. 30 days"
              />
            </Field>
            {SAP_MASTER_LIST_KEYS.map((key) => {
              const pick = pickFor(key);
              return (
                <Field
                  key={key}
                  label={MASTER_LIST_LABELS[key]}
                  htmlFor={`master-${key}`}
                  hint={pick.options.length === 0 ? "No options yet — add them in Settings." : undefined}
                >
                  <Select
                    id={`master-${key}`}
                    value={pick.value}
                    onChange={pick.onChange}
                    options={pick.options}
                    placeholder="Not set"
                  />
                </Field>
              );
            })}
            <Field label="SAP vendor code" htmlFor="sapVendorCode" hint="Optional. Must be unique.">
              <TextInput
                id="sapVendorCode"
                value={sapVendorCode}
                onChange={setSapVendorCode}
                className="font-mono"
                placeholder="e.g. 10004567"
              />
            </Field>
          </div>
        </Section>
      ) : null}

      {canApprove && vendor.onboardingStatus === "SUBMITTED" ? (
        decision === null ? (
          <Panel
            title="Decision"
            description="Approving creates the vendor's portal login and emails an activation link."
            actions={
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setDecision("reject")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setDecision("approve")}
                >
                  <ShieldCheck className="size-4" aria-hidden />
                  Approve
                </button>
              </>
            }
          >
            <p className="text-xs text-slate-500">
              Approving cannot be undone from here; a suspended vendor can be reinstated later.
            </p>
          </Panel>
        ) : (
          <Panel
            title={decision === "approve" ? "Approve this registration" : "Reject this registration"}
            description={
              decision === "approve"
                ? "The office-use fields above are saved with the approval."
                : "The vendor is told the reason, so write it for them to read."
            }
          >
            {decision === "approve" ? (
              <>
                <Field label="Remarks" htmlFor="approve-remarks" hint="Optional. Kept in the history.">
                  <TextArea
                    id="approve-remarks"
                    value={adminRemarks}
                    onChange={setAdminRemarks}
                    placeholder="e.g. Verified against the cheque and PAN."
                  />
                </Field>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => approve.mutate()}
                    disabled={deciding || missingDocuments.length > 0}
                  >
                    {approve.isPending ? <Spinner /> : null}
                    Confirm approval
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setDecision(null)}
                    disabled={deciding}
                  >
                    Cancel
                  </button>
                </div>
                {missingDocuments.length > 0 ? (
                  <p className="text-xs font-medium text-amber-700">
                    Waiting on {missingDocuments.length} required document
                    {missingDocuments.length === 1 ? "" : "s"}.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <Field
                  label="Remarks"
                  htmlFor="reject-remarks"
                  required
                  hint="Required. Emailed to the vendor, who can then correct and resubmit."
                >
                  <TextArea
                    id="reject-remarks"
                    value={rejectionRemarks}
                    onChange={setRejectionRemarks}
                    placeholder="e.g. The cancelled cheque is not legible."
                    invalid={reject.isError && rejectionRemarks.trim() === ""}
                  />
                </Field>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => reject.mutate()}
                    disabled={deciding || rejectionRemarks.trim() === ""}
                  >
                    {reject.isPending ? <Spinner /> : null}
                    Confirm rejection
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setDecision(null)}
                    disabled={deciding}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </Panel>
        )
      ) : null}
    </div>
  );
}
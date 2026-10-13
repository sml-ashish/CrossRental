import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Send, ShieldCheck } from "lucide-react";
import {
  approveVendor,
  DOCUMENT_LABELS,
  downloadDocument,
  loadVendorDetail,
  rejectVendor,
  resendActivation,
} from "@/lib/onboarding";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Field, ReadOnlyValue, Section, Select, TextArea, TextInput } from "@/components/ui/form";
import { ForbiddenNotice } from "@/components/guards";
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

  const queryClient = useQueryClient();

  const officeUse = {
    facilityStatus,
    manpowerStatus,
    improvementRequirement,
    improvementPeriod,
  };

  const detail = useQuery({
    queryKey: ["vendors", "detail", vendorId],
    queryFn: () => loadVendorDetail(vendorId),
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
      <div>
        <Link
          to="/app/approvals"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to approvals
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold text-slate-900">{vendor.name ?? "(no name yet)"}</h1>
            <StatusBadge status={vendor.onboardingStatus} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {vendor.sapVendorCode ? (
              <span className="font-mono">Vendor code {vendor.sapVendorCode}</span>
            ) : (
              "No vendor code assigned yet"
            )}
            {vendor.approvedAt
              ? ` · approved ${new Date(vendor.approvedAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>

        {canApprove && vendor.onboardingStatus === "APPROVED" ? (
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
          >
            {resend.isPending ? <Spinner /> : <Send className="size-4" aria-hidden />}
            Resend activation link
          </button>
        ) : null}
      </header>

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
            <ReadOnlyValue label="Registered address" value={vendor.registeredAddress ?? ""} />
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
          <ReadOnlyValue label="GSTIN" value={vendor.gstn ?? ""} mono />
          <ReadOnlyValue label="TAN" value={vendor.tan ?? ""} mono />
          <ReadOnlyValue label="CIN" value={vendor.cin ?? ""} mono />
          <ReadOnlyValue label="MSME category" value={vendor.msmeCategory ?? ""} />
          <ReadOnlyValue label="GSTR-1 frequency" value={vendor.gstr1FilingFrequency ?? ""} />
          <ReadOnlyValue
            label="GST composition"
            value={vendor.gstCompositionOpted ? "Opted in" : "No"}
          />
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
        <ul className="divide-y divide-slate-100">
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
                </p>
                <p className="truncate text-xs text-slate-500">{contact.email || "—"}</p>
              </div>
              <p className="text-sm text-slate-600">{contact.mobile || "—"}</p>
            </li>
          ))}
        </ul>
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
          </dl>
        </Section>
      ) : null}

      <Section title="Documents">
        {vendor.documents.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing uploaded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
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
          <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Decision</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                    Approving creates the vendor&apos;s portal login and emails an activation link.
                </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary px-4 py-2.5 text-sm"
                onClick={() => setDecision("reject")}
              >
                Reject
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2.5 text-sm"
                onClick={() => setDecision("approve")}
              >
                <ShieldCheck className="size-4" aria-hidden />
                Approve
              </button>
            </div>
          </div>
        ) : (
          <div className="card space-y-4 p-5">
            {decision === "approve" ? (
              <>
                <h2 className="text-sm font-semibold text-slate-900">Approve this registration</h2>
                <p className="text-xs text-slate-500">
                  The office-use fields above are saved with the approval.
                </p>
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
                    className="btn-primary px-4 py-2.5 text-sm"
                    onClick={() => approve.mutate()}
                    disabled={deciding || missingDocuments.length > 0}
                  >
                    {approve.isPending ? <Spinner /> : null}
                    Confirm approval
                  </button>
                  <button
                    type="button"
                    className="btn-secondary px-4 py-2.5 text-sm"
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
                <h2 className="text-sm font-semibold text-slate-900">Reject this registration</h2>
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
                    className="btn-primary px-4 py-2.5 text-sm"
                    onClick={() => reject.mutate()}
                    disabled={deciding || rejectionRemarks.trim() === ""}
                  >
                    {reject.isPending ? <Spinner /> : null}
                    Confirm rejection
                  </button>
                  <button
                    type="button"
                    className="btn-secondary px-4 py-2.5 text-sm"
                    onClick={() => setDecision(null)}
                    disabled={deciding}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
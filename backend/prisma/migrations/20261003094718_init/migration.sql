-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('vendor_user', 'admin_user', 'sales_user');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NatureOfCompany" AS ENUM ('PUBLIC_LTD', 'PRIVATE_LTD', 'PARTNERSHIP', 'PROPRIETORSHIP');

-- CreateEnum
CREATE TYPE "GstFilingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "MsmeCategory" AS ENUM ('MICRO', 'SMALL', 'MEDIUM');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('SAVING', 'CURRENT', 'OTHER');

-- CreateEnum
CREATE TYPE "FacilityStatus" AS ENUM ('ADEQUATE', 'NOT_ADEQUATE', 'NEEDS_IMPROVEMENT');

-- CreateEnum
CREATE TYPE "ManpowerStatus" AS ENUM ('ADEQUATE', 'NOT_ADEQUATE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CANCELLED_CHEQUE', 'GST_CERTIFICATE', 'PAN_COPY', 'OTHER');

-- CreateEnum
CREATE TYPE "CraneStatus" AS ENUM ('AVAILABLE', 'ENGAGED', 'UNDER_MAINTENANCE', 'BOOKED', 'HIRED');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('VENDOR', 'SML');

-- CreateEnum
CREATE TYPE "CoordinateSource" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'SENT', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RfqRollupStatus" AS ENUM ('SENT', 'AWAITING_QUOTES', 'QUOTES_RECEIVED');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('PENDING', 'QUOTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('PER_DAY', 'PER_MONTH', 'LUMP_SUM');

-- CreateEnum
CREATE TYPE "DurationUnit" AS ENUM ('DAYS', 'MONTHS');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'UNDER_REVIEW', 'SHORTLISTED', 'REJECTED', 'SELECTED', 'NOT_AWARDED');

-- CreateEnum
CREATE TYPE "QuoteSource" AS ENUM ('PORTAL');

-- CreateEnum
CREATE TYPE "DistanceMethod" AS ENUM ('road', 'straight_line');

-- CreateEnum
CREATE TYPE "EmailLogStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('LOAD_CHART', 'OTHER');

-- CreateTable
CREATE TABLE "states" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isUnionTerritory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "states_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "vendor_operating_regions" (
    "vendorId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,

    CONSTRAINT "vendor_operating_regions_pkey" PRIMARY KEY ("vendorId","stateCode")
);

-- CreateTable
CREATE TABLE "crane_types" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "crane_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "sapVendorCode" TEXT,
    "name" TEXT NOT NULL,
    "natureOfCompany" "NatureOfCompany" NOT NULL,
    "registeredAddress" TEXT NOT NULL,
    "telephone" TEXT NOT NULL,
    "fax" TEXT,
    "email" TEXT NOT NULL,
    "weeklyOffDays" TEXT,
    "companySize" TEXT,
    "pan" TEXT NOT NULL,
    "tan" TEXT,
    "gstn" TEXT NOT NULL,
    "gstCompositionOpted" BOOLEAN,
    "gstr1FilingFrequency" "GstFilingFrequency",
    "cin" TEXT,
    "govtRegistrationType" TEXT,
    "govtRegistrationNo" TEXT,
    "msmeCategory" "MsmeCategory",
    "bankAccountHolderName" TEXT,
    "bankName" TEXT NOT NULL,
    "bankBranch" TEXT NOT NULL,
    "bankAccountType" "BankAccountType" NOT NULL,
    "bankAccountNoEnc" TEXT NOT NULL,
    "bankAccountNoLast4" TEXT NOT NULL,
    "bankIfscEnc" TEXT NOT NULL,
    "codeOfConductAccepted" BOOLEAN NOT NULL,
    "declarationName" TEXT NOT NULL,
    "declarationDesignation" TEXT NOT NULL,
    "declarationDate" TIMESTAMP(3) NOT NULL,
    "fleetSummary" TEXT,
    "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "adminRemarks" TEXT,
    "facilityStatus" "FacilityStatus",
    "manpowerStatus" "ManpowerStatus",
    "improvementRequirement" TEXT,
    "improvementPeriod" TEXT,
    "totalFleetSize" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "telephone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_documents" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "docType" "DocumentType" NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,

    CONSTRAINT "vendor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "fullName" TEXT,
    "role" "UserRole" NOT NULL,
    "vendorId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "activationToken" TEXT,
    "activationTokenExpiresAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "resetToken" TEXT,
    "resetTokenExpiresAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_otps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'LOGIN',
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cranes" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "typeOfCraneCode" TEXT NOT NULL,
    "capacityT" DECIMAL(10,2) NOT NULL,
    "currentStatus" "CraneStatus" NOT NULL,
    "currentLocation" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "yom" INTEGER NOT NULL,
    "mainBoomM" DECIMAL(6,2),
    "fixedJibM" DECIMAL(6,2),
    "luffingJibM" DECIMAL(6,2),
    "windJibM" DECIMAL(6,2),
    "serialRegistrationNo" TEXT NOT NULL,
    "pincode" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "coordinateSource" "CoordinateSource",
    "geocodedBy" TEXT,
    "geocodedAt" TIMESTAMP(3),
    "availableFrom" TIMESTAMP(3),
    "loadChartFileRef" TEXT,
    "loadChartFileName" TEXT,
    "loadChartMimeType" TEXT,
    "loadChartSizeBytes" INTEGER,
    "ownershipType" "OwnershipType" NOT NULL DEFAULT 'VENDOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "cranes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" TEXT NOT NULL,
    "rfqNumber" TEXT NOT NULL,
    "enquiryNo" TEXT NOT NULL,
    "lineNo" TEXT NOT NULL,
    "craneType" TEXT NOT NULL,
    "capacityT" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "siteLocation" TEXT NOT NULL,
    "siteStateCode" TEXT NOT NULL,
    "sitePincode" TEXT,
    "siteLatitude" DECIMAL(10,7),
    "siteLongitude" DECIMAL(10,7),
    "siteCoordinateSource" "CoordinateSource",
    "requiredStartDate" TIMESTAMP(3) NOT NULL,
    "durationValue" DECIMAL(10,2) NOT NULL,
    "durationUnit" "DurationUnit" NOT NULL,
    "configuration" TEXT,
    "otCharges" TEXT,
    "breakdownTerms" TEXT,
    "dieselScope" TEXT,
    "workingHoursShift" TEXT,
    "craneAgeCriteriaYears" INTEGER,
    "accommodationConveyance" TEXT,
    "paymentTerms" TEXT,
    "notes" TEXT,
    "commercialTermsExtra" JSONB,
    "smlContactName" TEXT,
    "smlContactMobile" TEXT,
    "smlContactEmail" TEXT,
    "submissionDeadline" TIMESTAMP(3) NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "rollupStatus" "RfqRollupStatus",
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_attachments" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,

    CONSTRAINT "rfq_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_vendor_recipients" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "emails" TEXT[],
    "emailDeliveryStatus" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "emailDeliveryError" TEXT,
    "firstViewedAt" TIMESTAMP(3),
    "responseStatus" "ResponseStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "declineNote" TEXT,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "candidateSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_vendor_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "craneId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "rentalRate" DECIMAL(14,2) NOT NULL,
    "rateBasis" "RateBasis" NOT NULL,
    "mobilisationCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalQuotedValue" DECIMAL(14,2) NOT NULL,
    "calculationNote" TEXT,
    "availabilityConfirmed" BOOLEAN NOT NULL,
    "availableFrom" TIMESTAMP(3),
    "validityDate" TIMESTAMP(3) NOT NULL,
    "acceptsCommercialTerms" BOOLEAN NOT NULL,
    "deviationText" TEXT,
    "remarks" TEXT,
    "warnings" JSONB,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "QuoteSource" NOT NULL DEFAULT 'PORTAL',
    "craneLocationSnapshot" JSONB,
    "distanceToSiteKm" DECIMAL(10,2),
    "distanceMethod" "DistanceMethod",
    "status" "QuotationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_attachments" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL DEFAULT 'OTHER',
    "fileRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "actorId" TEXT,
    "actorRole" TEXT,
    "actorName" TEXT,
    "ipAddress" TEXT,
    "craneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmail" TEXT,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailLogStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distance_cache" (
    "id" TEXT NOT NULL,
    "originLat" DECIMAL(10,7) NOT NULL,
    "originLng" DECIMAL(10,7) NOT NULL,
    "destLat" DECIMAL(10,7) NOT NULL,
    "destLng" DECIMAL(10,7) NOT NULL,
    "roadDistanceKm" DECIMAL(10,2) NOT NULL,
    "provider" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distance_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rfq_sequences" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rfq_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "states_name_key" ON "states"("name");

-- CreateIndex
CREATE UNIQUE INDEX "crane_types_name_key" ON "crane_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_sapVendorCode_key" ON "vendors"("sapVendorCode");

-- CreateIndex
CREATE INDEX "vendors_onboardingStatus_idx" ON "vendors"("onboardingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_contacts_email_key" ON "vendor_contacts"("email");

-- CreateIndex
CREATE INDEX "vendor_contacts_vendorId_idx" ON "vendor_contacts"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_documents_vendorId_idx" ON "vendor_documents"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_activationToken_key" ON "users"("activationToken");

-- CreateIndex
CREATE UNIQUE INDEX "users_resetToken_key" ON "users"("resetToken");

-- CreateIndex
CREATE INDEX "users_vendorId_idx" ON "users"("vendorId");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "login_otps_userId_idx" ON "login_otps"("userId");

-- CreateIndex
CREATE INDEX "cranes_vendorId_isActive_idx" ON "cranes"("vendorId", "isActive");

-- CreateIndex
CREATE INDEX "cranes_stateCode_idx" ON "cranes"("stateCode");

-- CreateIndex
CREATE INDEX "cranes_currentStatus_idx" ON "cranes"("currentStatus");

-- CreateIndex
CREATE INDEX "cranes_typeOfCraneCode_idx" ON "cranes"("typeOfCraneCode");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_rfqNumber_key" ON "rfqs"("rfqNumber");

-- CreateIndex
CREATE INDEX "rfqs_status_idx" ON "rfqs"("status");

-- CreateIndex
CREATE INDEX "rfqs_submissionDeadline_idx" ON "rfqs"("submissionDeadline");

-- CreateIndex
CREATE INDEX "rfq_vendor_recipients_vendorId_idx" ON "rfq_vendor_recipients"("vendorId");

-- CreateIndex
CREATE INDEX "rfq_vendor_recipients_responseStatus_idx" ON "rfq_vendor_recipients"("responseStatus");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_vendor_recipients_rfqId_vendorId_key" ON "rfq_vendor_recipients"("rfqId", "vendorId");

-- CreateIndex
CREATE INDEX "quotations_rfqId_isLatest_idx" ON "quotations"("rfqId", "isLatest");

-- CreateIndex
CREATE INDEX "quotations_vendorId_status_idx" ON "quotations"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_rfqId_vendorId_craneId_version_key" ON "quotations"("rfqId", "vendorId", "craneId", "version");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "email_logs_entity_entityId_idx" ON "email_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- CreateIndex
CREATE INDEX "distance_cache_originLat_originLng_destLat_destLng_idx" ON "distance_cache"("originLat", "originLng", "destLat", "destLng");

-- AddForeignKey
ALTER TABLE "vendor_operating_regions" ADD CONSTRAINT "vendor_operating_regions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_operating_regions" ADD CONSTRAINT "vendor_operating_regions_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_otps" ADD CONSTRAINT "login_otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cranes" ADD CONSTRAINT "cranes_typeOfCraneCode_fkey" FOREIGN KEY ("typeOfCraneCode") REFERENCES "crane_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cranes" ADD CONSTRAINT "cranes_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cranes" ADD CONSTRAINT "cranes_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_siteStateCode_fkey" FOREIGN KEY ("siteStateCode") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_attachments" ADD CONSTRAINT "rfq_attachments_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_vendor_recipients" ADD CONSTRAINT "rfq_vendor_recipients_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_vendor_recipients" ADD CONSTRAINT "rfq_vendor_recipients_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_craneId_fkey" FOREIGN KEY ("craneId") REFERENCES "cranes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_attachments" ADD CONSTRAINT "quotation_attachments_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_craneId_fkey" FOREIGN KEY ("craneId") REFERENCES "cranes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

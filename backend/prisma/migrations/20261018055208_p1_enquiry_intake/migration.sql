-- CreateEnum
CREATE TYPE "EnquirySource" AS ENUM ('manual');

-- CreateEnum
CREATE TYPE "EnquiryOverallStatus" AS ENUM ('RECEIVED_PENDING_SOURCING', 'PARTIALLY_QUOTED', 'PARTIALLY_FINALISED', 'FULLY_FINALISED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EnquiryLineTrailStatus" AS ENUM ('NEW', 'AVAILABILITY_CHECK', 'VENDOR_SHORTLISTED', 'RFQ_SENT', 'AWAITING_QUOTES', 'QUOTES_RECEIVED', 'UNDER_EVALUATION', 'VENDOR_FINALISED', 'BOOKED', 'CLOSED', 'FULFILLED_INTERNALLY', 'CANCELLED');

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "enquiryLineId" TEXT;

-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "enquiryLineId" TEXT;

-- CreateTable
CREATE TABLE "enquiries" (
    "id" TEXT NOT NULL,
    "enquiryNo" TEXT NOT NULL,
    "externalReference" TEXT,
    "enquiryDate" TIMESTAMP(3) NOT NULL,
    "source" "EnquirySource" NOT NULL DEFAULT 'manual',
    "salesPartnerName" TEXT,
    "crOwnerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerAddress" TEXT NOT NULL,
    "siteLocation" TEXT NOT NULL,
    "siteStateCode" TEXT NOT NULL,
    "sitePincode" TEXT,
    "region" TEXT,
    "businessVertical" TEXT,
    "crossRentalFlag" BOOLEAN NOT NULL DEFAULT true,
    "overallStatus" "EnquiryOverallStatus" NOT NULL DEFAULT 'RECEIVED_PENDING_SOURCING',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_line_items" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "craneTypeCode" TEXT,
    "capacityT" DECIMAL(10,2),
    "capacityRule" "CapacityRule" NOT NULL DEFAULT 'AT_LEAST',
    "capacityNote" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "applicationDescription" TEXT,
    "loadDescription" TEXT,
    "liftLoadT" DECIMAL(10,2),
    "workingRadiusM" DECIMAL(6,2),
    "requiredMainBoomM" DECIMAL(6,2),
    "requiredFixedJibM" DECIMAL(6,2),
    "requiredLuffingJibM" DECIMAL(6,2),
    "requiredWindJibM" DECIMAL(6,2),
    "configurationNotes" TEXT,
    "requiredStartDate" TIMESTAMP(3),
    "startDateTbc" BOOLEAN NOT NULL DEFAULT false,
    "durationValue" DECIMAL(10,2),
    "durationUnit" "DurationUnit",
    "workingDaysPerMonth" INTEGER,
    "mobilisationTerms" TEXT,
    "demobilisationTerms" TEXT,
    "otCharges" TEXT,
    "breakdownTerms" TEXT,
    "dieselScope" TEXT,
    "workingHoursShift" TEXT,
    "accommodationConveyance" TEXT,
    "paymentTerms" TEXT,
    "supportCraneScope" TEXT,
    "steelMatsGroundPrepScope" TEXT,
    "ehsHrCompliance" TEXT,
    "insuranceTerms" TEXT,
    "extensionClause" TEXT,
    "craneAgeCriteriaYears" INTEGER,
    "otherTerms" TEXT,
    "additionalManpowerScope" TEXT,
    "intraSiteMovementScope" TEXT,
    "prereleaseTerms" TEXT,
    "ppeScope" TEXT,
    "rowScope" TEXT,
    "rentalBudget" TEXT,
    "rentalBudgetValue" DECIMAL(14,2),
    "internalNotes" TEXT,
    "poSapReference" TEXT,
    "trailStatus" "EnquiryLineTrailStatus" NOT NULL DEFAULT 'NEW',
    "selectedSource" "OwnershipType",
    "closureStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enquiry_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_sequences" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "enquiry_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "enquiries_enquiryNo_key" ON "enquiries"("enquiryNo");

-- CreateIndex
CREATE INDEX "enquiries_overallStatus_idx" ON "enquiries"("overallStatus");

-- CreateIndex
CREATE INDEX "enquiries_enquiryDate_idx" ON "enquiries"("enquiryDate");

-- CreateIndex
CREATE INDEX "enquiry_line_items_trailStatus_idx" ON "enquiry_line_items"("trailStatus");

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_line_items_enquiryId_lineNo_key" ON "enquiry_line_items"("enquiryId", "lineNo");

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "enquiry_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "enquiry_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_crOwnerId_fkey" FOREIGN KEY ("crOwnerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_siteStateCode_fkey" FOREIGN KEY ("siteStateCode") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_line_items" ADD CONSTRAINT "enquiry_line_items_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_line_items" ADD CONSTRAINT "enquiry_line_items_craneTypeCode_fkey" FOREIGN KEY ("craneTypeCode") REFERENCES "crane_types"("code") ON DELETE SET NULL ON UPDATE CASCADE;

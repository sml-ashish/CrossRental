-- M2: Onboarding drafts and approval workflow.
--
-- Two things happen here.
--
-- 1. The vendor onboarding inputs lose their NOT NULL constraints. Brief 7.2
--    requires "save as draft, then submit", so a half-filled form has to be
--    storable. Brief 5.1's "Mandatory" rules are therefore enforced by
--    validation at SUBMIT time (services/onboarding.service.ts) rather than by
--    the database. An APPROVED vendor is still guaranteed complete, and
--    approveVendor() re-runs the full submit validation before it will approve.
--
-- 2. vendor_invitations and vendor_decisions are added. Onboarding is gated on
--    an invitation (brief 8: the registration mail is replaced by a portal
--    link), and decisions are kept as rows so a resubmission after a rejection
--    has its own history.

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "vendors" ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "natureOfCompany" DROP NOT NULL,
ALTER COLUMN "registeredAddress" DROP NOT NULL,
ALTER COLUMN "telephone" DROP NOT NULL,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "pan" DROP NOT NULL,
ALTER COLUMN "gstn" DROP NOT NULL,
ALTER COLUMN "bankName" DROP NOT NULL,
ALTER COLUMN "bankBranch" DROP NOT NULL,
ALTER COLUMN "bankAccountType" DROP NOT NULL,
ALTER COLUMN "bankAccountNoEnc" DROP NOT NULL,
ALTER COLUMN "bankAccountNoLast4" DROP NOT NULL,
ALTER COLUMN "bankIfscEnc" DROP NOT NULL,
ALTER COLUMN "codeOfConductAccepted" DROP NOT NULL,
ALTER COLUMN "declarationName" DROP NOT NULL,
ALTER COLUMN "declarationDesignation" DROP NOT NULL,
ALTER COLUMN "declarationDate" DROP NOT NULL;

-- CreateTable
CREATE TABLE "vendor_invitations" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "companyName" TEXT,
    "contactName" TEXT,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "vendorId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_decisions" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL,
    "remarks" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_invitations_tokenHash_key" ON "vendor_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "vendor_invitations_vendorId_idx" ON "vendor_invitations"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_invitations_email_idx" ON "vendor_invitations"("email");

-- CreateIndex
CREATE INDEX "vendor_decisions_vendorId_idx" ON "vendor_decisions"("vendorId");

-- AddForeignKey
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_decisions" ADD CONSTRAINT "vendor_decisions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_decisions" ADD CONSTRAINT "vendor_decisions_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

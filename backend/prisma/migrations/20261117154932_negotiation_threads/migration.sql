-- CreateEnum
CREATE TYPE "NegotiationStatus" AS ENUM ('AWAITING_VENDOR', 'AWAITING_SML', 'AGREED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NegotiationParty" AS ENUM ('SML', 'VENDOR');

-- CreateEnum
CREATE TYPE "RoundOutcome" AS ENUM ('OPEN', 'ACCEPTED', 'COUNTERED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "QuoteSource" ADD VALUE 'NEGOTIATED';

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "negotiationId" TEXT;

-- CreateTable
CREATE TABLE "quotation_negotiations" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "craneId" TEXT NOT NULL,
    "baseQuotationId" TEXT NOT NULL,
    "agreedQuotationId" TEXT,
    "status" "NegotiationStatus" NOT NULL,
    "currentRound" INTEGER NOT NULL DEFAULT 0,
    "maxRounds" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 0,
    "closedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_negotiations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiation_rounds" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "offeredBy" "NegotiationParty" NOT NULL,
    "offeredByUserId" TEXT,
    "onBehalfOfVendor" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT,
    "rentalRate" DECIMAL(14,2) NOT NULL,
    "rateBasis" "RateBasis" NOT NULL,
    "mobilisationCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "demobilisationCharges" DECIMAL(14,2),
    "taxBasis" "TaxBasisOfQuotation" NOT NULL,
    "validityDate" TIMESTAMP(3) NOT NULL,
    "availableFrom" TIMESTAMP(3),
    "availabilityConfirmed" BOOLEAN NOT NULL,
    "deviationText" TEXT,
    "message" TEXT,
    "totalQuotedValue" DECIMAL(14,2) NOT NULL,
    "calculationNote" TEXT,
    "warnings" JSONB,
    "warningsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "respondBy" TIMESTAMP(3) NOT NULL,
    "outcome" "RoundOutcome" NOT NULL DEFAULT 'OPEN',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotation_negotiations_agreedQuotationId_key" ON "quotation_negotiations"("agreedQuotationId");

-- CreateIndex
CREATE INDEX "quotation_negotiations_rfqId_status_idx" ON "quotation_negotiations"("rfqId", "status");

-- CreateIndex
CREATE INDEX "quotation_negotiations_vendorId_status_idx" ON "quotation_negotiations"("vendorId", "status");

-- CreateIndex
CREATE INDEX "negotiation_rounds_negotiationId_outcome_idx" ON "negotiation_rounds"("negotiationId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "negotiation_rounds_negotiationId_roundNumber_key" ON "negotiation_rounds"("negotiationId", "roundNumber");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "quotation_negotiations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_negotiations" ADD CONSTRAINT "quotation_negotiations_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_negotiations" ADD CONSTRAINT "quotation_negotiations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_negotiations" ADD CONSTRAINT "quotation_negotiations_craneId_fkey" FOREIGN KEY ("craneId") REFERENCES "cranes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_negotiations" ADD CONSTRAINT "quotation_negotiations_baseQuotationId_fkey" FOREIGN KEY ("baseQuotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_negotiations" ADD CONSTRAINT "quotation_negotiations_agreedQuotationId_fkey" FOREIGN KEY ("agreedQuotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_rounds" ADD CONSTRAINT "negotiation_rounds_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "quotation_negotiations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live thread per vendor + crane + RFQ. Terminal rows (DECLINED, CANCELLED,
-- AGREED) are excluded so a cancelled thread can be followed by a new one, and
-- an EXPIRED row can be resumed by SML without creating a second thread.
CREATE UNIQUE INDEX "quotation_negotiations_one_live_thread"
ON "quotation_negotiations"("rfqId", "vendorId", "craneId")
WHERE "status" IN ('AWAITING_VENDOR', 'AWAITING_SML', 'AGREED');

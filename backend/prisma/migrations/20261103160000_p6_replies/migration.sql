-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "InboundReplyStatus" AS ENUM ('PENDING', 'CONVERTED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "QuoteSource" ADD VALUE 'EMAIL';
ALTER TYPE "QuoteSource" ADD VALUE 'WHATSAPP';
ALTER TYPE "QuoteSource" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "bodyHtml" TEXT,
ADD COLUMN     "bodyText" TEXT,
ADD COLUMN     "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
ADD COLUMN     "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
ADD COLUMN     "fromAddress" TEXT,
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "rfq_vendor_recipients" ADD COLUMN     "whatsappDeliveryError" TEXT,
ADD COLUMN     "whatsappDeliveryStatus" "EmailDeliveryStatus",
ADD COLUMN     "whatsappMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "whatsappPhones" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "channels" "MessageChannel"[] DEFAULT ARRAY['EMAIL']::"MessageChannel"[];

-- CreateTable
CREATE TABLE "inbound_replies" (
    "id" TEXT NOT NULL,
    "messageLogId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "vendorId" TEXT,
    "rfqId" TEXT,
    "enquiryLineId" TEXT,
    "matchedBy" TEXT,
    "parseNote" TEXT,
    "parsedRentalRate" DECIMAL(14,2),
    "parsedRateBasis" "RateBasis",
    "parsedMobilisation" DECIMAL(14,2),
    "parsedDemobilisation" DECIMAL(14,2),
    "parsedAvailability" BOOLEAN,
    "parsedAvailableFrom" TIMESTAMP(3),
    "parsedValidityDate" TIMESTAMP(3),
    "parsedCraneRef" TEXT,
    "parsedRemarks" TEXT,
    "parsedAcceptsTerms" BOOLEAN,
    "craneId" TEXT,
    "attachments" JSONB,
    "status" "InboundReplyStatus" NOT NULL DEFAULT 'PENDING',
    "convertedQuotationId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_replies_messageLogId_key" ON "inbound_replies"("messageLogId");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_replies_convertedQuotationId_key" ON "inbound_replies"("convertedQuotationId");

-- CreateIndex
CREATE INDEX "inbound_replies_status_createdAt_idx" ON "inbound_replies"("status", "createdAt");

-- CreateIndex
CREATE INDEX "inbound_replies_rfqId_idx" ON "inbound_replies"("rfqId");

-- CreateIndex
CREATE INDEX "inbound_replies_vendorId_idx" ON "inbound_replies"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_providerMessageId_key" ON "email_logs"("providerMessageId");

-- CreateIndex
CREATE INDEX "email_logs_channel_direction_idx" ON "email_logs"("channel", "direction");

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_messageLogId_fkey" FOREIGN KEY ("messageLogId") REFERENCES "email_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "enquiry_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_craneId_fkey" FOREIGN KEY ("craneId") REFERENCES "cranes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_convertedQuotationId_fkey" FOREIGN KEY ("convertedQuotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_replies" ADD CONSTRAINT "inbound_replies_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


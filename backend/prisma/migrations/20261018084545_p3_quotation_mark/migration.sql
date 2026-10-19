-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusChangedById" TEXT,
ADD COLUMN     "statusReasonCode" TEXT,
ADD COLUMN     "statusReasonText" TEXT;

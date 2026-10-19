-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "ehsHrRequirements" TEXT,
ADD COLUMN     "extensionClause" TEXT,
ADD COLUMN     "insuranceTerms" TEXT,
ADD COLUMN     "mobilisationTerms" TEXT,
ADD COLUMN     "steelMatsGroundPrep" TEXT,
ADD COLUMN     "supportCrane" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

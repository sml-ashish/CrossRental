-- AlterTable
ALTER TABLE "enquiries" ADD COLUMN     "siteCoordinateSource" "CoordinateSource",
ADD COLUMN     "siteLatitude" DECIMAL(10,7),
ADD COLUMN     "siteLongitude" DECIMAL(10,7);

-- CreateTable
CREATE TABLE "recommendation_snapshots" (
    "id" TEXT NOT NULL,
    "enquiryLineId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'initial',
    "provider" TEXT,
    "site" JSONB NOT NULL,
    "smlSet" JSONB NOT NULL,
    "vendorSet" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobilisation_rates" (
    "id" TEXT NOT NULL,
    "craneTypeCode" TEXT NOT NULL,
    "capacityMinT" DECIMAL(10,2) NOT NULL,
    "capacityMaxT" DECIMAL(10,2),
    "ownershipType" "OwnershipType",
    "ratePerKm" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobilisation_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_snapshots_enquiryLineId_createdAt_idx" ON "recommendation_snapshots"("enquiryLineId", "createdAt");

-- CreateIndex
CREATE INDEX "mobilisation_rates_craneTypeCode_idx" ON "mobilisation_rates"("craneTypeCode");

-- AddForeignKey
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "enquiry_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobilisation_rates" ADD CONSTRAINT "mobilisation_rates_craneTypeCode_fkey" FOREIGN KEY ("craneTypeCode") REFERENCES "crane_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

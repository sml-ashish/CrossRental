-- CreateEnum
CREATE TYPE "ReservationType" AS ENUM ('BOOKED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'COMPLETED');

-- DropForeignKey
ALTER TABLE "rfqs" DROP CONSTRAINT IF EXISTS "rfqs_craneType_fkey";

-- DropForeignKey
ALTER TABLE "vendors" DROP CONSTRAINT IF EXISTS "vendors_stateCode_fkey";

-- DropIndex
DROP INDEX IF EXISTS "rfqs_craneType_idx";

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "craneId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "type" "ReservationType" NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "rfqId" TEXT,
    "quotationId" TEXT,
    "createdById" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_craneId_status_idx" ON "reservations"("craneId", "status");

-- CreateIndex
CREATE INDEX "reservations_status_startDate_idx" ON "reservations"("status", "startDate");

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "states"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_craneType_fkey" FOREIGN KEY ("craneType") REFERENCES "crane_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_craneId_fkey" FOREIGN KEY ("craneId") REFERENCES "cranes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Brief 6.1 (phase B): the database refuses overlapping ACTIVE reservations on
-- one crane, not only the transaction that awards. The range is [start, end+1)
-- so the stored end date is the crane's last committed day. The CASTs to date
-- are safe: reservations are calendar slices, always written at UTC midnight.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "reservations" ADD CONSTRAINT "reservations_active_no_overlap"
  EXCLUDE USING gist (
    "craneId" WITH =,
    daterange("startDate"::date, ("endDate"::date + 1), '[)') WITH &&
  ) WHERE (status = 'ACTIVE');

-- The pre-reservation award flow left cranes stored as BOOKED (undated). Each
-- becomes one synthesized ACTIVE reservation covering today and open-ended, so
-- the derived badge keeps showing the commitment the stored status asserted;
-- the crane's own status returns to the vendor's word (Available). Hand-edited
-- rows have no author, hence the nullable createdById.
INSERT INTO "reservations" ("id", "craneId", "startDate", "endDate", "type", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id",
       COALESCE(c."availableFrom", CURRENT_DATE)::timestamp(3),
       TIMESTAMP '2099-12-30 00:00:00',
       'BOOKED', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "cranes" c
WHERE c."currentStatus" IN ('BOOKED', 'HIRED');

UPDATE "cranes"
SET "currentStatus" = 'AVAILABLE', "statusUpdatedAt" = CURRENT_TIMESTAMP
WHERE "currentStatus" IN ('BOOKED', 'HIRED');

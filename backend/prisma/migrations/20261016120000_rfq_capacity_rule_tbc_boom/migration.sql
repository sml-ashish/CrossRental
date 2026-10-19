-- Brief A3: richer requirement capture on the RFQ.
CREATE TYPE "CapacityRule" AS ENUM ('AT_LEAST', 'EXACT');

ALTER TABLE "rfqs"
  ADD COLUMN "capacityRule" "CapacityRule" NOT NULL DEFAULT 'AT_LEAST',
  ADD COLUMN "capacityNote" TEXT,
  ADD COLUMN "applicationDescription" TEXT,
  ADD COLUMN "loadDescription" TEXT,
  ADD COLUMN "mainBoomM" DECIMAL(6,2),
  ADD COLUMN "jibLengthM" DECIMAL(6,2),
  ADD COLUMN "startDateTbc" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "workingDaysPerMonth" INTEGER;

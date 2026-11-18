-- Optional line-item fields that sales can choose to include when raising an
-- RFQ. NULL means "not sent to the vendor", so no backfill is needed.
ALTER TABLE "rfqs"
  ADD COLUMN "liftLoadT" DECIMAL(10,2),
  ADD COLUMN "workingRadiusM" DECIMAL(6,2),
  ADD COLUMN "fixedJibM" DECIMAL(6,2),
  ADD COLUMN "luffingJibM" DECIMAL(6,2),
  ADD COLUMN "windJibM" DECIMAL(6,2);

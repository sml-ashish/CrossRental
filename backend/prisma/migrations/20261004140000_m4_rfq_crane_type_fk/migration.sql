-- Brief 6.9: the candidate picker matches vendor cranes to an RFQ on crane type.
--
-- rfqs.craneType arrived in M1 as a bare string, while cranes.typeOfCraneCode was
-- already a foreign key to crane_types. That mismatch is invisible until M4, where
-- the two columns are compared directly: an unrecognised type stored on an RFQ
-- matches no crane, and the sales user reads "no matching cranes" rather than
-- "that crane type does not exist".
--
-- Added NOT VALID then validated, so new and updated rows are checked immediately
-- while existing rows are verified in one pass instead of holding a lock for the
-- length of a full-table scan under an ACCESS EXCLUSIVE lock.
--
-- Column names here are camelCase because the rfqs table is mapped without
-- @map on its columns, unlike rfq_vendor_recipients.
ALTER TABLE "rfqs"
  ADD CONSTRAINT "rfqs_craneType_fkey"
  FOREIGN KEY ("craneType") REFERENCES "crane_types"("code")
  NOT VALID;

ALTER TABLE "rfqs" VALIDATE CONSTRAINT "rfqs_craneType_fkey";

CREATE INDEX "rfqs_craneType_idx" ON "rfqs"("craneType");

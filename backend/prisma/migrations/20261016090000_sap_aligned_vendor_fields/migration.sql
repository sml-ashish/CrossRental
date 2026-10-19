-- A1/A5 (brief 5.1 as revised): SAP-aligned vendor fields.
--
-- The single registeredAddress text is replaced by a structured address block;
-- the GST question becomes "registered?" with a registration type, replacing
-- the old gst_composition_opted boolean; MSME, TDS and foreign-bank fields are
-- added; PAN and GSTIN become unique across vendors; and the document-type
-- enum gains the conditional documents (declaration scan, TDS, MSME).
-- A4 rides along: vendor_contacts gains receives_rfqs.
--
-- Column names are camelCase because the vendors table maps its table name
-- only, not its columns.

-- Address block. Copy the old text into line 1 so nothing is lost; vendors and
-- admins can restructure it on the next edit.
CREATE TYPE "GstRegistrationType" AS ENUM ('REGULAR', 'COMPOSITE', 'SEZ', 'EOU');

ALTER TABLE "vendors" ADD COLUMN "addressLine1" TEXT;
ALTER TABLE "vendors" ADD COLUMN "addressLine2" TEXT;
ALTER TABLE "vendors" ADD COLUMN "city" TEXT;
ALTER TABLE "vendors" ADD COLUMN "district" TEXT;
ALTER TABLE "vendors" ADD COLUMN "stateCode" TEXT;
ALTER TABLE "vendors" ADD COLUMN "pincode" TEXT;

UPDATE "vendors" SET "addressLine1" = "registeredAddress" WHERE "registeredAddress" IS NOT NULL;

ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_stateCode_fkey"
  FOREIGN KEY ("stateCode") REFERENCES "states"("code")
  NOT VALID;

ALTER TABLE "vendors" VALIDATE CONSTRAINT "vendors_stateCode_fkey";

ALTER TABLE "vendors" DROP COLUMN "registeredAddress";

-- GST block.
ALTER TABLE "vendors" ADD COLUMN "gstRegistered" BOOLEAN;
ALTER TABLE "vendors" ADD COLUMN "gstRegistrationType" "GstRegistrationType";
ALTER TABLE "vendors" DROP COLUMN "gstCompositionOpted";

-- PAN and GSTIN are unique across vendors when present (brief 5.1). Both are
-- nullable, and Postgres permits many NULLs under a unique index, which is
-- what drafts need. GSTN is only ever set on a registered vendor, so the
-- unregistered case leaves it null rather than colliding.
CREATE UNIQUE INDEX "vendors_pan_key" ON "vendors"("pan");
CREATE UNIQUE INDEX "vendors_gstn_key" ON "vendors"("gstn");

-- MSME block.
ALTER TABLE "vendors" ADD COLUMN "msmeRegistered" BOOLEAN;
ALTER TABLE "vendors" ADD COLUMN "msmeRegNo" TEXT;
ALTER TABLE "vendors" ADD COLUMN "msmeExemptionDate" TIMESTAMP(3);

-- TDS lower-deduction block.
ALTER TABLE "vendors" ADD COLUMN "tdsLowerDeduction" BOOLEAN;
ALTER TABLE "vendors" ADD COLUMN "tdsCertificateNo" TEXT;
ALTER TABLE "vendors" ADD COLUMN "tdsSection" TEXT;
ALTER TABLE "vendors" ADD COLUMN "tdsRatePercent" INTEGER;
ALTER TABLE "vendors" ADD COLUMN "tdsValidFrom" TIMESTAMP(3);
ALTER TABLE "vendors" ADD COLUMN "tdsValidTo" TIMESTAMP(3);

-- Foreign-bank and MICR fields.
ALTER TABLE "vendors" ADD COLUMN "bankMicr" TEXT;
ALTER TABLE "vendors" ADD COLUMN "bankIban" TEXT;
ALTER TABLE "vendors" ADD COLUMN "bankSwift" TEXT;

-- Communication preferences notes (email is the only channel for now).
ALTER TABLE "vendors" ADD COLUMN "communicationNotes" TEXT;

-- Conditional and required documents: widen the enum. Postgres enum values
-- cannot be removed, but adding three is safe; the values are appended so
-- every existing row still casts.
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'DECLARATION_SCAN';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'TDS_CERTIFICATE';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'MSME_CERTIFICATE';

-- Receives-RFQs flag on contacts (A4). Default false so existing rows stay
-- exactly as they were; the RFQ dispatcher falls back to the primary contact
-- when nobody has the flag.
ALTER TABLE "vendor_contacts" ADD COLUMN "receivesRfqs" BOOLEAN NOT NULL DEFAULT false;

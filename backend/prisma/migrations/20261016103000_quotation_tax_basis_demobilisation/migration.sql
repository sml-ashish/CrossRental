-- A2 (brief 6.7 as revised): quotation additions.
--
-- Demobilisation charges become their own decimal line beside mobilisation,
-- and the quotation declares whether its total includes GST. The total is
-- unchanged for existing rows: demobilisation defaults to 0, and totals are
-- recomputed on the next revision. The tax basis is a declaration, not
-- arithmetic.

CREATE TYPE "TaxBasisOfQuotation" AS ENUM ('EXCLUSIVE_OF_GST', 'INCLUSIVE_OF_GST');

ALTER TABLE "quotations" ADD COLUMN "demobilisationCharges" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "quotations" ADD COLUMN "taxBasis" "TaxBasisOfQuotation" NOT NULL DEFAULT 'EXCLUSIVE_OF_GST';

-- Historical rows carry the brief's default in column and comment form.
COMMENT ON COLUMN "quotations"."demobilisationCharges" IS 'Return-transport charges; part of the total beside mobilisation.';

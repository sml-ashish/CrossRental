-- Remove three fields the CR enquiry form does not have.
--
--   enquiries.source             only `manual` ever existed and nothing read it
--   enquiries.crOwnerId          report scoping now uses createdById
--   enquiry_line_items.selectedSource
--                                the internal-vs-vendor split is dropped
--
-- Dropping `crOwnerId` also drops the "EnquiryCrOwner" relation on `User`.

ALTER TABLE "enquiries" DROP CONSTRAINT "enquiries_crOwnerId_fkey";

-- AlterTable
ALTER TABLE "enquiries" DROP COLUMN "crOwnerId",
DROP COLUMN "source";

-- AlterTable
ALTER TABLE "enquiry_line_items" DROP COLUMN "selectedSource";

-- DropEnum
DROP TYPE "EnquirySource";

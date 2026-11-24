-- The enquiry keeps only the city, state and the facts needed to source a crane.
-- Customer/site text, the derived pin and the vendor terms are now owned by the
-- RFQ, where they can be chosen per invitation.

-- Keep the city mandatory: every RFQ raised from an enquiry needs a site.
UPDATE "enquiries" SET "shipToCity" = 'Site' WHERE "shipToCity" IS NULL;
ALTER TABLE "enquiries" ALTER COLUMN "shipToCity" SET NOT NULL;

ALTER TABLE "enquiries" DROP COLUMN "customerName";
ALTER TABLE "enquiries" DROP COLUMN "customerAddress";
ALTER TABLE "enquiries" DROP COLUMN "siteLocation";
ALTER TABLE "enquiries" DROP COLUMN "sitePincode";
ALTER TABLE "enquiries" DROP COLUMN "region";
ALTER TABLE "enquiries" DROP COLUMN "siteLatitude";
ALTER TABLE "enquiries" DROP COLUMN "siteLongitude";
ALTER TABLE "enquiries" DROP COLUMN "siteCoordinateSource";

ALTER TABLE "enquiry_line_items" DROP COLUMN "capacityRule";
ALTER TABLE "enquiry_line_items" DROP COLUMN "capacityNote";
ALTER TABLE "enquiry_line_items" DROP COLUMN "quantity";
ALTER TABLE "enquiry_line_items" DROP COLUMN "loadDescription";
ALTER TABLE "enquiry_line_items" DROP COLUMN "workingRadiusM";
ALTER TABLE "enquiry_line_items" DROP COLUMN "requiredLuffingJibM";
ALTER TABLE "enquiry_line_items" DROP COLUMN "requiredWindJibM";
ALTER TABLE "enquiry_line_items" DROP COLUMN "configurationNotes";
ALTER TABLE "enquiry_line_items" DROP COLUMN "mobilisationTerms";
ALTER TABLE "enquiry_line_items" DROP COLUMN "demobilisationTerms";
ALTER TABLE "enquiry_line_items" DROP COLUMN "accommodationConveyance";
ALTER TABLE "enquiry_line_items" DROP COLUMN "paymentTerms";
ALTER TABLE "enquiry_line_items" DROP COLUMN "extensionClause";
ALTER TABLE "enquiry_line_items" DROP COLUMN "otherTerms";
ALTER TABLE "enquiry_line_items" DROP COLUMN "intraSiteMovementScope";
ALTER TABLE "enquiry_line_items" DROP COLUMN "prereleaseTerms";
ALTER TABLE "enquiry_line_items" DROP COLUMN "ppeScope";
ALTER TABLE "enquiry_line_items" DROP COLUMN "rentalBudget";

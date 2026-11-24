-- Main boom and fixed jib requirements are owned by the RFQ, not the enquiry.
-- Dropping these line columns keeps enquiry intake limited to sourceable facts.

ALTER TABLE "enquiry_line_items" DROP COLUMN "requiredMainBoomM";
ALTER TABLE "enquiry_line_items" DROP COLUMN "requiredFixedJibM";

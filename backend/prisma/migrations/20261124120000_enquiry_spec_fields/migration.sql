-- Structured ship-to city on the enquiry header.
ALTER TABLE "enquiries" ADD COLUMN "shipToCity" TEXT;

-- Crane model/year, the customer's own configuration label, and the two
-- separate working-hours values. `workingHoursShift` is kept as the combined
-- value that is copied into an RFQ.
ALTER TABLE "enquiry_line_items" ADD COLUMN "craneModel" TEXT;
ALTER TABLE "enquiry_line_items" ADD COLUMN "yom" INTEGER;
ALTER TABLE "enquiry_line_items" ADD COLUMN "craneConfiguration" TEXT;
ALTER TABLE "enquiry_line_items" ADD COLUMN "workingHoursPerDay" TEXT;
ALTER TABLE "enquiry_line_items" ADD COLUMN "shift" TEXT;

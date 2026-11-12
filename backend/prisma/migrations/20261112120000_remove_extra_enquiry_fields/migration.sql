-- Drop the enquiry columns that have no row in the Sales Partner's
-- Cross Rental Enquiry Template (docs/CR Enquiry from SP.xlsx).
ALTER TABLE "enquiries" DROP COLUMN "businessVertical",
DROP COLUMN "crossRentalFlag",
DROP COLUMN "externalReference",
DROP COLUMN "notes",
DROP COLUMN "salesPartnerName";

ALTER TABLE "enquiry_line_items" DROP COLUMN "internalNotes",
DROP COLUMN "poSapReference",
DROP COLUMN "rentalBudgetValue",
DROP COLUMN "startDateTbc";

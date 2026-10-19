-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "legalForm" TEXT,
ADD COLUMN     "paymentTerm" TEXT,
ADD COLUMN     "purchaseOrg" TEXT,
ADD COLUMN     "vendorOrigin" TEXT,
ADD COLUMN     "vendorType" TEXT,
ADD COLUMN     "withholdingTaxType" TEXT;

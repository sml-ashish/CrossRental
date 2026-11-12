-- Capture the vendor's contact number at invitation time, alongside the name
-- and email, so SML can call about the application.
ALTER TABLE "vendor_invitations" ADD COLUMN "contactNumber" TEXT;

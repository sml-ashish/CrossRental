-- Brief 6.4: the fleet approval toggle. The flag itself lives in app_settings,
-- so flipping it needs no migration; this column is what makes the code path
-- possible without one.
--
-- Defaults to APPROVED so every existing crane stays live and the default
-- configuration (FLEET_APPROVAL_REQUIRED=false) changes nothing.
CREATE TYPE "CraneApprovalStatus" AS ENUM ('APPROVED', 'PENDING');

ALTER TABLE "cranes"
  ADD COLUMN "approvalStatus" "CraneApprovalStatus" NOT NULL DEFAULT 'APPROVED';

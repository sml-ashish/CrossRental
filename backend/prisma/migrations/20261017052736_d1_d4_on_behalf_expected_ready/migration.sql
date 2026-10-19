-- DropForeignKey
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_createdById_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "onBehalfOfVendor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "cranes" ADD COLUMN     "expectedReadyDate" TIMESTAMP(3),
ADD COLUMN     "updatedOnBehalf" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

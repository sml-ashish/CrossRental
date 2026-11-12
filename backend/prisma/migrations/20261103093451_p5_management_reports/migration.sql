-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'management_viewer';

-- AlterTable
ALTER TABLE "states" ADD COLUMN     "region" TEXT;

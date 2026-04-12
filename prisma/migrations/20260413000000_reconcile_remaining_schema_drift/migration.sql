-- Reconcile schema.prisma with the committed migration history.
-- This closes the remaining drift detected by `prisma migrate diff`.

-- DropForeignKey
ALTER TABLE "HutLeaderAssignment" DROP CONSTRAINT "HutLeaderAssignment_memberId_fkey";

-- DropForeignKey
ALTER TABLE "PromoRedemption" DROP CONSTRAINT "PromoRedemption_memberId_fkey";

-- DropIndex
DROP INDEX "Booking_createdById_idx";

-- AlterTable
ALTER TABLE "Booking" ALTER COLUMN "notes" SET DATA TYPE VARCHAR(500);

-- AlterTable
ALTER TABLE "ChoreTemplate" ALTER COLUMN "frequencyDaysOfWeek" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GuestChoreToken" ALTER COLUMN "date" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "HutLeaderAssignment"
  ALTER COLUMN "startDate" SET DATA TYPE DATE,
  ALTER COLUMN "endDate" SET DATA TYPE DATE,
  ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "MemberSubscription" ALTER COLUMN "status" SET DEFAULT 'NOT_INVOICED';

-- DropTable
DROP TABLE "Room";

-- CreateIndex
CREATE INDEX "ChoreAssignment_choreTemplateId_idx" ON "ChoreAssignment"("choreTemplateId");

-- CreateIndex
CREATE INDEX "MemberSubscription_seasonYear_idx" ON "MemberSubscription"("seasonYear");

-- CreateIndex
CREATE INDEX "PasswordResetToken_memberId_idx" ON "PasswordResetToken"("memberId");

-- AddForeignKey
ALTER TABLE "PromoRedemption"
  ADD CONSTRAINT "PromoRedemption_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HutLeaderAssignment"
  ADD CONSTRAINT "HutLeaderAssignment_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

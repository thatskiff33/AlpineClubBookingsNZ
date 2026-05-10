-- Add profile completion and detail confirmation timestamps.
-- Existing members are intentionally not backfilled; they should confirm after deploy.
ALTER TABLE "Member" ADD COLUMN "profileCompletedAt" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN "detailsConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN "detailsConfirmedByMemberId" TEXT;
ALTER TABLE "Member" ADD COLUMN "onboardingConfirmedAt" TIMESTAMP(3);

CREATE INDEX "Member_detailsConfirmedByMemberId_idx" ON "Member"("detailsConfirmedByMemberId");

ALTER TABLE "Member"
  ADD CONSTRAINT "Member_detailsConfirmedByMemberId_fkey"
  FOREIGN KEY ("detailsConfirmedByMemberId")
  REFERENCES "Member"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

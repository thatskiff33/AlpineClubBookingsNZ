ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "requiresAdminReview" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "adminReviewReason" VARCHAR(300);

ALTER TABLE "NotificationPreference"
  ADD COLUMN IF NOT EXISTS "adminIssueReport" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "IssueReport" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "pageUrl" VARCHAR(2048) NOT NULL,
  "pageTitle" VARCHAR(300),
  "description" TEXT NOT NULL,
  "screenshotDataUrl" TEXT,
  "browserInfo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IssueReport_memberId_createdAt_idx"
  ON "IssueReport"("memberId", "createdAt");

CREATE INDEX IF NOT EXISTS "IssueReport_createdAt_idx"
  ON "IssueReport"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'IssueReport_memberId_fkey'
  ) THEN
    ALTER TABLE "IssueReport"
      ADD CONSTRAINT "IssueReport_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

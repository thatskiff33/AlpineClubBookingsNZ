-- Add explicit issue-report triage and sensitive attachment retention metadata.
ALTER TABLE "IssueReport"
  ADD COLUMN "screenshotCapturedAt" TIMESTAMP(3),
  ADD COLUMN "screenshotExpiresAt" TIMESTAMP(3),
  ADD COLUMN "screenshotDeletedAt" TIMESTAMP(3),
  ADD COLUMN "screenshotDeletedById" TEXT,
  ADD COLUMN "screenshotDeleteReason" VARCHAR(300),
  ADD COLUMN "browserInfoExpiresAt" TIMESTAMP(3),
  ADD COLUMN "browserInfoDeletedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedById" TEXT,
  ADD COLUMN "resolutionNote" VARCHAR(1000),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing screenshots and browser fingerprints get the same short support window
-- as newly created reports. The data remains available for current support work
-- but now has a deterministic purge target.
UPDATE "IssueReport"
SET
  "screenshotCapturedAt" = "createdAt",
  "screenshotExpiresAt" = "createdAt" + INTERVAL '30 days'
WHERE "screenshotDataUrl" IS NOT NULL;

UPDATE "IssueReport"
SET "browserInfoExpiresAt" = "createdAt" + INTERVAL '30 days'
WHERE "browserInfo" IS NOT NULL;

CREATE INDEX "IssueReport_resolvedAt_createdAt_idx"
  ON "IssueReport"("resolvedAt", "createdAt");
CREATE INDEX "IssueReport_screenshotExpiresAt_idx"
  ON "IssueReport"("screenshotExpiresAt");
CREATE INDEX "IssueReport_browserInfoExpiresAt_idx"
  ON "IssueReport"("browserInfoExpiresAt");

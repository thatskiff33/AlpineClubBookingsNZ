-- Add missing freeze window column for admin Mountain Conditions workflow.
ALTER TABLE "WhakapapaReportCache"
ADD COLUMN IF NOT EXISTS "frozenUntil" TIMESTAMP(3);

-- Index used by cache freshness/freeze checks.
CREATE INDEX IF NOT EXISTS "WhakapapaReportCache_frozenUntil_idx"
ON "WhakapapaReportCache"("frozenUntil");

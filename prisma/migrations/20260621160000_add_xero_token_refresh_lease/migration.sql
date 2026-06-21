-- Add a short database-backed lease for operational Xero OAuth token refresh.
-- This prevents multiple app workers from using the same rotating refresh token.
ALTER TABLE "XeroToken"
  ADD COLUMN "refreshInProgressUntil" TIMESTAMP(3);

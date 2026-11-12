-- Expand-only: old clients ignore this nullable marker; no backfill or default.
ALTER TABLE "Booking" ADD COLUMN "savedCardClaimAt" TIMESTAMP(3);

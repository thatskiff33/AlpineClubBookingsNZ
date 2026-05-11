ALTER TABLE "AgeTierSetting"
ADD COLUMN IF NOT EXISTS "subscriptionRequiredForBooking" BOOLEAN NOT NULL DEFAULT true;

UPDATE "AgeTierSetting"
SET "subscriptionRequiredForBooking" = CASE
  WHEN "tier" IN ('INFANT', 'CHILD') THEN false
  ELSE true
END;

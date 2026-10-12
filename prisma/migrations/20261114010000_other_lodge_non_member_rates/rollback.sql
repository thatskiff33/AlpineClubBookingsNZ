-- Reverse script for 20261114010000_other_lodge_non_member_rates (#61).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back to a release that
-- speaks Alpine Central Server API 2.1.
--
-- The release before #61 never names these columns, so routing traffic back
-- needs no schema reverse at all; run this only to remove them. What it loses:
-- the locally held rates. They are not lost from the network - the central
-- server still holds every rate it was sent, and a release that speaks 2.2
-- re-downloads them on its next full pull.

ALTER TABLE "OtherLodge"
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRateUnder5Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRate5To11Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRate12To17Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRateAdultCents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRateUnder5Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRate5To11Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRate12To17Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRateAdultCents_range",
  DROP COLUMN IF EXISTS "winterRateUnder5Cents",
  DROP COLUMN IF EXISTS "winterRate5To11Cents",
  DROP COLUMN IF EXISTS "winterRate12To17Cents",
  DROP COLUMN IF EXISTS "winterRateAdultCents",
  DROP COLUMN IF EXISTS "summerRateUnder5Cents",
  DROP COLUMN IF EXISTS "summerRate5To11Cents",
  DROP COLUMN IF EXISTS "summerRate12To17Cents",
  DROP COLUMN IF EXISTS "summerRateAdultCents";

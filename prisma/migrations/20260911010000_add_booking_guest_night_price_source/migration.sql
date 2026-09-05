-- #3275 (stage 1 of programme #3272): record where each stored night price
-- came from. This migration changes no priceCents value.
--
-- UNKNOWN is deliberately the column default. During a blue/green deploy the
-- draining colour does not know this column and omits it from inserts; the
-- default therefore records the only fact the new colour can honestly know
-- about such a row. It must never re-derive provenance from the amount.
CREATE TYPE "BookingGuestNightPriceSource" AS ENUM (
  'SOLD',
  'OFFICER_PRICED',
  'EVEN_SPLIT',
  'UNKNOWN'
);

ALTER TABLE "BookingGuestNight"
ADD COLUMN "priceSource" "BookingGuestNightPriceSource" NOT NULL DEFAULT 'UNKNOWN';

-- The table-creation backfill wrote a deterministic id from the guest id and
-- night. Match that exact formula, not the amount or timestamp.
UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT'
WHERE bgn."id" =
  'bgn_' || md5(
    bgn."bookingGuestId" || ':' || to_char(bgn."stayDate", 'YYYY-MM-DD')
  );

-- The two later backfills were the only production writers that generated
-- BookingGuestNight identifiers with gen_random_uuid()::text. Runtime Prisma
-- inserts use cuid identifiers. The UUID shape therefore comes from what those
-- migrations wrote; no price, rate, total or createdAt inference is involved.
UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT'
WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

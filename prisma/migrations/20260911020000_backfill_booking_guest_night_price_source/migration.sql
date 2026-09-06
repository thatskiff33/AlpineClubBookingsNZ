BEGIN;

-- #3275 (stage 1 of programme #3272): classify only stored night prices
-- whose provenance is proved by the writer that created or repaired them.
-- This migration changes no priceCents value.

-- The table-creation backfill wrote a deterministic id from the guest id and
-- night. Match that exact formula, not the amount or timestamp.
UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT'
WHERE bgn."id" =
  'bgn_' || md5(
    bgn."bookingGuestId" || ':' || to_char(bgn."stayDate", 'YYYY-MM-DD')
  )
  AND bgn."priceCents" IS NOT NULL;

-- The two later backfills generated identifiers with gen_random_uuid()::text,
-- which produces RFC 4122 version-4 UUIDs. Runtime Prisma inserts use cuid
-- identifiers. Match exactly that writer shape; do not infer from an amount,
-- rate, total, timestamp, or other current data.
UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT'
WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND bgn."priceCents" IS NOT NULL;

-- #3247 landed two officer repair writers before provenance existed. Their
-- successful AuditLog rows were committed atomically with the exact repaired
-- guest/date/amount pairs, so replay those writer-authored facts after the
-- broad historical backfill classification. The helper is also called by the
-- expand migration's trigger for draining-colour repairs during deployment.
SELECT "applyBookingGuestNightOfficerPriceSourceFromAudit"(
  audit."entityId",
  audit."metadata"->'nightPrices',
  audit."createdAt"
)
FROM "AuditLog" AS audit
WHERE audit."action" IN (
    'booking-payment.stored-night-price.record',
    'booking-payment.stored-night-price.reconcile'
  )
  AND audit."entityType" = 'BookingGuest'
  AND audit."outcome" = 'success';

COMMIT;

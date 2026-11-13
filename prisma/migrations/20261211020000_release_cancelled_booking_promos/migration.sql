-- Data-only repair (#4909): cancelled bookings hold no promotion benefit.
-- Delete redemptions, cascading allocations; do not UPDATE PromoRedemption:
-- its compatibility triggers would recreate allocation rows.
-- Old-code compatible: no DDL and no change to live bookings' promotions.
-- OPERATOR STEP: after the old blue/green colour and its workers fully drain,
-- re-run BOTH statements together once. Old code can still cancel without
-- releasing during the overlap. The correlated RAW recount is idempotent.
-- No application advisory keys: migrations use the deploy migration protocol.
DELETE FROM "PromoRedemption" r
USING "Booking" b
WHERE r."bookingId" = b."id" AND b."status" = 'CANCELLED';

UPDATE "PromoCode" p
SET "currentRedemptions" = (
  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id"
)
WHERE p."currentRedemptions" <> (
  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id"
);

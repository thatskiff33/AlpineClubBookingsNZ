-- Data-only repair (#4909): cancelled bookings hold no promotion benefit.
-- Delete redemptions, cascading allocations; do not UPDATE PromoRedemption:
-- its compatibility triggers would recreate allocation rows.
-- Old-code compatible: no DDL and no change to live bookings' promotions.
-- OPERATOR STEP: after the old blue/green colour and its workers fully drain,
-- re-run this whole file once (docs/UPGRADING.md, #4909). Old code can still
-- cancel without releasing during the overlap. A second run changes nothing.
-- No application advisory keys: migrations use the deploy migration protocol.
-- One transaction, so the release and the recount commit together on the
-- deploy and on the psql re-run alike.
BEGIN;

DELETE FROM "PromoRedemption" r
USING "Booking" b
WHERE r."bookingId" = b."id" AND b."status" = 'CANCELLED';

-- Lock every code row first, in lockPromoCodeRowsForUpdate's ordinal id order.
-- A redeem or release in flight on a code finishes before the recount starts,
-- and the recount's own snapshot, taken after these locks, counts its rows.
-- Without it, a recount that waited on a drifted code's row would re-check
-- that row against its older snapshot and store one fewer than RAW.
DO $$
BEGIN
  PERFORM 1 FROM "PromoCode" ORDER BY "id" COLLATE "C" FOR UPDATE;
END
$$;

UPDATE "PromoCode" p
SET "currentRedemptions" = (
  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id"
)
WHERE p."currentRedemptions" <> (
  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id"
);

COMMIT;

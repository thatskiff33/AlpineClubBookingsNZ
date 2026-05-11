-- Promote legacy CONFIRMED bookings that already have a succeeded payment.
-- The previous PAYMENT_PENDING backfill intentionally left these rows alone;
-- after the paid lifecycle rollout they must hold capacity and appear on lodge
-- operational surfaces as PAID bookings.
UPDATE "Booking" AS b
SET "status" = 'PAID',
    "updatedAt" = NOW()
WHERE b."status" = 'CONFIRMED'
  AND EXISTS (
    SELECT 1
    FROM "Payment" AS p
    WHERE p."bookingId" = b."id"
      AND p."status" = 'SUCCEEDED'
  );

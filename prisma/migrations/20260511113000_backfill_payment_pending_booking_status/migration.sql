-- Backfill legacy unpaid immediate-payment bookings after PAYMENT_PENDING is
-- present and the production app code can read the enum value.
UPDATE "Booking" AS b
SET "status" = 'PAYMENT_PENDING'
WHERE b."status" = 'CONFIRMED'
  AND NOT EXISTS (
    SELECT 1
    FROM "Payment" AS p
    WHERE p."bookingId" = b."id"
      AND p."status" = 'SUCCEEDED'
  );

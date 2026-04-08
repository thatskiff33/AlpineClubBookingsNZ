-- Fix existing $0 CONFIRMED bookings that should be PAID.
-- These may have been created before the zero-dollar booking fix was deployed.
-- Note: IDs use gen_random_uuid() (UUID format) rather than the app's cuid() convention.
-- This only affects the small number of records created by this migration.

-- First, create SUCCEEDED payment records for $0 CONFIRMED bookings that don't have one
INSERT INTO "Payment" ("id", "bookingId", "amountCents", "status", "refundedAmountCents", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  b."id",
  0,
  'SUCCEEDED',
  0,
  NOW(),
  NOW()
FROM "Booking" b
LEFT JOIN "Payment" p ON p."bookingId" = b."id"
WHERE b."status" = 'CONFIRMED'
  AND b."finalPriceCents" = 0
  AND p."id" IS NULL
ON CONFLICT ("bookingId") DO NOTHING;

-- Then update those bookings to PAID status
UPDATE "Booking"
SET "status" = 'PAID', "updatedAt" = NOW()
WHERE "status" = 'CONFIRMED'
  AND "finalPriceCents" = 0
  AND EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."bookingId" = "Booking"."id"
    AND p."status" = 'SUCCEEDED'
  );

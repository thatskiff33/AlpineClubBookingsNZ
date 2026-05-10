ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';

-- Existing CONFIRMED rows represent unpaid immediate-payment bookings. During
-- rollout CONFIRMED remains in the enum for blue/green compatibility, but app
-- code should stop writing it.
UPDATE "Booking"
SET "status" = 'PAYMENT_PENDING'
WHERE "status" = 'CONFIRMED';

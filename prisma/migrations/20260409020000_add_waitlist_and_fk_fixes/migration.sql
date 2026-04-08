-- Add waitlist feature schema changes and fix FK onDelete behaviors.

-- ============================================================================
-- 1. BookingStatus enum: add WAITLISTED and WAITLIST_OFFERED
-- ============================================================================

ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'WAITLISTED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'WAITLIST_OFFERED';

-- ============================================================================
-- 2. Booking: add waitlist columns
-- ============================================================================

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "waitlistPosition" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "waitlistOfferedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "waitlistOfferExpiresAt" TIMESTAMP(3);

-- Composite index for efficient waitlist queries (status + date range + FIFO order)
CREATE INDEX IF NOT EXISTS "Booking_status_checkIn_checkOut_createdAt_idx"
  ON "Booking"("status", "checkIn", "checkOut", "createdAt");

-- ============================================================================
-- 3. NotificationPreference: add bookingWaitlist preference
-- ============================================================================

ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "bookingWaitlist" BOOLEAN NOT NULL DEFAULT true;

-- ============================================================================
-- 4. ChoreAssignment: add missing index on bookingGuestId
-- ============================================================================

CREATE INDEX IF NOT EXISTS "ChoreAssignment_bookingGuestId_idx"
  ON "ChoreAssignment"("bookingGuestId");

-- ============================================================================
-- 5. FK fixes: FamilyGroupJoinRequest.requester RESTRICT → CASCADE
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupJoinRequest_requesterId_fkey'
  ) THEN
    ALTER TABLE "FamilyGroupJoinRequest" DROP CONSTRAINT "FamilyGroupJoinRequest_requesterId_fkey";
  END IF;
  ALTER TABLE "FamilyGroupJoinRequest" ADD CONSTRAINT "FamilyGroupJoinRequest_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

-- ============================================================================
-- 6. FK fixes: DeletionRequest.member RESTRICT → CASCADE
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DeletionRequest_memberId_fkey'
  ) THEN
    ALTER TABLE "DeletionRequest" DROP CONSTRAINT "DeletionRequest_memberId_fkey";
  END IF;
  ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

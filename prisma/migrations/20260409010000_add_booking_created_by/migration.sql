-- Add createdById to Booking for admin "book on behalf of" feature.
-- Records which admin created the booking when done on behalf of a member.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "createdById" TEXT;

-- Foreign key to Member
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Booking_createdById_fkey'
  ) THEN
    ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Index for lookups
CREATE INDEX IF NOT EXISTS "Booking_createdById_idx" ON "Booking"("createdById");

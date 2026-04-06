-- Phase 7 + Xero joined date schema additions
-- Adds columns introduced after phase 1/4/5/6/9 migration

-- Member: add passwordChangedAt, joinedDate, secondaryParentId
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "joinedDate" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "secondaryParentId" TEXT;

-- Add foreign key for secondaryParentId
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Member_secondaryParentId_fkey') THEN
    ALTER TABLE "Member" ADD CONSTRAINT "Member_secondaryParentId_fkey" FOREIGN KEY ("secondaryParentId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Add index on secondaryParentId
CREATE INDEX IF NOT EXISTS "Member_secondaryParentId_idx" ON "Member"("secondaryParentId");

-- Create ChoreTimeOfDay enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChoreTimeOfDay') THEN
    CREATE TYPE "ChoreTimeOfDay" AS ENUM ('MORNING', 'EVENING', 'ANYTIME');
  END IF;
END $$;

-- Create ChoreFrequencyMode enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChoreFrequencyMode') THEN
    CREATE TYPE "ChoreFrequencyMode" AS ENUM ('DAILY', 'EVERY_X_DAYS', 'SPECIFIC_DAYS');
  END IF;
END $$;

-- ChoreTemplate: add timeOfDay as proper enum
-- If column already exists as TEXT (from a prior buggy migration), fix it
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChoreTemplate' AND column_name = 'timeOfDay' AND udt_name = 'text'
  ) THEN
    -- Fix any invalid enum values from the old TEXT column
    UPDATE "ChoreTemplate" SET "timeOfDay" = 'ANYTIME' WHERE "timeOfDay" NOT IN ('MORNING', 'EVENING', 'ANYTIME');
    -- Convert TEXT column to enum
    ALTER TABLE "ChoreTemplate" ALTER COLUMN "timeOfDay" TYPE "ChoreTimeOfDay" USING "timeOfDay"::"ChoreTimeOfDay";
    ALTER TABLE "ChoreTemplate" ALTER COLUMN "timeOfDay" SET DEFAULT 'ANYTIME'::"ChoreTimeOfDay";
  ELSE
    -- Column doesn't exist yet, add it fresh
    ALTER TABLE "ChoreTemplate" ADD COLUMN IF NOT EXISTS "timeOfDay" "ChoreTimeOfDay" NOT NULL DEFAULT 'ANYTIME';
  END IF;
END $$;

-- Drop bogus columns from prior buggy migration if they exist
ALTER TABLE "ChoreTemplate" DROP COLUMN IF EXISTS "maxPerDay";
ALTER TABLE "ChoreTemplate" DROP COLUMN IF EXISTS "daysPerStay";

-- ChoreTemplate: add frequency columns
ALTER TABLE "ChoreTemplate" ADD COLUMN IF NOT EXISTS "frequencyMode" "ChoreFrequencyMode" NOT NULL DEFAULT 'DAILY';
ALTER TABLE "ChoreTemplate" ADD COLUMN IF NOT EXISTS "frequencyDays" INTEGER;
ALTER TABLE "ChoreTemplate" ADD COLUMN IF NOT EXISTS "frequencyDaysOfWeek" INTEGER[] DEFAULT '{}';

-- ChoreAssignment: add completedAt, completedVia
ALTER TABLE "ChoreAssignment" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "ChoreAssignment" ADD COLUMN IF NOT EXISTS "completedVia" TEXT;

-- BookingGuest: add arrivedAt, departedAt
ALTER TABLE "BookingGuest" ADD COLUMN IF NOT EXISTS "arrivedAt" TIMESTAMP(3);
ALTER TABLE "BookingGuest" ADD COLUMN IF NOT EXISTS "departedAt" TIMESTAMP(3);

-- HutLeaderAssignment table
CREATE TABLE IF NOT EXISTS "HutLeaderAssignment" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HutLeaderAssignment_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'HutLeaderAssignment_memberId_fkey') THEN
    ALTER TABLE "HutLeaderAssignment" ADD CONSTRAINT "HutLeaderAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "HutLeaderAssignment_memberId_idx" ON "HutLeaderAssignment"("memberId");
CREATE INDEX IF NOT EXISTS "HutLeaderAssignment_startDate_endDate_idx" ON "HutLeaderAssignment"("startDate", "endDate");

-- GuestChoreToken table
CREATE TABLE IF NOT EXISTS "GuestChoreToken" (
    "id" TEXT NOT NULL,
    "bookingGuestId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestChoreToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuestChoreToken_token_key" ON "GuestChoreToken"("token");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GuestChoreToken_bookingGuestId_fkey') THEN
    ALTER TABLE "GuestChoreToken" ADD CONSTRAINT "GuestChoreToken_bookingGuestId_fkey" FOREIGN KEY ("bookingGuestId") REFERENCES "BookingGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "GuestChoreToken_bookingGuestId_idx" ON "GuestChoreToken"("bookingGuestId");
CREATE INDEX IF NOT EXISTS "GuestChoreToken_token_idx" ON "GuestChoreToken"("token");

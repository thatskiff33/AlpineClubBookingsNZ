-- Fix schema drift: add missing columns, tables, enums, and indexes
-- that exist in schema.prisma but were never migrated.

-- ============================================================================
-- 1. CreditType enum
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditType') THEN
    CREATE TYPE "CreditType" AS ENUM ('CANCELLATION_REFUND', 'ADMIN_ADJUSTMENT', 'BOOKING_APPLIED');
  END IF;
END $$;

-- ============================================================================
-- 2. Payment: add missing columns
-- ============================================================================

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "xeroRefundCreditNoteId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "creditAppliedCents" INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- 3. CancellationPolicy: add missing creditRefundPercentage column
-- ============================================================================

ALTER TABLE "CancellationPolicy" ADD COLUMN IF NOT EXISTS "creditRefundPercentage" INTEGER;

-- ============================================================================
-- 4. MemberCredit table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "MemberCredit" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "type" "CreditType" NOT NULL,
    "description" TEXT NOT NULL,
    "sourceBookingId" TEXT,
    "appliedToBookingId" TEXT,
    "xeroCreditNoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberCredit_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "MemberCredit_memberId_idx" ON "MemberCredit"("memberId");
CREATE INDEX IF NOT EXISTS "MemberCredit_sourceBookingId_idx" ON "MemberCredit"("sourceBookingId");
CREATE INDEX IF NOT EXISTS "MemberCredit_appliedToBookingId_idx" ON "MemberCredit"("appliedToBookingId");

-- Foreign keys
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberCredit_memberId_fkey'
  ) THEN
    ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberCredit_sourceBookingId_fkey'
  ) THEN
    ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_sourceBookingId_fkey"
      FOREIGN KEY ("sourceBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberCredit_appliedToBookingId_fkey'
  ) THEN
    ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_appliedToBookingId_fkey"
      FOREIGN KEY ("appliedToBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Fix schema drift: add all columns/tables/indexes that exist in schema.prisma
-- but were never migrated to the production database.

-- ============================================================================
-- 1. MemberSubscription: add missing columns + NOT_INVOICED enum value
-- ============================================================================

-- Add NOT_INVOICED to SubscriptionStatus enum
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'NOT_INVOICED';

-- Add missing columns
ALTER TABLE "MemberSubscription" ADD COLUMN IF NOT EXISTS "xeroInvoiceNumber" TEXT;
ALTER TABLE "MemberSubscription" ADD COLUMN IF NOT EXISTS "xeroOnlineInvoiceUrl" TEXT;

-- Add composite index for season+status queries
CREATE INDEX IF NOT EXISTS "MemberSubscription_seasonYear_status_idx" ON "MemberSubscription"("seasonYear", "status");

-- ============================================================================
-- 2. Payment: add missing xeroInvoiceNumber column + indexes
-- ============================================================================

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "xeroInvoiceNumber" TEXT;

-- Add composite index for status+createdAt queries
CREATE INDEX IF NOT EXISTS "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- ============================================================================
-- 3. Booking: add missing expectedArrivalTime column + indexes
-- ============================================================================

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "expectedArrivalTime" VARCHAR(5);

-- Change notes from TEXT to VARCHAR(500) if currently TEXT (non-destructive, truncates nothing since limit is enforced in app)
-- Actually just leave it as TEXT since Prisma handles the VarChar annotation at the application level

-- Add composite indexes for common queries
CREATE INDEX IF NOT EXISTS "Booking_memberId_status_idx" ON "Booking"("memberId", "status");
CREATE INDEX IF NOT EXISTS "Booking_memberId_status_checkIn_idx" ON "Booking"("memberId", "status", "checkIn");
CREATE INDEX IF NOT EXISTS "Booking_status_createdAt_idx" ON "Booking"("status", "createdAt");

-- ============================================================================
-- 4. BookingPeriod table (date-specific policy overrides)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "BookingPeriod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "nonMemberHoldDays" INTEGER NOT NULL DEFAULT 7,
    "cancellationRules" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BookingPeriod_startDate_endDate_idx" ON "BookingPeriod"("startDate", "endDate");

-- ============================================================================
-- 5. BookingDefaults table (global settings, single row)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "BookingDefaults" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "nonMemberHoldDays" INTEGER NOT NULL DEFAULT 7,

    CONSTRAINT "BookingDefaults_pkey" PRIMARY KEY ("id")
);

-- Seed the default row if it doesn't exist
INSERT INTO "BookingDefaults" ("id", "nonMemberHoldDays")
VALUES ('default', 7)
ON CONFLICT ("id") DO NOTHING;

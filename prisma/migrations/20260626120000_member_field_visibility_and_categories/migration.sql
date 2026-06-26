-- Add membership category roles. These carry the same access as MEMBER; only
-- ADMIN and LODGE grant elevated access. IF NOT EXISTS keeps the migration
-- idempotent and re-runnable (Postgres 12+).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ASSOCIATE';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'LIFE';

-- New optional, adult-only member field.
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "occupation" TEXT;

-- Single-row club setting for optional member-field visibility (defaults on).
CREATE TABLE IF NOT EXISTS "MemberFieldsSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "showTitle" BOOLEAN NOT NULL DEFAULT true,
    "showGender" BOOLEAN NOT NULL DEFAULT true,
    "showOccupation" BOOLEAN NOT NULL DEFAULT true,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MemberFieldsSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MemberFieldsSettings_updatedByMemberId_idx" ON "MemberFieldsSettings"("updatedByMemberId");

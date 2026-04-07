-- Add DRAFT to BookingStatus enum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'DRAFT';

-- Add draftExpiresAt column to Booking
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "draftExpiresAt" TIMESTAMP(3);

-- Add inheritEmailFromId column to Member
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "inheritEmailFromId" TEXT;

-- Add FK constraint for inheritEmailFromId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Member_inheritEmailFromId_fkey'
  ) THEN
    ALTER TABLE "Member" ADD CONSTRAINT "Member_inheritEmailFromId_fkey"
      FOREIGN KEY ("inheritEmailFromId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Add index on inheritEmailFromId
CREATE INDEX IF NOT EXISTS "Member_inheritEmailFromId_idx" ON "Member"("inheritEmailFromId");

-- CreateTable FamilyGroupMember (join table)
CREATE TABLE IF NOT EXISTS "FamilyGroupMember" (
    "id" TEXT NOT NULL,
    "familyGroupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamilyGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FamilyGroupMember_familyGroupId_memberId_key" ON "FamilyGroupMember"("familyGroupId", "memberId");
CREATE INDEX IF NOT EXISTS "FamilyGroupMember_memberId_idx" ON "FamilyGroupMember"("memberId");
CREATE INDEX IF NOT EXISTS "FamilyGroupMember_familyGroupId_idx" ON "FamilyGroupMember"("familyGroupId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'FamilyGroupMember_familyGroupId_fkey'
  ) THEN
    ALTER TABLE "FamilyGroupMember" ADD CONSTRAINT "FamilyGroupMember_familyGroupId_fkey"
      FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'FamilyGroupMember_memberId_fkey'
  ) THEN
    ALTER TABLE "FamilyGroupMember" ADD CONSTRAINT "FamilyGroupMember_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable XeroAccountMapping
CREATE TABLE IF NOT EXISTS "XeroAccountMapping" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroAccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "XeroAccountMapping_key_key" ON "XeroAccountMapping"("key");
CREATE INDEX IF NOT EXISTS "XeroAccountMapping_key_idx" ON "XeroAccountMapping"("key");

-- CreateTable AgeTierSetting
CREATE TABLE IF NOT EXISTS "AgeTierSetting" (
    "id" TEXT NOT NULL,
    "tier" "AgeTier" NOT NULL,
    "minAge" INTEGER NOT NULL,
    "maxAge" INTEGER,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgeTierSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgeTierSetting_tier_key" ON "AgeTierSetting"("tier");
CREATE INDEX IF NOT EXISTS "AgeTierSetting_sortOrder_idx" ON "AgeTierSetting"("sortOrder");

-- CreateEnum DeletionRequestStatus
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeletionRequestStatus') THEN
    CREATE TYPE "DeletionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
  END IF;
END $$;

-- CreateTable DeletionRequest
CREATE TABLE IF NOT EXISTS "DeletionRequest" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "adminNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeletionRequest_memberId_idx" ON "DeletionRequest"("memberId");
CREATE INDEX IF NOT EXISTS "DeletionRequest_status_idx" ON "DeletionRequest"("status");
CREATE INDEX IF NOT EXISTS "DeletionRequest_createdAt_idx" ON "DeletionRequest"("createdAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'DeletionRequest_memberId_fkey'
  ) THEN
    ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill FamilyGroupMember from legacy familyGroupId
INSERT INTO "FamilyGroupMember" ("id", "familyGroupId", "memberId", "role", "joinedAt")
SELECT
  gen_random_uuid()::text,
  "familyGroupId",
  "id",
  'MEMBER',
  CURRENT_TIMESTAMP
FROM "Member"
WHERE "familyGroupId" IS NOT NULL
ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;

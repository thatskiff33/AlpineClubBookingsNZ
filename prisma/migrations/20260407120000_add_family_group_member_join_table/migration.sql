-- Create FamilyGroupMember join table for many-to-many family group memberships
CREATE TABLE IF NOT EXISTS "FamilyGroupMember" (
    "id" TEXT NOT NULL,
    "familyGroupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FamilyGroupMember_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupMember_familyGroupId_fkey') THEN
    ALTER TABLE "FamilyGroupMember" ADD CONSTRAINT "FamilyGroupMember_familyGroupId_fkey"
      FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupMember_memberId_fkey') THEN
    ALTER TABLE "FamilyGroupMember" ADD CONSTRAINT "FamilyGroupMember_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Add unique constraint and indexes
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupMember_familyGroupId_memberId_key') THEN
    ALTER TABLE "FamilyGroupMember" ADD CONSTRAINT "FamilyGroupMember_familyGroupId_memberId_key"
      UNIQUE ("familyGroupId", "memberId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "FamilyGroupMember_memberId_idx" ON "FamilyGroupMember"("memberId");
CREATE INDEX IF NOT EXISTS "FamilyGroupMember_familyGroupId_idx" ON "FamilyGroupMember"("familyGroupId");

-- Data migration: copy existing familyGroupId data into FamilyGroupMember rows
INSERT INTO "FamilyGroupMember" (id, "familyGroupId", "memberId", role, "joinedAt")
SELECT gen_random_uuid(), "familyGroupId", id, 'MEMBER', now()
FROM "Member" WHERE "familyGroupId" IS NOT NULL
ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;

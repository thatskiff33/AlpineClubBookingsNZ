-- Add secondary parent and email inheritance for dependents
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "inheritParentEmail" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "secondaryParentId" TEXT;
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "familyGroupId" TEXT;

-- Create FamilyGroup table
CREATE TABLE IF NOT EXISTS "FamilyGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FamilyGroup_pkey" PRIMARY KEY ("id")
);

-- Create FamilyGroupJoinRequest table
CREATE TABLE IF NOT EXISTS "FamilyGroupJoinRequest" (
    "id" TEXT NOT NULL,
    "familyGroupId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    CONSTRAINT "FamilyGroupJoinRequest_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys
ALTER TABLE "Member" ADD CONSTRAINT "Member_secondaryParentId_fkey"
    FOREIGN KEY ("secondaryParentId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Member" ADD CONSTRAINT "Member_familyGroupId_fkey"
    FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FamilyGroupJoinRequest" ADD CONSTRAINT "FamilyGroupJoinRequest_familyGroupId_fkey"
    FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FamilyGroupJoinRequest" ADD CONSTRAINT "FamilyGroupJoinRequest_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add indexes
CREATE INDEX IF NOT EXISTS "Member_secondaryParentId_idx" ON "Member"("secondaryParentId");
CREATE INDEX IF NOT EXISTS "Member_familyGroupId_idx" ON "Member"("familyGroupId");
CREATE INDEX IF NOT EXISTS "FamilyGroupJoinRequest_familyGroupId_idx" ON "FamilyGroupJoinRequest"("familyGroupId");
CREATE INDEX IF NOT EXISTS "FamilyGroupJoinRequest_requesterId_idx" ON "FamilyGroupJoinRequest"("requesterId");
CREATE INDEX IF NOT EXISTS "FamilyGroupJoinRequest_status_idx" ON "FamilyGroupJoinRequest"("status");

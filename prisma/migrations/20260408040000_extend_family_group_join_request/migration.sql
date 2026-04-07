-- Extend FamilyGroupJoinRequest for adult invitations and child/youth requests
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'JOIN_REQUEST';
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "invitedMemberId" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "childFirstName" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "childLastName" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "childDateOfBirth" TIMESTAMP(3);
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN IF NOT EXISTS "linkedMemberId" TEXT;

-- Foreign keys
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupJoinRequest_invitedMemberId_fkey') THEN
    ALTER TABLE "FamilyGroupJoinRequest" ADD CONSTRAINT "FamilyGroupJoinRequest_invitedMemberId_fkey"
      FOREIGN KEY ("invitedMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyGroupJoinRequest_linkedMemberId_fkey') THEN
    ALTER TABLE "FamilyGroupJoinRequest" ADD CONSTRAINT "FamilyGroupJoinRequest_linkedMemberId_fkey"
      FOREIGN KEY ("linkedMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "FamilyGroupJoinRequest_invitedMemberId_idx" ON "FamilyGroupJoinRequest"("invitedMemberId");
CREATE INDEX IF NOT EXISTS "FamilyGroupJoinRequest_type_idx" ON "FamilyGroupJoinRequest"("type");

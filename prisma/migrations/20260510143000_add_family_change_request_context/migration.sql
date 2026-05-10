-- Add context fields for admin-reviewed adult-addition and removal requests.
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "requestedFirstName" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "requestedLastName" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "requestedDateOfBirth" TIMESTAMP(3);
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "requestedEmail" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "subjectMemberId" TEXT;
ALTER TABLE "FamilyGroupJoinRequest" ADD COLUMN "requestNotes" TEXT;

CREATE INDEX "FamilyGroupJoinRequest_subjectMemberId_idx" ON "FamilyGroupJoinRequest"("subjectMemberId");
CREATE INDEX "FamilyGroupJoinRequest_requestedEmail_idx" ON "FamilyGroupJoinRequest"("requestedEmail");

ALTER TABLE "FamilyGroupJoinRequest"
  ADD CONSTRAINT "FamilyGroupJoinRequest_subjectMemberId_fkey"
  FOREIGN KEY ("subjectMemberId")
  REFERENCES "Member"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

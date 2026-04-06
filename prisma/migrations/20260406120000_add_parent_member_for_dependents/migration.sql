-- AlterTable: Add parentMemberId to Member for dependent/family member support
ALTER TABLE "Member" ADD COLUMN "parentMemberId" TEXT;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_parentMemberId_fkey" FOREIGN KEY ("parentMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex: Remove the simple unique constraint on email
DROP INDEX "Member_email_key";

-- CreateIndex: Partial unique index - email must be unique among primary members only
-- Dependents (parentMemberId IS NOT NULL) can share their parent's email
CREATE UNIQUE INDEX "Member_email_primary_unique" ON "Member" ("email") WHERE "parentMemberId" IS NULL;

-- CreateIndex: Index on parentMemberId for efficient dependent lookups
CREATE INDEX "Member_parentMemberId_idx" ON "Member" ("parentMemberId");

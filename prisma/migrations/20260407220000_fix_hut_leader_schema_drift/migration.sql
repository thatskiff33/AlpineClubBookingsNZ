-- Add missing updatedAt column to HutLeaderAssignment
ALTER TABLE "HutLeaderAssignment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Drop assignedBy column that was removed from schema
ALTER TABLE "HutLeaderAssignment" DROP COLUMN IF EXISTS "assignedBy";

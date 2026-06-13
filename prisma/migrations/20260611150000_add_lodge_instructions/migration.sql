-- Lodge instructions for hut leaders (issue #710).
-- Protected procedure documents (opening, closing, day-to-day) kept in a
-- dedicated table, deliberately separate from the public "PageContent" table.

-- CreateEnum
CREATE TYPE "LodgeInstructionKey" AS ENUM ('OPEN', 'CLOSE', 'DAY_TO_DAY');

-- CreateTable
CREATE TABLE "LodgeInstruction" (
    "id" TEXT NOT NULL,
    "key" "LodgeInstructionKey" NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgeInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LodgeInstruction_key_key" ON "LodgeInstruction"("key");

-- CreateIndex
CREATE INDEX "LodgeInstruction_updatedByMemberId_idx" ON "LodgeInstruction"("updatedByMemberId");

-- Backfill the three keyed documents so every environment that runs
-- migrations (including deploy-only environments that never run the seed)
-- has one row per document for admins to edit. ON CONFLICT DO NOTHING keeps
-- this safe to re-run and never overwrites admin-edited content.
INSERT INTO "LodgeInstruction"
  ("id", "key", "contentHtml", "updatedAt")
VALUES
  ('lodge-instruction-open', 'OPEN', '', CURRENT_TIMESTAMP),
  ('lodge-instruction-close', 'CLOSE', '', CURRENT_TIMESTAMP),
  ('lodge-instruction-day-to-day', 'DAY_TO_DAY', '', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

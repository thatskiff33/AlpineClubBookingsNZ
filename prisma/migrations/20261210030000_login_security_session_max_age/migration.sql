-- #4611: additive, expand-only. One new integer on the cold LoginSecuritySetting
-- singleton, NOT NULL with a constant default of 168 (7 days), so every existing
-- row reads as the default maximum session age and an old-colour INSERT that
-- omits the column still succeeds. The draining release never names the column.
-- PostgreSQL 11+ adds a column with a constant default without rewriting the
-- table.

-- AlterTable
ALTER TABLE "LoginSecuritySetting" ADD COLUMN "sessionMaxAgeHours" INTEGER NOT NULL DEFAULT 168;

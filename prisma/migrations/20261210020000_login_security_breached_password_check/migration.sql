-- #4610: additive, expand-only. One new boolean on the cold LoginSecuritySetting
-- singleton, NOT NULL with a constant default of true, so every existing row
-- reads as "check on" and an old-colour INSERT that omits the column still
-- succeeds. The draining release never names the column. PostgreSQL 11+ adds a
-- column with a constant default without rewriting the table.

-- AlterTable
ALTER TABLE "LoginSecuritySetting" ADD COLUMN "breachedPasswordCheck" BOOLEAN NOT NULL DEFAULT true;

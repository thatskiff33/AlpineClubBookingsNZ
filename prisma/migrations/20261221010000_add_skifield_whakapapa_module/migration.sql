-- #4932: split the Whakapapa (Mt Ruapehu) conditions report out of the
-- generic skifieldConditions module into its own skifieldWhakapapa module.
--
-- EXPAND, OLD-CODE COMPATIBLE. One defaulted column on the ClubModuleSettings
-- singleton. Every read of that table narrows to
-- CLUB_MODULE_SETTINGS_COLUMN_SELECT, so the draining release never names the
-- column, and its upsert leaves the column at whatever this migration wrote.
--
-- The column defaults to false because a NEW install should opt into a
-- report that only makes sense for one ski field. An EXISTING install keeps
-- what it has today, where the one skifieldConditions switch also served the
-- Whakapapa report and the admin Mountain Conditions page, so the UPDATE
-- copies that value across.
--
-- Every database already holds the singleton row: 20260518113000_add_club_module_settings
-- inserted it, on a fresh install too, with skifieldConditions at its default
-- of true. So the row cannot tell a new install from an old one. A member can:
-- a fresh install's first migrate runs before anyone has signed up, so its row
-- keeps the column default and the report starts off.
--
-- Safe to run twice in a row: the second run's ADD COLUMN IF NOT EXISTS is a
-- no-op and its UPDATE rewrites the same value. It is NOT safe to replay later:
-- once an admin has set the two switches apart, the UPDATE would copy
-- skifieldConditions back over their choice. Prisma's _prisma_migrations ledger
-- is what stops a later replay; the migration does not guard against it.

ALTER TABLE "ClubModuleSettings"
  ADD COLUMN IF NOT EXISTS "skifieldWhakapapa" BOOLEAN NOT NULL DEFAULT false;

-- A deployment can have no row if it never saved Modules and the migration-
-- seeded singleton was removed. Preserve the old effective default there too.
INSERT INTO "ClubModuleSettings" ("id", "skifieldWhakapapa")
SELECT 'default', true
WHERE EXISTS (SELECT 1 FROM "Member")
ON CONFLICT ("id") DO NOTHING;

UPDATE "ClubModuleSettings"
SET "skifieldWhakapapa" = "skifieldConditions"
WHERE EXISTS (SELECT 1 FROM "Member");

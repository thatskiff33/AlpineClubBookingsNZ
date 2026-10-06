-- Reverse script for 20261112010000_other_lodge_beds_and_facilities.
--
-- That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, so its rollback boundary is the MIGRATE
-- step. Prisma never applies, checksums or reads this file: run it by hand, as
-- the migration role, against the database being rolled back to a release that
-- speaks Alpine Central Server API 2.0.
--
-- WHAT IT RESTORES. The "bookingPath" column, byte-identical in shape to the
-- one 20261006010000_add_other_lodge_details_and_amenities created
-- (VARCHAR(300), nullable, no default). Every row comes back NULL: PostgreSQL
-- cannot un-drop a column. NULL is the safe value because the field is
-- optional free text shown only in the admin editor, and a 2.0 site refills it
-- from the next download from a 2.0 server.
--
-- The 2.1 columns and the enum type are removed too, so the table matches the
-- 2.0 schema exactly (Prisma's migration-drift check would otherwise report
-- them). Their values are lost; a 2.1 server is the source for all of them.

ALTER TABLE "OtherLodge" ADD COLUMN "bookingPath" VARCHAR(300),
  DROP COLUMN "doubleBeds",
  DROP COLUMN "singleBeds",
  DROP COLUMN "minutesWalkToLodge",
  DROP COLUMN "roomType",
  DROP COLUMN "skiWorkshopArea",
  DROP COLUMN "gamesRoom";

DROP TYPE "OtherLodgeRoomType";

-- ROLLING FORWARD AFTER THIS SCRIPT: `_prisma_migrations` still records the
-- migration as applied, so `prisma migrate deploy` will not re-run it. Re-apply
-- migration.sql by hand as the migration role (the same practice as
-- 20260803030000_contract_drop_family_group_member_role/rollback.sql). This
-- script is not idempotent: a second run fails on the existing "bookingPath",
-- which is the safe direction.

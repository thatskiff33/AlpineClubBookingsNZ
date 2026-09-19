-- Member lodge roster (#2942).
--
-- Two additive columns, no DML of any kind.
--
-- 1. The module flag. Default false: the roster discloses one member's stay
--    pattern to another, so a club opts in deliberately rather than inheriting
--    the surface from an upgrade.
-- 2. The per-lodge name-detail dial for that roster. Nullable, and null means
--    the roster default (FULL_NAME) resolved in application code, exactly as
--    the sibling "displayNameGranularity" column already works for the lobby
--    display. No enum is created: DisplayNameGranularity already exists.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client names neither
-- column, so its INSERTs receive the DEFAULT and its reads never select them.
-- Both surfaces are inert until the flag is switched on by an administrator.

BEGIN;

ALTER TABLE "ClubModuleSettings"
  ADD COLUMN "memberLodgeRoster" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Lodge"
  ADD COLUMN "rosterNameGranularity" "DisplayNameGranularity";

COMMIT;

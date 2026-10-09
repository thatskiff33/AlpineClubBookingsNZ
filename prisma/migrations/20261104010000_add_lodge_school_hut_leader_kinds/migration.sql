-- #3819 (wave #3820, epic #3789; owner decisions 2 Oct 2026): a per-lodge
-- setting, "Who can be hut leader for school bookings", with four kinds a lodge
-- may tick in any combination. It replaces #3416's club-wide switch
-- BookingRequestSettings.assignSchoolTeachersAsHutLeaders.
--
-- EXPAND ONLY. The old switch column is left in place for the draining colour;
-- a later contract release drops it (an epic never pairs an expand with its own
-- contract, docs/BLUE_GREEN_MIGRATION_POLICY.md).
--
-- 1. Four NOT NULL booleans with constant defaults (catalog-only on PostgreSQL
--    11+). The three member/custodian kinds default ON, because before this
--    setting any present leader covered a school booking's nights; teachers
--    default OFF, matching #3416's default.
ALTER TABLE "LodgeSettings"
  ADD COLUMN "schoolHutLeaderTeacherOnBooking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "schoolHutLeaderCustodian" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "schoolHutLeaderMemberOnBooking" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "schoolHutLeaderMemberStayingSeparately" BOOLEAN NOT NULL DEFAULT true;

-- 2. Carry the switch's value into EVERY lodge's setting, so behaviour is kept.
--    A lodge's setting resolves from its own row (id = lodge id), else from the
--    legacy "default" row when that row is unlinked or linked to the same lodge,
--    else from the code defaults (src/lib/lodge-settings.ts). When the switch is
--    OFF (or the lazy singleton row was never written) nothing is inserted,
--    because the code default already reads OFF. When it is ON:
--
--    2a. With no legacy row at all, create it LINKED TO THE DEFAULT LODGE, the
--        row the boot-time capacity self-heal and the seed would create. It
--        holds NULL capacity and soft cap, which is what that lodge resolved
--        with no row, and the self-heal keeps writing the capacity it heals
--        onto the row that lodge reads. (An own row here would shadow the
--        legacy row the self-heal writes, and lose that capacity.)
INSERT INTO "LodgeSettings" ("id", "lodgeId")
SELECT 'default', default_lodge_id()
WHERE COALESCE(
        (SELECT brs."assignSchoolTeachersAsHutLeaders"
         FROM "BookingRequestSettings" brs
         WHERE brs."id" = 'default'),
        false
      ) IS TRUE
  AND default_lodge_id() IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "LodgeSettings" existing WHERE existing."id" = 'default');

--    2b. Every other lodge that no row serves (no own row, and the legacy row
--        is linked to another lodge) gets its own row: NULL capacity and soft
--        cap, which is exactly what it resolved before, so nothing but the new
--        tick changes for it. A lodge an unlinked legacy row serves is never
--        given one, because that row would then shadow the capacity it serves.
INSERT INTO "LodgeSettings" ("id", "lodgeId")
SELECT l."id", l."id"
FROM "Lodge" l
WHERE COALESCE(
        (SELECT brs."assignSchoolTeachersAsHutLeaders"
         FROM "BookingRequestSettings" brs
         WHERE brs."id" = 'default'),
        false
      )
  AND NOT EXISTS (SELECT 1 FROM "LodgeSettings" own WHERE own."id" = l."id")
  AND NOT EXISTS (
    SELECT 1 FROM "LodgeSettings" legacy
    WHERE legacy."id" = 'default'
      AND (legacy."lodgeId" IS NULL OR legacy."lodgeId" = l."id")
  );

UPDATE "LodgeSettings"
SET "schoolHutLeaderTeacherOnBooking" = COALESCE(
  (SELECT brs."assignSchoolTeachersAsHutLeaders"
   FROM "BookingRequestSettings" brs
   WHERE brs."id" = 'default'),
  false
);

import type { DataMigrationVerification } from "./types";

/**
 * #3819: #3416's club-wide switch is carried into every lodge's per-lodge
 * "Who can be hut leader for school bookings" setting.
 *
 * Every case pins the club's legacy "default" LodgeSettings row to a lodge of
 * its own choosing, so which lodges that row serves is the case's decision
 * rather than whatever the earlier migrations happened to leave.
 */

const LODGES = `
  INSERT INTO "Lodge" ("id", "name", "slug", "updatedAt") VALUES
    ('dmv-3819-legacy', 'Legacy Lodge', 'dmv-3819-legacy', TIMESTAMP '2026-10-01 00:00:00'),
    ('dmv-3819-own', 'Own Row Lodge', 'dmv-3819-own', TIMESTAMP '2026-10-01 00:00:00'),
    ('dmv-3819-none', 'No Row Lodge', 'dmv-3819-none', TIMESTAMP '2026-10-01 00:00:00');
  INSERT INTO "LodgeSettings" ("id", "lodgeId", "capacity", "schoolGroupSoftCap")
  VALUES ('dmv-3819-own', 'dmv-3819-own', 30, 12);
`;

function switchRow(value: boolean): string {
  return `
    INSERT INTO "BookingRequestSettings" ("id", "assignSchoolTeachersAsHutLeaders", "updatedAt")
    VALUES ('default', ${value}, TIMESTAMP '2026-10-01 00:00:00')
    ON CONFLICT ("id") DO UPDATE SET "assignSchoolTeachersAsHutLeaders" = ${value};
  `;
}

function legacyRow(lodgeId: string | null): string {
  const link = lodgeId === null ? "NULL" : `'${lodgeId}'`;
  return `
    INSERT INTO "LodgeSettings" ("id", "lodgeId", "capacity")
    VALUES ('default', ${link}, 20)
    ON CONFLICT ("id") DO UPDATE SET "lodgeId" = ${link}, "capacity" = 20;
  `;
}

/** What the previous release's Prisma client writes: none of the new columns. */
const OLD_CODE_INSERT = `
  INSERT INTO "LodgeSettings" ("id", "lodgeId", "capacity")
  VALUES ('dmv-3819-old-insert', NULL, 8);
`;

const ROWS_SQL = `
  SELECT "id", "lodgeId", "capacity", "schoolGroupSoftCap",
         "schoolHutLeaderTeacherOnBooking" AS "teacher",
         "schoolHutLeaderCustodian" AS "custodian",
         "schoolHutLeaderMemberOnBooking" AS "memberOnBooking",
         "schoolHutLeaderMemberStayingSeparately" AS "memberSeparately"
  FROM "LodgeSettings"
  WHERE "id" IN ('default', 'dmv-3819-own', 'dmv-3819-none', 'dmv-3819-legacy', 'dmv-3819-old-insert')
  ORDER BY "id" COLLATE "C"
`;

const OTHER_KINDS = { custodian: true, memberOnBooking: true, memberSeparately: true };

const verification: DataMigrationVerification = {
  migration: "20261104010000_add_lodge_school_hut_leader_kinds",
  intent:
    "Add the four per-lodge school hut-leader kinds and carry #3416's club-wide teacher switch into every lodge's setting, inserting an own row only for a lodge no row serves, without changing any lodge's capacity or soft cap.",
  idempotentReRun: false,
  cases: [
    {
      name: "switch ON, legacy row linked to one lodge: every lodge reads teachers ticked",
      seed: `${LODGES}${legacyRow("dmv-3819-legacy")}${switchRow(true)}`,
      afterMigration: OLD_CODE_INSERT,
      expectations: [
        {
          claim:
            "the own row and the legacy row are ticked in place, the lodge no row served gets its own row with NULL capacity and soft cap, and the lodge the legacy row serves gets none; an old-code insert reads the defaults",
          sql: ROWS_SQL,
          rows: [
            { id: "default", lodgeId: "dmv-3819-legacy", capacity: 20, schoolGroupSoftCap: null, teacher: true, ...OTHER_KINDS },
            { id: "dmv-3819-none", lodgeId: "dmv-3819-none", capacity: null, schoolGroupSoftCap: null, teacher: true, ...OTHER_KINDS },
            { id: "dmv-3819-old-insert", lodgeId: null, capacity: 8, schoolGroupSoftCap: null, teacher: false, ...OTHER_KINDS },
            { id: "dmv-3819-own", lodgeId: "dmv-3819-own", capacity: 30, schoolGroupSoftCap: 12, teacher: true, ...OTHER_KINDS },
          ],
        },
      ],
    },
    {
      name: "switch ON, legacy row unlinked: it serves every lodge without a row, so nothing is inserted",
      seed: `${LODGES}${legacyRow(null)}${switchRow(true)}`,
      expectations: [
        {
          claim:
            "no own row is inserted while the unlinked legacy row serves the lodges, and both existing rows read teachers ticked",
          sql: ROWS_SQL,
          rows: [
            { id: "default", lodgeId: null, capacity: 20, schoolGroupSoftCap: null, teacher: true, ...OTHER_KINDS },
            { id: "dmv-3819-own", lodgeId: "dmv-3819-own", capacity: 30, schoolGroupSoftCap: 12, teacher: true, ...OTHER_KINDS },
          ],
        },
      ],
    },
    {
      name: "switch OFF: nothing is inserted and every lodge reads teachers unticked",
      seed: `${LODGES}${legacyRow("dmv-3819-legacy")}${switchRow(false)}`,
      afterMigration: OLD_CODE_INSERT,
      expectations: [
        {
          claim:
            "no own row is inserted, every row reads teachers unticked and the other three kinds ticked",
          sql: ROWS_SQL,
          rows: [
            { id: "default", lodgeId: "dmv-3819-legacy", capacity: 20, schoolGroupSoftCap: null, teacher: false, ...OTHER_KINDS },
            { id: "dmv-3819-old-insert", lodgeId: null, capacity: 8, schoolGroupSoftCap: null, teacher: false, ...OTHER_KINDS },
            { id: "dmv-3819-own", lodgeId: "dmv-3819-own", capacity: 30, schoolGroupSoftCap: 12, teacher: false, ...OTHER_KINDS },
          ],
        },
      ],
    },
    {
      name: "switch ON with no legacy row: the legacy row is created for the default lodge, not an own row",
      // The default lodge is pinned to one of this case's lodges, so which lodge
      // `default_lodge_id()` names is the case's decision.
      seed: `${LODGES}
        UPDATE "Lodge" SET "isDefault" = false WHERE "isDefault";
        UPDATE "Lodge" SET "isDefault" = true WHERE "id" = 'dmv-3819-legacy';
        DELETE FROM "LodgeSettings" WHERE "id" = 'default';
        ${switchRow(true)}`,
      expectations: [
        {
          claim:
            "the default lodge reads a new legacy row linked to it (which the capacity self-heal writes), with NULL capacity as before; the lodge no row served gets its own; the own row is ticked in place",
          sql: ROWS_SQL,
          rows: [
            { id: "default", lodgeId: "dmv-3819-legacy", capacity: null, schoolGroupSoftCap: null, teacher: true, ...OTHER_KINDS },
            { id: "dmv-3819-none", lodgeId: "dmv-3819-none", capacity: null, schoolGroupSoftCap: null, teacher: true, ...OTHER_KINDS },
            { id: "dmv-3819-own", lodgeId: "dmv-3819-own", capacity: 30, schoolGroupSoftCap: 12, teacher: true, ...OTHER_KINDS },
          ],
        },
      ],
    },
    {
      name: "the lazy booking-request singleton was never written: the switch reads OFF",
      seed: `${LODGES}${legacyRow("dmv-3819-legacy")}
        DELETE FROM "BookingRequestSettings" WHERE "id" = 'default';`,
      expectations: [
        {
          claim: "an absent singleton is the switch's OFF default, so nothing is inserted or ticked",
          sql: ROWS_SQL,
          rows: [
            { id: "default", lodgeId: "dmv-3819-legacy", capacity: 20, schoolGroupSoftCap: null, teacher: false, ...OTHER_KINDS },
            { id: "dmv-3819-own", lodgeId: "dmv-3819-own", capacity: 30, schoolGroupSoftCap: 12, teacher: false, ...OTHER_KINDS },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "give the lodge the legacy row is linked to an own row as well",
      harm:
        "That lodge's new own row, with NULL capacity, is read before the legacy row that held its capacity: its capacity silently drops to the bed count or zero.",
      find: ` OR legacy."lodgeId" = l."id"`,
      replace: "",
    },
    {
      name: "create the missing legacy row unlinked",
      harm:
        "An unlinked legacy row serves every lodge, so the lodges that should have got their own ticked row read it instead, and the self-heal later links it to the default lodge alone: the other lodges silently lose the teacher tick.",
      find: `SELECT 'default', default_lodge_id()`,
      replace: `SELECT 'default', NULL`,
    },
    {
      name: "insert own rows even while the unlinked legacy row serves the lodge",
      harm:
        "A lodge served by the unlinked legacy row gets an own row with NULL capacity, which the resolver reads first: its capacity silently drops to the bed count or zero.",
      find: `legacy."lodgeId" IS NULL OR `,
      replace: "",
    },
    {
      name: "insert own rows when the switch is OFF",
      harm:
        "Lodges gain settings rows nobody asked for; harmless to the tick but a data rewrite the switch's value did not call for.",
      find: `FROM "Lodge" l
WHERE COALESCE(`,
      replace: `FROM "Lodge" l
WHERE NOT COALESCE(`,
    },
    {
      name: "ignore the switch and leave every lodge unticked",
      harm:
        "A club that had turned teacher hut leaders on silently loses it at every lodge: school approvals stop assigning teachers.",
      find: `UPDATE "LodgeSettings"
SET "schoolHutLeaderTeacherOnBooking" = COALESCE(`,
      replace: `UPDATE "LodgeSettings"
SET "schoolHutLeaderTeacherOnBooking" = false AND COALESCE(`,
    },
    {
      name: "default the custodian kind off",
      harm:
        "Every lodge stops counting its custodian as cover for school nights, so nights that were covered show as needing a leader.",
      find: `"schoolHutLeaderCustodian" BOOLEAN NOT NULL DEFAULT true`,
      replace: `"schoolHutLeaderCustodian" BOOLEAN NOT NULL DEFAULT false`,
    },
    {
      name: "default the teacher kind on",
      harm:
        "An old-colour insert during the drain creates a lodge row that makes teachers hut leaders without anyone choosing it.",
      find: `"schoolHutLeaderTeacherOnBooking" BOOLEAN NOT NULL DEFAULT false`,
      replace: `"schoolHutLeaderTeacherOnBooking" BOOLEAN NOT NULL DEFAULT true`,
    },
  ],
};

export default verification;

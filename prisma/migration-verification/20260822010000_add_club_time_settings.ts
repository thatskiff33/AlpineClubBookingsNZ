import type { DataMigrationVerification } from "./types";

/**
 * CT-1 (#2989) — the installation's one club timezone gets a home, and the
 * migration deliberately puts nothing in it.
 *
 * WHY A FIXTURE FOR A MIGRATION THAT REWRITES NOTHING. This migration is two
 * `CREATE` statements, so `scripts/check-data-migration-verification.sh`
 * classifies it as shape-only and demands nothing. It ships a fixture anyway,
 * because on this table the SHAPE *is* the behaviour, in four specific ways that
 * a reader of the schema file cannot check and `Migration drift check` does not
 * distinguish from any other passing migration:
 *
 *  1. `timeZone` is NOT NULL. That is what makes the ROW's existence mean "this
 *     club has a configured timezone". Nullable, a row could exist carrying no
 *     zone — and that state is worse than no row at all, because the boot
 *     backfill's presence check is row-level, so it would see the row, skip, and
 *     leave the club resolving from `TZ` forever with nothing to notice.
 *  2. The `id` default is exactly `'default'`. Every read and write is
 *     `where: { id: "default" }`. Any other default and the row the backfill
 *     writes is invisible to the application that wrote it.
 *  3. `id` carries a PRIMARY KEY. This is the property a review found unpinned,
 *     and it is the strongest of the four: it is what makes `where: { id: ... }`
 *     a `findUnique` at all, and it is the SOLE reason the documented blue/green
 *     double-boot race raises the `P2002` that `isUniqueConstraintError` handles
 *     — without it two simultaneous colour boots insert two `'default'` rows and
 *     the "one row, never overwritten" guarantee is gone. Deleting the constraint
 *     line leaves valid SQL and left every other expectation here passing: `id`
 *     keeps its explicit `NOT NULL` so the column shape is byte-identical, the
 *     table is still empty, and the index query filters on the other index by
 *     name. So the fixture would have gone green on a table with no unique
 *     constraint on its key.
 *  4. The table is EMPTY afterwards. This is the substantive decision in the
 *     migration rather than an accident of it: SQL cannot read `process.env.TZ`,
 *     so seeding `'Pacific/Auckland'` here would silently reassign the civil time
 *     of every club running on any other zone. Preserving each deployment's
 *     CURRENT EFFECTIVE zone has to happen at boot, from the environment, which is
 *     what `clubTimeZoneSelfHealStep` does. A future edit that "helpfully" seeds a
 *     default row has to fail something, and this is the something.
 *
 * The pre-state is empty on purpose — the strongest form the fixture types
 * describe. A real install upgrading to this release holds exactly what the
 * earlier migrations produce and nothing more, because the table does not exist
 * for it to hold anything in.
 */

/** The catalog shape of the new table, read in a stable order. */
const COLUMN_SHAPE_QUERY = `SELECT "column_name", "data_type", "character_maximum_length",
          "is_nullable", "column_default"
     FROM information_schema.columns
    WHERE "table_schema" = current_schema() AND "table_name" = 'ClubTimeSettings'
    ORDER BY "ordinal_position"`;

const verification: DataMigrationVerification = {
  migration: "20260822010000_add_club_time_settings",
  intent:
    "Create the ClubTimeSettings singleton that holds this installation's one IANA club timezone, with timeZone NOT NULL and the id defaulting to 'default', and leave it EMPTY — an existing deployment's current effective timezone comes from its own environment, which SQL cannot read, so the row is written at boot by the create-if-absent club-time-zone self-heal step rather than guessed at here.",
  // CREATE TABLE without IF NOT EXISTS fails 42P07 on a replay, so the file as a
  // whole is not re-runnable and does not claim to be. The re-runnable half is
  // the boot backfill, which is a create-if-absent upsert by construction.
  idempotentReRun: false,
  cases: [
    {
      name:
        "any club upgrading to this release — nothing is seeded, so the pre-state is literally what the earlier migrations produce",
      seed: "",
      expectations: [
        {
          claim:
            "the table exists with exactly five columns: a TEXT id defaulting to 'default', a NOT NULL VARCHAR(64) timeZone, a nullable updatedByMemberId, and the two timestamps",
          sql: COLUMN_SHAPE_QUERY,
          rows: [
            {
              column_name: "id",
              data_type: "text",
              character_maximum_length: null,
              is_nullable: "NO",
              column_default: "'default'::text",
            },
            {
              column_name: "timeZone",
              data_type: "character varying",
              character_maximum_length: 64,
              is_nullable: "NO",
              column_default: null,
            },
            {
              column_name: "updatedByMemberId",
              data_type: "text",
              character_maximum_length: null,
              is_nullable: "YES",
              column_default: null,
            },
            {
              column_name: "createdAt",
              data_type: "timestamp without time zone",
              character_maximum_length: null,
              is_nullable: "NO",
              column_default: "CURRENT_TIMESTAMP",
            },
            {
              column_name: "updatedAt",
              data_type: "timestamp without time zone",
              character_maximum_length: null,
              is_nullable: "NO",
              column_default: "CURRENT_TIMESTAMP",
            },
          ],
        },
        {
          claim:
            "the table is EMPTY — the migration invents no timezone for a club that may not be in New Zealand",
          sql: 'SELECT count(*)::int AS "rows" FROM "ClubTimeSettings"',
          rows: [{ rows: 0 }],
        },
        {
          claim:
            "id is the PRIMARY KEY — the unique constraint that makes findUnique work and that turns a raced double-boot insert into the P2002 the backfill handles",
          sql: `SELECT tc."constraint_name", tc."constraint_type", kcu."column_name"
                  FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu
                    ON kcu."constraint_name" = tc."constraint_name"
                   AND kcu."table_schema" = tc."table_schema"
                 WHERE tc."table_schema" = current_schema()
                   AND tc."table_name" = 'ClubTimeSettings'
                   AND tc."constraint_type" = 'PRIMARY KEY'
                 ORDER BY kcu."ordinal_position"`,
          rows: [
            {
              constraint_name: "ClubTimeSettings_pkey",
              constraint_type: "PRIMARY KEY",
              column_name: "id",
            },
          ],
        },
        {
          claim:
            "the updatedByMemberId index the schema declares exists, and indexes updatedByMemberId",
          sql: `SELECT "indexname", "indexdef" FROM pg_indexes
                 WHERE "schemaname" = current_schema()
                   AND "tablename" = 'ClubTimeSettings'
                   AND "indexname" = 'ClubTimeSettings_updatedByMemberId_idx'`,
          rows: [
            {
              indexname: "ClubTimeSettings_updatedByMemberId_idx",
              indexdef:
                'CREATE INDEX "ClubTimeSettings_updatedByMemberId_idx" ON public."ClubTimeSettings" USING btree ("updatedByMemberId")',
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "timeZone becomes nullable",
      harm:
        "A row could then exist carrying no timezone at all. That is worse than no row: the boot backfill's presence check is row-level, so it would find the row, skip, and leave the club resolving its civil time from the container's TZ indefinitely — with the setup checklist reporting a configured timezone because a row exists. The one state #2989 forbids, reached silently.",
      find: '"timeZone" VARCHAR(64) NOT NULL',
      replace: '"timeZone" VARCHAR(64)',
    },
    {
      name: "the id default is something other than 'default'",
      harm:
        'Every read and write of this singleton is `where: { id: "default" }`. With any other default, a row inserted without an explicit id — which is what a create-if-absent upsert from an older client or a hand-written INSERT does — is invisible to the application that wrote it, so the club never appears configured and the backfill re-runs forever.',
      find: "\"id\" TEXT NOT NULL DEFAULT 'default'",
      replace: "\"id\" TEXT NOT NULL DEFAULT 'club'",
    },
    {
      name: "the PRIMARY KEY on id is dropped",
      harm:
        "`where: { id: \"default\" }` stops being a unique lookup, and — the part that actually breaks — two colours booting simultaneously both INSERT a 'default' row instead of one of them raising P2002. The backfill's whole never-overwrite guarantee rests on that constraint, so the club could end up with two timezone rows and the reader returning whichever the planner happened to reach first.",
      // Replaces the key with an always-true CHECK rather than deleting the
      // line: same single-line edit, still valid SQL, and it leaves the table
      // with NO unique constraint on `id` — which is the property under test.
      find: 'CONSTRAINT "ClubTimeSettings_pkey" PRIMARY KEY ("id")',
      replace: 'CONSTRAINT "ClubTimeSettings_pkey" CHECK (true)',
    },
    {
      name: "the index is built over the wrong column",
      harm:
        "The declared index would not match the schema, so `Migration drift check` and the application's own expectations diverge — the class of drift that only shows up as a slow query or a failed later migration.",
      find: '("updatedByMemberId");',
      replace: '("id");',
    },
  ],
};

export default verification;

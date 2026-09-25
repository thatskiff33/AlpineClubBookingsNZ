import type { DataMigrationVerification } from "./types";

/**
 * #3603 (owner decision D1 on PR #3608): session revocation is stored on the
 * server. This migration adds `Member.sessionsRevokedAt` and the trigger that
 * stamps it whenever `canLogin` goes from true to false; the backfill for
 * members whose login is already off is the next migration, with its own
 * fixture. The token refresh refuses any session issued before the stamp
 * (INV-LIFE-092).
 *
 * The trigger must stamp a true-to-false write and nothing else: not an update
 * that leaves `canLogin` alone, not true-to-true, not false-to-false, and not a
 * re-enable, which must keep the earlier revocation time. And it must not
 * rewrite any existing row itself: that is the backfill's job.
 */

const MEMBERS = (rows: string) => `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "canLogin", "updatedAt"
  ) VALUES ${rows};
`;

const REVOKED_STATE = `
  SELECT
    "id",
    "canLogin",
    ("sessionsRevokedAt" IS NOT NULL) AS "revoked"
  FROM "Member"
  WHERE "id" LIKE 'dmv-revoke-%'
  ORDER BY "id" COLLATE "C"
`;

/** A revocation time the trigger could never write, so a re-stamp is visible. */
const EARLIER = "2020-01-01 00:00:00.000";

const verification: DataMigrationVerification = {
  migration: "20261009010000_add_member_sessions_revoked_at",
  intent:
    "Add Member.sessionsRevokedAt and install a trigger that stamps it in explicit UTC on every canLogin true-to-false update and on no other write, rewriting no existing row.",
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "the migration itself stamps no existing member",
      seed: MEMBERS(`
        ('dmv-revoke-a-login', 'dmv-revoke-a@example.invalid', 'x', 'Login', 'On', true, now()),
        ('dmv-revoke-b-nologin', 'dmv-revoke-b@example.invalid', 'x', 'Login', 'Off', false, now())
      `),
      expectations: [
        {
          claim: "no row is stamped until a real switch-off or the backfill",
          sql: REVOKED_STATE,
          rows: [
            { id: "dmv-revoke-a-login", canLogin: true, revoked: false },
            { id: "dmv-revoke-b-nologin", canLogin: false, revoked: false },
          ],
        },
      ],
    },
    {
      name: "the trigger stamps a true-to-false write and no other update",
      seed: MEMBERS(`
        ('dmv-revoke-d-switched-off', 'dmv-revoke-d@example.invalid', 'x', 'Switched', 'Off', true, now()),
        ('dmv-revoke-e-name-only', 'dmv-revoke-e@example.invalid', 'x', 'Name', 'Only', true, now()),
        ('dmv-revoke-f-re-enabled', 'dmv-revoke-f@example.invalid', 'x', 'Re', 'Enabled', false, now()),
        ('dmv-revoke-g-stays-on', 'dmv-revoke-g@example.invalid', 'x', 'Stays', 'On', true, now()),
        ('dmv-revoke-h-stays-off', 'dmv-revoke-h@example.invalid', 'x', 'Stays', 'Off', false, now())
      `),
      afterMigration: `
        -- A non-UTC session, so a stamp written in session-local time lands
        -- hours away from the UTC window checked below, even on a UTC server.
        SET TIME ZONE 'Pacific/Auckland';

        -- Give the two already-off members a revocation time the trigger could
        -- never write, so a re-stamp would be visible below.
        UPDATE "Member"
        SET "sessionsRevokedAt" = TIMESTAMP '${EARLIER}'
        WHERE "id" IN ('dmv-revoke-f-re-enabled', 'dmv-revoke-h-stays-off');

        UPDATE "Member" SET "canLogin" = false WHERE "id" = 'dmv-revoke-d-switched-off';
        UPDATE "Member" SET "firstName" = 'Renamed' WHERE "id" = 'dmv-revoke-e-name-only';
        UPDATE "Member" SET "canLogin" = true WHERE "id" = 'dmv-revoke-f-re-enabled';
        UPDATE "Member" SET "canLogin" = true WHERE "id" = 'dmv-revoke-g-stays-on';
        UPDATE "Member" SET "canLogin" = false WHERE "id" = 'dmv-revoke-h-stays-off';

        RESET TIME ZONE;
      `,
      expectations: [
        {
          claim:
            "only the true-to-false write is stamped; a rename and a true-to-true write are not",
          sql: `
            SELECT "id", ("sessionsRevokedAt" IS NOT NULL) AS "revoked"
            FROM "Member"
            WHERE "id" IN (
              'dmv-revoke-d-switched-off',
              'dmv-revoke-e-name-only',
              'dmv-revoke-g-stays-on'
            )
            ORDER BY "id" COLLATE "C"
          `,
          rows: [
            { id: "dmv-revoke-d-switched-off", revoked: true },
            { id: "dmv-revoke-e-name-only", revoked: false },
            { id: "dmv-revoke-g-stays-on", revoked: false },
          ],
        },
        {
          claim:
            "a re-enable and a false-to-false write keep the earlier revocation time",
          sql: `
            SELECT
              "id",
              to_char("sessionsRevokedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "revokedAt"
            FROM "Member"
            WHERE "id" IN ('dmv-revoke-f-re-enabled', 'dmv-revoke-h-stays-off')
            ORDER BY "id" COLLATE "C"
          `,
          rows: [
            { id: "dmv-revoke-f-re-enabled", revokedAt: EARLIER },
            { id: "dmv-revoke-h-stays-off", revokedAt: EARLIER },
          ],
        },
        {
          claim:
            "the switch-off is stamped with the write's own UTC time, not a fixed or session-local value",
          sql: `
            SELECT COUNT(*)::integer AS "stampedNearNow"
            FROM "Member"
            WHERE "id" = 'dmv-revoke-d-switched-off'
              AND "sessionsRevokedAt" BETWEEN
                timezone('UTC', clock_timestamp()) - interval '1 hour'
                AND timezone('UTC', clock_timestamp()) + interval '1 minute'
          `,
          rows: [{ stampedNearNow: 1 }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "stamp on every write that sets canLogin false, including false-to-false",
      harm:
        "Re-saving an already login-disabled member moves its revocation time, so the column stops recording when the login was actually switched off.",
      find: `WHEN (OLD."canLogin" IS TRUE AND NEW."canLogin" IS FALSE)`,
      replace: `WHEN (NEW."canLogin" IS FALSE)`,
    },
    {
      name: "stamp the re-enable instead of the switch-off",
      harm:
        "Switching login off records nothing, so a session copied before the switch-off revives after a re-enable.",
      find: `WHEN (OLD."canLogin" IS TRUE AND NEW."canLogin" IS FALSE)`,
      replace: `WHEN (OLD."canLogin" IS FALSE AND NEW."canLogin" IS TRUE)`,
    },
    {
      name: "fire the trigger on the wrong column",
      harm:
        "No path that switches login off stamps the column, so every later switch-off is revivable.",
      find: `BEFORE UPDATE OF "canLogin" ON "Member"`,
      replace: `BEFORE UPDATE OF "firstName" ON "Member"`,
    },
    {
      name: "stamp a fixed time instead of the write's own",
      harm:
        "The recorded switch-off time is fiction; an old enough constant refuses no session at all, so every switch-off becomes revivable.",
      find: `NEW."sessionsRevokedAt" := timezone('UTC', statement_timestamp());`,
      replace: `NEW."sessionsRevokedAt" := TIMESTAMP '1970-01-01 00:00:00';`,
    },
    {
      name: "stamp session-local time instead of UTC",
      harm:
        "On a database whose session zone is ahead of UTC the stamp lands in the future and refuses sessions started after the member signs in again; behind UTC it lands in the past and lets an earlier session through.",
      find: `NEW."sessionsRevokedAt" := timezone('UTC', statement_timestamp());`,
      replace: `NEW."sessionsRevokedAt" := statement_timestamp();`,
    },
    {
      name: "install no trigger",
      harm:
        "Only members whose login was off at deploy are covered; every later switch-off is revivable.",
      find: `CREATE TRIGGER "Member_stamp_sessions_revoked_at"
BEFORE UPDATE OF "canLogin" ON "Member"
FOR EACH ROW
WHEN (OLD."canLogin" IS TRUE AND NEW."canLogin" IS FALSE)
EXECUTE FUNCTION member_stamp_sessions_revoked_at();`,
      replace: ``,
    },
  ],
};

export default verification;

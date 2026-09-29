import type { DataMigrationVerification } from "./types";

/**
 * #3603 (owner decision D1 on PR #3608): the backfill that stamps
 * `Member.sessionsRevokedAt` for every member whose login is already off, so a
 * session from before the release cannot be revived by a later re-enable.
 *
 * It runs after 20261009010000_add_member_sessions_revoked_at has committed, so
 * the trigger is already live: a member switched off between the two
 * migrations already carries the trigger's time, which is the more accurate
 * one, and must be left alone.
 */

const MEMBERS = (rows: string) => `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "canLogin",
    "sessionsRevokedAt", "updatedAt"
  ) VALUES ${rows};
`;

/** A revocation time the backfill could never write, so an overwrite is visible. */
const EARLIER = "2020-01-01 00:00:00.000";

const verification: DataMigrationVerification = {
  migration: "20261009020000_backfill_member_sessions_revoked_at",
  intent:
    "Stamp Member.sessionsRevokedAt in explicit UTC for every member whose login is already off and who has no revocation time yet; leave login-enabled members and existing times untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club whose members are a mix of login on, login off, and already stamped",
      seed: MEMBERS(`
        ('dmv-backfill-a-login', 'dmv-backfill-a@example.invalid', 'x', 'Login', 'On', true, NULL, now()),
        ('dmv-backfill-b-nologin', 'dmv-backfill-b@example.invalid', 'x', 'Login', 'Off', false, NULL, now()),
        ('dmv-backfill-c-never', 'dmv-backfill-c@example.invalid', 'x', 'Never', 'Had', false, NULL, now()),
        ('dmv-backfill-d-stamped', 'dmv-backfill-d@example.invalid', 'x', 'Already', 'Stamped', false, TIMESTAMP '${EARLIER}', now())
      `),
      expectations: [
        {
          claim:
            "login-disabled members are stamped and a login-enabled member is not",
          sql: `
            SELECT "id", ("sessionsRevokedAt" IS NOT NULL) AS "revoked"
            FROM "Member"
            WHERE "id" LIKE 'dmv-backfill-%'
            ORDER BY "id" COLLATE "C"
          `,
          rows: [
            { id: "dmv-backfill-a-login", revoked: false },
            { id: "dmv-backfill-b-nologin", revoked: true },
            { id: "dmv-backfill-c-never", revoked: true },
            { id: "dmv-backfill-d-stamped", revoked: true },
          ],
        },
        {
          claim:
            "a time the trigger already wrote is kept, not replaced by the backfill's",
          sql: `
            SELECT to_char("sessionsRevokedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "revokedAt"
            FROM "Member"
            WHERE "id" = 'dmv-backfill-d-stamped'
          `,
          rows: [{ revokedAt: EARLIER }],
        },
        {
          claim:
            "the backfilled time is the migration's own UTC time, not a session-local or fixed value",
          sql: `
            SELECT COUNT(*)::integer AS "stampedNearNow"
            FROM "Member"
            WHERE "id" IN ('dmv-backfill-b-nologin', 'dmv-backfill-c-never')
              AND "sessionsRevokedAt" BETWEEN
                timezone('UTC', clock_timestamp()) - interval '1 hour'
                AND timezone('UTC', clock_timestamp()) + interval '1 minute'
          `,
          rows: [{ stampedNearNow: 2 }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "backfill every member rather than the login-disabled ones",
      harm:
        "Every member's sessions are revoked at deploy, signing the whole club out, and the column no longer says whose login was switched off.",
      find: `WHERE "canLogin" = false
  AND "sessionsRevokedAt" IS NULL;`,
      replace: `WHERE "sessionsRevokedAt" IS NULL;`,
    },
    {
      name: "overwrite a revocation time the trigger already wrote",
      harm:
        "A member switched off between the two migrations gets a later time, so a session they started in between is no longer refused after a re-enable.",
      find: `WHERE "canLogin" = false
  AND "sessionsRevokedAt" IS NULL;`,
      replace: `WHERE "canLogin" = false;`,
    },
    {
      name: "stamp a fixed time instead of the migration's own",
      harm:
        "The recorded switch-off time is fiction; an old enough constant would refuse nothing at all.",
      find: `SET "sessionsRevokedAt" = timezone('UTC', statement_timestamp())`,
      replace: `SET "sessionsRevokedAt" = TIMESTAMP '1970-01-01 00:00:00'`,
    },
  ],
};

export default verification;

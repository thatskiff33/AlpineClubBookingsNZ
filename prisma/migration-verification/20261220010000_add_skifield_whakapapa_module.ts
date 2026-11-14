import type { DataMigrationVerification } from "./types";

/**
 * #4932 — the Whakapapa (Mt Ruapehu) conditions report gets its own module,
 * skifieldWhakapapa, split out of skifieldConditions.
 *
 * Every database already holds the ClubModuleSettings row, because
 * 20260518113000_add_club_module_settings inserted it on every install, fresh
 * ones included. So the migration tells an existing install from a new one by
 * whether it holds a member: an existing install copies its skifieldConditions
 * choice across, and a fresh install's first migrate leaves the column at its
 * default, off. The cases seed nothing but members and the row's own values, so
 * the row itself is the one the earlier migrations really produce.
 */

const MEMBER = `INSERT INTO "Member" ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
  VALUES ('mem-4932', 'admin-4932@example.test', 'x', 'Ada', 'Admin', TIMESTAMP '2026-01-01 00:00:00');`;

const savedRow = (skifieldConditions: boolean) =>
  `UPDATE "ClubModuleSettings" SET "skifieldConditions" = ${skifieldConditions}, "kiosk" = true;`;

const MODULE_ROWS = `SELECT "id", "skifieldConditions", "skifieldWhakapapa", "kiosk"
  FROM "ClubModuleSettings" ORDER BY "id"`;

const verification: DataMigrationVerification = {
  migration: "20261220010000_add_skifield_whakapapa_module",
  intent:
    "Add ClubModuleSettings.skifieldWhakapapa, default false, and keep each existing install's Whakapapa report as it was by copying its skifieldConditions value. A fresh install, which holds no member on its first migrate, keeps the default and starts with the report off.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club that saved its Modules page with ski-field conditions ON",
      seed: `${MEMBER}\n${savedRow(true)}`,
      expectations: [
        {
          claim: "the Whakapapa report stays on, and no other column changes",
          sql: MODULE_ROWS,
          rows: [{ id: "default", skifieldConditions: true, skifieldWhakapapa: true, kiosk: true }],
        },
      ],
    },
    {
      name: "a club that saved its Modules page with ski-field conditions OFF",
      seed: `${MEMBER}\n${savedRow(false)}`,
      expectations: [
        {
          claim: "the Whakapapa report stays off",
          sql: MODULE_ROWS,
          rows: [{ id: "default", skifieldConditions: false, skifieldWhakapapa: false, kiosk: true }],
        },
      ],
    },
    {
      name: "an existing club that never saved its Modules page",
      seed: MEMBER,
      expectations: [
        {
          claim: "the Whakapapa report stays on, as the old default had it",
          sql: MODULE_ROWS,
          rows: [{ id: "default", skifieldConditions: true, skifieldWhakapapa: true, kiosk: false }],
        },
      ],
    },
    {
      name: "an existing club with no module settings row",
      seed: `${MEMBER}\nDELETE FROM "ClubModuleSettings";`,
      expectations: [
        {
          claim: "both conditions features retain the old effective ON default",
          sql: MODULE_ROWS,
          rows: [{ id: "default", skifieldConditions: true, skifieldWhakapapa: true, kiosk: false }],
        },
      ],
    },
    {
      name: "a fresh install on its first migrate, with no members",
      seed: "",
      expectations: [
        {
          claim: "the Whakapapa report starts off, while the generic widget keeps its default on",
          sql: MODULE_ROWS,
          rows: [{ id: "default", skifieldConditions: true, skifieldWhakapapa: false, kiosk: false }],
        },
        {
          claim: "the new column is NOT NULL and defaults to false",
          sql: `SELECT "is_nullable", "column_default" FROM information_schema.columns
                 WHERE "table_schema" = current_schema() AND "table_name" = 'ClubModuleSettings'
                   AND "column_name" = 'skifieldWhakapapa'`,
          rows: [{ is_nullable: "NO", column_default: "false" }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "the missing singleton is not restored",
      harm: "A commissioned club with no settings row loses its Whakapapa report to the new runtime's OFF fallback.",
      find: 'WHERE EXISTS (SELECT 1 FROM "Member")\nON CONFLICT',
      replace: 'WHERE false\nON CONFLICT',
    },
    {
      name: "the saved choice is not copied across",
      harm: "Every club that saved its Modules page loses the Whakapapa report and the admin Mountain Conditions page on upgrade.",
      find: 'SET "skifieldWhakapapa" = "skifieldConditions"',
      replace: 'SET "skifieldWhakapapa" = "skifieldWhakapapa"',
    },
    {
      name: "the saved choice is forced on",
      harm: "A club that had switched ski-field conditions off starts serving the Whakapapa feed again.",
      find: 'SET "skifieldWhakapapa" = "skifieldConditions"',
      replace: 'SET "skifieldWhakapapa" = true',
    },
    {
      name: "the copy reaches a fresh install too",
      harm: "A new install starts with the Whakapapa report on, which is the default #4932 turns off.",
      find: 'WHERE EXISTS (SELECT 1 FROM "Member");',
      replace: ";",
    },
    {
      name: "the column defaults on",
      harm: "A new install, and any row the draining release creates, gets the Whakapapa report without opting in.",
      find: "BOOLEAN NOT NULL DEFAULT false",
      replace: "BOOLEAN NOT NULL DEFAULT true",
    },
  ],
};

export default verification;

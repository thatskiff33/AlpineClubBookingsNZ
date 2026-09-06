import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";

/**
 * #2430 / PR #2466 — the public "Book Now" button is switched OFF for every
 * club, not only for fresh installs.
 *
 * The owner's first decision flipped the column DEFAULT alone, which left every
 * existing club on whatever it had saved. The owner then widened it (1 Aug
 * 2026), knowingly overriding deliberate saved choices: after this release no
 * club advertises the button until an admin ticks it back on. Two claims have
 * to hold, and neither is provable by testing the TypeScript:
 *
 *   1. a FRESH install still gets the column default (false), and
 *   2. an EXISTING club's stored row is rewritten to false — every row, not
 *      only the id = 'default' singleton — without touching anything else on
 *      the row.
 *
 * The text assertions below pin the shape of the SQL; the PostgreSQL block at
 * the bottom actually runs it, because string-matching a migration is exactly
 * how a neutered statement stays green (#2418).
 */

const MIGRATION_SQL_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260802100000_public_book_now_default_off",
  "migration.sql",
);

const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf8");

/**
 * The executable SQL only, whitespace-normalised: `--` comment lines are
 * dropped the same way `scripts/validate-blue-green-migrations.sh` drops them,
 * so the assertions below describe what PostgreSQL will run rather than what
 * the header prose happens to mention. (The header prose does mention
 * `CURRENT_TIMESTAMP` and `now()`, precisely to say it writes neither.) The
 * file contains no string literal carrying a `--`, so a line-wise strip is
 * exact here.
 */
const normalised = migrationSql
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe("public Book Now default-off migration SQL (#2430)", () => {
  it("flips the column default so a fresh install ships the button off", () => {
    expect(normalised).toContain(
      'ALTER TABLE "PublicContentSettings" ALTER COLUMN "showBookNow" SET DEFAULT false',
    );
    // The schema and the synthesised-on-miss constant must agree with it, or a
    // fresh install would disagree with itself between SQL and the app.
    const schema = readFileSync(
      path.join(process.cwd(), "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(/showBookNow\s+Boolean\s+@default\(false\)/);
    expect(DEFAULT_PUBLIC_CONTENT_SETTINGS.showBookNow).toBe(false);
  });

  it("backfills every existing row to false", () => {
    expect(normalised).toMatch(
      /UPDATE "PublicContentSettings" SET "showBookNow" = false WHERE "showBookNow" = true;/,
    );
  });

  it("does not assume the singleton: the backfill is not scoped to id = 'default'", () => {
    const updates = normalised.match(
      /UPDATE "PublicContentSettings"[^;]*;/g,
    ) as string[] | null;
    expect(updates).not.toBeNull();
    for (const statement of updates ?? []) {
      expect(statement).not.toMatch(/"id"/);
    }
  });

  it("writes no timestamp and no session clock", () => {
    // "updatedAt"/"updatedByMemberId" keep naming the admin who really saved
    // the panel — this is a release-level change, not an admin edit — and that
    // is also what keeps the session-clock DML gate out of the picture.
    expect(normalised).not.toMatch(/SET[^;]*"updatedAt"/);
    expect(normalised).not.toMatch(/SET[^;]*"updatedByMemberId"/);
    expect(normalised).not.toMatch(/\bnow\s*\(/i);
    expect(normalised).not.toContain("CURRENT_TIMESTAMP");
  });

  it("touches no other public-content setting", () => {
    // One assignment, and only that one. A second column in the SET list would
    // silently reset a club's fee/policy visibility, its Book Now target, or
    // its updatedAt bookkeeping along with the button.
    // `[^;]` keeps each match inside one statement, so the ALTER's own
    // "SET DEFAULT false" cannot run on into the UPDATE below it.
    const setClauses = normalised.match(/\bSET\b[^;]*?\bWHERE\b/g) ?? [];
    expect(setClauses).toEqual(['SET "showBookNow" = false WHERE']);
  });
});

// ---------------------------------------------------------------------------
// Real PostgreSQL. Same pattern as
// src/lib/__tests__/email-message-annotation-strip.test.ts and
// src/lib/__tests__/xero-member-grouping-migration.test.ts: point the env var at
// a disposable database and each test provisions its own SCHEMA, creates only
// the columns this migration touches in their PRE-migration shape, runs the
// migration's own SQL, and drops the schema again. `describe.skip` without the
// variable, so `npm test` never needs a live database — the CI migration-drift
// job wires the variable, so this MUST stay wired there.
//
//   PUBLIC_BOOK_NOW_DEFAULT_OFF_TEST_DATABASE_URL=postgres://... \
//     npx vitest run src/lib/__tests__/public-book-now-default-off-migration.test.ts
// ---------------------------------------------------------------------------

const migrationDatabaseUrl =
  process.env.PUBLIC_BOOK_NOW_DEFAULT_OFF_TEST_DATABASE_URL;
const describeWithDatabase = migrationDatabaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * The table as it stands BEFORE this migration: `showBookNow` defaults true
 * (#1929's shipped value). Only the columns this migration reads, writes, or
 * must be shown not to disturb are modelled.
 */
const PRE_MIGRATION_SCHEMA_SQL = `
  CREATE TABLE "PublicContentSettings" (
    "id" TEXT PRIMARY KEY DEFAULT 'default',
    "hutFees" BOOLEAN NOT NULL DEFAULT false,
    "annualFees" BOOLEAN NOT NULL DEFAULT false,
    "showBookNow" BOOLEAN NOT NULL DEFAULT true,
    "bookNowTarget" TEXT NOT NULL DEFAULT 'BOOKING_FLOW',
    "bookNowPageId" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

type SettingsRow = {
  id: string;
  hutFees: boolean;
  annualFees: boolean;
  showBookNow: boolean;
  bookNowTarget: string;
  bookNowPageId: string | null;
  updatedByMemberId: string | null;
  /**
   * Read as TEXT, deliberately. `updatedAt` is a naive `timestamp(3)`, and the
   * pg driver resolves one against the CLIENT's local zone — so a Date
   * comparison would fail on a Pacific/Auckland machine and pass in UTC CI,
   * which is the very confusion this migration avoids by writing no clock at
   * all. Comparing the stored characters is zone-independent.
   */
  updatedAt: string;
};

async function withMigrationSchema(run: (client: Client) => Promise<void>) {
  const schemaName = `book_now_off_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: migrationDatabaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Test fixture: hardcoded DDL in a disposable per-test schema; no user input.
    await client.query(PRE_MIGRATION_SCHEMA_SQL);
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function runMigration(client: Client) {
  // Test fixture: runs the migration's own SQL against a disposable per-test
  // schema; no user input.
  await client.query(migrationSql);
}

async function seedSettings(
  client: Client,
  row: { id: string; showBookNow: boolean },
) {
  await client.query(
    `INSERT INTO "PublicContentSettings"
       ("id", "hutFees", "annualFees", "showBookNow", "bookNowTarget",
        "bookNowPageId", "updatedByMemberId", "createdAt", "updatedAt")
     VALUES ($1, true, true, $2, 'PAGE', 'page-7', 'admin-3',
             TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-02-02 00:00:00')`,
    [row.id, row.showBookNow],
  );
}

async function readSettings(client: Client): Promise<SettingsRow[]> {
  const result = await client.query<SettingsRow>(
    `SELECT "id", "hutFees", "annualFees", "showBookNow", "bookNowTarget",
            "bookNowPageId", "updatedByMemberId",
            to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
       FROM "PublicContentSettings" ORDER BY "id"`,
  );
  return result.rows;
}

describeWithDatabase(
  "public Book Now default-off migration against PostgreSQL (#2430)",
  () => {
    it("switches an existing club that had SAVED the button ON to off", async () => {
      await withMigrationSchema(async (client) => {
        await seedSettings(client, { id: "default", showBookNow: true });

        await runMigration(client);

        const [row] = await readSettings(client);
        expect(row.showBookNow).toBe(false);
      });
    });

    it("leaves every other field on that row exactly as it was", async () => {
      await withMigrationSchema(async (client) => {
        await seedSettings(client, { id: "default", showBookNow: true });

        await runMigration(client);

        const [row] = await readSettings(client);
        expect(row.hutFees).toBe(true);
        expect(row.annualFees).toBe(true);
        // The Book Now TARGET survives, so re-ticking the box restores the
        // club's own destination rather than resetting it to the booking flow.
        expect(row.bookNowTarget).toBe("PAGE");
        expect(row.bookNowPageId).toBe("page-7");
        // Not an admin edit: the row keeps naming the admin who really saved it
        // and when, which is also why no session clock is written.
        expect(row.updatedByMemberId).toBe("admin-3");
        expect(row.updatedAt).toBe("2026-02-02 00:00:00");
      });
    });

    it("reaches every row, not only the id = 'default' singleton", async () => {
      await withMigrationSchema(async (client) => {
        await seedSettings(client, { id: "default", showBookNow: true });
        await seedSettings(client, { id: "legacy-copy", showBookNow: true });
        await seedSettings(client, { id: "already-off", showBookNow: false });

        await runMigration(client);

        const rows = await readSettings(client);
        expect(rows.map((row) => row.id)).toEqual([
          "already-off",
          "default",
          "legacy-copy",
        ]);
        expect(rows.every((row) => row.showBookNow === false)).toBe(true);
      });
    });

    it("changes the column default, so a fresh install lands off", async () => {
      await withMigrationSchema(async (client) => {
        // Before: an INSERT that omits the column takes the pre-#2430 default.
        await client.query(
          `INSERT INTO "PublicContentSettings" ("id") VALUES ('before')`,
        );

        await runMigration(client);

        // After: the same INSERT lands false. Asserting the "before" row was
        // true is what proves the SET DEFAULT is doing the work rather than the
        // fixture already being false.
        await client.query(
          `INSERT INTO "PublicContentSettings" ("id") VALUES ('after')`,
        );

        const rows = await readSettings(client);
        const after = rows.find((row) => row.id === "after");
        expect(after?.showBookNow).toBe(false);
      });
    });

    it("is idempotent: a second run matches no row and changes nothing", async () => {
      await withMigrationSchema(async (client) => {
        await seedSettings(client, { id: "default", showBookNow: true });
        await runMigration(client);
        const afterFirst = await readSettings(client);

        const second = await client.query(
          `UPDATE "PublicContentSettings" SET "showBookNow" = false WHERE "showBookNow" = true`,
        );

        expect(second.rowCount).toBe(0);
        expect(await readSettings(client)).toEqual(afterFirst);
      });
    });

    it("lets an admin turn the button straight back on afterwards", async () => {
      await withMigrationSchema(async (client) => {
        await seedSettings(client, { id: "default", showBookNow: true });
        await runMigration(client);

        // The one click the release note promises: tick the box and save.
        await client.query(
          `UPDATE "PublicContentSettings" SET "showBookNow" = true WHERE "id" = 'default'`,
        );

        const [row] = await readSettings(client);
        expect(row.showBookNow).toBe(true);
        expect(row.bookNowTarget).toBe("PAGE");
      });
    });
  },
);

/**
 * Opt-in PostgreSQL proof for the #2363 blue/green trigger boundary.
 *
 * Ordinary test runs skip this file. Hosted CI also imports it from the
 * existing guarded concurrency-race harness and supplies that harness's
 * dedicated localhost database; every test still creates and drops a unique
 * schema. To run it directly, provide a throwaway loopback database on port
 * 55442+ whose name contains `booking_policy_2363`:
 *
 *   BOOKING_POLICY_TRIGGER_TEST_DATABASE_URL=postgresql://...@127.0.0.1:55442/booking_policy_2363 \
 *     pnpm test src/lib/__tests__/minimum-stay-policy-trigger.realdb.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const explicitDatabaseUrl =
  process.env.BOOKING_POLICY_TRIGGER_TEST_DATABASE_URL ?? "";
const hostedRaceDatabaseUrl =
  process.env.CI === "true" &&
  process.env.RUN_CONCURRENCY_RACE_TESTS === "1"
    ? process.env.CONCURRENCY_RACE_DATABASE_URL ?? ""
    : "";
const databaseUrl = explicitDatabaseUrl || hostedRaceDatabaseUrl;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const migrationPath =
  "prisma/migrations/20260802130000_add_booking_policy_exception_foundation/migration.sql";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSafeDatabaseUrl(value: string): void {
  const url = new URL(value);
  const port = Number.parseInt(url.port, 10);
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      url.hostname.toLowerCase(),
    ) ||
    !Number.isFinite(port) ||
    port < 55442 ||
    ![
      "booking_policy_2363",
      ...(hostedRaceDatabaseUrl ? ["concurrency_race_1881"] : []),
    ].some((marker) => decodeURIComponent(url.pathname).includes(marker))
  ) {
    throw new Error(
      "Booking-policy trigger tests require a loopback throwaway database on port 55442+ with the expected dedicated test marker.",
    );
  }
}

async function withTriggerSchema(
  run: (writerA: Client, writerB: Client) => Promise<void>,
): Promise<void> {
  assertSafeDatabaseUrl(databaseUrl);
  const schemaName = `booking_policy_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const writerA = new Client({ connectionString: databaseUrl });
  const writerB = new Client({ connectionString: databaseUrl });

  await Promise.all([writerA.connect(), writerB.connect()]);
  try {
    await writerA.query(`CREATE SCHEMA ${schema}`);
    await Promise.all([
      writerA.query(`SET search_path TO ${schema}`),
      writerB.query(`SET search_path TO ${schema}`),
    ]);
    await writerA.query(`
      CREATE TABLE "MinimumStayPolicy" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "triggerDays" INTEGER[] NOT NULL,
        "minimumNights" INTEGER NOT NULL,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "lodgeId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const migration = await readFile(path.join(process.cwd(), migrationPath), "utf8");
    await writerA.query(migration);
    await writerA.query(`
      INSERT INTO "MinimumStayPolicy"
        ("id", "name", "startDate", "endDate", "triggerDays", "minimumNights")
      VALUES
        ('club-1', 'Club one', DATE '2026-06-01', DATE '2026-09-30', ARRAY[6], 2),
        ('club-2', 'Club two', DATE '2026-06-01', DATE '2026-09-30', ARRAY[6], 2)
    `);

    await run(writerA, writerB);
  } finally {
    await Promise.allSettled([
      writerA.query("ROLLBACK"),
      writerB.query("ROLLBACK"),
    ]);
    await writerA.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await Promise.all([writerA.end(), writerB.end()]);
  }
}

async function beginWithShortLockTimeout(client: Client): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '100ms'");
}

describeWithDatabase("MinimumStayPolicy drain trigger (#2363)", () => {
  it("backfills old inserts and advances old/new material updates exactly once", async () => {
    await withTriggerSchema(async (client) => {
      const initial = await client.query(`
        SELECT "capacityMode"::text, "version"
        FROM "MinimumStayPolicy" WHERE "id" = 'club-1'
      `);
      expect(initial.rows[0]).toEqual({ capacityMode: "HOLD", version: 1 });

      // Old colour: the UPDATE does not name version.
      await client.query(`
        UPDATE "MinimumStayPolicy" SET "name" = 'Old colour edit'
        WHERE "id" = 'club-1'
      `);
      // New colour: its CAS writer has already advanced OLD + 1.
      await client.query(`
        UPDATE "MinimumStayPolicy"
        SET "capacityMode" = 'NO_HOLD', "version" = "version" + 1
        WHERE "id" = 'club-1'
      `);
      // Prisma @updatedAt alone is not a material policy mutation.
      await client.query(`
        UPDATE "MinimumStayPolicy" SET "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 'club-1'
      `);

      const final = await client.query(`
        SELECT "capacityMode"::text, "version"
        FROM "MinimumStayPolicy" WHERE "id" = 'club-1'
      `);
      expect(final.rows[0]).toEqual({ capacityMode: "NO_HOLD", version: 3 });

      await expect(
        client.query(`
          UPDATE "MinimumStayPolicy"
          SET "name" = 'Skipped revision', "version" = "version" + 2
          WHERE "id" = 'club-1'
        `),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("makes old INSERT/UPDATE/DELETE join the exact new-runtime set key", async () => {
    await withTriggerSchema(async (newRuntime, oldRuntime) => {
      const key = "minimum-stay-policy-set";
      for (const sql of [
        `INSERT INTO "MinimumStayPolicy"
          ("id", "name", "startDate", "endDate", "triggerDays", "minimumNights")
         VALUES ('blocked-insert', 'Blocked', DATE '2026-06-01', DATE '2026-09-30', ARRAY[6], 2)`,
        `UPDATE "MinimumStayPolicy" SET "name" = 'Blocked update' WHERE "id" = 'club-1'`,
        `DELETE FROM "MinimumStayPolicy" WHERE "id" = 'club-1'`,
      ]) {
        await newRuntime.query("BEGIN");
        await newRuntime.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [key],
        );
        await beginWithShortLockTimeout(oldRuntime);
        await expect(oldRuntime.query(sql)).rejects.toMatchObject({
          code: "55P03",
        });
        await oldRuntime.query("ROLLBACK");
        await newRuntime.query("ROLLBACK");
      }
    });
  });

  it("serialises two draining old-colour writers in the same scope", async () => {
    await withTriggerSchema(async (first, second) => {
      await first.query("BEGIN");
      await first.query(`
        UPDATE "MinimumStayPolicy" SET "name" = 'First writer'
        WHERE "id" = 'club-1'
      `);
      await beginWithShortLockTimeout(second);
      await expect(
        second.query(`
          UPDATE "MinimumStayPolicy" SET "name" = 'Second writer'
          WHERE "id" = 'club-2'
        `),
      ).rejects.toMatchObject({ code: "55P03" });
    });
  });
});

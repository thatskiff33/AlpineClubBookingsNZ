/**
 * #4262: the other-lodge name-index pair against real PostgreSQL — the
 * evidence behind its `windowed` ledger rows and its reverse scripts.
 *
 * `other-lodge-name-index-window.test.ts` proves the deploy gate refuses the
 * pair without the window. This proves what the ledger rows SAY:
 *
 *   1. the previous release's download upsert (`INSERT ... ON CONFLICT
 *      ("name")`, the statement a native Prisma upsert keyed on `name` sends)
 *      works before `20261126040000` and is refused once it commits — so the
 *      pair is not old-code compatible and must be windowed;
 *   2. each `rollback.sql` refuses, changing nothing, while lodges share a name
 *      its restored index cannot hold — the duplicate-name recovery limit;
 *   3. run in the wrong order, `20261126040000`'s reverse stops and changes
 *      nothing; run newest first after renaming, the pair reverses and the old
 *      upsert works again.
 *
 * The committed SQL files run byte-for-byte, in a scratch schema this suite
 * creates and drops, over a minimal "OtherLodge" with the pre-PR name index.
 * Off by default; it reads only the guarded disposable race database
 * (`assertSafeRaceDbUrl`), and hosted CI reaches it through the race harness.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const SCHEMA = "other_lodge_window_4262";

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");
const sqlOf = (name: string, file: "migration.sql" | "rollback.sql") =>
  readFileSync(path.join(MIGRATIONS, name, file), "utf8");
const HIDDEN_AT = "20261126040000_other_lodge_hidden_at";
const NAMES_NOT_UNIQUE = "20261126050000_other_lodge_names_not_unique";

/** The previous release's download create, as its native upsert sends it. */
const OLD_UPSERT = `INSERT INTO "OtherLodge" ("id", "name", "location") VALUES ($1, $2, $3)
  ON CONFLICT ("name") DO UPDATE SET "location" = EXCLUDED."location" RETURNING "id"`;

(RUN ? describe : describe.skip)("other-lodge name-index window — real PostgreSQL (#4262)", { timeout: 60_000 }, () => {
  let client: Client;

  async function indexes(): Promise<string[]> {
    const rows = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'OtherLodge' ORDER BY indexname`,
      [SCHEMA],
    );
    return rows.rows.map((r) => r.indexname);
  }

  async function lodge(id: string, name: string, hidden = false) {
    await client.query(
      hidden
        ? `INSERT INTO "OtherLodge" ("id", "name", "location", "hiddenAt") VALUES ($1, $2, 'Whakapapa', TIMESTAMP '2026-07-01 00:00:00')`
        : `INSERT INTO "OtherLodge" ("id", "name", "location") VALUES ($1, $2, 'Whakapapa')`,
      [id, name],
    );
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Other-lodge name-index window");
    client = new Client({ connectionString: RACE_DB_URL });
    await client.connect();
  });

  beforeEach(async () => {
    // A case whose expected rejection did not come leaves its reverse script's
    // transaction open (aborted); end it so it cannot poison this one.
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    // The pre-PR shape this pair changes: the full unique index on name.
    await client.query(`CREATE TABLE "OtherLodge" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "location" TEXT, "centralId" VARCHAR(64))`);
    await client.query(`CREATE UNIQUE INDEX "OtherLodge_name_key" ON "OtherLodge"("name")`);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await client.end();
    }
  });

  it("refuses the previous release's name-keyed upsert once the pair is applied", async () => {
    await expect(client.query(OLD_UPSERT, ["ol_1", "Aorangi", "Ohakune"])).resolves.toBeDefined();
    await client.query(sqlOf(HIDDEN_AT, "migration.sql"));
    await expect(client.query(OLD_UPSERT, ["ol_2", "Aorangi", "Ohakune"])).rejects.toThrow(
      /no unique or exclusion constraint matching the ON CONFLICT specification/,
    );
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "migration.sql"));
    await expect(client.query(OLD_UPSERT, ["ol_2", "Aorangi", "Ohakune"])).rejects.toThrow(
      /no unique or exclusion constraint matching the ON CONFLICT specification/,
    );
    expect(await indexes()).toEqual(["OtherLodge_name_idx", "OtherLodge_pkey"]);
  });

  it("refuses each reverse script while lodges share a name, changing nothing", async () => {
    await client.query(sqlOf(HIDDEN_AT, "migration.sql"));
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "migration.sql"));
    await lodge("ol_a", "Twin");
    await lodge("ol_b", "Twin");

    await expect(client.query(sqlOf(NAMES_NOT_UNIQUE, "rollback.sql"))).rejects.toThrow(
      /other_lodge_names_rollback_blocked/,
    );
    await client.query("ROLLBACK");
    expect(await indexes()).toEqual(["OtherLodge_name_idx", "OtherLodge_pkey"]);

    // Hiding one satisfies the partial index, but not the previous release's
    // full one: the second script refuses a hidden duplicate.
    await client.query(`UPDATE "OtherLodge" SET "hiddenAt" = TIMESTAMP '2026-07-01 00:00:00' WHERE "id" = 'ol_b'`);
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "rollback.sql"));
    expect(await indexes()).toEqual(["OtherLodge_name_visible_key", "OtherLodge_pkey"]);
    await expect(client.query(sqlOf(HIDDEN_AT, "rollback.sql"))).rejects.toThrow(
      /other_lodge_hidden_rollback_blocked/,
    );
    await client.query("ROLLBACK");
    expect(await indexes()).toEqual(["OtherLodge_name_visible_key", "OtherLodge_pkey"]);
    const column = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'OtherLodge' AND column_name = 'hiddenAt'`,
      [SCHEMA],
    );
    expect(column.rowCount).toBe(1);
  });

  it("stops the older reverse script when it runs first, and reverses the pair newest first after renaming", async () => {
    await client.query(sqlOf(HIDDEN_AT, "migration.sql"));
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "migration.sql"));
    await lodge("ol_a", "Twin");
    await lodge("ol_b", "Twin", true);

    await expect(client.query(sqlOf(HIDDEN_AT, "rollback.sql"))).rejects.toThrow(
      /other_lodge_hidden_rollback_blocked|OtherLodge_name_visible_key/,
    );
    await client.query("ROLLBACK");
    expect(await indexes()).toEqual(["OtherLodge_name_idx", "OtherLodge_pkey"]);

    // Step 2 of the scripts: rename all but one of each set, by id.
    await client.query(`UPDATE "OtherLodge" SET "name" = "name" || ' (deleted)' WHERE "id" = 'ol_b'`);
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "rollback.sql"));
    await client.query(sqlOf(HIDDEN_AT, "rollback.sql"));
    expect(await indexes()).toEqual(["OtherLodge_name_key", "OtherLodge_pkey"]);
    const rows = await client.query<{ id: string; name: string }>(
      `SELECT "id", "name" FROM "OtherLodge" ORDER BY "id"`,
    );
    expect(rows.rows).toEqual([
      { id: "ol_a", name: "Twin" },
      { id: "ol_b", name: "Twin (deleted)" },
    ]);
    // The previous release's download works again.
    await expect(client.query(OLD_UPSERT, ["ol_c", "Twin", "Ohakune"])).resolves.toMatchObject({
      rows: [{ id: "ol_a" }],
    });
  });

  it("stops the older reverse script on the missing index even with no duplicate names", async () => {
    await client.query(sqlOf(HIDDEN_AT, "migration.sql"));
    await client.query(sqlOf(NAMES_NOT_UNIQUE, "migration.sql"));
    await lodge("ol_a", "Solo");
    await expect(client.query(sqlOf(HIDDEN_AT, "rollback.sql"))).rejects.toThrow(
      /"OtherLodge_name_visible_key" does not exist/,
    );
    await client.query("ROLLBACK");
    expect(await indexes()).toEqual(["OtherLodge_name_idx", "OtherLodge_pkey"]);
  });
});

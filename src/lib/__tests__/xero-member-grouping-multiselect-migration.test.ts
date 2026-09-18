import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { canonicalizeAgeTiers } from "@/lib/age-tier-schema";

const migrationSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260719170000_xero_grouping_age_tiers_multiselect/migration.sql",
  ),
  "utf8",
);

const partialIndexManifest = readFileSync(
  join(process.cwd(), "prisma/partial-unique-indexes.tsv"),
  "utf8",
);

describe("xero grouping multi-select age-tier migration (#2093)", () => {
  it("adds the ageTiers array column", () => {
    expect(migrationSql).toMatch(
      /ADD COLUMN IF NOT EXISTS "ageTiers" "AgeTier"\[\] NOT NULL DEFAULT ARRAY\[\]::"AgeTier"\[\]/,
    );
  });

  it("drops the transitional column default so the final state matches Prisma (no DB default)", () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE "XeroContactGroupRule" ALTER COLUMN "ageTiers" DROP DEFAULT/,
    );
    // The drop must come AFTER the backfill, which relies on the default to
    // seed existing rows with [].
    expect(migrationSql.indexOf('DROP DEFAULT')).toBeGreaterThan(
      migrationSql.indexOf('WHERE "ageTier" IS NOT NULL'),
    );
  });

  it("backfills scalar ageTier -> [ageTier] (NULL -> the default empty array)", () => {
    expect(migrationSql).toMatch(
      /UPDATE "XeroContactGroupRule"\s*SET "ageTiers" = ARRAY\["ageTier"\]::"AgeTier"\[\]\s*WHERE "ageTier" IS NOT NULL/,
    );
  });

  it("drops the old scalar column and its indexes", () => {
    expect(migrationSql).toContain(`DROP INDEX IF EXISTS "XeroContactGroupRule_shape_unique"`);
    expect(migrationSql).toContain(`DROP INDEX IF EXISTS "XeroContactGroupRule_ageTier_idx"`);
    expect(migrationSql).toContain(`ALTER TABLE "XeroContactGroupRule" DROP COLUMN IF EXISTS "ageTier"`);
  });

  it("shape-dedupes over the array form BEFORE recreating the unique index", () => {
    expect(migrationSql).toMatch(
      /DELETE FROM "XeroContactGroupRule" AS dup[\s\S]*dup\."ageTiers" = keeper\."ageTiers"/,
    );
    expect(migrationSql.indexOf(`DELETE FROM "XeroContactGroupRule"`)).toBeLessThan(
      migrationSql.lastIndexOf(`CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"`),
    );
  });

  it("recreates the rule-shape partial unique index over the array with NULLS NOT DISTINCT", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"\s*ON "XeroContactGroupRule" \("membershipTypeId", "ageTiers", "mode", "groupId"\)\s*NULLS NOT DISTINCT\s*WHERE "groupId" IS NOT NULL/,
    );
  });

  it("re-records the reworked partial index (array form) in the CI manifest", () => {
    expect(partialIndexManifest).toContain(
      `("membershipTypeId", "ageTiers", mode, "groupId") NULLS NOT DISTINCT`,
    );
    expect(partialIndexManifest).not.toContain(
      `("membershipTypeId", "ageTier", mode, "groupId")`,
    );
  });

  it("performs no Xero calls (DB-only migration)", () => {
    expect(migrationSql.toLowerCase()).not.toContain("http");
  });
});

// ---------------------------------------------------------------------------
// Real-PostgreSQL behavior (env-gated). Requires PostgreSQL 15+ (NULLS NOT
// DISTINCT). Point the env var at a disposable database:
//   XERO_MEMBER_GROUPING_MIGRATION_TEST_DATABASE_URL=postgres://... \
//     npx vitest run xero-member-grouping-multiselect-migration
// ---------------------------------------------------------------------------

const databaseUrl = process.env.XERO_MEMBER_GROUPING_MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// The pre-#2093 shape: the scalar ageTier column + the old NULLS NOT DISTINCT
// shape-unique index and the ageTier btree index this migration reworks.
const PRE_EXISTING_SCHEMA_SQL = `
  CREATE TYPE "AgeTier" AS ENUM ('INFANT', 'CHILD', 'YOUTH', 'ADULT', 'NOT_APPLICABLE');
  CREATE TYPE "XeroContactGroupRuleMode" AS ENUM ('MANAGED', 'ACCEPTED');
  CREATE TABLE "XeroContactGroupRule" (
    "id" TEXT PRIMARY KEY,
    "membershipTypeId" TEXT,
    "ageTier" "AgeTier",
    "mode" "XeroContactGroupRuleMode" NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX "XeroContactGroupRule_ageTier_idx" ON "XeroContactGroupRule" ("ageTier");
  CREATE UNIQUE INDEX "XeroContactGroupRule_shape_unique"
    ON "XeroContactGroupRule" ("membershipTypeId", "ageTier", "mode", "groupId")
    NULLS NOT DISTINCT
    WHERE "groupId" IS NOT NULL;
`;

const SEED_SQL = `
  INSERT INTO "XeroContactGroupRule"
    ("id", "membershipTypeId", "ageTier", "mode", "groupId", "groupName", "isActive", "createdAt", "updatedAt") VALUES
    ('r_any', 'mt_life', NULL, 'MANAGED', 'g_life', 'Life', true, '2026-01-01', '2026-01-01'),
    ('r_adult', NULL, 'ADULT', 'MANAGED', 'g_adult', 'Adults', true, '2026-01-02', '2026-01-02'),
    ('r_youth', NULL, 'YOUTH', 'ACCEPTED', 'g_youth', 'Youth', false, '2026-01-03', '2026-01-03');
`;

type RuleRow = {
  id: string;
  membershipTypeId: string | null;
  ageTiers: string[];
  mode: string;
  groupId: string;
};

async function readRules(client: Client): Promise<RuleRow[]> {
  const result = await client.query<RuleRow>(
    `SELECT "id", "membershipTypeId", "ageTiers"::text[] AS "ageTiers", "mode"::text AS "mode", "groupId"
     FROM "XeroContactGroupRule" ORDER BY "id"`,
  );
  return result.rows;
}

async function withMigrationSchema(run: (client: Client) => Promise<void>) {
  const schemaName = `xero_grouping_ms_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Test fixture: hardcoded DDL in a disposable per-test schema; no user input.
    await client.query(PRE_EXISTING_SCHEMA_SQL);
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

describeWithDatabase(
  "xero grouping multi-select migration PostgreSQL behavior (#2093)",
  () => {
    it("maps scalar tiers to arrays (X -> [X], NULL -> []) and drops the scalar column", async () => {
      await withMigrationSchema(async (client) => {
        await client.query(SEED_SQL);
        await client.query(migrationSql);

        const rules = await readRules(client);
        expect(rules.find((r) => r.id === "r_any")?.ageTiers).toEqual([]);
        expect(rules.find((r) => r.id === "r_adult")?.ageTiers).toEqual(["ADULT"]);
        expect(rules.find((r) => r.id === "r_youth")?.ageTiers).toEqual(["YOUTH"]);

        const col = await client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'XeroContactGroupRule' AND column_name = 'ageTier'`,
        );
        expect(col.rowCount).toBe(0);
      });
    });

    it("re-enforces shape uniqueness over identical stored arrays (same canonical shape collides)", async () => {
      await withMigrationSchema(async (client) => {
        await client.query(migrationSql);
        // Two type-wildcard rules with the SAME stored (canonical) tier set +
        // group collide under the reworked NULLS NOT DISTINCT array index. The
        // stored order here is the canonical one the app would write
        // (YOUTH < ADULT per CANONICAL_AGE_TIER_ORDER).
        await client.query(
          `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
           VALUES ('a', ARRAY['YOUTH','ADULT']::"AgeTier"[], 'MANAGED', 'g', CURRENT_TIMESTAMP)`,
        );
        await expect(
          client.query(
            `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
             VALUES ('b', ARRAY['YOUTH','ADULT']::"AgeTier"[], 'MANAGED', 'g', CURRENT_TIMESTAMP)`,
          ),
        ).rejects.toThrow();
      });
    });

    it("does NOT collide on a genuinely reordered raw insert — canonical order is app-enforced, not DB-enforced", async () => {
      await withMigrationSchema(async (client) => {
        await client.query(migrationSql);
        // btree array equality is ORDER-SENSITIVE, so two raw inserts that differ
        // ONLY by tier order are DISTINCT rows at the DB level: the index does
        // NOT dedupe them. This documents that the canonical ordering that makes
        // reordered sets collide is enforced by the app (normalizeRule ->
        // canonicalizeAgeTiers), not by the index itself.
        await client.query(
          `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
           VALUES ('raw_adult_youth', ARRAY['ADULT','YOUTH']::"AgeTier"[], 'MANAGED', 'g', CURRENT_TIMESTAMP)`,
        );
        // Reversed order — accepted, NO unique violation at the DB level.
        await expect(
          client.query(
            `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
             VALUES ('raw_youth_adult', ARRAY['YOUTH','ADULT']::"AgeTier"[], 'MANAGED', 'g', CURRENT_TIMESTAMP)`,
          ),
        ).resolves.toBeDefined();

        // The app canonicalizes BOTH orders to the same array, so the
        // app-canonical write path is what actually produces the collision the
        // index then enforces.
        const canonicalFromReversed = canonicalizeAgeTiers(["ADULT", "YOUTH"]);
        const canonicalFromOrdered = canonicalizeAgeTiers(["YOUTH", "ADULT"]);
        expect(canonicalFromReversed).toEqual(canonicalFromOrdered);
        expect(canonicalFromOrdered).toEqual(["YOUTH", "ADULT"]);

        // Writing that single canonical shape twice DOES collide.
        await client.query(
          `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
           VALUES ('canon_1', $1::"AgeTier"[], 'MANAGED', 'g2', CURRENT_TIMESTAMP)`,
          [canonicalFromReversed],
        );
        await expect(
          client.query(
            `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
             VALUES ('canon_2', $1::"AgeTier"[], 'MANAGED', 'g2', CURRENT_TIMESTAMP)`,
            [canonicalFromOrdered],
          ),
        ).rejects.toThrow();
      });
    });

    it("collides two all-tiers ([]) rules with the same group (empty-array + NULLS NOT DISTINCT)", async () => {
      await withMigrationSchema(async (client) => {
        await client.query(migrationSql);
        // The "all age tiers" wildcard stores []; two such type-wildcard (NULL
        // membershipTypeId) rules for the same group must collide (empty-array
        // equality under NULLS NOT DISTINCT).
        await client.query(
          `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
           VALUES ('e1', ARRAY[]::"AgeTier"[], 'MANAGED', 'g_all', CURRENT_TIMESTAMP)`,
        );
        await expect(
          client.query(
            `INSERT INTO "XeroContactGroupRule" ("id", "ageTiers", "mode", "groupId", "updatedAt")
             VALUES ('e2', ARRAY[]::"AgeTier"[], 'MANAGED', 'g_all', CURRENT_TIMESTAMP)`,
          ),
        ).rejects.toThrow();
      });
    });

    it("is idempotent: a second run of the migration is a no-op", async () => {
      await withMigrationSchema(async (client) => {
        await client.query(SEED_SQL);
        await client.query(migrationSql);
        const before = await readRules(client);
        await client.query(migrationSql);
        expect(await readRules(client)).toEqual(before);
      });
    });
  },
);

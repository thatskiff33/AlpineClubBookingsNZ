import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260716140000_xero_member_grouping/migration.sql",
  ),
  "utf8",
);

const partialIndexManifest = readFileSync(
  join(process.cwd(), "prisma/partial-unique-indexes.tsv"),
  "utf8",
);

describe("xero member grouping migration (#1934)", () => {
  it("creates the grouping-mode enum and singleton settings table", () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "XeroMemberGroupingMode" AS ENUM ('NONE', 'MEMBERSHIP_TYPE', 'MEMBERSHIP_TYPE_AND_AGE')`,
    );
    expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "XeroGroupingSettings"`);
  });

  it("deactivates dormant pre-existing rules BEFORE the backfill, first run only", () => {
    // Pre-existing rows (old membership-types editor) must not go live at
    // deploy: everything that is not this migration's own backfill goes
    // dormant, and the whole pass is fenced on the settings singleton so a
    // re-run never deactivates rules created later via the new UI.
    expect(migrationSql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM "XeroGroupingSettings" WHERE "id" = 'default'\) THEN[\s\S]*UPDATE "XeroContactGroupRule"[\s\S]*SET "isActive" = false[\s\S]*AND "id" NOT LIKE 'xcgr-managed-%'[\s\S]*AND "id" NOT LIKE 'xcgr-accepted-%'/,
    );
    // Ordering: deactivation runs before the first backfill INSERT.
    expect(migrationSql.indexOf(`SET "isActive" = false`)).toBeLessThan(
      migrationSql.indexOf(`INSERT INTO "XeroContactGroupRule"`),
    );
  });

  it("shape-dedupes legacy duplicates BEFORE creating the unique index", () => {
    expect(migrationSql).toMatch(
      /DELETE FROM "XeroContactGroupRule" AS dup[\s\S]*IS NOT DISTINCT FROM keeper\."membershipTypeId"[\s\S]*IS NOT DISTINCT FROM keeper\."ageTier"[\s\S]*\(keeper\."createdAt", keeper\."id"\) < \(dup\."createdAt", dup\."id"\)/,
    );
    // Ordering: dedupe runs before CREATE UNIQUE INDEX so index creation
    // cannot fail on pre-existing duplicate shapes.
    expect(migrationSql.indexOf(`DELETE FROM "XeroContactGroupRule"`)).toBeLessThan(
      migrationSql.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"`),
    );
  });

  it("creates the rule-shape partial unique index with NULLS NOT DISTINCT", () => {
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"`);
    expect(migrationSql).toContain(`NULLS NOT DISTINCT`);
    expect(migrationSql).toContain(`WHERE "groupId" IS NOT NULL`);
  });

  it("records the partial index in the CI-enforced manifest", () => {
    expect(partialIndexManifest).toContain("XeroContactGroupRule_shape_unique");
    expect(partialIndexManifest).toContain("NULLS NOT DISTINCT");
  });

  it("backfills tier-only MANAGED rules from AgeTierSetting primary groups", () => {
    expect(migrationSql).toMatch(
      /INSERT INTO "XeroContactGroupRule"[\s\S]*'MANAGED'::"XeroContactGroupRuleMode"[\s\S]*FROM "AgeTierSetting" s[\s\S]*WHERE s\."xeroContactGroupId" IS NOT NULL/,
    );
  });

  it("backfills tier-only ACCEPTED rules from accepted-group rows", () => {
    expect(migrationSql).toMatch(
      /'ACCEPTED'::"XeroContactGroupRuleMode"[\s\S]*FROM "AgeTierXeroAcceptedContactGroup" a[\s\S]*JOIN "AgeTierSetting" s/,
    );
  });

  it("is idempotent: deterministic ids + ON CONFLICT DO NOTHING", () => {
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING");
    expect(migrationSql).toContain("'xcgr-managed-' || md5(");
    expect(migrationSql).toContain("'xcgr-accepted-' || md5(");
  });

  it("seeds MEMBERSHIP_TYPE_AND_AGE only when age-tier group config existed, else NONE", () => {
    expect(migrationSql).toMatch(
      /CASE[\s\S]*EXISTS \(SELECT 1 FROM "AgeTierSetting" WHERE "xeroContactGroupId" IS NOT NULL\)[\s\S]*OR EXISTS \(SELECT 1 FROM "AgeTierXeroAcceptedContactGroup"\)[\s\S]*THEN 'MEMBERSHIP_TYPE_AND_AGE'[\s\S]*ELSE 'NONE'/,
    );
    // Never clobber an admin-chosen mode on re-run.
    expect(migrationSql).toContain(`ON CONFLICT ("id") DO NOTHING`);
  });

  it("performs no Xero calls (DB-only migration)", () => {
    expect(migrationSql.toLowerCase()).not.toContain("http");
  });
});

// ---------------------------------------------------------------------------
// Real-PostgreSQL behavior (env-gated, disposable-schema-per-test pattern).
// Requires PostgreSQL 15+
// (NULLS NOT DISTINCT). Point the env var at a disposable database:
//   XERO_MEMBER_GROUPING_MIGRATION_TEST_DATABASE_URL=postgres://... npx vitest run xero-member-grouping-migration
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.XERO_MEMBER_GROUPING_MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// Minimal pre-existing schema the migration depends on (the real tables are
// created by earlier migrations; only the columns this migration touches are
// modelled here).
const PRE_EXISTING_SCHEMA_SQL = `
  CREATE TYPE "AgeTier" AS ENUM ('INFANT', 'CHILD', 'YOUTH', 'ADULT', 'NOT_APPLICABLE');
  CREATE TYPE "XeroContactGroupRuleMode" AS ENUM ('MANAGED', 'ACCEPTED');
  CREATE TABLE "AgeTierSetting" (
    "id" TEXT PRIMARY KEY,
    "tier" "AgeTier" NOT NULL UNIQUE,
    "xeroContactGroupId" TEXT,
    "xeroContactGroupName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE "AgeTierXeroAcceptedContactGroup" (
    "id" TEXT PRIMARY KEY,
    "ageTierSettingId" TEXT NOT NULL REFERENCES "AgeTierSetting"("id") ON DELETE CASCADE,
    "groupId" TEXT NOT NULL UNIQUE,
    "groupName" TEXT
  );
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
`;

// Tokoroa-shaped seed: two tiers with primary groups, one accepted group, a
// dormant type-keyed legacy rule, and a legacy duplicate shape pair.
const SEED_SQL = `
  INSERT INTO "AgeTierSetting" ("id", "tier", "xeroContactGroupId", "xeroContactGroupName", "sortOrder") VALUES
    ('ats_adult', 'ADULT', 'g_adult', 'Adults', 3),
    ('ats_youth', 'YOUTH', 'g_youth', 'Youth', 2),
    ('ats_child', 'CHILD', NULL, NULL, 1);
  INSERT INTO "AgeTierXeroAcceptedContactGroup" ("id", "ageTierSettingId", "groupId", "groupName") VALUES
    ('acc_1', 'ats_adult', 'g_adult_legacy', 'Adults (legacy)');
  INSERT INTO "XeroContactGroupRule"
    ("id", "membershipTypeId", "ageTier", "mode", "groupId", "groupName", "isActive", "createdAt", "updatedAt") VALUES
    ('legacy_rule_1', 'mt_full', NULL, 'MANAGED', 'g_full_members', 'Full members', true, '2026-01-01', '2026-01-01'),
    ('legacy_dup_a', NULL, 'ADULT', 'ACCEPTED', 'g_dup', 'Dup', true, '2026-01-02', '2026-01-02'),
    ('legacy_dup_b', NULL, 'ADULT', 'ACCEPTED', 'g_dup', 'Dup', true, '2026-01-03', '2026-01-03');
`;

type RuleRow = {
  id: string;
  membershipTypeId: string | null;
  ageTier: string | null;
  mode: string;
  groupId: string;
  isActive: boolean;
};

async function readRules(client: Client): Promise<RuleRow[]> {
  const result = await client.query<RuleRow>(
    `SELECT "id", "membershipTypeId", "ageTier"::text AS "ageTier", "mode"::text AS "mode", "groupId", "isActive"
     FROM "XeroContactGroupRule" ORDER BY "id"`,
  );
  return result.rows;
}

async function withMigrationSchema(
  run: (client: Client) => Promise<void>,
) {
  const schemaName = `xero_grouping_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Test fixture: hardcoded DDL/seed in a disposable per-test schema; no user input.
    await client.query(PRE_EXISTING_SCHEMA_SQL);
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

describeWithDatabase(
  "xero member grouping migration PostgreSQL behavior (#1934)",
  () => {
    it("backfills tier-only rules, deactivates legacy rules, dedupes, and seeds the mode", async () => {
      await withMigrationSchema(async (client) => {
        // Test fixture: hardcoded seed in a disposable per-test schema; no user input.
        await client.query(SEED_SQL);

        // Test fixture: runs the migration's own SQL against a disposable per-test schema; no user input.
        await client.query(migrationSql);

        const rules = await readRules(client);
        // Legacy duplicate collapsed to the earliest row.
        expect(rules.map((rule) => rule.id)).not.toContain("legacy_dup_b");
        const dupKeeper = rules.find((rule) => rule.id === "legacy_dup_a");
        expect(dupKeeper).toBeDefined();
        // Every pre-existing rule is dormant after the cutover.
        expect(dupKeeper!.isActive).toBe(false);
        const legacy = rules.find((rule) => rule.id === "legacy_rule_1");
        expect(legacy).toMatchObject({ isActive: false });

        // The ONLY active rules are the backfilled tier-only ones.
        const active = rules.filter((rule) => rule.isActive);
        expect(active).toHaveLength(3);
        expect(active.every((rule) => rule.membershipTypeId === null)).toBe(true);
        expect(active.every((rule) => rule.id.startsWith("xcgr-"))).toBe(true);
        expect(
          active
            .map((rule) => `${rule.ageTier}:${rule.mode}:${rule.groupId}`)
            .sort(),
        ).toEqual([
          "ADULT:ACCEPTED:g_adult_legacy",
          "ADULT:MANAGED:g_adult",
          "YOUTH:MANAGED:g_youth",
        ]);

        const settings = await client.query(
          `SELECT "mode"::text AS "mode" FROM "XeroGroupingSettings" WHERE "id" = 'default'`,
        );
        expect(settings.rows).toEqual([{ mode: "MEMBERSHIP_TYPE_AND_AGE" }]);
      });
    });

    it("re-running is a no-op and never deactivates post-cutover admin rules", async () => {
      await withMigrationSchema(async (client) => {
        // Test fixture: hardcoded seed in a disposable per-test schema; no user input.
        await client.query(SEED_SQL);
        await client.query(migrationSql);

        // Simulate post-cutover admin actions via the new UI: a new active
        // rule (cuid-style id) and a deliberate mode change.
        await client.query(
          `INSERT INTO "XeroContactGroupRule" ("id", "membershipTypeId", "ageTier", "mode", "groupId", "isActive", "updatedAt")
           VALUES ('cadmin_new_rule', 'mt_life', NULL, 'MANAGED', 'g_life', true, CURRENT_TIMESTAMP)`,
        );
        await client.query(
          `UPDATE "XeroGroupingSettings" SET "mode" = 'MEMBERSHIP_TYPE' WHERE "id" = 'default'`,
        );
        const before = await readRules(client);

        // Test fixture: re-runs the migration's own SQL to assert idempotency; no user input.
        await client.query(migrationSql);

        expect(await readRules(client)).toEqual(before);
        const adminRule = (await readRules(client)).find(
          (rule) => rule.id === "cadmin_new_rule",
        );
        expect(adminRule?.isActive).toBe(true);
        const settings = await client.query(
          `SELECT "mode"::text AS "mode" FROM "XeroGroupingSettings" WHERE "id" = 'default'`,
        );
        expect(settings.rows).toEqual([{ mode: "MEMBERSHIP_TYPE" }]);
      });
    });

    it("seeds NONE and no rules for an install without age-tier group config", async () => {
      await withMigrationSchema(async (client) => {
        // Test fixture: runs the migration's own SQL against a disposable per-test schema; no user input.
        await client.query(migrationSql);

        expect(await readRules(client)).toEqual([]);
        const settings = await client.query(
          `SELECT "mode"::text AS "mode" FROM "XeroGroupingSettings" WHERE "id" = 'default'`,
        );
        expect(settings.rows).toEqual([{ mode: "NONE" }]);
      });
    });
  },
);

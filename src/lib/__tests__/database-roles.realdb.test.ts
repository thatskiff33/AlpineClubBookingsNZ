/**
 * Real-PostgreSQL proof for the least-privilege database roles (#4453; owner
 * decision 27 Oct 2026).
 *
 * Every claim the issue makes is a claim about PostgreSQL's own privilege checks
 * — "the application role cannot UPDATE a ledger line", "it cannot run a
 * superuser-only statement", "migrations still run", "pg_dump still works" — so
 * only a real server can prove them. The roles are created by the SHIPPED
 * statements (`buildDatabaseRolesSql`, and the operator CLI for the re-runs),
 * never by a fixture that re-declares its own grants.
 *
 * Three scratch databases, created and dropped here:
 *  - FRESH: provisioned while empty, then `prisma migrate deploy` runs as the
 *    MIGRATION role — every migration in the repository, with no superuser —
 *    and is provisioned again once the tables exist.
 *  - UPGRADE: the shape of an existing deployment — every object owned by the
 *    superuser, plus an AI Diagnostics role (ADR-007) — which the CLI then
 *    provisions. Every proof about the application and retention roles runs here.
 *  - RESTORE: a `pg_dump` taken AS THE APPLICATION ROLE (the nightly backup's
 *    credential), restored by the superuser.
 *
 * ROLES ARE CLUSTER-GLOBAL, so every role and database carries a per-run
 * `tac_test_4453_<random>` prefix and is dropped in `afterAll`.
 *
 * Off by default. Runs only with `RUN_CONCURRENCY_RACE_TESTS=1` and the guarded
 * loopback `CONCURRENCY_RACE_DATABASE_URL` (`assertSafeRaceDbUrl`); it needs the
 * superuser that URL carries, `pg_dump` and `psql` on PATH, and the repository's
 * Prisma CLI. CI's `realdb-all` job runs it (`scripts/ci/realdb-files.mjs`).
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/database-roles.realdb.test.ts
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import type { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { restoreDumpWithoutOwnershipOrPrivileges } from "@/lib/backup-restore-validation";
import { APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES, APPEND_ONLY_SCHEMA_MIGRATION, buildDatabaseRolesSql } from "@/lib/database-roles";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";
import { buildAiDiagnosticsRoleSql } from "@/lib/diagnostics/tools/provision-role";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const REPO_ROOT = process.cwd();
const INSUFFICIENT_PRIVILEGE = "42501";
const RESTRICT_VIOLATION = "23001";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

const PREFIX = `tac_test_4453_${randomBytes(3).toString("hex")}`;
const ROLES = {
  migrator: `${PREFIX}_migrator`,
  app: `${PREFIX}_app`,
  auditRetention: `${PREFIX}_retention`,
  diagnostics: `${PREFIX}_diag`,
  restoreCheck: `${PREFIX}_restorecheck`,
} as const;
// Test-only secrets, long enough for the CLI and URL-safe.
const PASSWORDS = {
  migrator: "test-4453-migrator-password-not-a-secret",
  app: "test-4453-application-password-not-a-secret",
  auditRetention: "test-4453-retention-password-not-a-secret",
  diagnostics: "test-4453-diagnostics-password-not-a-secret",
  // Built, not written: a readable literal reads to gitleaks as a secret.
  restoreCheck: "c".repeat(28),
} as const;
const DATABASES = {
  fresh: `${PREFIX}_fresh`,
  upgrade: `${PREFIX}_upgrade`,
  restore: `${PREFIX}_restore`,
  restoreCheck: `${PREFIX}_restorecheck`,
  journal: `${PREFIX}_journal`,
} as const;

type RoleKey = keyof typeof ROLES;

function urlFor(database: string, role?: RoleKey): string {
  const url = new URL(RACE_DB_URL);
  url.pathname = `/${database}`;
  url.search = "";
  if (role) {
    url.username = ROLES[role];
    url.password = PASSWORDS[role];
  }
  return url.toString();
}

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Runs the shipped statement list in one transaction, as the CLI does. */
async function provisionWithBuilder(database: string): Promise<void> {
  const statements = buildDatabaseRolesSql({
    databaseName: database,
    migrator: { roleName: ROLES.migrator, password: PASSWORDS.migrator },
    app: { roleName: ROLES.app, password: PASSWORDS.app },
    auditRetention: { roleName: ROLES.auditRetention, password: PASSWORDS.auditRetention },
  });
  await withClient(urlFor(database), async (client) => {
    await client.query("BEGIN");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

/** The operator CLI, `pnpm run db:provision-roles --apply`, exactly as shipped. */
function provisionWithCli(database: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_ROLES_PROVISION_DATABASE_URL: urlFor(database),
    MIGRATION_DB_USER: ROLES.migrator,
    APP_DB_USER: ROLES.app,
    AUDIT_RETENTION_DB_USER: ROLES.auditRetention,
    MIGRATION_DB_PASSWORD: PASSWORDS.migrator,
    APP_DB_PASSWORD: PASSWORDS.app,
    AUDIT_RETENTION_DB_PASSWORD: PASSWORDS.auditRetention,
    AI_DIAGNOSTICS_DB_ROLE: ROLES.diagnostics,
  };
  return spawnSync(
    path.join(REPO_ROOT, "node_modules/.bin/tsx"),
    ["scripts/provision-database-roles.ts", "--apply"],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000 },
  );
}

function runTool(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
    timeout: 240_000,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(`${command} is not on PATH; this suite needs the PostgreSQL client tools.`);
  }
  return result;
}

/**
 * The deploy script's post-migrate grants check (#4453 review, O-F2), lifted out
 * of `scripts/run-production-blue-green-deploy.sh` between its markers and run
 * here as shipped, with the same psql variables.
 */
function deployGrantsCheck(database: string): string {
  const script = readFileSync(path.join(REPO_ROOT, "scripts/run-production-blue-green-deploy.sh"), "utf8");
  const block = script.slice(
    script.indexOf("# BEGIN least-privilege-grants-check"),
    script.indexOf("# END least-privilege-grants-check"),
  );
  const sql = block.slice(block.indexOf("<<'SQL'\n") + "<<'SQL'\n".length, block.indexOf("\nSQL\n"));
  expect(sql).toContain("SELECT coalesce(string_agg(c.relname");
  const result = runTool(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-v", `migration_role=${ROLES.migrator}`, "-v", `app_role=${ROLES.app}`, "-Atq", "-f", "-", urlFor(database)],
    `${sql}\n`,
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** SQLSTATE of a refused statement, or "ok" when PostgreSQL ran it. */
async function sqlstate(client: Client, sql: string, values: unknown[] = []): Promise<string> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(sql, values);
    await client.query("RELEASE SAVEPOINT probe");
    return "ok";
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return String((error as { code?: string }).code ?? "unknown");
  }
}

/** Every owner, ACL and default ACL in the schema, plus the roles' own shape. */
async function privilegeSnapshot(database: string, { includeDatabaseAcl = true } = {}) {
  return withClient(urlFor(database), async (client) => {
    // A NULL ACL means "the owner's default"; a REVOKE materialises that default
    // explicitly, and pg_dump then omits it again, so both read as acldefault.
    const sortedAcl = (column: string, fallback?: string) =>
      `(SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(${fallback ? `coalesce(${column}, ${fallback})` : column}) x)`;
    const { rows } = await client.query(`
      SELECT json_build_object(
        'relations', (SELECT json_agg(json_build_array(c.relname, c.relkind, pg_get_userbyid(c.relowner), ${sortedAcl("c.relacl", "acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\", c.relowner)")}) ORDER BY c.relname)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')),
        'columns', (SELECT json_agg(json_build_array(c.relname, a.attname, ${sortedAcl("a.attacl")}) ORDER BY c.relname, a.attname)
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND a.attacl IS NOT NULL),
        'types', (SELECT json_agg(json_build_array(t.typname, pg_get_userbyid(t.typowner)) ORDER BY t.typname)
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'),
        'routines', (SELECT json_agg(json_build_array(p.oid::regprocedure::text, pg_get_userbyid(p.proowner), ${sortedAcl("p.proacl", "acldefault('f'::\"char\", p.proowner)")}) ORDER BY p.oid::regprocedure::text)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
        'defaults', (SELECT json_agg(json_build_array(pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype, ${sortedAcl("d.defaclacl")}) ORDER BY pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype)
          FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace),
        'schema', (SELECT ${sortedAcl("nspacl", "acldefault('n'::\"char\", nspowner)")} FROM pg_namespace WHERE nspname = 'public'),
        'database', ${includeDatabaseAcl ? `(SELECT ${sortedAcl("datacl")} FROM pg_database WHERE datname = current_database())` : "null"},
        'roles', (SELECT json_agg(json_build_array(r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls) ORDER BY r.rolname)
          FROM pg_roles r WHERE r.rolname LIKE $1),
        'memberships', (SELECT json_agg(json_build_array(g.rolname, m.rolname) ORDER BY g.rolname, m.rolname)
          FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
          WHERE g.rolname LIKE $1 OR m.rolname LIKE $1)
      ) AS snapshot`, [`${PREFIX}%`]);
    return rows[0].snapshot as Record<string, unknown>;
  });
}

(RUN ? describe : describe.skip)(
  "least-privilege database roles (#4453) - real PostgreSQL",
  { timeout: 180_000 },
  () => {
    let admin: Client;
    let migrateResult: ReturnType<typeof spawnSync>;
    let freshCheckBeforeReprovision = "";
    let firstCliRun: ReturnType<typeof spawnSync>;
    let diagnosticsBefore: unknown;
    let appPrisma: PrismaClient;
    let appDumpSql = "";

    async function diagnosticsPrivileges(database: string) {
      return withClient(urlFor(database), async (client) => {
        const { rows } = await client.query(
          `SELECT json_build_object(
             'tables', (SELECT json_agg(json_build_array(c.relname,
                 has_table_privilege($1, c.oid, 'SELECT'), has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) ORDER BY c.relname)
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
                 AND (has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                      OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE'))),
             'columns', (SELECT json_agg(json_build_array(c.relname, a.attname) ORDER BY c.relname, a.attname)
               FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
                 AND has_column_privilege($1, c.oid, a.attnum, 'SELECT')),
             'createOnSchema', has_schema_privilege($1, 'public', 'CREATE'),
             'temp', has_database_privilege($1, current_database(), 'TEMPORARY'),
             'memberOf', (SELECT count(*) FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname = $1),
             'attributes', (SELECT row_to_json(r) FROM (SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = $1) r)
           ) AS privileges`,
          [ROLES.diagnostics],
        );
        return rows[0].privileges;
      });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Least-privilege database roles");
      admin = new Client({ connectionString: RACE_DB_URL });
      await admin.connect();
      const superuser = await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
      if (!superuser.rows[0]?.rolsuper) {
        throw new Error("This suite provisions roles and transfers ownership: CONCURRENCY_RACE_DATABASE_URL must be a superuser.");
      }

      // FRESH: roles first, then every migration as the migration role.
      await admin.query(`CREATE DATABASE "${DATABASES.fresh}"`);
      await provisionWithBuilder(DATABASES.fresh);
      const migrateEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: urlFor(DATABASES.fresh, "migrator") };
      delete migrateEnv.SHADOW_DATABASE_URL;
      migrateResult = spawnSync(path.join(REPO_ROOT, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
        cwd: REPO_ROOT,
        env: migrateEnv,
        encoding: "utf8",
        timeout: 400_000,
      });
      if (migrateResult.status !== 0) {
        throw new Error(`prisma migrate deploy as the migration role failed:\n${migrateResult.stdout}\n${migrateResult.stderr}`);
      }
      freshCheckBeforeReprovision = deployGrantsCheck(DATABASES.fresh);
      await provisionWithBuilder(DATABASES.fresh);

      // UPGRADE: the fresh schema re-created with every object owned by the
      // superuser and no grants — an existing single-superuser deployment.
      await admin.query(`CREATE DATABASE "${DATABASES.upgrade}"`);
      const schemaDump = runTool("pg_dump", ["--no-owner", "--no-privileges", urlFor(DATABASES.fresh)]);
      if (schemaDump.status !== 0) throw new Error(`pg_dump of the fresh database failed: ${schemaDump.stderr}`);
      const load = runTool("psql", ["-q", "-v", "ON_ERROR_STOP=1", urlFor(DATABASES.upgrade)], schemaDump.stdout);
      if (load.status !== 0) throw new Error(`loading the upgrade database failed: ${load.stderr}`);

      // An AI Diagnostics role provisioned the shipped way, before the split.
      const superuserName = new URL(RACE_DB_URL).username;
      await withClient(urlFor(DATABASES.upgrade), async (client) => {
        await client.query("BEGIN");
        for (const statement of buildAiDiagnosticsRoleSql({
          roleName: ROLES.diagnostics,
          password: PASSWORDS.diagnostics,
          databaseName: DATABASES.upgrade,
          preserveTempForRoles: [superuserName],
          statementTimeoutMs: 5_000,
          connectionLimit: 4,
        })) {
          await client.query(statement);
        }
        await client.query("COMMIT");
      });
      diagnosticsBefore = await diagnosticsPrivileges(DATABASES.upgrade);

      firstCliRun = provisionWithCli(DATABASES.upgrade);

      vi.stubEnv("DATABASE_URL", urlFor(DATABASES.upgrade, "app"));
      const { PrismaClient: Prisma } = await import("@prisma/client");
      const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
      appPrisma = new Prisma({ adapter: createPrismaPgAdapter(urlFor(DATABASES.upgrade, "app")) });
    }, 600_000);

    afterAll(async () => {
      await appPrisma?.$disconnect().catch(() => {});
      vi.unstubAllEnvs();
      if (!admin) return;
      for (const database of Object.values(DATABASES)) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
      }
      for (const role of Object.values(ROLES)) {
        await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch((error) => {
          console.warn(`[database-roles.realdb] could not drop test role ${role}: ${String(error)}`);
        });
      }
      await admin.end().catch(() => {});
    });

    describe("migrations", () => {
      it("runs every migration as the migration role on an empty database, with no superuser", async () => {
        expect(migrateResult.status).toBe(0);
        const owners = await withClient(urlFor(DATABASES.fresh), (client) =>
          client.query(
            `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
          ),
        );
        expect(owners.rows.map((row) => row.owner)).toEqual([ROLES.migrator]);
      });

      it("transfers ownership of every schema object on an existing database to the migration role", async () => {
        expect(firstCliRun.status, `${firstCliRun.stdout}\n${firstCliRun.stderr}`).toBe(0);
        const { rows } = await withClient(urlFor(DATABASES.upgrade), (client) =>
          client.query(
            `SELECT 'relation ' || c.relname AS object FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> $1
             UNION ALL
             SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) <> $1
             UNION ALL
             SELECT 'routine ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> $1
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
            [ROLES.migrator],
          ),
        );
        expect(rows).toEqual([]);
      });

      it("runs after AI Diagnostics provisioning took TEMPORARY away from PUBLIC", async () => {
        const { rows } = await withClient(urlFor(DATABASES.upgrade), (client) =>
          client.query(
            `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS diag,
                    has_database_privilege($2, current_database(), 'TEMPORARY') AS migrator,
                    has_database_privilege($3, current_database(), 'TEMPORARY') AS app`,
            [ROLES.diagnostics, ROLES.migrator, ROLES.app],
          ),
        );
        expect(rows[0]).toEqual({ diag: false, migrator: true, app: true });
      });

      it("lets the migration role run the DDL and data statements a migration is made of", async () => {
        await withClient(urlFor(DATABASES.upgrade, "migrator"), async (client) => {
          await client.query("BEGIN");
          for (const statement of [
            "CREATE EXTENSION IF NOT EXISTS pgcrypto",
            `ALTER TABLE "BookingLedgerLine" ADD COLUMN "tac4453Probe" TEXT`,
            `CREATE INDEX "tac4453_probe_idx" ON "AuditLog" ("action", "createdAt")`,
            `ALTER TYPE "LedgerSide" ADD VALUE IF NOT EXISTS 'TAC4453_PROBE'`,
            `UPDATE "AuditLog" SET "summary" = "summary" WHERE false`,
            `CREATE OR REPLACE FUNCTION tac4453_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
            // Migrations use temp tables, and AI Diagnostics provisioning (run on
            // this database above) revoked TEMPORARY from PUBLIC (S-F10).
            `CREATE TEMP TABLE tac4453_probe_temp ("x" INT) ON COMMIT DROP`,
          ]) {
            expect(await sqlstate(client, statement), statement).toBe("ok");
          }
          await client.query("ROLLBACK");
        });
      });

      it("gives a table a later migration creates the application's grants at once (default privileges)", async () => {
        await withClient(urlFor(DATABASES.upgrade, "migrator"), (client) =>
          client.query(`CREATE TABLE "Tac4453Later" ("id" INT PRIMARY KEY, "note" TEXT, "seq" SERIAL)`),
        );
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          await client.query("BEGIN");
          // "seq" draws on its sequence, which the default privileges also cover.
          expect(await sqlstate(client, `INSERT INTO "Tac4453Later" ("id", "note") VALUES (1, 'a')`)).toBe("ok");
          expect(await sqlstate(client, `UPDATE "Tac4453Later" SET "note" = 'b' WHERE "id" = 1`)).toBe("ok");
          expect(await sqlstate(client, `SELECT * FROM "Tac4453Later"`)).toBe("ok");
          expect(await sqlstate(client, `DELETE FROM "Tac4453Later" WHERE "id" = 1`)).toBe("ok");
          expect(await sqlstate(client, `TRUNCATE "Tac4453Later"`)).toBe(INSUFFICIENT_PRIVILEGE);
          await client.query("ROLLBACK");
        });
        await withClient(urlFor(DATABASES.upgrade, "auditRetention"), async (client) => {
          await client.query("BEGIN");
          expect(await sqlstate(client, `SELECT * FROM "Tac4453Later"`)).toBe(INSUFFICIENT_PRIVILEGE);
          await client.query("ROLLBACK");
        });
      });
    });

    describe("the member-money journal migration on a provisioned database (#4513)", () => {
      it("leaves only the older append-only tables for provisioning on a database provisioned while empty (DEPLOYMENT.md)", async () => {
        // The journal's migration narrowed its own tables; the deploy check stops
        // on the two that provisioning narrows, until --apply runs again.
        expect(freshCheckBeforeReprovision).toBe("AuditLog, BookingLedgerLine");
        expect(deployGrantsCheck(DATABASES.fresh)).toBe("");
      });

      it("narrows its own tables as the migration role, so the deploy grants check passes without re-provisioning", async () => {
        const database = DATABASES.journal;
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${DATABASES.fresh}"`);
        // The release before the journal, provisioned: take the journal away again.
        await withClient(urlFor(database), (client) => client.query(`
          DROP TABLE ${MEMBER_MONEY_RELATIONS.map((name) => `"${name}"`).join(", ")} CASCADE;
          DROP FUNCTION member_money_require_complete(), member_money_batch_errors(text),
            member_money_check_seal(), member_money_refuse_mutation(), member_money_system_identifier();
          DROP TYPE "MemberMoneyAccount", "MemberMoneySide", "MemberMoneyEventKind", "MemberMoneyOrigin",
            "MemberMoneySourceKind", "MemberMoneyObligationKind", "MemberMoneyDebtorKind";
          DELETE FROM "_prisma_migrations" WHERE migration_name = '${APPEND_ONLY_SCHEMA_MIGRATION}'`));
        expect(deployGrantsCheck(database)).toBe("");
        // Applied as prisma migrate deploy applies it: one file, as the migration role.
        await withClient(urlFor(database, "migrator"), (client) => client.query(
          readFileSync(path.join(REPO_ROOT, `prisma/migrations/${APPEND_ONLY_SCHEMA_MIGRATION}/migration.sql`), "utf8"),
        ));
        expect(deployGrantsCheck(database)).toBe("");
        const { rows } = await withClient(urlFor(database), (client) => client.query(
          `SELECT t.name, has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'SELECT')
                    AND has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'INSERT') AS inserts,
                  has_table_privilege($1, to_regclass(format('public.%I', t.name)), '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}') AS changes,
                  pg_get_userbyid(c.relowner) AS owner
             FROM unnest($2::text[]) AS t(name) JOIN pg_class c ON c.oid = to_regclass(format('public.%I', t.name))
             ORDER BY t.name`,
          [ROLES.app, [...MEMBER_MONEY_RELATIONS]],
        ));
        expect(rows).toEqual([...MEMBER_MONEY_RELATIONS].sort().map((name) => (
          { name, inserts: true, changes: false, owner: ROLES.migrator })));
      });
    });

    describe("the application role", () => {
      const lodgeId = "tac4453-lodge";
      const bookingId = "tac4453-booking";
      let ledgerLineId = "";
      let auditId = "";

      beforeAll(async () => {
        await appPrisma.lodge.create({ data: { id: lodgeId, name: "Roles test lodge", slug: lodgeId } });
        await appPrisma.organisation.create({ data: { id: "tac4453-organisation", name: "Roles test school" } });
        await appPrisma.booking.create({
          data: {
            id: bookingId,
            lodgeId,
            organisationId: "tac4453-organisation",
            checkIn: new Date("2026-08-01T00:00:00.000Z"),
            checkOut: new Date("2026-08-02T00:00:00.000Z"),
            totalPriceCents: 100,
            finalPriceCents: 100,
          },
        });
        ledgerLineId = (
          await appPrisma.bookingLedgerLine.create({
            data: {
              bookingId,
              lodgeId,
              side: "ADJUSTMENT",
              kind: "AGREED_ADJUSTMENT",
              sign: 1,
              quantity: 1,
              unitCents: 100,
              amountCents: 100,
              guestNames: [],
              anchorKind: "REVIEW_TASK",
              anchorId: "tac4453",
              narration: "Adjustment agreed with member: roles test",
            },
          })
        ).id;
        auditId = (await appPrisma.auditLog.create({ data: { action: "tac4453.roles.probe", ipAddress: "203.0.113.7" } })).id;
      });

      it("keeps ordinary tables fully usable through Prisma", async () => {
        await appPrisma.booking.update({ where: { id: bookingId }, data: { finalPriceCents: 90 } });
        // PaymentTransaction.insertionSeq is the schema's one autoincrement: the
        // application role's sequence grant is exercised here (O-F8).
        const payment = await appPrisma.payment.create({ data: { bookingId, amountCents: 90 } });
        const transaction = await appPrisma.paymentTransaction.create({
          data: { paymentId: payment.id, kind: "PRIMARY", amountCents: 90 },
        });
        expect(transaction.insertionSeq).toBeGreaterThan(0);
        const scratch = await appPrisma.lodge.create({ data: { id: "tac4453-scratch", name: "Scratch", slug: "tac4453-scratch" } });
        await appPrisma.lodge.delete({ where: { id: scratch.id } });
        expect((await appPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).finalPriceCents).toBe(90);
        expect(await appPrisma.bookingLedgerLine.count({ where: { bookingId } })).toBe(1);
        expect(await appPrisma.auditLog.count({ where: { id: auditId } })).toBe(1);
      });

      it("cannot UPDATE, DELETE, TRUNCATE, upsert over or lock a ledger line or an audit row", async () => {
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          await client.query("BEGIN");
          const refused = [
            [`UPDATE "BookingLedgerLine" SET "narration" = 'rewritten' WHERE "id" = $1`, [ledgerLineId]],
            [`DELETE FROM "BookingLedgerLine" WHERE "id" = $1`, [ledgerLineId]],
            [`UPDATE "AuditLog" SET "summary" = 'rewritten' WHERE "id" = $1`, [auditId]],
            [`UPDATE "AuditLog" SET "ipAddress" = NULL WHERE "id" = $1`, [auditId]],
            [`DELETE FROM "AuditLog" WHERE "id" = $1`, [auditId]],
            [`TRUNCATE "BookingLedgerLine"`, []],
            [`TRUNCATE "AuditLog"`, []],
            [`INSERT INTO "AuditLog" ("id", "action") VALUES ($1, 'x') ON CONFLICT ("id") DO UPDATE SET "action" = 'y'`, [auditId]],
            [`SELECT 1 FROM "BookingLedgerLine" WHERE "id" = $1 FOR UPDATE`, [ledgerLineId]],
            [`INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at") VALUES ('x', 'x', 'x', now())`, []],
          ] as const;
          for (const [sql, values] of refused) {
            expect(await sqlstate(client, sql, [...values]), sql).toBe(INSUFFICIENT_PRIVILEGE);
          }
          // What the application may still do with them: read and append.
          expect(await sqlstate(client, `SELECT count(*) FROM "BookingLedgerLine"`)).toBe("ok");
          expect(await sqlstate(client, `SELECT count(*) FROM "_prisma_migrations"`)).toBe("ok");
          expect(await sqlstate(client, `INSERT INTO "AuditLog" ("id", "action") VALUES ('tac4453-dup', 'x') ON CONFLICT DO NOTHING`)).toBe("ok");
          await client.query("ROLLBACK");
        });
        const unchanged = await withClient(urlFor(DATABASES.upgrade), (client) =>
          client.query(`SELECT "narration" FROM "BookingLedgerLine" WHERE "id" = $1`, [ledgerLineId]),
        );
        expect(unchanged.rows).toEqual([{ narration: "Adjustment agreed with member: roles test" }]);
      });

      it("cannot rewrite a ledger line through its parent's key: the key-change triggers refuse it (S-F1)", async () => {
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          // The trigger raises restrict_violation (23001) before any referential
          // action; a foreign-key violation (23503) would mean the key, not the
          // trigger, refused it.
          await client.query("BEGIN");
          expect(await sqlstate(client, `UPDATE "Booking" SET "id" = 'tac4453-renamed' WHERE "id" = $1`, [bookingId])).toBe(RESTRICT_VIOLATION);
          expect(await sqlstate(client, `UPDATE "Lodge" SET "id" = 'tac4453-renamed' WHERE "id" = $1`, [lodgeId])).toBe(RESTRICT_VIOLATION);
          // Writing the same key back is no change, so ordinary updates are untouched.
          expect(await sqlstate(client, `UPDATE "Booking" SET "id" = "id" WHERE "id" = $1`, [bookingId])).toBe("ok");
          await client.query("ROLLBACK");
        });
        const lines = await appPrisma.bookingLedgerLine.findMany({ where: { id: ledgerLineId }, select: { bookingId: true, lodgeId: true } });
        expect(lines).toEqual([{ bookingId, lodgeId }]);
      });

      // #4514 (Ledger M2), the #4482 acceptance criterion: an application-role
      // booking delete cannot remove ledger lines. D1 (owner, 28 Oct 2026) made
      // every financial key RESTRICT; a referential action runs with the table
      // owner's rights, so before it the cascade was a route around the grant.
      // Each booking below carries ONE kind of history, so each refusal is that
      // key's own: a booking held by a credit row too would mask a ledger cascade.
      const createHistoryBooking = (id: string, checkIn: string, checkOut: string) => appPrisma.booking.create({
        data: {
          id,
          lodgeId,
          organisationId: "tac4453-organisation",
          checkIn: new Date(`${checkIn}T00:00:00.000Z`),
          checkOut: new Date(`${checkOut}T00:00:00.000Z`),
          totalPriceCents: 100,
          finalPriceCents: 100,
        },
      });

      it("cannot remove a booking's ledger lines by deleting the booking, by any route (#4482, D1)", async () => {
        const kept = "tac4514-booking-with-lines";
        await createHistoryBooking(kept, "2026-09-01", "2026-09-02");
        const line = await appPrisma.bookingLedgerLine.create({
          data: {
            bookingId: kept, lodgeId, side: "ADJUSTMENT", kind: "AGREED_ADJUSTMENT", sign: 1, quantity: 1,
            unitCents: 100, amountCents: 100, guestNames: [], anchorKind: "REVIEW_TASK", anchorId: "tac4514-delete",
            narration: "Adjustment agreed with member: outlives its booking",
          },
        });

        // Every route the application role has to the booking row.
        await expect(appPrisma.booking.delete({ where: { id: kept } })).rejects.toMatchObject({ code: "P2003" });
        await expect(appPrisma.booking.deleteMany({ where: { id: kept } })).rejects.toMatchObject({ code: "P2003" });
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          await client.query("BEGIN");
          expect(await sqlstate(client, `DELETE FROM "Booking" WHERE "id" = $1`, [kept])).toBe(FOREIGN_KEY_VIOLATION);
          expect(await sqlstate(client, `TRUNCATE "Booking" CASCADE`)).toBe(INSUFFICIENT_PRIVILEGE);
          // The parent-key routes: a line's own key is not the application's to
          // change, and the booking's key stays refused (S-F1).
          expect(await sqlstate(client, `UPDATE "BookingLedgerLine" SET "id" = 'tac4514-renamed' WHERE "id" = $1`, [line.id])).toBe(INSUFFICIENT_PRIVILEGE);
          expect(await sqlstate(client, `UPDATE "Booking" SET "id" = 'tac4514-renamed' WHERE "id" = $1`, [kept])).toBe(RESTRICT_VIOLATION);
          await client.query("ROLLBACK");
        });
        // The owner is refused too: RESTRICT binds whoever deletes.
        await withClient(urlFor(DATABASES.upgrade), async (client) => {
          await client.query("BEGIN");
          expect(await sqlstate(client, `DELETE FROM "Booking" WHERE "id" = $1`, [kept])).toBe(FOREIGN_KEY_VIOLATION);
          await client.query("ROLLBACK");
        });

        expect(await appPrisma.bookingLedgerLine.findMany({ where: { bookingId: kept }, select: { id: true } })).toEqual([{ id: line.id }]);
        expect(await appPrisma.booking.count({ where: { id: kept } })).toBe(1);
      });

      it("cannot blank a credit row's booking link by deleting the booking (D1, INV-MONEY-035)", async () => {
        const credited = "tac4514-booking-with-credit";
        const memberId = "tac4514-member";
        await appPrisma.member.create({
          data: { id: memberId, email: `${memberId}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ledger", lastName: "Keeper" },
        });
        await createHistoryBooking(credited, "2026-09-05", "2026-09-06");
        const credit = await appPrisma.memberCredit.create({
          data: { memberId, amountCents: -100, type: "BOOKING_APPLIED", description: "tac4514 applied", appliedToBookingId: credited },
        });

        await expect(appPrisma.booking.delete({ where: { id: credited } })).rejects.toMatchObject({ code: "P2003" });
        expect(await appPrisma.memberCredit.findUniqueOrThrow({ where: { id: credit.id }, select: { appliedToBookingId: true } }))
          .toEqual({ appliedToBookingId: credited });
      });

      it("still hard-deletes a draft that carries no money, as the previous release's draft paths do", async () => {
        const draft = "tac4514-money-free-draft";
        await appPrisma.booking.create({
          data: {
            id: draft,
            lodgeId,
            organisationId: "tac4453-organisation",
            status: "DRAFT",
            checkIn: new Date("2026-09-03T00:00:00.000Z"),
            checkOut: new Date("2026-09-04T00:00:00.000Z"),
            totalPriceCents: 100,
            finalPriceCents: 100,
            guests: { create: [{ firstName: "Draft", lastName: "Guest", ageTier: "ADULT", priceCents: 100, stayStart: new Date("2026-09-03T00:00:00.000Z"), stayEnd: new Date("2026-09-04T00:00:00.000Z") }] },
          },
        });
        await appPrisma.booking.delete({ where: { id: draft } });
        expect(await appPrisma.booking.count({ where: { id: draft } })).toBe(0);
        expect(await appPrisma.bookingGuest.count({ where: { bookingId: draft } })).toBe(0);
      });

      it("holds every key a money line, a credit row's booking link or a group settlement has as RESTRICT both ways, so no referential action can reach one", async () => {
        const { rows } = await withClient(urlFor(DATABASES.upgrade), (client) => client.query(
          `SELECT c.conrelid::regclass::text AS relation, a.attname AS "column", c.confdeltype AS "onDelete",
                  c.confupdtype AS "onUpdate", c.convalidated AS validated
             FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
              AND (c.conrelid::regclass::text = ANY($1::text[])
                OR (c.conrelid = '"MemberCredit"'::regclass
                  AND a.attname IN ('sourceBookingId', 'appliedToBookingId', 'sourceBookingModificationId'))
                OR (c.conrelid = '"GroupBookingSettlement"'::regclass AND a.attname = 'groupBookingId'))
            ORDER BY 1, 2`,
          [["\"BookingLedgerLine\"", ...MEMBER_MONEY_RELATIONS.map((name) => `"${name}"`)]],
        ));
        // Not vacuous: the legacy ledger's three keys, the credit links and the journal's keys are all here.
        expect(rows.filter((row) => row.relation === '"BookingLedgerLine"').map((row) => row.column).sort())
          .toEqual(["bookingId", "lodgeId", "reversesLineId"]);
        expect(rows.filter((row) => row.relation === '"MemberCredit"')).toHaveLength(3);
        expect(rows.filter((row) => row.relation === '"GroupBookingSettlement"').map((row) => row.column)).toEqual(["groupBookingId"]);
        expect(rows.filter((row) => row.relation === '"MemberMoneyLine"').map((row) => row.column))
          .toEqual(expect.arrayContaining(["bookingId", "lodgeId", "journalId"]));
        expect(rows.filter((row) => row.onDelete !== "r" || row.onUpdate !== "r" || !row.validated)).toEqual([]);
      });

      it("may create a temporary table, which nothing else grants it once AI Diagnostics revoked PUBLIC's", async () => {
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          await client.query("BEGIN");
          expect(await sqlstate(client, `CREATE TEMP TABLE tac4453_app_temp ("x" INT) ON COMMIT DROP`)).toBe("ok");
          await client.query("ROLLBACK");
        });
      });

      it("cannot run superuser-only or owner-only statements", async () => {
        await withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
          await client.query("BEGIN");
          const refused = [
            `CREATE ROLE tac4453_escalated`,
            `ALTER ROLE "${ROLES.app}" SUPERUSER`,
            `SET session_replication_role = replica`,
            `SELECT pg_read_file('postgresql.conf')`,
            `COPY (SELECT 1) TO PROGRAM 'true'`,
            `ALTER TABLE "BookingLedgerLine" DISABLE TRIGGER ALL`,
            `ALTER TABLE "AuditLog" DROP COLUMN "summary"`,
            `DROP TABLE "BookingLedgerLine"`,
            `CREATE TABLE "Tac4453Escape" ("id" INT)`,
            `SET ROLE "${ROLES.migrator}"`,
            // The in-app "restore local backup" first statement: refused, so a
            // split deployment's live data is never dropped by the app.
            `DROP SCHEMA IF EXISTS public CASCADE`,
          ];
          for (const sql of refused) {
            expect(await sqlstate(client, sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
          }
          await client.query("ROLLBACK");
          // ALTER SYSTEM and CREATE DATABASE cannot run inside a transaction block.
          for (const sql of [`ALTER SYSTEM SET work_mem = '64MB'`, `CREATE DATABASE tac4453_escape`]) {
            const code = await client.query(sql).then(
              () => "ok",
              (error: { code?: string }) => String(error.code),
            );
            expect(code, sql).toBe(INSUFFICIENT_PRIVILEGE);
          }
        });
      });

      it("takes a pg_dump backup as the application role, which the operator restores with the role split intact", async () => {
        const dump = runTool("pg_dump", [urlFor(DATABASES.upgrade, "app")]);
        expect(dump.status, dump.stderr).toBe(0);
        appDumpSql = dump.stdout;
        expect(appDumpSql).toContain(`CREATE TABLE public."BookingLedgerLine"`);
        expect(appDumpSql).toContain(`OWNER TO ${ROLES.migrator}`);

        await admin.query(`CREATE DATABASE "${DATABASES.restore}"`);
        const restore = runTool("psql", ["-q", "-v", "ON_ERROR_STOP=1", urlFor(DATABASES.restore)], appDumpSql);
        expect(restore.status, restore.stderr).toBe(0);

        const restored = await withClient(urlFor(DATABASES.restore), (client) =>
          client.query(`SELECT "narration" FROM "BookingLedgerLine" WHERE "id" = $1`, [ledgerLineId]),
        );
        expect(restored.rows).toHaveLength(1);
        // Ownership, table and column grants and default privileges all travel
        // in the dump; the database-level CONNECT grants do not (pg_dump writes
        // those only with --create), so the operator re-runs provisioning.
        expect(await privilegeSnapshot(DATABASES.restore, { includeDatabaseAcl: false })).toEqual(
          await privilegeSnapshot(DATABASES.upgrade, { includeDatabaseAcl: false }),
        );
      });
    });

    describe("backup restore-validation without a superuser (S-F2)", () => {
      it("restores the application role's dump, owners and grants stripped, as a role that owns only the shadow database", async () => {
        expect(appDumpSql).toContain("OWNER TO");
        await admin.query(`CREATE ROLE "${ROLES.restoreCheck}" LOGIN NOSUPERUSER PASSWORD '${PASSWORDS.restoreCheck}'`);
        await admin.query(`CREATE DATABASE "${DATABASES.restoreCheck}" OWNER "${ROLES.restoreCheck}"`);
        const target = urlFor(DATABASES.restoreCheck, "restoreCheck");
        const reset = () =>
          runTool("psql", ["-q", "-v", "ON_ERROR_STOP=1", "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;", target]);

        // The dump as taken still needs the roles' owner: refused without one.
        expect(reset().status).toBe(0);
        const unstripped = runTool("psql", ["-q", "-v", "ON_ERROR_STOP=1", target], appDumpSql);
        expect(unstripped.status).not.toBe(0);

        // What `validateBackupRestore` runs, as shipped: the gzipped backup streamed
        // through the owner/grant filter into psql.
        expect(reset().status).toBe(0);
        const dir = mkdtempSync(path.join(tmpdir(), "tac4453-validation-"));
        try {
          const gz = path.join(dir, "backup.sql.gz");
          writeFileSync(gz, gzipSync(Buffer.from(appDumpSql, "utf8")));
          await restoreDumpWithoutOwnershipOrPrivileges({ sourcePath: gz, argvUrl: target, env: process.env, timeoutMs: 120_000 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        const { rows } = await withClient(target, (client) =>
          client.query(`SELECT (SELECT count(*) FROM "BookingLedgerLine")::int AS lines, (SELECT count(*) FROM "Booking")::int AS bookings`),
        );
        expect(rows[0].lines).toBeGreaterThan(0);
        expect(rows[0].bookings).toBeGreaterThan(0);
      });
    });

    describe("the audit-retention role", () => {
      const now = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
      const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

      async function seedRetentionRows() {
        await appPrisma.auditLog.createMany({
          data: [
            { id: "tac4453-anonymise", action: "tac4453.retention", ipAddress: "203.0.113.8", userAgent: "probe", retentionClass: "standard", createdAt: daysAgo(200) },
            { id: "tac4453-prune", action: "tac4453.retention", retentionClass: "diagnostic_high_volume", createdAt: daysAgo(200), expiresAt: daysAgo(1) },
            { id: "tac4453-keep", action: "tac4453.retention", ipAddress: "203.0.113.9", retentionClass: "standard", createdAt: daysAgo(1) },
          ],
        });
      }

      it("runs the real retention job: anonymises and prunes AuditLog through AUDIT_RETENTION_DATABASE_URL", async () => {
        await seedRetentionRows();
        const { runAuditLogRetentionJob } = await import("@/lib/audit-retention");
        const result = await runAuditLogRetentionJob({
          now,
          retentionDatabaseUrl: urlFor(DATABASES.upgrade, "auditRetention"),
          archiveDatabaseUrl: null,
        });
        expect(result.requestData.anonymized).toBeGreaterThanOrEqual(1);
        expect(result.mainPrune.deleted).toBeGreaterThanOrEqual(1);

        const rows = await appPrisma.auditLog.findMany({
          where: { action: "tac4453.retention" },
          select: { id: true, ipAddress: true, userAgent: true },
          orderBy: { id: "asc" },
        });
        expect(rows).toEqual([
          { id: "tac4453-anonymise", ipAddress: null, userAgent: null },
          { id: "tac4453-keep", ipAddress: "203.0.113.9", userAgent: null },
        ]);
      });

      it("fails closed on the application role's own client, which may not change audit rows", async () => {
        await appPrisma.auditLog.create({
          data: { action: "tac4453.retention.app", ipAddress: "203.0.113.10", createdAt: daysAgo(200) },
        });
        const { runAuditLogRetentionJob } = await import("@/lib/audit-retention");
        await expect(
          runAuditLogRetentionJob({ now, db: appPrisma, archiveDatabaseUrl: null }),
        ).rejects.toThrow(/permission denied|42501/i);
      });

      it("may clear request data but never set it: the AuditLog trigger refuses, whoever asks (S-F4)", async () => {
        const target = await appPrisma.auditLog.create({ data: { action: "tac4453.forge", ipAddress: "203.0.113.11", userAgent: "probe" } });
        for (const role of ["auditRetention", undefined] as const) {
          await withClient(urlFor(DATABASES.upgrade, role), async (client) => {
            await client.query("BEGIN");
            expect(await sqlstate(client, `UPDATE "AuditLog" SET "ipAddress" = '198.51.100.1' WHERE "id" = $1`, [target.id])).toBe(CHECK_VIOLATION);
            expect(await sqlstate(client, `UPDATE "AuditLog" SET "userAgent" = 'forged' WHERE "id" = $1`, [target.id])).toBe(CHECK_VIOLATION);
            expect(await sqlstate(client, `UPDATE "AuditLog" SET "ipAddress" = NULL, "userAgent" = NULL WHERE "id" = $1`, [target.id])).toBe("ok");
            await client.query("ROLLBACK");
          });
        }
      });

      it("can do nothing else: no INSERT, no other column, no other table", async () => {
        await withClient(urlFor(DATABASES.upgrade, "auditRetention"), async (client) => {
          await client.query("BEGIN");
          const refused = [
            `INSERT INTO "AuditLog" ("id", "action") VALUES ('tac4453-forged', 'x')`,
            `UPDATE "AuditLog" SET "summary" = 'rewritten' WHERE false`,
            `UPDATE "AuditLog" SET "action" = 'rewritten' WHERE false`,
            `TRUNCATE "AuditLog"`,
            `SELECT 1 FROM "BookingLedgerLine" LIMIT 1`,
            `DELETE FROM "BookingLedgerLine" WHERE false`,
            `SELECT 1 FROM "Member" LIMIT 1`,
            `UPDATE "Booking" SET "finalPriceCents" = 0 WHERE false`,
            `CREATE TABLE "Tac4453RetentionEscape" ("id" INT)`,
          ];
          for (const sql of refused) {
            expect(await sqlstate(client, sql), sql).toBe(INSUFFICIENT_PRIVILEGE);
          }
          expect(await sqlstate(client, `UPDATE "AuditLog" SET "ipAddress" = NULL, "userAgent" = NULL WHERE false`)).toBe("ok");
          expect(await sqlstate(client, `DELETE FROM "AuditLog" WHERE false`)).toBe("ok");
          await client.query("ROLLBACK");
        });
      });
    });

    describe("provisioning", () => {
      it("is idempotent: a second CLI run changes nothing", async () => {
        const before = await privilegeSnapshot(DATABASES.upgrade);
        const rerun = provisionWithCli(DATABASES.upgrade);
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(await privilegeSnapshot(DATABASES.upgrade)).toEqual(before);
      });

      it("repairs drift: a hand-granted UPDATE on the ledger and a membership are revoked by the next run", async () => {
        const before = await privilegeSnapshot(DATABASES.upgrade);
        await withClient(urlFor(DATABASES.upgrade), async (client) => {
          await client.query(`GRANT UPDATE, DELETE ON "BookingLedgerLine" TO "${ROLES.app}"`);
          await client.query(`GRANT UPDATE ("summary") ON "AuditLog" TO "${ROLES.auditRetention}"`);
          await client.query(`GRANT "${ROLES.migrator}" TO "${ROLES.app}"`);
          await client.query(`ALTER TABLE "Member" OWNER TO CURRENT_USER`);
        });
        expect(await privilegeSnapshot(DATABASES.upgrade)).not.toEqual(before);
        const rerun = provisionWithCli(DATABASES.upgrade);
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(await privilegeSnapshot(DATABASES.upgrade)).toEqual(before);
      });

      it("narrows a view over the ledger to SELECT, which the default privileges had made writable (S-F3)", async () => {
        await withClient(urlFor(DATABASES.upgrade, "migrator"), (client) =>
          client.query(`CREATE VIEW "Tac4453LedgerView" AS SELECT * FROM "BookingLedgerLine"`),
        );
        const writeThroughView = () =>
          withClient(urlFor(DATABASES.upgrade, "app"), async (client) => {
            await client.query("BEGIN");
            const code = await sqlstate(client, `UPDATE "Tac4453LedgerView" SET "narration" = 'rewritten'`);
            await client.query("ROLLBACK");
            return code;
          });
        // The hole the review reproduced: a new view gets the default table grants.
        expect(await writeThroughView()).toBe("ok");
        // The deploy script's post-migrate check would stop a deploy here.
        expect(deployGrantsCheck(DATABASES.upgrade)).toBe("Tac4453LedgerView");

        const rerun = provisionWithCli(DATABASES.upgrade);
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(await writeThroughView()).toBe(INSUFFICIENT_PRIVILEGE);
        expect(deployGrantsCheck(DATABASES.upgrade)).toBe("");
        await withClient(urlFor(DATABASES.upgrade, "migrator"), (client) => client.query(`DROP VIEW "Tac4453LedgerView"`));
      });

      it("passes the deploy script's post-migrate check, and fails it for a table the superuser made (O-F2)", async () => {
        expect(deployGrantsCheck(DATABASES.upgrade)).toBe("");
        // An extension's own relations keep their owner, as provisioning leaves
        // them: the check must not refuse every deploy because of one (N3).
        await withClient(urlFor(DATABASES.upgrade), (client) => client.query(`CREATE EXTENSION IF NOT EXISTS pg_buffercache`));
        const rerun = provisionWithCli(DATABASES.upgrade);
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(deployGrantsCheck(DATABASES.upgrade)).toBe("");
        await withClient(urlFor(DATABASES.upgrade), (client) => client.query(`DROP EXTENSION pg_buffercache`));
        await withClient(urlFor(DATABASES.upgrade), (client) => client.query(`CREATE TABLE "Tac4453HandMade" ("id" INT)`));
        expect(deployGrantsCheck(DATABASES.upgrade)).toBe("Tac4453HandMade");
        await withClient(urlFor(DATABASES.upgrade), (client) => client.query(`DROP TABLE "Tac4453HandMade"`));
      });

      it("stops within its lock timeout, changing nothing, when a reader holds a table it must hand over (O-F1)", async () => {
        await withClient(urlFor(DATABASES.upgrade), (client) => client.query(`ALTER TABLE "Member" OWNER TO CURRENT_USER`));
        const holder = new Client({ connectionString: urlFor(DATABASES.upgrade) });
        await holder.connect();
        try {
          await holder.query("BEGIN");
          await holder.query(`SELECT 1 FROM "Member" LIMIT 1`);
          const started = process.hrtime.bigint();
          const blocked = provisionWithCli(DATABASES.upgrade);
          expect(blocked.status).toBe(1);
          expect(blocked.stderr).toContain("Retry in a quiet window");
          expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(60_000);
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          await holder.end().catch(() => {});
        }
        const owner = () =>
          withClient(urlFor(DATABASES.upgrade), (client) =>
            client.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = '"Member"'::regclass`),
          );
        expect((await owner()).rows[0].owner).not.toBe(ROLES.migrator);
        const retried = provisionWithCli(DATABASES.upgrade);
        expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
        expect((await owner()).rows[0].owner).toBe(ROLES.migrator);
      });

      it("refuses to commit when the application role could still change a ledger line", async () => {
        const statements = buildDatabaseRolesSql({
          databaseName: DATABASES.upgrade,
          migrator: { roleName: ROLES.migrator, password: PASSWORDS.migrator },
          app: { roleName: ROLES.app, password: PASSWORDS.app },
          auditRetention: { roleName: ROLES.auditRetention, password: PASSWORDS.auditRetention },
        });
        const verification = statements.at(-1)!;
        await withClient(urlFor(DATABASES.upgrade), async (client) => {
          for (const breach of [
            `GRANT UPDATE ON "BookingLedgerLine" TO PUBLIC`,
            `GRANT DELETE ON "AuditLog" TO "${ROLES.app}"`,
            `GRANT UPDATE ("summary") ON "AuditLog" TO "${ROLES.auditRetention}"`,
            `GRANT SELECT ON "Member" TO "${ROLES.auditRetention}"`,
            `GRANT "${ROLES.migrator}" TO "${ROLES.app}"`,
            `ALTER ROLE "${ROLES.app}" CREATEROLE`,
            // S-F3: a view the app may write through, and a SECURITY DEFINER routine.
            `CREATE VIEW "Tac4453Breach" AS SELECT * FROM "BookingLedgerLine"; GRANT UPDATE ON "Tac4453Breach" TO "${ROLES.app}"`,
            `CREATE FUNCTION tac4453_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
            // O-F8: a migrated schema missing an append-only relation.
            `ALTER TABLE "AuditLog" RENAME TO "Tac4453AuditLogMoved"`,
            // N10: a database still on a release before the current append-only schema.
            `DROP TABLE "BookingLedgerLine" CASCADE; DELETE FROM "_prisma_migrations" WHERE migration_name = '${APPEND_ONLY_SCHEMA_MIGRATION}'`,
          ]) {
            await client.query("BEGIN");
            await client.query(breach);
            await expect(client.query(verification), breach).rejects.toThrow(
              breach.startsWith("DROP TABLE") ? /older release\. Deploy this release's migrations first/ : /Refusing to commit/,
            );
            await client.query("ROLLBACK");
          }
          // And the same statement commits cleanly on the provisioned state.
          await client.query("BEGIN");
          await client.query(verification);
          await client.query("ROLLBACK");
        });
      });

      it("leaves the AI Diagnostics SELECT-only role exactly as it was", async () => {
        expect(await diagnosticsPrivileges(DATABASES.upgrade)).toEqual(diagnosticsBefore);
      });
    });
  },
);

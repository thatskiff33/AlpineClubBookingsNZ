/**
 * Real-PostgreSQL PRIVILEGE PROOF for the AI Diagnostics SELECT-only database
 * role (AID-5, #2374; contract in ADR-007).
 *
 * WHY MOCKS ARE NOT ENOUGH, stated plainly because the issue makes this proof
 * mandatory: every claim ADR-007 makes is a claim about PostgreSQL's own
 * behaviour. "The role cannot INSERT", "it cannot CREATE TEMP TABLE", "it cannot
 * read `IntegrationCredential`", "a READ ONLY transaction refuses a write even
 * when the grant exists", "a long query is cancelled" — none of those can be
 * demonstrated by a fake. A unit test can only prove we ASKED for the right
 * thing; this suite proves the database AGREED.
 *
 * IT PROVES THE SHIPPED SQL. The role is created here by running
 * `buildAiDiagnosticsRoleSql` — the exact statement list
 * `npm run diagnostics:provision-role` executes for an operator — not a
 * hand-written fixture. A test fixture that re-declared its own grants would
 * prove nothing about what operators run.
 *
 * SAFETY ENVELOPE, the same as the sibling harnesses. OFF by default and a no-op
 * in ordinary `npm test`:
 *   - The proof describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`; otherwise
 *     it is `describe.skip` and never imports `pg` or connects to anything.
 *   - It reads ONLY `CONCURRENCY_RACE_DATABASE_URL` and requires a loopback host,
 *     port 55442+, and the dedicated `concurrency_race_1881` database marker.
 *   - Hosted CI runs it by importing this file from
 *     `concurrency-lock-races.realdb.test.ts`, which supplies that dedicated
 *     localhost database with every migration already deployed. The CI step is
 *     pinned by `review-findings-contracts.test.ts`, so the suite cannot be
 *     silently unplugged.
 *
 * It needs the migrations deployed, because the strongest single assertion here is
 * that the real `IntegrationCredential` table — the encrypted credential store —
 * is unreadable by this role.
 *
 * To run it directly against a throwaway Docker Postgres:
 *   docker run -d --name aid5-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
 *     -p 127.0.0.1:55442:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     npx prisma migrate deploy
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     npx vitest run src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "./helpers/clock";
import { collectStatementColumnReads } from "./helpers/diagnostics-statement-reads";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/** The role this suite provisions. Deliberately not the default production name. */
const TEST_ROLE = "aid5_privilege_probe_ro";
const TEST_ROLE_PASSWORD = "aid5-privilege-proof-password-not-a-secret";
/** A table the role IS granted SELECT on, to prove read-vs-write asymmetry. */
const GRANTED_TABLE = "aid5_privilege_granted";
/** A table the role is granted INSERT on, to prove READ ONLY refuses it anyway. */
const WRITABLE_TABLE = "aid5_privilege_writable";
/** A table the role is granted nothing on, to prove the allowlist is closed. */
const UNGRANTED_TABLE = "aid5_privilege_ungranted";
/**
 * An ORDINARY, non-superuser role standing in for a deployment's application role —
 * the thing an operator actually reaches for when a diagnostics read fails
 * (`GRANT tac_app TO ai_diagnostics_ro`) and the one no list of predefined role names
 * can anticipate.
 */
const APP_LIKE_ROLE = "aid5_probe_app_like";
/** Granted to `APP_LIKE_ROLE`, so membership has to be counted through a chain. */
const GROUP_LIKE_ROLE = "aid5_probe_group_like";
/**
 * A role that makes a grant the PROVISIONER did not make. PostgreSQL records a
 * membership per grantor, and a REVOKE without `GRANTED BY` removes only the current
 * role's own grant — so a suite where the provisioner grants everything itself cannot
 * reach the case where the sweep silently strips nothing.
 */
const DEPLOYER_ROLE = "aid5_probe_deployer";

function quoteTestRoleIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** PostgreSQL SQLSTATEs this suite asserts on. */
const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_TRANSACTION = "25006";
const QUERY_CANCELED = "57014";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the shared race-harness database
 * marker — the same envelope as `assertSafeRaceDbUrl` in
 * `concurrency-lock-races.realdb.test.ts`, re-declared here so this file can be
 * run standalone without importing (and re-registering) that whole harness.
 */
export function assertSafePrivilegeProofDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Diagnostics privilege proof needs a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run the diagnostics privilege proof against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Diagnostics privilege proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Diagnostics privilege proof DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

describe("diagnostics privilege proof DB safety guard (#2374)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafePrivilegeProofDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafePrivilegeProofDbUrl(url)).toThrow();
  });

  it("keeps known-password role cleanup explicit and fail-closed", () => {
    const source = readFileSync(import.meta.filename, "utf8");
    const cleanupStart = source.lastIndexOf("    afterAll(async () => {");
    expect(cleanupStart).toBeGreaterThan(0);
    const cleanupSource = source.slice(cleanupStart);
    const closePool = cleanupSource.indexOf(
      'cleanupStep("close diagnostics pool"',
    );
    const terminate = cleanupSource.indexOf("pg_catalog.pg_terminate_backend");
    const revokeMemberships = cleanupSource.indexOf(
      "pg_catalog.pg_auth_members edge",
    );
    const dropOwned = cleanupSource.indexOf(
      "DROP OWNED BY ${quoteTestRoleIdentifier(role)}",
    );
    const dropRole = cleanupSource.indexOf(
      "DROP ROLE ${quoteTestRoleIdentifier(role)}",
    );
    const proveAbsent = cleanupSource.indexOf("still exists after DROP ROLE");

    expect(closePool).toBeGreaterThan(0);
    expect(terminate).toBeGreaterThan(closePool);
    expect(revokeMemberships).toBeGreaterThan(terminate);
    expect(dropOwned).toBeGreaterThan(revokeMemberships);
    expect(dropRole).toBeGreaterThan(dropOwned);
    expect(proveAbsent).toBeGreaterThan(dropRole);
    expect(cleanupSource).toContain(
      "AI Diagnostics real-PostgreSQL cleanup failed",
    );
  });
});

(RUN ? describe : describe.skip)(
  "AI Diagnostics SELECT-only role — real PostgreSQL privilege proof (#2374)",
  () => {
    type PgClient = import("pg").Client;

    let PgClientCtor: typeof import("pg").Client;
    let buildAiDiagnosticsRoleSql: typeof import("@/lib/diagnostics/tools/provision-role")["buildAiDiagnosticsRoleSql"];
    let FORBIDDEN_PREDEFINED_ROLES: typeof import("@/lib/diagnostics/tools/provision-role")["FORBIDDEN_PREDEFINED_ROLES"];
    let SELECT_GRANTS: typeof import("@/lib/diagnostics/tools/provision-role")["SELECT_GRANTS"];
    let FORBIDDEN_SERVER_FILE_FUNCTIONS: typeof import("@/lib/diagnostics/tools/database")["FORBIDDEN_SERVER_FILE_FUNCTIONS"];
    let getDiagnosticsDatabase: typeof import("@/lib/diagnostics/tools/database")["getDiagnosticsDatabase"];
    let closeDiagnosticsDatabase: typeof import("@/lib/diagnostics/tools/database")["closeDiagnosticsDatabase"];
    let runDiagnosticsReadOnlyQuery: typeof import("@/lib/diagnostics/tools/database")["runDiagnosticsReadOnlyQuery"];
    let DIAGNOSTICS_TOOLS: typeof import("@/lib/diagnostics/tools/registry")["DIAGNOSTICS_TOOLS"];
    let DIAGNOSTICS_TOOL_BOUNDS: typeof import("@/lib/diagnostics/tools/types")["DIAGNOSTICS_TOOL_BOUNDS"];

    let admin: PgClient;
    let roleUrl: string;
    let databaseName: string;
    let adminRole: string;
    /**
     * Whether PUBLIC held TEMPORARY on the scratch database BEFORE this suite ran.
     *
     * Recorded rather than assumed, because the cleanup below used to
     * unconditionally `GRANT TEMPORARY ... TO PUBLIC` on the way out. On a database
     * where PUBLIC did not have it, that hands back a privilege the operator had
     * deliberately removed — a test tidying up by widening the thing this very
     * suite exists to prove is narrow. `null` means the state was never observed
     * (the suite failed before it could ask), and the cleanup then changes nothing.
     */
    let publicHadTemporaryBefore: boolean | null = null;

    /**
     * Run one statement as the restricted role and return the SQLSTATE, or null
     * when it succeeded.
     *
     * `disableReadOnlyDefault` matters for the privilege matrix below. The role
     * carries `default_transaction_read_only = on`, so a write attempt would
     * normally be refused with 25006 (read-only transaction) BEFORE the privilege
     * check ever ran — which would make a "cannot INSERT" assertion pass even if
     * the role held INSERT. Turning the read-only default off for the session
     * strips that layer away so the assertion proves the GRANT layer specifically.
     * The transaction layer is then proven separately, on a table the role
     * deliberately CAN write.
     */
    async function sqlStateAsRole(
      sql: string,
      options: {
        readOnlyTransaction?: boolean;
        disableReadOnlyDefault?: boolean;
      } = {},
    ): Promise<string | null> {
      const client = new PgClientCtor({ connectionString: roleUrl });
      await client.connect();
      try {
        if (options.disableReadOnlyDefault) {
          await client.query("SET default_transaction_read_only = off");
        }
        if (options.readOnlyTransaction) await client.query("BEGIN READ ONLY");
        await client.query(sql);
        if (options.readOnlyTransaction) await client.query("COMMIT");
        return null;
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        return code || "unknown";
      } finally {
        await client.end().catch(() => {});
      }
    }

    async function provision(): Promise<void> {
      /**
       * OBSERVE PUBLIC's TEMPORARY grant BEFORE the provisioner revokes it, so the
       * cleanup can restore exactly what existed rather than granting it back
       * unconditionally. Recorded once: `provision()` runs more than once in this
       * suite, and the state that matters is the one before the FIRST revoke.
       */
      if (publicHadTemporaryBefore === null) {
        const before = await admin.query(
          `SELECT pg_catalog.has_database_privilege('public', current_database(), 'TEMPORARY') AS temp`,
        );
        publicHadTemporaryBefore = before.rows[0]?.temp === true;
      }
      const statements = buildAiDiagnosticsRoleSql({
        roleName: TEST_ROLE,
        password: TEST_ROLE_PASSWORD,
        databaseName,
        preserveTempForRoles: [adminRole],
        statementTimeoutMs: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
        connectionLimit: 6,
      });
      await admin.query("BEGIN");
      try {
        for (const statement of statements) await admin.query(statement);
        await admin.query("COMMIT");
      } catch (err) {
        // ROLLBACK so the SHARED admin client stays usable. The statement list can
        // legitimately fail — the membership sweep raises rather than committing a
        // role it could not fully strip — and an aborted transaction left open would
        // make every later query in this suite fail with 25P02 instead of reporting
        // its own result, turning one real failure into thirty misleading ones.
        await admin.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }

    /**
     * The two grants this suite adds on top of the shipped (empty) allowlist: SELECT
     * on one scratch table, and a deliberately over-granted SELECT+INSERT on another
     * so the READ ONLY transaction can be shown refusing a write the GRANT allows.
     */
    async function grantScratchPrivileges(): Promise<void> {
      await admin.query(
        `GRANT SELECT ON public.${GRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON public.${WRITABLE_TABLE} TO "${TEST_ROLE}"`,
      );
    }

    /**
     * Run `fn` with those grants STRIPPED, so the role is exactly the shape an
     * operator's provisioning leaves behind.
     *
     * Both grants are things the runtime self-check now refuses — any write
     * privilege on any relation, and any readable relation the declared allowlist
     * does not name — which is the check doing its job. So the tests that need an
     * ACCEPTED pool run against the declared shape, and the tests that need the
     * over-grants keep them. The cached verdict is dropped on the way in and out,
     * because it is cached per pool for up to `rolePrivilegeTtlMs`.
     */
    async function withDeclaredGrantsOnly<T>(fn: () => Promise<T>): Promise<T> {
      await admin.query(
        `REVOKE ALL PRIVILEGES ON public.${GRANTED_TABLE} FROM "${TEST_ROLE}"`,
      );
      await admin.query(
        `REVOKE ALL PRIVILEGES ON public.${WRITABLE_TABLE} FROM "${TEST_ROLE}"`,
      );
      await closeDiagnosticsDatabase();
      try {
        return await fn();
      } finally {
        await grantScratchPrivileges();
        await closeDiagnosticsDatabase();
      }
    }

    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing pg or any app module.
      assertSafePrivilegeProofDbUrl(RACE_DB_URL);
      const parsed = new URL(RACE_DB_URL);
      databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      adminRole = decodeURIComponent(parsed.username);
      publicHadTemporaryBefore = null;

      ({ Client: PgClientCtor } = await import("pg"));
      ({ buildAiDiagnosticsRoleSql, FORBIDDEN_PREDEFINED_ROLES, SELECT_GRANTS } =
        await import("@/lib/diagnostics/tools/provision-role"));
      ({ FORBIDDEN_SERVER_FILE_FUNCTIONS } = await import(
        "@/lib/diagnostics/tools/database"
      ));
      ({ DIAGNOSTICS_TOOL_BOUNDS } = await import(
        "@/lib/diagnostics/tools/types"
      ));

      admin = new PgClientCtor({ connectionString: RACE_DB_URL });
      await admin.connect();

      // The migrations must be deployed: the headline assertion below is that the
      // real encrypted credential store is unreadable by this role.
      const credentialTable = await admin.query(
        `SELECT to_regclass('public."IntegrationCredential"') IS NOT NULL AS present`,
      );
      expect(
        credentialTable.rows[0]?.present,
        'The privilege proof needs the schema deployed — run `npx prisma migrate deploy` against CONCURRENCY_RACE_DATABASE_URL first (CI does this in the "Migrate dedicated advisory-lock race database" step).',
      ).toBe(true);

      for (const table of [GRANTED_TABLE, WRITABLE_TABLE, UNGRANTED_TABLE]) {
        await admin.query(`DROP TABLE IF EXISTS public.${table}`);
        await admin.query(
          `CREATE TABLE public.${table} (id integer PRIMARY KEY, note text)`,
        );
        await admin.query(
          `INSERT INTO public.${table} (id, note) VALUES (1, 'seed')`,
        );
      }

      await provision();

      // The grants a tool pack (AID-6A/B/C) would add for its own table, applied
      // here so the proof can show SELECT works while every write does not — plus a
      // deliberate over-grant of INSERT, which exists ONLY so the suite can prove the
      // READ ONLY transaction refuses a write the GRANT allows.
      await grantScratchPrivileges();

      roleUrl = `postgresql://${TEST_ROLE}:${encodeURIComponent(TEST_ROLE_PASSWORD)}@${parsed.host}/${encodeURIComponent(databaseName)}`;

      // Point the app modules at the two roles: the application (superuser) URL
      // and the restricted diagnostics URL. `getDiagnosticsDatabase` refuses when
      // they name the same role, which is the case this separation avoids.
      process.env.DATABASE_URL = RACE_DB_URL;
      process.env.AI_DIAGNOSTICS_DATABASE_URL = roleUrl;
      ({
        getDiagnosticsDatabase,
        closeDiagnosticsDatabase,
        runDiagnosticsReadOnlyQuery,
      } = await import("@/lib/diagnostics/tools/database"));
      ({ DIAGNOSTICS_TOOLS } = await import("@/lib/diagnostics/tools/registry"));
    }, 120_000);

    afterAll(async () => {
      const cleanupErrors: string[] = [];
      const cleanupStep = async (
        label: string,
        action: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          await action();
        } catch (err) {
          cleanupErrors.push(
            `${label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // Close the restricted pool FIRST. A checked-out known-password session is a
      // dependency of the role and makes DROP ROLE fail; a client timeout is not a
      // substitute for actually closing it.
      if (typeof closeDiagnosticsDatabase === "function") {
        await cleanupStep("close diagnostics pool", closeDiagnosticsDatabase);
      }

      // Release any transaction/SET ROLE state on the suite client, then close it.
      // Cleanup uses a new superuser connection so a failed test cannot leave this
      // client aborted or impersonating one of the roles it must remove.
      if (typeof admin !== "undefined") {
        await cleanupStep("rollback suite admin transaction", async () => {
          await admin.query("ROLLBACK");
        });
        await cleanupStep("reset suite admin role", async () => {
          await admin.query("RESET ROLE");
        });
        await cleanupStep("close suite admin connection", async () => {
          await admin.end();
        });
      }

      let cleanupAdmin: PgClient | undefined;
      if (typeof PgClientCtor !== "undefined") {
        await cleanupStep("open isolated cleanup connection", async () => {
          assertSafePrivilegeProofDbUrl(RACE_DB_URL);
          cleanupAdmin = new PgClientCtor({ connectionString: RACE_DB_URL });
          await cleanupAdmin.connect();
        });
      }

      if (cleanupAdmin) {
        const removeRole = async (role: string): Promise<void> => {
          const roleExists = await cleanupAdmin!.query(
            `SELECT EXISTS (
               SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1
             ) AS present`,
            [role],
          );
          if (!roleExists.rows[0]?.present) return;

          // No session may retain the known password while cleanup proceeds.
          await cleanupAdmin!.query(
            `SELECT pg_catalog.pg_terminate_backend(pid)
             FROM pg_catalog.pg_stat_activity
             WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()`,
            [role],
          );

          // Remove memberships in BOTH directions and name the original grantor.
          // PostgreSQL records one row per grantor; a bare REVOKE can otherwise
          // report success while another grantor's membership survives.
          const memberships = await cleanupAdmin!.query(
            `SELECT granted.rolname AS granted_role,
                    member.rolname  AS member_role,
                    grantor.rolname AS grantor_role
             FROM pg_catalog.pg_auth_members edge
             JOIN pg_catalog.pg_roles granted ON granted.oid = edge.roleid
             JOIN pg_catalog.pg_roles member  ON member.oid  = edge.member
             JOIN pg_catalog.pg_roles grantor ON grantor.oid = edge.grantor
             WHERE granted.rolname = $1 OR member.rolname = $1`,
            [role],
          );
          for (const edge of memberships.rows) {
            await cleanupAdmin!.query(
              `REVOKE ${quoteTestRoleIdentifier(String(edge.granted_role))} ` +
                `FROM ${quoteTestRoleIdentifier(String(edge.member_role))} ` +
                `GRANTED BY ${quoteTestRoleIdentifier(String(edge.grantor_role))}`,
            );
          }

          const membershipResidue = await cleanupAdmin!.query(
            `SELECT count(*)::int AS remaining
             FROM pg_catalog.pg_auth_members edge
             JOIN pg_catalog.pg_roles granted ON granted.oid = edge.roleid
             JOIN pg_catalog.pg_roles member  ON member.oid  = edge.member
             WHERE granted.rolname = $1 OR member.rolname = $1`,
            [role],
          );
          if (membershipResidue.rows[0]?.remaining !== 0) {
            throw new Error(`${role} still has role-membership dependencies`);
          }

          // Required even when the role owns no object today: this drops its
          // grants/dependencies in the scratch database before the cluster role.
          await cleanupAdmin!.query(
            `DROP OWNED BY ${quoteTestRoleIdentifier(role)}`,
          );
          await cleanupAdmin!.query(`DROP ROLE ${quoteTestRoleIdentifier(role)}`);

          const absent = await cleanupAdmin!.query(
            `SELECT NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1
             ) AS absent`,
            [role],
          );
          if (!absent.rows[0]?.absent) {
            throw new Error(`${role} still exists after DROP ROLE`);
          }
        };

        for (const table of [GRANTED_TABLE, WRITABLE_TABLE, UNGRANTED_TABLE]) {
          await cleanupStep(`drop scratch table ${table}`, async () => {
            await cleanupAdmin!.query(`DROP TABLE IF EXISTS public.${table}`);
          });
        }
        // Leave the shared scratch database's PUBLIC TEMP grant EXACTLY as it was
        // before this suite, so later isolated suites are not coupled to our
        // provisioner — and so a database where PUBLIC deliberately does NOT hold
        // TEMPORARY does not have it handed back by a test. Restoring
        // unconditionally was the defect: the one privilege this suite proves the
        // provisioner revokes is the one the cleanup would re-grant to everybody.
        if (databaseName && publicHadTemporaryBefore === true) {
          await cleanupStep("restore PUBLIC TEMPORARY", async () => {
            await cleanupAdmin!.query(
              `GRANT TEMPORARY ON DATABASE ${quoteTestRoleIdentifier(databaseName)} TO PUBLIC`,
            );
          });
        } else if (databaseName && publicHadTemporaryBefore === false) {
          await cleanupStep("leave PUBLIC TEMPORARY revoked", async () => {
            // Nothing to do, and saying so is the point: the state we found is the
            // state we leave. Asserted rather than assumed, because a silent
            // no-op here and a silent GRANT look identical in a cleanup log.
            const after = await cleanupAdmin!.query(
              `SELECT pg_catalog.has_database_privilege('public', current_database(), 'TEMPORARY') AS temp`,
            );
            if (after.rows[0]?.temp === true) {
              throw new Error(
                "cleanup left PUBLIC holding TEMPORARY on a database that did not have it",
              );
            }
          });
        }

        // Main role first while every possible membership grantor still exists.
        // This is the known-password role; failure to remove it fails the suite.
        await cleanupStep(`remove ${TEST_ROLE}`, () => removeRole(TEST_ROLE));
        for (const role of [APP_LIKE_ROLE, GROUP_LIKE_ROLE, DEPLOYER_ROLE]) {
          await cleanupStep(`remove ${role}`, () => removeRole(role));
        }
        await cleanupStep("close isolated cleanup connection", async () => {
          await cleanupAdmin!.end();
        });
      }

      if (cleanupErrors.length > 0) {
        throw new Error(
          `AI Diagnostics real-PostgreSQL cleanup failed:\n${cleanupErrors.join("\n")}`,
        );
      }
    }, 120_000);

    // ---------------------------------------------------------------------
    // 1. The role's own attributes and database/schema privileges
    // ---------------------------------------------------------------------

    it("creates a NON-SUPERUSER role with no DDL, replication or RLS-bypass attribute", async () => {
      const result = await admin.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin, rolconnlimit
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_ROLE],
      );
      const role = result.rows[0];
      expect(role).toBeDefined();
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolreplication).toBe(false);
      expect(role.rolbypassrls).toBe(false);
      // NOINHERIT: a future accidental role grant does not silently take effect.
      expect(role.rolinherit).toBe(false);
      expect(role.rolcanlogin).toBe(true);
      expect(role.rolconnlimit).toBeGreaterThan(0);
    });

    it("denies TEMP and CREATE on the database, and CREATE on schema public", async () => {
      const result = await admin.query(
        `SELECT
           pg_catalog.has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
           pg_catalog.has_database_privilege($1, current_database(), 'CREATE')    AS create_db,
           pg_catalog.has_database_privilege($1, current_database(), 'CONNECT')   AS connect,
           pg_catalog.has_schema_privilege($1, 'public', 'CREATE')                AS create_schema,
           pg_catalog.has_schema_privilege($1, 'public', 'USAGE')                 AS usage_schema`,
        [TEST_ROLE],
      );
      const p = result.rows[0];
      expect(p.temp).toBe(false);
      expect(p.create_db).toBe(false);
      expect(p.create_schema).toBe(false);
      // It must still be able to connect and to name relations.
      expect(p.connect).toBe(true);
      expect(p.usage_schema).toBe(true);
    });

    it("is a member of NO role at all, which is what the runtime gate requires", async () => {
      // The baseline the total-membership gate stands on: a correctly provisioned role
      // belongs to nothing, so requiring zero refuses no valid deployment. Counted the
      // way the self-check counts it — the transitive closure by `MEMBER`, excluding
      // the role's own row, since every role is a member of itself.
      const result = await admin.query(
        `SELECT count(*)::int AS memberships
         FROM pg_catalog.pg_roles other
         WHERE other.rolname <> $1
           AND pg_catalog.pg_has_role($1, other.oid, 'MEMBER')`,
        [TEST_ROLE],
      );
      expect(result.rows[0].memberships).toBe(0);
    });

    it("holds no membership in any privilege-escalating predefined role", async () => {
      // `MEMBER`, not `USAGE`. The role is provisioned NOINHERIT, and for a NOINHERIT
      // role `USAGE` is FALSE while `MEMBER` is TRUE — so the `USAGE` predicate this
      // assertion used to share with the runtime self-check reported zero for a role
      // that HAD been granted `pg_write_all_data` and could reach every table with
      // one `SET ROLE`. On a freshly provisioned role both predicates read zero,
      // which is what made the old assertion a tautology on this axis; the drift case
      // below is the one that distinguishes them.
      const result = await admin.query(
        `SELECT
           count(*) FILTER (WHERE pg_catalog.pg_has_role($1, forbidden.oid, 'MEMBER'))::int AS memberships,
           count(*) FILTER (WHERE pg_catalog.pg_has_role($1, forbidden.oid, 'USAGE'))::int  AS inherited
         FROM pg_catalog.pg_roles forbidden
         WHERE forbidden.rolname = ANY($2::text[])`,
        [TEST_ROLE, [...FORBIDDEN_PREDEFINED_ROLES]],
      );
      expect(result.rows[0].memberships).toBe(0);
      expect(result.rows[0].inherited).toBe(0);
    });

    it("cannot execute ANY overload of a server-file or large-object function", async () => {
      // By NAME across every signature: PostgreSQL ships `pg_read_file(text)`,
      // `(text, bigint, bigint)` and `(text, bigint, bigint, boolean)` as three
      // functions with three ACLs, and EXECUTE on any one of them is enough to read a
      // file under the data directory. A check pinned to one signature is a canary
      // that cannot fire.
      const result = await admin.query(
        `SELECT
           count(*)::int AS overloads,
           count(*) FILTER (
             WHERE pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
           )::int AS executable
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pg_catalog' AND p.proname = ANY($2::text[])`,
        [TEST_ROLE, [...FORBIDDEN_SERVER_FILE_FUNCTIONS]],
      );
      // More overloads than names, which is the whole point of checking by name.
      expect(result.rows[0].overloads).toBeGreaterThan(
        FORBIDDEN_SERVER_FILE_FUNCTIONS.length,
      );
      expect(result.rows[0].executable).toBe(0);

      const other = await admin.query(
        `SELECT pg_catalog.has_function_privilege($1, 'pg_catalog.pg_reload_conf()', 'EXECUTE') AS reload_conf`,
        [TEST_ROLE],
      );
      expect(other.rows[0].reload_conf).toBe(false);
    });

    it("can read nothing on the migrated schema but the declared allowlist", async () => {
      // The property the role is NAMED for, asserted against the real schema rather
      // than inferred from the provisioning statements. The scratch tables this suite
      // grants on are excluded from both counts.
      //
      // The relations `SELECT_GRANTS` declares — which AID-6A (#2375) makes non-empty
      // for the first time: `AuditLog`, by column, for the audit-correlation tools —
      // are excluded from the READABLE count only, deliberately. They are allowed to
      // be readable and nothing else, so keeping them inside the WRITABLE count is
      // what proves a declared relation did not also pick up a write privilege on the
      // way in. Excluding them from both would have made this assertion blind to
      // exactly the mistake a new grant can introduce.
      const result = await admin.query(
        `SELECT
           count(*) FILTER (
             WHERE (
                 pg_catalog.has_table_privilege($1, c.oid, 'SELECT')
                 OR pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT')
               )
               AND c.relname <> ALL ($3::text[])
           )::int AS readable,
           count(*) FILTER (
             WHERE pg_catalog.has_table_privilege($1, c.oid, 'INSERT')
               OR pg_catalog.has_table_privilege($1, c.oid, 'UPDATE')
               OR pg_catalog.has_table_privilege($1, c.oid, 'DELETE')
               OR pg_catalog.has_table_privilege($1, c.oid, 'TRUNCATE')
               OR pg_catalog.has_any_column_privilege($1, c.oid, 'INSERT')
               OR pg_catalog.has_any_column_privilege($1, c.oid, 'UPDATE')
           )::int AS writable,
           count(*)::int AS relations
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
           AND c.relname <> ALL ($2::text[])`,
        [
          TEST_ROLE,
          [GRANTED_TABLE, WRITABLE_TABLE, UNGRANTED_TABLE],
          SELECT_GRANTS.map((grant) => grant.relation),
        ],
      );
      // The migrations really are deployed, so "zero readable" is not vacuous.
      expect(result.rows[0].relations).toBeGreaterThan(50);
      expect(result.rows[0].readable).toBe(0);
      expect(result.rows[0].writable).toBe(0);
    });

    it("reads ONLY the declared columns of a column-granted relation", async () => {
      // Every grant is by COLUMN, and this is the assertion that makes that a
      // server-enforced boundary rather than an application one. `AuditLog` carries
      // `ipAddress`, `userAgent`, `summary`, `details`, `metadata` and three
      // member-identifying columns; AID-6C's twelve relations carry raw provider
      // payloads (`XeroInboundEvent."payload"`), raw error text
      // (`PaymentRecoveryOperation."lastError"`), operator free text, payment
      // instruments and — on `Member` — every piece of member PII this platform
      // holds. The tools project none of them, and as this role PostgreSQL itself
      // refuses to return them.
      /**
       * WHAT THIS ASSERTION IS REALLY FOR, restated because it was nearly weakened
       * into a formality.
       *
       * It used to require that EVERY column-granted relation withhold at least one
       * column. That was never the property; it was a PROXY for "the grant is
       * column-scoped rather than whole-table", chosen because a relation with
       * something withheld gives the 42501 loop below something to prove. The proxy
       * breaks on a relation that is simply small: `FamilyGroupMember` has exactly
       * four columns — `id`, `familyGroupId`, `memberId`, `joinedAt` — and
       * `member_family_state` reads all four (the join key, the co-member key, the
       * evidence reference and the joined-at instant). There is no fifth to withhold;
       * notably the relation has NO `role` column, one having been physically dropped
       * by `20260803030000_contract_drop_family_group_member_role`. Narrowing that
       * grant would break the statement, so the proxy — not the grant — is what was
       * wrong, and it is REPLACED here rather than relaxed.
       *
       * WHAT REPLACES IT IS THE PROPERTY ITSELF, IN BOTH DIRECTIONS, asserted against
       * PostgreSQL's own answer and the SHIPPED statements:
       *
       *   this role may read a column  IF AND ONLY IF  some registered
       *   `select_only_sql` statement reads that column.
       *
       * The forward half ("every column a statement reads is granted") is the one a
       * missing grant breaks at runtime with 42501. The reverse half ("every granted
       * column is read by some statement") is the one that was PROMISED by AID-6C's
       * docblock and never implemented — `finance-pack.test.ts` built the set and
       * never asserted on it — behind which the seven granted-but-unread columns
       * named in `provision-role.ts` survived two releases, two of which stopped
       * being harmless the moment AID-6B granted `Booking`.
       * `provision-role.test.ts` asserts both against the DECLARATION
       * on every pull request; this asserts both against the SERVER, so neither half
       * of the claim rests on the other file having run. Both use one shared resolver
       * (`./helpers/diagnostics-statement-reads`) so they cannot drift into answering
       * different questions.
       *
       * That makes "granted in full" self-justifying rather than exempt: a relation
       * can only reach zero withheld columns if a statement reads every one of them.
       * The enumeration below is still required, and is asserted as an exact SET
       * EQUALITY after the loop — so a SECOND relation becoming fully granted fails
       * by name and has to have its argument written down, and an enumerated relation
       * that grows a withheld column fails too. "The census expected zero withheld
       * columns" and "the census silently found zero" stay different outcomes, which
       * is the failure mode the hard-coded column list this loop already replaced
       * once had, and the one an exemption list would quietly re-introduce.
       */
      const GRANTED_IN_FULL = ["FamilyGroupMember"];

      /**
       * Every `Relation.column` any registered SELECT-only statement reads. Taken
       * from the REGISTRY loaded in `beforeAll`, not from a fixture: the credential
       * is one credential, so the union across every pack is the only set a
       * per-column grant can be justified against.
       */
      const statementReads = collectStatementColumnReads(
        DIAGNOSTICS_TOOLS.flatMap((entry) =>
          entry.source === "select_only_sql" ? [entry.sql] : [],
        ),
      );
      // Non-vacuous: an empty or tiny read set would make the reverse direction
      // below pass by finding nothing rather than by the grant being justified.
      expect(statementReads.size).toBeGreaterThan(100);

      /** Relations PostgreSQL reports as having nothing withheld, as measured. */
      const measuredGrantedInFull: string[] = [];

      for (const grant of SELECT_GRANTS) {
        if (grant.columns === undefined) continue;
        const declared = new Set<string>(grant.columns);

        const columns = await admin.query(
          `SELECT a.attname::text AS name,
                  pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'SELECT') AS readable
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_catalog.pg_attribute a
               ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = $2 AND c.relname = $3`,
          [TEST_ROLE, grant.schema, grant.relation],
        );
        // The relation is real and the query found its attributes. Without this a
        // renamed relation returns zero rows and every per-column assertion below
        // iterates nothing — the exact shape of vacuous pass this test exists to
        // refuse.
        expect(
          columns.rows.length,
          `${grant.relation} has no attributes — is it still in the schema?`,
        ).toBeGreaterThan(0);

        // Every DECLARED column exists on the relation. A typo in the allowlist
        // grants nothing, so the tool that needs it fails with 42703 in front of an
        // operator; here it is a named failure instead.
        const attributes = new Set(
          columns.rows.map((row) => String(row.name)),
        );
        expect(
          [...declared].filter((column) => !attributes.has(column)).sort(),
          `${grant.relation} declares columns that do not exist on it`,
        ).toEqual([]);

        // THE BOTH-DIRECTIONS PROPERTY, column by column, as the SERVER answers it.
        //
        // Two independent equalities per column, not one: PostgreSQL agrees with the
        // ALLOWLIST (so provisioning did what it declared), and PostgreSQL agrees
        // with the STATEMENTS (so the allowlist has no reach nobody argued for).
        // Asserting only the first would make this a test of `buildAiDiagnosticsRoleSql`
        // against its own input; asserting only the second would not catch a grant
        // that drifted from the declaration it is reviewed as.
        for (const row of columns.rows) {
          const name = String(row.name);
          const pair = `${grant.relation}.${name}`;
          expect(
            row.readable,
            `${pair} readable=${row.readable}, declared=${declared.has(name)}`,
          ).toBe(declared.has(name));
          expect(
            row.readable,
            row.readable
              ? `${pair} is readable by the diagnostics role and NO registered statement reads it — reach nobody argued for`
              : `${pair} is read by a registered statement and the role may not read it — that statement fails with 42501 in production`,
          ).toBe(statementReads.has(pair));
        }

        // Table-level SELECT is ABSENT, which is exactly why the runtime self-check
        // needs its own column-level count: `has_any_column_privilege` is true here
        // while `has_table_privilege` is false, so a relation-level check cannot tell
        // a column grant from a table grant.
        const tableLevel = await admin.query(
          `SELECT pg_catalog.has_table_privilege($1, $2, 'SELECT') AS table_level,
                  pg_catalog.has_any_column_privilege($1, $2, 'SELECT') AS any_column`,
          [TEST_ROLE, `${grant.schema}."${grant.relation}"`],
        );
        expect(tableLevel.rows[0].table_level).toBe(false);
        expect(tableLevel.rows[0].any_column).toBe(true);

        // And the server refuses the read, not merely the privilege function.
        const allowed = [...declared][0];
        expect(
          await sqlStateAsRole(
            `SELECT "${allowed}" FROM ${grant.schema}."${grant.relation}" LIMIT 1`,
          ),
        ).toBeNull();
        // EVERY un-declared column of THIS relation is refused, derived from the
        // schema rather than from a hard-coded list.
        //
        // The list used to be `["ipAddress", "userAgent", "summary", "metadata"]`,
        // which was AuditLog's shape and only AuditLog's. The moment AID-6C (#2377)
        // granted eleven more relations by column, those names did not exist on any
        // of them and PostgreSQL answered `42703` (undefined column) instead of
        // `42501` — a green-looking assertion that had stopped testing anything on
        // the new relations while failing on the old expectation. Driving it from
        // `pg_attribute` makes it total: `Member."email"`,
        // `XeroInboundEvent."payload"`, `PaymentRecoveryOperation."lastError"` and
        // every other withheld column are each proved refused, and a relation added
        // later inherits the proof.
        const withheldColumns = columns.rows
          .map((row) => String(row.name))
          .filter((name) => !declared.has(name));
        if (withheldColumns.length === 0) {
          measuredGrantedInFull.push(grant.relation);
        }
        for (const withheld of withheldColumns) {
          expect(
            await sqlStateAsRole(
              `SELECT "${withheld}" FROM ${grant.schema}."${grant.relation}" LIMIT 1`,
            ),
            `${grant.relation}.${withheld} must be refused`,
          ).toBe("42501");
        }
        // `SELECT *` is refused too — it expands to every column, including the
        // withheld ones, so a tool that lost its projection could not fall back to
        // it. On a relation with nothing withheld there is nothing for the expansion
        // to reach, so it succeeds; the polarity is taken from what the server just
        // reported rather than from the enumeration, because an unconditional 42501
        // here would be asserting a boundary that does not exist and would fail for
        // the right reason at the wrong relation. Which relations may legitimately be
        // in that state is what the set equality after the loop decides.
        expect(
          await sqlStateAsRole(
            `SELECT * FROM ${grant.schema}."${grant.relation}" LIMIT 1`,
          ),
          `${grant.relation}: SELECT *`,
        ).toBe(withheldColumns.length === 0 ? null : "42501");
      }

      // THE ENUMERATION, AS AN EXACT SET EQUALITY — the tripwire that stops
      // "granted in full" becoming a quiet exemption one relation at a time.
      //
      // A relation newly granted in full fails here by name, and the only way to
      // make it pass is to add it above with the argument for why the relation has
      // no column left to withhold. An enumerated relation that GAINS a withheld
      // column fails too, which is the right signal: a new column appeared on a
      // relation this credential holds entirely, and somebody has to decide whether
      // it should be granted. Neither direction can be satisfied by loosening a
      // comparison, and the per-column equality above has already proved that every
      // column of a fully granted relation is one a shipped statement reads.
      expect(
        measuredGrantedInFull.sort(),
        "a relation is granted in FULL: add it to GRANTED_IN_FULL with the argument for why it has no column left to withhold, or withhold one",
      ).toEqual([...GRANTED_IN_FULL].sort());
      // The timeout is EXPLICIT because this test's cost is proportional to the
      // schema, not to the code: it opens a fresh connection as the restricted role
      // for every withheld column of every granted relation — hundreds of round
      // trips, and one more every time a migration adds a column to a relation the
      // allowlist names. Vitest's 5s default was already marginal before AID-6B
      // added twelve relations, which makes it a flake waiting for a slow runner
      // rather than a bound anybody chose.
    }, 120_000);

    it("re-provisioning REVOKES a hand-widened column grant", async () => {
      // The narrowing direction. PostgreSQL's REVOKE reference states that revoking a
      // privilege on a table also revokes the corresponding column privileges, which
      // is what lets an allowlist entry lose a column in a later release instead of
      // accumulating forever. Proven rather than trusted.
      const grant = SELECT_GRANTS.find((entry) => entry.columns !== undefined);
      expect(grant, "AID-6A declares a column-restricted grant").toBeDefined();
      if (!grant?.columns) return;

      const target = `${grant.schema}."${grant.relation}"`;
      await admin.query(
        `GRANT SELECT ("ipAddress") ON ${target} TO "${TEST_ROLE}"`,
      );
      expect(
        await sqlStateAsRole(`SELECT "ipAddress" FROM ${target} LIMIT 1`),
      ).toBeNull();

      await provision();
      await grantScratchPrivileges();

      expect(
        await sqlStateAsRole(`SELECT "ipAddress" FROM ${target} LIMIT 1`),
      ).toBe("42501");
      expect(
        await sqlStateAsRole(
          `SELECT "${grant.columns[0]}" FROM ${target} LIMIT 1`,
        ),
      ).toBeNull();
    });

    it("REFUSES the role when a column grant widens to the whole relation", async () => {
      // The drift this count exists for. A hand-added table-level grant on a relation
      // the allowlist DOES declare leaves `undeclaredReadableRelations` at zero, so
      // without the column-level count the self-check would accept a role that can
      // read every audit IP address, user agent, summary and member id.
      const grant = SELECT_GRANTS.find((entry) => entry.columns !== undefined);
      if (!grant?.columns) return;
      const target = `${grant.schema}."${grant.relation}"`;

      await withDeclaredGrantsOnly(async () => {
        try {
          await admin.query(`GRANT SELECT ON ${target} TO "${TEST_ROLE}"`);
          await closeDiagnosticsDatabase();
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) {
            expect(handle.reason).toBe("database_role_unsafe");
            expect(handle.report?.undeclaredReadableRelations).toBe(0);
            expect(handle.report?.undeclaredReadableColumns).toBeGreaterThan(0);
            expect(
              handle.report?.tableWideSelectOnColumnRestrictedRelations,
            ).toBe(1);
          }
        } finally {
          // Restore from the reviewed declaration even when GRANT, pool close or
          // an assertion fails midway; no hand-maintained inverse may leak drift.
          await provision();
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES table-wide SELECT when a column declaration currently names every column", async () => {
      const grant = SELECT_GRANTS.find(
        (entry) => entry.relation === "FamilyGroupMember",
      );
      expect(grant?.columns).toBeDefined();
      if (!grant?.columns) return;
      const target = `${grant.schema}."${grant.relation}"`;

      await withDeclaredGrantsOnly(async () => {
        try {
          await admin.query(`GRANT SELECT ON ${target} TO "${TEST_ROLE}"`);
          await closeDiagnosticsDatabase();
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (handle.ok) return;

          expect(handle.reason).toBe("database_role_unsafe");
          expect(handle.report?.undeclaredReadableRelations).toBe(0);
          // FamilyGroupMember currently has no withheld physical column, so the
          // old undeclared-column detector is intentionally silent here.
          expect(handle.report?.undeclaredReadableColumns).toBe(0);
          expect(handle.report?.missingReadableRelations).toBe(0);
          expect(handle.report?.missingReadableColumns).toBe(0);
          expect(
            handle.report?.tableWideSelectOnColumnRestrictedRelations,
          ).toBe(1);
        } finally {
          await provision();
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("may execute no SECURITY DEFINER routine, though PUBLIC gives it EXECUTE on the rest", async () => {
      // The subtlety the provisioning cannot fix: PostgreSQL grants EXECUTE on every
      // new function to PUBLIC, and a PUBLIC grant cannot be revoked for one role, so
      // `REVOKE ALL ON ALL ROUTINES … FROM <role>` is a no-op. What matters is that
      // none of those routines runs with its owner's privileges.
      const result = await admin.query(
        `SELECT
           count(*)::int AS routines,
           count(*) FILTER (
             WHERE pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
           )::int AS executable,
           count(*) FILTER (
             WHERE p.prosecdef
               AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
           )::int AS executable_security_definer
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'`,
        [TEST_ROLE],
      );
      const p = result.rows[0];
      // Documented honestly rather than wished away: the routines ARE executable.
      expect(p.executable).toBe(p.routines);
      expect(p.executable_security_definer).toBe(0);
    });

    it("carries a server-side statement timeout and read-only default of its own", async () => {
      const result = await admin.query(
        `SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_ROLE],
      );
      const config: string[] = result.rows[0].rolconfig ?? [];
      expect(config).toContain("default_transaction_read_only=on");
      expect(config).toContain(
        `statement_timeout=${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}ms`,
      );
      expect(config).toContain("search_path=public");
    });

    // ---------------------------------------------------------------------
    // 2. Read works; every write and every DDL statement FAILS
    // ---------------------------------------------------------------------

    it("can SELECT the one table it was granted", async () => {
      const client = new PgClientCtor({ connectionString: roleUrl });
      await client.connect();
      try {
        const result = await client.query(
          `SELECT id, note FROM public.${GRANTED_TABLE} ORDER BY id`,
        );
        expect(result.rows).toEqual([{ id: 1, note: "seed" }]);
      } finally {
        await client.end();
      }
    });

    it.each([
      ["INSERT", `INSERT INTO public.${GRANTED_TABLE} (id, note) VALUES (99, 'x')`],
      ["UPDATE", `UPDATE public.${GRANTED_TABLE} SET note = 'x' WHERE id = 1`],
      ["DELETE", `DELETE FROM public.${GRANTED_TABLE} WHERE id = 1`],
      ["TRUNCATE", `TRUNCATE public.${GRANTED_TABLE}`],
    ])(
      "is denied the PRIVILEGE to %s the table it can read",
      async (_label, sql) => {
        // Read-only default off, so 42501 (insufficient privilege) is the only
        // refusal available — this asserts the GRANT layer, not the transaction.
        const code = await sqlStateAsRole(sql, { disableReadOnlyDefault: true });
        expect(code).toBe(INSUFFICIENT_PRIVILEGE);
      },
    );

    it.each([
      ["CREATE TABLE", `CREATE TABLE public.aid5_should_not_exist (id int)`],
      ["CREATE TEMP TABLE", `CREATE TEMP TABLE aid5_temp_should_not_exist (id int)`],
      ["CREATE SCHEMA", `CREATE SCHEMA aid5_schema_should_not_exist`],
      ["CREATE INDEX", `CREATE INDEX aid5_idx ON public.${GRANTED_TABLE} (id)`],
      ["ALTER TABLE", `ALTER TABLE public.${GRANTED_TABLE} ADD COLUMN extra text`],
      ["DROP TABLE", `DROP TABLE public.${GRANTED_TABLE}`],
      [
        "CREATE FUNCTION",
        `CREATE FUNCTION public.aid5_fn() RETURNS int AS 'SELECT 1' LANGUAGE sql`,
      ],
      ["CREATE ROLE", `CREATE ROLE aid5_escalated LOGIN`],
      ["ALTER ROLE self SUPERUSER", `ALTER ROLE "${TEST_ROLE}" SUPERUSER`],
    ])("is denied the PRIVILEGE to run DDL: %s", async (_label, sql) => {
      const code = await sqlStateAsRole(sql, { disableReadOnlyDefault: true });
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot grant itself access to a table it may not read", async () => {
      // PostgreSQL answers a GRANT from a role without grant option with a
      // WARNING rather than an error, so the assertion that matters is the
      // OUTCOME: the table is still unreadable afterwards.
      await sqlStateAsRole(
        `GRANT ALL ON public.${UNGRANTED_TABLE} TO "${TEST_ROLE}"`,
        { disableReadOnlyDefault: true },
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    // ---------------------------------------------------------------------
    // 3. The allowlist is closed, and the credential store is out of reach
    // ---------------------------------------------------------------------

    it.each([
      // The two credential surfaces, named individually because they are the ones
      // ADR-007 §1 puts permanently out of scope. `IntegrationCredential` holds
      // encrypted provider secrets; `XeroToken` holds PLAINTEXT Xero OAuth access
      // and refresh tokens. No tool pack may ever grant either.
      ["IntegrationCredential", `SELECT * FROM public."IntegrationCredential" LIMIT 1`],
      ["XeroToken", `SELECT * FROM public."XeroToken" LIMIT 1`],
    ])("cannot read the credential store %s", async (_label, sql) => {
      const code = await sqlStateAsRole(sql);
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      // Relations that carry the domain's own personal and free-text data and that
      // NO tool pack has argued for. `Member` and `Payment` used to be on this list
      // and legitimately left it in AID-6C (#2377) — but by COLUMN, so they are
      // covered by the column-level case below rather than dropped.
      //
      // `Booking` AND `BookingGuest` LEFT THIS LIST IN AID-6B (#2376), the same way
      // and for the same reason: both are now granted BY COLUMN under
      // `bookings:view`, and PostgreSQL permits `count(*)` for a role holding SELECT
      // on ANY column of a relation — so leaving them here would have been a
      // table-shaped assertion failing for a reason that has nothing to do with the
      // boundary that actually matters. Their per-column boundary is asserted in
      // "reads ONLY the declared columns of a column-granted relation" above, which
      // derives every un-declared column from `pg_attribute` and requires 42501 for
      // each, and in the withheld-column case below.
      //
      // WHAT REPLACES THEM has to be relations AID-6B looked at and DECLINED, or the
      // case degrades into naming tables nobody was ever tempted by:
      //  - `MemberCredit`: the credit ledger, read through the authoritative credit
      //    helpers. Unchanged from AID-6C.
      //  - `FamilyGroupJoinRequest`: #2376 reads family STRUCTURE through
      //    `FamilyGroupMember`, and deliberately grants nothing on the REQUEST
      //    relation, which carries the requester's free text and children's dates of
      //    birth. `member_family_state` is the entry that would have used it.
      //  - `MemberInduction`: `member_eligibility_state` reports an induction state,
      //    and reads it through the application's own connection in a `server_owned`
      //    entry rather than by granting the relation — so the SELECT-only credential
      //    must still be refused it.
      //  - `MembershipCancellationRequest`: named by `member_record_audit_history`'s
      //    subject map as an audit ENTITY TYPE. That is a predicate on `AuditLog`,
      //    not a read of the relation, and this asserts the difference.
      ["MemberCredit", `SELECT count(*) FROM public."MemberCredit"`],
      [
        "FamilyGroupJoinRequest",
        `SELECT count(*) FROM public."FamilyGroupJoinRequest"`,
      ],
      ["MemberInduction", `SELECT count(*) FROM public."MemberInduction"`],
      [
        "MembershipCancellationRequest",
        `SELECT count(*) FROM public."MembershipCancellationRequest"`,
      ],
    ])("cannot read the un-granted table %s", async (_label, sql) => {
      const code = await sqlStateAsRole(sql);
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("counts rows on a column-granted relation, but reads no withheld column", async () => {
      // `AuditLog` left the un-granted list when AID-6A (#2375) granted the
      // audit-correlation tools eight of its columns, and `Member` and `Payment`
      // followed in AID-6C (#2377). The distinction is worth pinning rather than
      // deleting a case for: PostgreSQL permits `count(*)` for a role holding SELECT
      // on ANY column of the relation, so a table-shaped assertion would now pass for
      // the wrong reason. The boundary that matters is per COLUMN, and it is the
      // server's own.
      //
      // The withheld names below are spelled out rather than derived — the loop over
      // every relation's every un-declared column lives in "reads ONLY the declared
      // columns" above — because THESE are the ones a reviewer should be able to
      // find by name: the three member references and the free text on `AuditLog`,
      // the member PII on `Member`, the raw payload on `XeroInboundEvent`, and the
      // raw error text on `PaymentRecoveryOperation`.
      //
      // `AuditLog."entityId"` is deliberately NOT here any more. AID-6A withheld it
      // and recorded that per-record evidence was AID-6B/6C work under its own
      // permission and privacy review; AID-6C granted it for
      // `diagnostics.finance_record_audit_history`, which uses it as a PREDICATE
      // against an id the caller already supplied and never projects it.
      for (const [relation, readable, withheldColumns] of [
        [
          "AuditLog",
          "action",
          [
            "memberId",
            "actorMemberId",
            "subjectMemberId",
            "targetId",
            "summary",
            "details",
            "metadata",
            "ipAddress",
            "userAgent",
          ],
        ],
        // `Member`'s withheld set is REWRITTEN BY AID-6B (#2376), not shortened.
        //
        // `email`, `firstName`, `lastName` and `phoneNumber` were here, and #2376's
        // owner decision grants all four: the first three as evidence about a member
        // an operator has already selected, and `phoneNumber` (with `phoneAreaCode`)
        // ONLY so the mobile search has a predicate — no entry projects a phone
        // number, and `member_diagnostic_summary` reports `hasPhone` instead.
        //
        // What replaces them is the class the grant may NEVER reach, named rather
        // than sampled: the two credentials the erasure test compares inside
        // PostgreSQL and never loads, the federated identity, the date of birth
        // (age-based eligibility in this platform is decided on `ageTier`, which IS
        // granted, so the date is not needed), the address, the two lifecycle free-
        // text reasons, the operator's private comments, and the two authorization
        // columns — because a credential that could read `role` or
        // `financeAccessLevel` could enumerate who to attack.
        [
          "Member",
          "xeroContactId",
          [
            "passwordHash",
            "totpSecret",
            "googleSub",
            "dateOfBirth",
            "streetAddressLine1",
            "cancelledReason",
            "archivedReason",
            "comments",
            "role",
            "financeAccessLevel",
          ],
        ],
        // AID-6B's own widest new relations, pinned the same way. `Booking` and
        // `BookingGuest` are granted by column, so what a reviewer should be able to
        // find by name is the free text and the actor ids beside the columns that
        // ARE granted.
        [
          "Booking",
          "status",
          [
            "notes",
            "adminReviewReason",
            "adminReviewNotes",
            "memberReviewJustification",
            "adultMemberHostingReview",
            "deletedReason",
            "deletedById",
            "adminReviewedById",
            "adultMemberHostingReviewedById",
          ],
        ],
        [
          "BookingGuest",
          "ageTier",
          // NOT `consentRespondedByMemberId`: that column IS granted — the consent
          // sub-state entry reads it — and this pin listing it as withheld was the
          // same stale copy review finding [5] caught in the docblock, surfacing
          // here on the suite's first real-PostgreSQL execution. `arrivedAt` is the
          // deliberately-dropped column the allowlist's own comment records.
          ["rateMembershipTypeId", "arrivedAt"],
        ],
        [
          "BookingChangeRequest",
          "status",
          [
            "requestedChanges",
            "proposalSnapshot",
            "frozenEvidence",
            "reason",
            "adminNotes",
            "memberMessage",
            "lastConflictReason",
            "internalNotes",
            "reviewedByMemberId",
          ],
        ],
        [
          "MemberSubscription",
          "status",
          ["manualPaymentNote", "manuallyMarkedPaidByMemberId"],
        ],
        ["BedAllocation", "stayDate", ["approvedByMemberId"]],
        ["LodgeRoom", "name", ["notes"]],
        [
          "Payment",
          "status",
          [
            "manualPaymentNote",
            "stripeCustomerId",
            "stripePaymentMethodId",
            "manuallyMarkedPaidByMemberId",
          ],
        ],
        ["XeroInboundEvent", "status", ["payload", "errorMessage"]],
        [
          "XeroSyncOperation",
          "lastErrorCode",
          ["requestPayload", "responsePayload", "lastErrorMessage"],
        ],
        ["PaymentRecoveryOperation", "attempts", ["lastError", "allocationPlan"]],
        ["RefundRequest", "status", ["memberId", "reason", "adminNotes"]],
        ["WebhookLog", "status", ["error"]],
      ] as const) {
        expect(
          await sqlStateAsRole(`SELECT count(*) FROM public."${relation}"`),
          `${relation} count(*)`,
        ).toBeNull();
        expect(
          await sqlStateAsRole(
            `SELECT "${readable}" FROM public."${relation}" LIMIT 1`,
          ),
          `${relation}.${readable} must be readable`,
        ).toBeNull();
        for (const withheld of withheldColumns) {
          expect(
            await sqlStateAsRole(
              `SELECT "${withheld}" FROM public."${relation}" LIMIT 1`,
            ),
            `${relation}.${withheld} must be refused`,
          ).toBe(INSUFFICIENT_PRIVILEGE);
        }
      }
      // Explicit for the same reason as the derived loop above: fifteen relations
      // times a connection per named column is ~80 round trips, which the 5s
      // default only just covers on a fast runner.
    }, 120_000);

    it("cannot read a table created after provisioning (no default privileges)", async () => {
      const code = await sqlStateAsRole(
        `SELECT count(*) FROM public.${UNGRANTED_TABLE}`,
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("re-running the provisioning statements REVOKES a hand-added grant", async () => {
      await admin.query(
        `GRANT SELECT ON public.${UNGRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBeNull();

      // The declarative reset: the grant allowlist lives in provision-role.ts, so
      // a re-provision strips anything that is not declared there.
      await provision();
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${UNGRANTED_TABLE}`),
      ).toBe(INSUFFICIENT_PRIVILEGE);

      // Re-provisioning is otherwise idempotent: the declared grant survives.
      await admin.query(
        `GRANT SELECT ON public.${GRANTED_TABLE} TO "${TEST_ROLE}"`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON public.${WRITABLE_TABLE} TO "${TEST_ROLE}"`,
      );
      expect(
        await sqlStateAsRole(`SELECT count(*) FROM public.${GRANTED_TABLE}`),
      ).toBeNull();
    });

    // ---------------------------------------------------------------------
    // 4. The READ ONLY transaction is an independent second layer
    // ---------------------------------------------------------------------

    it("refuses an INSERT the GRANT allows, inside a READ ONLY transaction", async () => {
      // This is the layering proof. `WRITABLE_TABLE` is deliberately granted
      // INSERT, so a privilege check alone would let this through; the read-only
      // transaction refuses it anyway (25006). A future tool pack that
      // over-granted by mistake would still be unable to write.
      const code = await sqlStateAsRole(
        `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (2, 'x')`,
        { readOnlyTransaction: true },
      );
      expect(code).toBe(READ_ONLY_TRANSACTION);
    });

    it("refuses that same INSERT with no explicit transaction, from the role default", async () => {
      // `default_transaction_read_only = on` is pinned on the role itself, so a
      // connection that forgot to open a READ ONLY transaction is still read-only.
      const code = await sqlStateAsRole(
        `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (3, 'x')`,
      );
      expect(code).toBe(READ_ONLY_TRANSACTION);
    });

    // ---------------------------------------------------------------------
    // 5. The application's own executor, against the real restricted role
    // ---------------------------------------------------------------------

    it("accepts the provisioned role through the runtime privilege self-check", async () => {
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (handle.ok) expect(handle.roleName).toBe(TEST_ROLE);
      });
    });

    it("REFUSES an under-provisioned declared column through the real runtime check", async () => {
      await withDeclaredGrantsOnly(async () => {
        try {
          await admin.query(
            `REVOKE SELECT ("createdAt") ON public."AuditLog" FROM "${TEST_ROLE}"`,
          );
          await closeDiagnosticsDatabase();
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (handle.ok) return;

          expect(handle.reason).toBe("database_grants_missing");
          expect(handle.report?.missingReadableColumns).toBe(1);
          expect(handle.report?.missingReadableRelations).toBe(0);
          expect(handle.report?.undeclaredReadableRelations).toBe(0);
          expect(handle.report?.undeclaredReadableColumns).toBe(0);
        } finally {
          // Restore the exact shipped declaration before the next test. This is
          // deliberately provisioning, not a hand-written inverse, so the recovery
          // path is proven against the same reviewed allowlist as deployment.
          await provision();
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES a one-column grant for a declared whole relation", async () => {
      await withDeclaredGrantsOnly(async () => {
        // No shipped relation currently uses the whole-relation form. Exercise that
        // supported declaration shape against PostgreSQL anyway: a future entry must
        // require table SELECT, not pass merely because one arbitrary column is
        // readable. Mutating the imported array is a scoped test seam; it is restored
        // in `finally` before any other assertion can observe it.
        const mutableSelectGrants = SELECT_GRANTS as unknown as Array<{
          schema: string;
          relation: string;
          columns?: readonly string[];
        }>;
        const wholeRelationGrant = {
          schema: "public",
          relation: GRANTED_TABLE,
        };
        mutableSelectGrants.push(wholeRelationGrant);
        try {
          await admin.query(
            `GRANT SELECT (id) ON public.${GRANTED_TABLE} TO "${TEST_ROLE}"`,
          );
          await closeDiagnosticsDatabase();
          expect(
            await sqlStateAsRole(`SELECT id FROM public.${GRANTED_TABLE}`),
          ).toBeNull();
          expect(
            await sqlStateAsRole(`SELECT note FROM public.${GRANTED_TABLE}`),
          ).toBe(INSUFFICIENT_PRIVILEGE);

          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (handle.ok) return;

          expect(handle.reason).toBe("database_grants_missing");
          expect(handle.report?.missingReadableRelations).toBe(1);
          expect(handle.report?.missingReadableColumns).toBe(0);
          expect(handle.report?.undeclaredReadableRelations).toBe(0);
          expect(handle.report?.undeclaredReadableColumns).toBe(0);
        } finally {
          // Remove the process-global declaration first. Even a failed cleanup SQL
          // statement must not leave later tests believing the scratch table ships.
          const index = mutableSelectGrants.indexOf(wholeRelationGrant);
          if (index >= 0) mutableSelectGrants.splice(index, 1);
          await admin
            .query(
              `REVOKE ALL PRIVILEGES ON public.${GRANTED_TABLE} FROM "${TEST_ROLE}"`,
            )
            .catch(() => {});
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES the same role the moment it holds a write grant or an undeclared read", async () => {
      // The suite's own scratch grants are exactly the drift the self-check exists to
      // catch: SELECT on a table the declared allowlist does not name, and INSERT on
      // another. Nothing in the runtime path used to ask about a single table
      // privilege, so a role carrying full DML was reported `verified`.
      await closeDiagnosticsDatabase();
      const handle = await getDiagnosticsDatabase();
      expect(handle.ok).toBe(false);
      if (handle.ok) return;
      expect(handle.reason).toBe("database_role_unsafe");
      expect(handle.report?.writableRelations).toBe(1);
      expect(handle.report?.undeclaredReadableRelations).toBe(2);
      // And it is the ONLY thing wrong with it.
      expect(handle.report?.isSuperuser).toBe(false);
      expect(handle.report?.matchesConfiguredRole).toBe(true);
      await closeDiagnosticsDatabase();
    });

    it("REFUSES a hand-granted predefined-role membership a NOINHERIT role hides", async () => {
      await withDeclaredGrantsOnly(async () => {
        // The shortcut an operator reaches for: "let diagnostics read one more
        // table". `pg_has_role(…, 'USAGE')` reports this as ZERO for a NOINHERIT
        // role, so the control written to catch it saw nothing.
        await admin.query(`GRANT pg_read_all_data TO "${TEST_ROLE}"`);
        await closeDiagnosticsDatabase();
        try {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) {
            expect(handle.reason).toBe("database_role_unsafe");
            expect(handle.report?.forbiddenRoleMemberships).toBe(1);
            // And it says WHICH one, so the alert is actionable rather than a count.
            expect(handle.report?.forbiddenRoleNames).toEqual(["pg_read_all_data"]);
          }

          // And the capability is real, not theoretical: the role cannot read the
          // credential store directly, but one `SET ROLE` away it can.
          const client = new PgClientCtor({ connectionString: roleUrl });
          await client.connect();
          try {
            await expect(
              client.query(`SELECT count(*) FROM public."IntegrationCredential"`),
            ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
            await client.query("SET ROLE pg_read_all_data");
            const escalated = await client.query(
              `SELECT count(*)::int AS rows FROM public."IntegrationCredential"`,
            );
            expect(escalated.rows[0].rows).toBeGreaterThanOrEqual(0);
          } finally {
            await client.end().catch(() => {});
          }
        } finally {
          await admin.query(`REVOKE pg_read_all_data FROM "${TEST_ROLE}"`);
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES membership in an ORDINARY role, which nothing else in the report sees", async () => {
      // The symmetric hole the predefined-role list left open. `GRANT <app role> TO
      // <diagnostics role>` is the same operator shortcut as the case above, but the
      // granted role is not one the shipped list can name — and because the role is
      // NOINHERIT the membership is invisible to EVERY other column: `rolsuper` is
      // read for `current_user` only, and the writable/undeclared/server-file counts
      // all use `current_user` ACL functions, which respect `rolinherit`. The total
      // membership count is the only thing that can catch it.
      await withDeclaredGrantsOnly(async () => {
        await admin.query(`CREATE ROLE "${APP_LIKE_ROLE}" NOSUPERUSER`);
        await admin.query(`CREATE ROLE "${GROUP_LIKE_ROLE}" NOSUPERUSER`);
        // What an ordinary application role holds: the encrypted credential store and
        // a table the diagnostics role has no privilege on at all.
        await admin.query(
          `GRANT SELECT ON public."IntegrationCredential" TO "${APP_LIKE_ROLE}"`,
        );
        await admin.query(
          `GRANT INSERT ON public.${UNGRANTED_TABLE} TO "${APP_LIKE_ROLE}"`,
        );
        // A second hop, so the count has to be the transitive closure and not the
        // direct `pg_auth_members` rows.
        await admin.query(`GRANT "${GROUP_LIKE_ROLE}" TO "${APP_LIKE_ROLE}"`);
        await admin.query(`GRANT "${APP_LIKE_ROLE}" TO "${TEST_ROLE}"`);
        await closeDiagnosticsDatabase();
        try {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) {
            expect(handle.reason).toBe("database_role_unsafe");
            // Direct membership plus the one reached through it.
            expect(handle.report?.roleMemberships).toBe(2);
            // Every other column is blind to it, which is the finding in one line.
            expect(handle.report?.forbiddenRoleMemberships).toBe(0);
            expect(handle.report?.isSuperuser).toBe(false);
            expect(handle.report?.canReadServerFiles).toBe(false);
            expect(handle.report?.writableRelations).toBe(0);
            expect(handle.report?.undeclaredReadableRelations).toBe(0);
            expect(handle.report?.matchesConfiguredRole).toBe(true);
          }

          // And the capability is real. As the diagnostics role: refused. One
          // `SET ROLE` later: the credential store, and a write.
          const client = new PgClientCtor({ connectionString: roleUrl });
          await client.connect();
          try {
            await expect(
              client.query(`SELECT count(*) FROM public."IntegrationCredential"`),
            ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
            await client.query(`SET ROLE "${APP_LIKE_ROLE}"`);
            const escalated = await client.query(
              `SELECT count(*)::int AS rows FROM public."IntegrationCredential"`,
            );
            expect(escalated.rows[0].rows).toBeGreaterThanOrEqual(0);
            await client.query("SET default_transaction_read_only = off");
            // No `RETURNING`: that would need SELECT on the returned column, and the
            // point here is the WRITE. The app-like role holds INSERT and nothing else.
            const written = await client.query(
              `INSERT INTO public.${UNGRANTED_TABLE} (id, note) VALUES (42, 'escalated')`,
            );
            expect(written.rowCount).toBe(1);
            // The two-hop role is reachable too, which is why the count is transitive.
            await client.query("RESET ROLE");
            await client.query(`SET ROLE "${GROUP_LIKE_ROLE}"`);
            const reached = await client.query(`SELECT current_user AS whoami`);
            expect(reached.rows[0].whoami).toBe(GROUP_LIKE_ROLE);
          } finally {
            await client.end().catch(() => {});
          }

          // Unlike the SECURITY DEFINER case, re-provisioning DOES repair this: the
          // statement list sweeps every membership, not only the eight it can name.
          await provision();
          await closeDiagnosticsDatabase();
          const afterProvision = await getDiagnosticsDatabase();
          expect(afterProvision.ok).toBe(true);
          const swept = await admin.query(
            `SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS still_member`,
            [TEST_ROLE, APP_LIKE_ROLE],
          );
          expect(swept.rows[0].still_member).toBe(false);
        } finally {
          await admin
            .query(`DELETE FROM public.${UNGRANTED_TABLE} WHERE id = 42`)
            .catch(() => {});
          for (const role of [APP_LIKE_ROLE, GROUP_LIKE_ROLE]) {
            // DROP OWNED BY also drops the privileges granted TO the role, which a
            // bare DROP ROLE would refuse.
            await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
            await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
          }
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("STRIPS a membership granted by somebody other than the provisioner", async () => {
      // The case this suite structurally could not reach while the provisioner made
      // every grant itself. A membership is recorded per grantor, and
      // `REVOKE <role> FROM <member>` without `GRANTED BY` removes only the CURRENT
      // role's own grant — even for a superuser. So a deployer's grant survived the
      // sweep, the DO block committed, the CLI reported success, and readiness stayed
      // `over_privileged` for good while the documented repair claimed to have worked.
      await withDeclaredGrantsOnly(async () => {
        await admin.query(`CREATE ROLE "${APP_LIKE_ROLE}" NOSUPERUSER`);
        await admin.query(`CREATE ROLE "${DEPLOYER_ROLE}" NOSUPERUSER CREATEROLE`);
        await admin.query(
          `GRANT "${APP_LIKE_ROLE}" TO "${DEPLOYER_ROLE}" WITH ADMIN OPTION`,
        );
        // The GRANT is made by the deployer, not by the provisioning role.
        await admin.query(`SET ROLE "${DEPLOYER_ROLE}"`);
        await admin.query(`GRANT "${APP_LIKE_ROLE}" TO "${TEST_ROLE}"`);
        await admin.query("RESET ROLE");
        await closeDiagnosticsDatabase();
        try {
          const grantor = await admin.query(
            `SELECT grantor.rolname AS grantor
             FROM pg_catalog.pg_auth_members m
             JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
             JOIN pg_catalog.pg_roles member  ON member.oid  = m.member
             JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
             WHERE member.rolname = $1 AND granted.rolname = $2`,
            [TEST_ROLE, APP_LIKE_ROLE],
          );
          // Non-vacuous: the grant really is attributed to the deployer.
          expect(grantor.rows[0]?.grantor).toBe(DEPLOYER_ROLE);
          expect(grantor.rows[0]?.grantor).not.toBe(adminRole);

          const refused = await getDiagnosticsDatabase();
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.report?.roleMemberships).toBe(1);

          // The old sweep's REVOKE, run verbatim by the SUPERUSER provisioner: it
          // returns success, emits a WARNING, and changes nothing.
          const warnings: string[] = [];
          const bare = new PgClientCtor({ connectionString: RACE_DB_URL });
          bare.on("notice", (notice) => {
            warnings.push(
              `${String(notice.severity ?? "")}: ${String(notice.message ?? "")}`,
            );
          });
          await bare.connect();
          try {
            await bare.query(
              `REVOKE "${APP_LIKE_ROLE}" FROM "${TEST_ROLE}"`,
            );
          } finally {
            await bare.end().catch(() => {});
          }
          expect(warnings.join(" | ")).toContain("has not been granted membership");
          const survived = await admin.query(
            `SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS still_member`,
            [TEST_ROLE, APP_LIKE_ROLE],
          );
          expect(survived.rows[0].still_member).toBe(true);

          // The shipped statements, which name the grantor on every revoke and then
          // re-check before committing.
          await provision();
          await closeDiagnosticsDatabase();
          const swept = await admin.query(
            `SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS still_member`,
            [TEST_ROLE, APP_LIKE_ROLE],
          );
          expect(swept.rows[0].still_member).toBe(false);
          const accepted = await getDiagnosticsDatabase();
          expect(accepted.ok).toBe(true);
        } finally {
          // Cleanup names the grantor itself, so it does not depend on the behaviour
          // under test: if the sweep regresses, this test fails on its own assertions
          // rather than leaving a membership behind that breaks every later case.
          await admin
            .query(
              `REVOKE "${APP_LIKE_ROLE}" FROM "${TEST_ROLE}" GRANTED BY "${DEPLOYER_ROLE}"`,
            )
            .catch(() => {});
          for (const role of [APP_LIKE_ROLE, DEPLOYER_ROLE]) {
            await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
            await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
          }
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("refuses a GRANTED BY revoke from a role without the grantor's privileges", async () => {
      // The reason the sweep's re-check is a rollback and not a warning: a provisioner
      // that may not revoke another role's grant cannot silently half-succeed either.
      await admin.query(`CREATE ROLE "${DEPLOYER_ROLE}" NOSUPERUSER CREATEROLE`);
      await admin.query(`CREATE ROLE "${APP_LIKE_ROLE}" NOSUPERUSER`);
      await admin.query(
        `GRANT "${APP_LIKE_ROLE}" TO "${DEPLOYER_ROLE}" WITH ADMIN OPTION`,
      );
      await admin.query(`CREATE ROLE "${GROUP_LIKE_ROLE}" NOSUPERUSER CREATEROLE`);
      await admin.query(
        `GRANT "${APP_LIKE_ROLE}" TO "${GROUP_LIKE_ROLE}" WITH ADMIN OPTION`,
      );
      try {
        await admin.query(`SET ROLE "${DEPLOYER_ROLE}"`);
        await admin.query(`GRANT "${APP_LIKE_ROLE}" TO "${TEST_ROLE}"`);
        await admin.query("RESET ROLE");

        // A different admin-option holder tries to revoke the deployer's grant.
        await admin.query(`SET ROLE "${GROUP_LIKE_ROLE}"`);
        await expect(
          admin.query(
            `REVOKE "${APP_LIKE_ROLE}" FROM "${TEST_ROLE}" GRANTED BY "${DEPLOYER_ROLE}"`,
          ),
        ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      } finally {
        await admin.query("RESET ROLE").catch(() => {});
        for (const role of [APP_LIKE_ROLE, DEPLOYER_ROLE, GROUP_LIKE_ROLE]) {
          await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
          await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
        }
        await closeDiagnosticsDatabase();
      }
    });

    it("REFUSES membership in a SUPERUSER role, including for server-file access", async () => {
      // The worst version of the same shape: the granted role is a superuser, so
      // `SET ROLE` yields everything — yet `is_superuser` is false (it is the
      // diagnostics role's own attribute) and `can_read_server_files` is false (the
      // ACL check respects NOINHERIT). Membership is the only trace.
      await withDeclaredGrantsOnly(async () => {
        const adminAttributes = await admin.query(
          `SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1`,
          [adminRole],
        );
        // Non-vacuous: if the harness role were not a superuser this proves nothing.
        expect(adminAttributes.rows[0]?.rolsuper).toBe(true);

        await admin.query(`GRANT "${adminRole}" TO "${TEST_ROLE}"`);
        await closeDiagnosticsDatabase();
        try {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) {
            expect(handle.reason).toBe("database_role_unsafe");
            expect(handle.report?.roleMemberships).toBeGreaterThanOrEqual(1);
            expect(handle.report?.forbiddenRoleMemberships).toBe(0);
            expect(handle.report?.isSuperuser).toBe(false);
            expect(handle.report?.canReadServerFiles).toBe(false);
          }

          const client = new PgClientCtor({ connectionString: roleUrl });
          await client.connect();
          try {
            await expect(
              client.query(`SELECT pg_catalog.pg_read_file('postgresql.conf', 0, 60)`),
            ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
            await client.query(`SET ROLE "${adminRole}"`);
            const file = await client.query(
              `SELECT pg_catalog.pg_read_file('postgresql.conf', 0, 60) AS head`,
            );
            expect(String(file.rows[0].head).length).toBeGreaterThan(0);
          } finally {
            await client.end().catch(() => {});
          }
        } finally {
          await admin
            .query(`REVOKE "${adminRole}" FROM "${TEST_ROLE}"`)
            .catch(() => {});
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES a role granted EXECUTE on a non-default pg_read_file overload", async () => {
      await withDeclaredGrantsOnly(async () => {
        await admin.query(
          `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text, bigint, bigint) TO "${TEST_ROLE}"`,
        );
        await closeDiagnosticsDatabase();
        try {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) expect(handle.report?.canReadServerFiles).toBe(true);
        } finally {
          await admin.query(
            `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text, bigint, bigint) FROM "${TEST_ROLE}"`,
          );
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES a role that may execute a SECURITY DEFINER routine in public", async () => {
      await withDeclaredGrantsOnly(async () => {
        // PUBLIC gets EXECUTE on a new function by default, so this needs no grant at
        // all — creating the function is enough, which is exactly why the check is a
        // count rather than a revoke.
        await admin.query(
          `CREATE FUNCTION public.aid5_secdef_probe() RETURNS int AS 'SELECT 1' LANGUAGE sql SECURITY DEFINER`,
        );
        await closeDiagnosticsDatabase();
        try {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(false);
          if (!handle.ok) {
            expect(handle.report?.executableSecurityDefinerRoutines).toBe(1);
          }

          // Re-provisioning does NOT fix it — the revoke cannot touch a PUBLIC grant.
          await provision();
          await closeDiagnosticsDatabase();
          const afterProvision = await getDiagnosticsDatabase();
          expect(afterProvision.ok).toBe(false);
        } finally {
          await admin.query(`DROP FUNCTION IF EXISTS public.aid5_secdef_probe()`);
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("re-verifies the role with the SERVER once the cached verdict ages out", async () => {
      await withDeclaredGrantsOnly(async () => {
        const accepted = await getDiagnosticsDatabase();
        expect(accepted.ok).toBe(true);

        // Escalate the LIVE role, the way a hand-edit would.
        await admin.query(`ALTER ROLE "${TEST_ROLE}" WITH CREATEDB`);
        const pinnedNow = new Date();
        try {
          // Inside the TTL the cached verdict still stands...
          expect((await getDiagnosticsDatabase()).ok).toBe(true);

          // ...and once it has aged out the server is asked again and says no. The
          // frozen test clock is moved rather than slept through — the suite's `Date`
          // is fake, so a real sleep would never expire a TTL measured with
          // `Date.now()`. The database's own state is untouched by that.
          vi.setSystemTime(
            new Date(
              pinnedNow.getTime() + DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs + 1,
            ),
          );
          const refused = await getDiagnosticsDatabase();
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.report?.canCreateDb).toBe(true);
        } finally {
          vi.setSystemTime(pinnedNow);
          await provision();
          await closeDiagnosticsDatabase();
        }
      });
    });

    it("REFUSES the application's superuser credential at runtime", async () => {
      // The self-check is what stops a deployment pointing diagnostics at its
      // superuser. Proven against a real superuser role, not a mock: the URL is
      // the same shape, the role is genuinely a superuser, and the answer is no.
      await closeDiagnosticsDatabase();
      const parsed = new URL(RACE_DB_URL);
      // A distinct username is required to get past the config check, so the
      // privilege PROBE is what has to do the refusing here.
      process.env.DATABASE_URL = `postgresql://not_the_diagnostics_role:x@${parsed.host}/${databaseName}`;
      process.env.AI_DIAGNOSTICS_DATABASE_URL = RACE_DB_URL;
      try {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(false);
        if (!handle.ok) {
          expect(handle.reason).toBe("database_role_unsafe");
          expect(handle.report?.isSuperuser).toBe(true);
        }
      } finally {
        await closeDiagnosticsDatabase();
        process.env.DATABASE_URL = RACE_DB_URL;
        process.env.AI_DIAGNOSTICS_DATABASE_URL = roleUrl;
      }
    });

    it("runs the registry probe tool's SQL and proves the transaction is READ ONLY", async () => {
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        const probe = DIAGNOSTICS_TOOLS[0];
        expect(probe.source).toBe("select_only_sql");
        if (probe.source !== "select_only_sql") return;
        const result = await runDiagnosticsReadOnlyQuery(
          { sql: probe.sql, params: [], rowLimit: probe.rowLimit, toolId: probe.id },
          handle.pool,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const row = probe.project(result.rows[0]);
        expect(row.probeOk).toBe(true);
        // The database itself reporting the executor's settings back.
        expect(row.transactionReadOnly).toBe("on");
        // NUMERICALLY, not as a formatted string. PostgreSQL re-renders a GUC in
        // whatever unit divides evenly — `SET LOCAL statement_timeout = 5000` reads
        // back as `5s`, not `5000ms` — so the raw setting is only asserted to be
        // present and non-zero, and the derived millisecond value is what pins the
        // control. A regression that dropped the timeout entirely reports `0`.
        expect(row.statementTimeoutMs).toBe(
          DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
        );
        expect(row.statementTimeout).not.toBe("");
        expect(row.statementTimeout).not.toBe("0");
      });
    });

    /**
     * Representative arguments for the registered entries that REQUIRE some.
     *
     * The ids are not imported from the pack modules on purpose: those modules are
     * `server-only`, this suite loads the registry dynamically after setting the
     * environment, and a literal key here fails loudly (the entry's `parseArgs`
     * refuses `{}`) if an entry is ever renamed. The values are shaped to parse and
     * to match nothing on a freshly migrated schema — the assertion below is that
     * the statement RUNS as the least-privilege role with the grants the allowlist
     * declares, not that it finds anything.
     */
    const REALDB_ENTRY_ARGS: Record<string, unknown> = {
      "diagnostics.finance_payment_search": {
        referenceKind: "booking_reference",
        reference: "CLZ00000",
      },
      // Deliberately ZERO, and it is the interesting value rather than a lazy one.
      // `Payment."additionalAmountCents"` is `Int @default(0)` NOT NULL, so the
      // guard that stops a zero search matching the whole relation
      // (`$1::int > 0 AND …`) is a real SQL construct that has to PARSE and run on
      // PostgreSQL with the declared grants, not just read correctly.
      "diagnostics.finance_payment_amount_search": {
        amountCents: 0,
        window: "30d",
      },
      "diagnostics.payment_diagnostic_summary": {
        paymentId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.payment_attempt_ledger": {
        paymentId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.payment_refund_state": {
        paymentId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.finance_webhook_timeline": {
        provider: "stripe",
        eventRef: "evt_3Qabcdefghijklmnopqrstu",
      },
      "diagnostics.xero_invoice_linkage": {
        localModel: "Booking",
        localId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.xero_contact_linkage": {
        memberId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.finance_record_audit_history": {
        subject: "payment",
        recordId: "clz0000000abcdefghijklmno",
      },
      // AID-6B (#2376). All thirteen, because all thirteen refuse `{}` — and without a
      // row here the loop below does not merely SKIP an entry, it throws on the
      // first one it reaches and never executes a single AID-6B statement against a
      // real server. That is the failure this file exists to prevent: the thirteen
      // statements read fifteen relations by column, and an ungranted column
      // among them is a 42501 that passes every mock in the repository.
      //
      // The SEARCH arms are chosen for what they exercise on the server rather than
      // for brevity. `booking_search` uses the `lodge_nights` arm because it is the
      // only one that binds a date and an interval and evaluates the half-open
      // overlap — `checkIn < ($5::date + $6 * INTERVAL '1 day') AND checkOut > $5` —
      // which is a construct that has to PARSE and type-check under real
      // PostgreSQL, not just read correctly. `member_search` uses `name_prefix`
      // because it is the only predicate in the whole pack that is not `=`:
      // `pg_catalog.starts_with`, whose schema qualification is load-bearing and
      // whose existence a mock cannot prove.
      "diagnostics.booking_search": {
        kind: "lodge_nights",
        lodgeId: "clz0000000abcdefghijklmno",
        nightFrom: "2026-08-08",
        window: "30d",
      },
      "diagnostics.member_search": { kind: "name_prefix", namePrefix: "smi" },
      "diagnostics.booking_diagnostic_summary": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.booking_linked_state": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.booking_party_state": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.booking_bed_allocation_state": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.booking_exception_request_state": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.booking_record_audit_history": {
        bookingId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.member_diagnostic_summary": {
        memberId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.member_subscription_state": {
        memberId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.member_family_state": {
        memberId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.member_booking_summary": {
        memberId: "clz0000000abcdefghijklmno",
      },
      "diagnostics.member_record_audit_history": {
        subject: "member",
        recordId: "clz0000000abcdefghijklmno",
      },
    };

    it("runs EVERY registered SELECT-only entry, with its real parameters and grants", async () => {
      // The proof a unit test cannot give, and the one AID-6A (#2375) most needs: each
      // registered statement is executed as the least-privilege role against the
      // migrated schema, with the parameters the entry's own `bind` produced. Four
      // things can only fail here — a column the allowlist does not grant (42501), a
      // mis-numbered `$n`, a statement that does not parse, and a driver value the
      // entry's projection cannot handle — and every one of them would otherwise first
      // appear the first time an operator asked the question that reaches the tool.
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        const sqlEntries = DIAGNOSTICS_TOOLS.filter(
          (entry) => entry.source === "select_only_sql",
        );
        // The probe, AID-6A's five correlation entries, AID-6C's nine finance
        // entries and AID-6B's thirteen, so this is not vacuous.
        expect(sqlEntries.length).toBeGreaterThan(1);

        // THE CENSUS, ASSERTED BEFORE THE LOOP RATHER THAN DISCOVERED INSIDE IT.
        // An entry with no argument row does not skip: `parseArgs({})` fails, the
        // assertion inside the loop throws, and every entry after it — however many
        // — is never executed against the server at all. That is how thirteen
        // statements reached a review with their real-database proof silently not
        // running. Naming the gap up front turns "expected false to be true" into a
        // sentence that says which entry and what to do about it.
        const unarguable = sqlEntries
          .filter((entry) => !entry.parseArgs(REALDB_ENTRY_ARGS[entry.id] ?? {}).ok)
          .map((entry) => entry.id);
        expect(
          unarguable,
          "add a REALDB_ENTRY_ARGS row for each of these, or their statements are never proved against a real PostgreSQL",
        ).toEqual([]);

        for (const entry of sqlEntries) {
          if (entry.source !== "select_only_sql") continue;
          // Arguments the entry itself accepts. `{}` was enough while every entry
          // either took none or defaulted them; AID-6C (#2377) ends that, and it
          // ends it deliberately — a finance search that accepted `{}` would be the
          // blank, unbounded search #2377 forbids. So an entry that needs arguments
          // supplies them here, and an entry with no row falls back to `{}` and
          // still has to parse, which keeps this a census rather than a skip.
          const binding = entry.parseArgs(REALDB_ENTRY_ARGS[entry.id] ?? {});
          expect(binding.ok, entry.id).toBe(true);
          if (!binding.ok || binding.source !== "select_only_sql") continue;

          const result = await runDiagnosticsReadOnlyQuery(
            {
              sql: entry.sql,
              params: binding.params,
              rowLimit: entry.rowLimit,
              toolId: entry.id,
            },
            handle.pool,
          );
          expect(result.ok, `${entry.id} was refused by the database`).toBe(true);
          if (!result.ok) continue;
          // Whatever came back must survive the entry's own projection: a real driver
          // hands timestamps and nullable columns over in shapes a mock does not.
          for (const row of result.rows) {
            const projected = entry.project(row);
            expect(Object.keys(projected).length, entry.id).toBeGreaterThan(0);
          }
        }
      });
    });

    it("runs the real member-search mobile arm against punctuated stored fragments", async () => {
      const memberId = "aid6b_mobile_probe_member";
      const email = "aid6b-mobile-probe@example.invalid";
      await admin.query(`DELETE FROM public."Member" WHERE "id" = $1`, [memberId]);
      await admin.query(
        `INSERT INTO public."Member"
           ("id", "email", "passwordHash", "firstName", "lastName",
            "phoneCountryCode", "phoneAreaCode", "phoneNumber",
            "createdAt", "updatedAt")
         VALUES ($1, $2, 'not-a-login-hash', 'Mobile', 'Probe',
                 '+64 ', ' 27-', '422 4115', pg_catalog.now(), pg_catalog.now())`,
        [memberId, email],
      );

      try {
        await withDeclaredGrantsOnly(async () => {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(true);
          if (!handle.ok) return;

          const entry = DIAGNOSTICS_TOOLS.find(
            (candidate) => candidate.id === "diagnostics.member_search",
          );
          expect(entry?.source).toBe("select_only_sql");
          if (!entry || entry.source !== "select_only_sql") return;

          const binding = entry.parseArgs({
            kind: "mobile",
            mobile: "+64 27-422 4115",
          });
          expect(binding.ok).toBe(true);
          if (!binding.ok || binding.source !== "select_only_sql") return;
          expect(binding.params[4]).toBe("64274224115");

          const result = await runDiagnosticsReadOnlyQuery(
            {
              sql: entry.sql,
              params: binding.params,
              rowLimit: entry.rowLimit,
              toolId: entry.id,
            },
            handle.pool,
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.rows).toHaveLength(1);
          const projected = entry.project(result.rows[0]);
          expect(projected).toMatchObject({ memberRef: memberId });
          expect(projected).not.toHaveProperty("phoneCountryCode");
          expect(projected).not.toHaveProperty("phoneAreaCode");
          expect(projected).not.toHaveProperty("phoneNumber");
        });
      } finally {
        await admin.query(`DELETE FROM public."Member" WHERE "id" = $1`, [memberId]);
      }
    });

    it("correlates a REAL audit row and returns none of the withheld values", async () => {
      // The end-to-end privacy assertion, on a row that carries every withheld value a
      // real audit entry can: an IP address, a user agent, a description, free text,
      // arbitrary JSON metadata and three member references. The projection cannot be
      // the only thing keeping them out of the evidence channel here — the role holds
      // no privilege on those columns at all — so this proves both layers at once.
      const auditId = "aid6a_realdb_probe_row";
      const requestId = "aid6a-realdb-probe";
      await admin.query(
        `INSERT INTO public."AuditLog"
           ("id","action","category","severity","outcome","entityType","requestId",
            "createdAt","ipAddress","userAgent","summary","details","metadata",
            "memberId","actorMemberId","subjectMemberId","entityId")
         VALUES ($1,'diagnostics.realdb_probe','system','info','success','system',$2,
                 pg_catalog.now(),'203.0.113.7','Mozilla/5.0 probe',
                 'Refund for Jane Tramper','raw detail text','{"secret":"value"}',
                 'cmqmember0001','cmqadmin0001','cmqmember0002','cmqentity0001')
         ON CONFLICT ("id") DO NOTHING`,
        [auditId, requestId],
      );
      try {
        await withDeclaredGrantsOnly(async () => {
          const handle = await getDiagnosticsDatabase();
          expect(handle.ok).toBe(true);
          if (!handle.ok) return;

          const entry = DIAGNOSTICS_TOOLS.find(
            (candidate) => candidate.id === "diagnostics.system_event_correlation",
          );
          expect(entry, "the system correlation entry is registered").toBeDefined();
          if (!entry || entry.source !== "select_only_sql") return;

          const binding = entry.parseArgs({ window: "1h", requestId });
          expect(binding.ok).toBe(true);
          if (!binding.ok || binding.source !== "select_only_sql") return;

          const result = await runDiagnosticsReadOnlyQuery(
            {
              sql: entry.sql,
              params: binding.params,
              rowLimit: entry.rowLimit,
              toolId: entry.id,
            },
            handle.pool,
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.rows).toHaveLength(1);

          const projected = entry.project(result.rows[0]);
          expect(projected.eventRef).toBe(auditId);
          expect(projected.action).toBe("diagnostics.realdb_probe");
          expect(projected.requestId).toBe(requestId);
          // Formatted in SQL, so it arrives as a flat scalar rather than a `Date` the
          // projection would have to convert (and the executor would refuse).
          expect(typeof projected.occurredAtUtc).toBe("string");
          expect(projected.occurredAtUtc).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
          );

          const serialised = JSON.stringify(projected);
          for (const withheld of [
            "203.0.113.7",
            "Mozilla",
            "Jane Tramper",
            "raw detail text",
            "secret",
            "cmqmember0001",
            "cmqadmin0001",
            "cmqmember0002",
            "cmqentity0001",
          ]) {
            expect(serialised, withheld).not.toContain(withheld);
          }

          // TIMEZONE INDEPENDENCE, proven rather than reasoned about. `createdAt` is a
          // naive `timestamp` holding UTC, so a statement that let the session's
          // `TimeZone` into the comparison or the formatting would, on a deployment set
          // to `Pacific/Auckland`, shift the window by 12-13 hours (dropping this row
          // entirely) and stamp a local time with a `Z`. The executor pins UTC per
          // transaction; this runs the same statement OUTSIDE that pin to show the
          // statement does not depend on it.
          await admin.query("SET TimeZone TO 'Pacific/Auckland'");
          try {
            const shifted = await admin.query(entry.sql, [...binding.params]);
            const shiftedRow = shifted.rows.find(
              (row) => row.event_ref === auditId,
            );
            expect(
              shiftedRow,
              "the window must not move with the session TimeZone",
            ).toBeDefined();
            expect(shiftedRow?.occurred_at_utc).toBe(
              result.rows[0].occurred_at_utc,
            );
          } finally {
            await admin.query("RESET TimeZone");
          }
        });
      } finally {
        await admin.query(`DELETE FROM public."AuditLog" WHERE "id" = $1`, [
          auditId,
        ]);
      }
    });

    it("caps rows in SQL, whatever the query would have returned", async () => {
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        // 100 rows available, rowLimit 3 → the executor's own LIMIT returns exactly
        // rowLimit + 1 (the extra row is how truncation is detected honestly).
        const result = await runDiagnosticsReadOnlyQuery(
          {
            sql: "SELECT g AS n FROM pg_catalog.generate_series(1, 100) AS g",
            params: [],
            rowLimit: 3,
          },
          handle.pool,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.rows).toHaveLength(4);
      });
    });

    it("binds a registry entry's OWN parameters and still appends its LIMIT", async () => {
      // The executor wraps an entry's SQL and appends the row limit as the LAST
      // parameter, so the entry's own `$1`/`$2` keep their meaning. AID-6A's
      // correlation entries bind three, and the test above runs them for real; this
      // one isolates the numbering on a statement whose expected row count is known
      // exactly, because a wrong `$n` is a runtime error rather than a type error.
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        const result = await runDiagnosticsReadOnlyQuery(
          {
            sql: "SELECT g AS n, $1::text AS first_param, $2::int AS second_param FROM pg_catalog.generate_series(1, 50) AS g ORDER BY g",
            params: ["bound-value", 42],
            rowLimit: 2,
          },
          handle.pool,
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // rowLimit + 1 rows, proving the appended LIMIT parameter was read as the
        // limit and not consumed by the entry's own placeholders.
        expect(result.rows).toHaveLength(3);
        expect(result.rows[0]).toMatchObject({
          n: 1,
          first_param: "bound-value",
          second_param: 42,
        });
      });
    });

    it("REFUSES an entry that binds one parameter short, which PostgreSQL would not", async () => {
      // The reason the arity guard exists, proven both ways on a real server.
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        const oneShort =
          "SELECT g AS n FROM pg_catalog.generate_series(1, 50) AS g WHERE g > $1 AND g < $2";

        // 1. The database is perfectly happy to let the appended row cap serve as the
        //    entry's own `$2`. No error, and the wrong answer: the second predicate is
        //    evaluated against the row cap rather than the caller's value.
        const aliased = await admin.query(
          `SELECT * FROM (${oneShort}) AS diagnostics_tool_result LIMIT ($2)::bigint`,
          [0, 6],
        );
        expect(aliased.rows).toHaveLength(5);

        // 2. The executor refuses it instead, before opening a transaction.
        const result = await runDiagnosticsReadOnlyQuery(
          { sql: oneShort, params: [0], rowLimit: 5, toolId: "diagnostics.example" },
          handle.pool,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.timedOut).toBe(false);
      });
    });

    it("cannot execute a write through the executor at all, parameters or not", async () => {
      // A THIRD independent layer, below the role's grants and the read-only
      // transaction: the executor wraps every statement as
      // `SELECT * FROM (<sql>) AS … LIMIT …`, and an INSERT inside a FROM-subquery
      // is not valid SQL. So a registry entry that somehow shipped a write (it
      // would have to defeat `registry.test.ts` first) fails to PARSE before the
      // privilege check is ever reached — the error here is 42601, not 42501 or
      // 25006. Asserted on the OUTCOME rather than the SQLSTATE, because which
      // layer refuses first is an implementation detail and all three must hold.
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        const result = await runDiagnosticsReadOnlyQuery(
          {
            sql: `INSERT INTO public.${WRITABLE_TABLE} (id, note) VALUES (99, $1) RETURNING id`,
            params: ["written-by-diagnostics"],
            rowLimit: 1,
          },
          handle.pool,
        );
        expect(result.ok).toBe(false);

        // And the row genuinely is not there.
        const after = await admin.query(
          `SELECT count(*)::int AS rows FROM public.${WRITABLE_TABLE} WHERE id = 99`,
        );
        expect(after.rows[0].rows).toBe(0);
      });
    });

    it("cancels a long-running query at the statement timeout", async () => {
      await withDeclaredGrantsOnly(async () => {
        const handle = await getDiagnosticsDatabase();
        expect(handle.ok).toBe(true);
        if (!handle.ok) return;

        // `Date.now()` is frozen for every test in this repo, so `result.durationMs`
        // is 0 here and asserting on it would be vacuous. Real elapsed time comes
        // from `process.hrtime.bigint()` via the shared helper.
        const startedNs = process.hrtime.bigint();
        const result = await runDiagnosticsReadOnlyQuery(
          {
            sql: "SELECT pg_catalog.pg_sleep(30) AS slept",
            params: [],
            rowLimit: 1,
            toolId: "diagnostics.example",
          },
          handle.pool,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.timedOut).toBe(true);
        // Cancelled at the configured timeout, not after 30 seconds.
        expect(realElapsedMs(startedNs)).toBeLessThan(
          DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs * 3,
        );
      });
    }, 40_000);

    it("cancels a long query run directly by the role, from its own role default", async () => {
      const code = await sqlStateAsRole("SELECT pg_catalog.pg_sleep(30)");
      expect(code).toBe(QUERY_CANCELED);
    }, 40_000);
  },
);

#!/usr/bin/env -S npx tsx
/**
 * Provision the dedicated SELECT-only AI Diagnostics database role (AID-5,
 * #2374; contract in ADR-007).
 *
 *   AI_DIAGNOSTICS_DB_PASSWORD='<a long random secret>' \
 *     pnpm run diagnostics:provision-role
 *
 *   pnpm run diagnostics:provision-role --dry-run     # print the SQL, no connection
 *
 * WHY A SCRIPT AND NOT A MIGRATION. A Prisma migration runs on every deployment
 * and is part of the schema history; a database ROLE is neither. It is cluster
 * state, it needs a secret the schema must never contain, it is provisioned once
 * per deployment (plus once per password rotation), and a fork may already have a
 * role or a policy of its own. ADR-007 §3 makes provisioning a documented
 * operational step for exactly these reasons — see
 * `docs/ai-diagnostics/deployment.md`.
 *
 * WHY NOT A COMPOSE INIT SCRIPT EITHER. `docker-entrypoint-initdb.d` runs only on
 * the FIRST initialisation of an empty data directory, so an init script would
 * silently never run on any existing club server — the deployments that most need
 * it. This script is safe to run against a live database at any time.
 *
 * WHAT IT NEEDS. A connection that may create roles: the application's own
 * `DATABASE_URL` in the stock Compose stack (that role is a SUPERUSER), or an
 * explicit `AI_DIAGNOSTICS_PROVISION_DATABASE_URL` for a deployment that keeps a
 * separate DBA credential.
 *
 * WHAT IT NEVER DOES: print, log or echo the diagnostics password — not even
 * under `--dry-run`, where the password literal is replaced before the SQL is
 * shown.
 */

import { Client } from "pg";

import {
  buildAiDiagnosticsRoleSql,
  DEFAULT_AI_DIAGNOSTICS_ROLE_NAME,
  isSupportedProvisionIdentifier,
  SELECT_GRANTS,
  SUPPORTED_IDENTIFIER_DESCRIPTION,
} from "../../src/lib/diagnostics/tools/provision-role";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../../src/lib/diagnostics/tools/types";

const DRY_RUN_PASSWORD = "REDACTED-DRY-RUN-PLACEHOLDER";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The declared allowlist, in a form an operator can act on. Counting relations alone
 * stopped being enough when AID-6A (#2375) introduced COLUMN grants: "1 relation" and
 * "1 relation, 8 of its columns" are very different privileges, and the second is the
 * one an operator should be able to confirm from the console output.
 */
function describeDeclaredGrants(): string {
  if (SELECT_GRANTS.length === 0) return "SELECT grants declared: none.";
  const parts = SELECT_GRANTS.map((grant) =>
    grant.columns === undefined
      ? `${grant.schema}.${grant.relation} (whole relation)`
      : `${grant.schema}.${grant.relation} (${grant.columns.length} columns: ${grant.columns.join(", ")})`,
  );
  return `SELECT grants declared: ${parts.join("; ")}.`;
}

function fail(message: string): never {
  console.error(`[provision-ai-diagnostics-role] ${message}`);
  process.exit(1);
}

/**
 * Refuse an unsupported role or database name HERE, with the variable that carried
 * it, rather than letting the SQL builder throw a raw stack trace at the operator.
 *
 * The refusal itself is right — the builder interpolates these names into
 * dollar-quoted `DO $$ … $$` blocks — but a hyphenated or `user@server` name is
 * legal in PostgreSQL and standard on managed providers, so an operator hitting it
 * needs to be told what to change, and where. `AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES`
 * matters most: it defaults to the APPLICATION role parsed out of `DATABASE_URL`, so
 * a deployment whose app role is `tac-app` could not provision at all, however clean
 * its own diagnostics role name was.
 */
function requireSupportedIdentifier(
  value: string,
  what: string,
  source: string,
): void {
  if (isSupportedProvisionIdentifier(value)) return;
  fail(
    `Refusing to provision: ${what} "${value}" (from ${source}) cannot be used in the provisioning SQL. Use ${SUPPORTED_IDENTIFIER_DESCRIPTION}. See docs/ai-diagnostics/deployment.md.`,
  );
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  const adminUrl =
    readEnv("AI_DIAGNOSTICS_PROVISION_DATABASE_URL") ?? readEnv("DATABASE_URL");
  if (!adminUrl) {
    fail(
      "Set DATABASE_URL (or AI_DIAGNOSTICS_PROVISION_DATABASE_URL) to a connection that may create roles.",
    );
  }

  let parsedAdminUrl: URL;
  try {
    parsedAdminUrl = new URL(adminUrl);
  } catch {
    fail("The provisioning connection string is not a valid URL.");
  }

  const databaseName = decodeURIComponent(
    parsedAdminUrl.pathname.replace(/^\//, ""),
  );
  if (!databaseName) {
    fail("The provisioning connection string must name a database.");
  }
  const adminRole = decodeURIComponent(parsedAdminUrl.username);
  if (!adminRole) {
    fail("The provisioning connection string must carry a username.");
  }

  const roleName = readEnv("AI_DIAGNOSTICS_DB_ROLE") ?? DEFAULT_AI_DIAGNOSTICS_ROLE_NAME;
  if (roleName.toLowerCase() === adminRole.toLowerCase()) {
    fail(
      `Refusing to provision: AI_DIAGNOSTICS_DB_ROLE (${roleName}) is the application role. ADR-007 requires a SEPARATE role.`,
    );
  }

  const password = dryRun
    ? DRY_RUN_PASSWORD
    : readEnv("AI_DIAGNOSTICS_DB_PASSWORD");
  if (!password) {
    fail(
      "Set AI_DIAGNOSTICS_DB_PASSWORD to a long random secret (it is never printed).",
    );
  }
  if (!dryRun && password.length < 20) {
    fail(
      "AI_DIAGNOSTICS_DB_PASSWORD must be at least 20 characters — this credential guards read access to club data.",
    );
  }

  // Roles that keep `TEMPORARY` on the database after it is revoked from PUBLIC.
  // Defaults to the provisioning role itself, which in the stock stack is also
  // the application role. A fork whose app role differs from its DBA role must
  // list both.
  const preserveTempForRoles = (
    readEnv("AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [adminRole]
  );

  requireSupportedIdentifier(roleName, "the diagnostics role", "AI_DIAGNOSTICS_DB_ROLE");
  requireSupportedIdentifier(
    databaseName,
    "the database name",
    "the provisioning connection string",
  );
  for (const preserved of preserveTempForRoles) {
    requireSupportedIdentifier(
      preserved,
      "a role that must keep TEMPORARY",
      "AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES (which defaults to the role in DATABASE_URL)",
    );
  }

  let statements: string[];
  try {
    statements = buildAiDiagnosticsRoleSql({
      roleName,
      password,
      databaseName,
      preserveTempForRoles,
      statementTimeoutMs: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
      connectionLimit: DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections * 2,
    });
  } catch (err) {
    // The builder refuses several things besides identifiers (a control character
    // in the password, a non-positive timeout). Its message is safe to print — it
    // never contains the password literal — but an unhandled throw here would print
    // a stack trace instead of an actionable line.
    fail(err instanceof Error ? err.message : String(err));
  }

  if (dryRun) {
    console.log(
      `-- Dry run for role ${roleName} on database ${databaseName}.\n` +
        `-- The password literal below is a PLACEHOLDER, not the real secret.\n`,
    );
    for (const statement of statements) console.log(`${statement}\n`);
    console.log(
      `-- ${statements.length} statements. ${describeDeclaredGrants()}`,
    );
    return;
  }

  void run(adminUrl, statements, {
    roleName,
    databaseName,
    host: parsedAdminUrl.host,
  });
}

/**
 * Print whatever the server said, on both the success and the rollback path. Safe to
 * echo: a notice carries the server's own text, never the statement list (which holds
 * the password literal).
 */
function reportNotices(notices: string[]): void {
  if (notices.length === 0) return;
  console.log("[provision-ai-diagnostics-role] The server reported:");
  for (const notice of notices) console.log(`  ${notice}`);
}

async function run(
  adminUrl: string,
  statements: string[],
  info: { roleName: string; databaseName: string; host: string },
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });

  /**
   * Server notices, surfaced rather than swallowed.
   *
   * PostgreSQL says a great deal at WARNING level and still returns success, and one
   * of those sentences is the exact failure this script must not paper over:
   * `REVOKE <role> FROM <member>` without `GRANTED BY` removes only the current
   * role's own grant and reports `WARNING: role "…" has not been granted membership
   * in role "…" by role "postgres"` when somebody else did the granting. The
   * statement list now revokes per recorded grantor and raises if a membership
   * survives, so that warning should no longer appear — but a client that discards
   * notices could never have told an operator it had, which is why the shipped
   * success message used to claim memberships were stripped whatever happened.
   */
  const notices: string[] = [];
  let sawWarning = false;
  client.on("notice", (notice) => {
    const severity = String(notice.severity ?? "NOTICE").toUpperCase();
    // NOTICE and DEBUG are routine chatter; WARNING and above are not.
    if (severity !== "NOTICE" && severity !== "DEBUG" && severity !== "INFO") {
      sawWarning = true;
    }
    notices.push(`${severity}: ${notice.message ?? ""}`);
  });

  await client.connect();
  try {
    // One transaction: role creation, attribute pinning, revokes and grants are
    // all transactional in PostgreSQL, so a failure half-way leaves no partially
    // privileged role behind.
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // The statement list is not echoed: it contains the password literal.
    console.error(
      `[provision-ai-diagnostics-role] Provisioning failed and was rolled back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    reportNotices(notices);
    process.exitCode = 1;
    return;
  } finally {
    await client.end().catch(() => {});
  }

  reportNotices(notices);

  console.log(
    [
      `[provision-ai-diagnostics-role] Provisioned SELECT-only role "${info.roleName}" on ${info.databaseName}.`,
      `  ${describeDeclaredGrants()} (declared in provision-role.ts)`,
      // Said out loud because it is the one thing an operator is most likely to undo
      // by hand: "let diagnostics read one more table" is usually a GRANT of some
      // existing role, and the runtime refuses the credential outright for it.
      //
      // Stated as a fact ONLY when the server said nothing at WARNING level. The
      // transaction's own re-check raises if a membership survived the revokes, so a
      // commit does mean they are gone — but a warning means the server told us
      // something about this run, and an unconditional "stripped" is how a claim
      // becomes untrue.
      sawWarning
        ? "  Role memberships: the server reported a WARNING above — verify before trusting this run."
        : "  Role memberships: stripped, and re-checked inside the same transaction.",
      "  This role must belong to NO role at all: the application refuses every",
      "  diagnostics read if it is a member of one, because a member is one",
      "  SET ROLE away from that role's privileges.",
      "",
      "  Now set this in the deployment environment (compose .env), with the password you supplied:",
      `    AI_DIAGNOSTICS_DATABASE_URL=postgresql://${info.roleName}:<AI_DIAGNOSTICS_DB_PASSWORD>@${info.host}/${info.databaseName}?connection_limit=${DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections}`,
      "",
      "  Re-run this command after adding a diagnostics tool that reads a new table,",
      "  and to rotate the password. It is idempotent and re-asserts every restriction.",
    ].join("\n"),
  );
}

main();

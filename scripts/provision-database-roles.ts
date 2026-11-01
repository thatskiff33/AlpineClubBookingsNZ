#!/usr/bin/env -S pnpm exec tsx
/**
 * Provision the least-privilege database roles (#4453): a migration role that
 * owns the schema, an application role that may only INSERT and SELECT the
 * booking ledger and the audit log, and a narrow audit-retention role. The
 * statements, and why each exists, are in `src/lib/database-roles.ts`.
 *
 *   pnpm run db:provision-roles            # DRY RUN: print the SQL, connect to nothing
 *   APP_DB_PASSWORD=... MIGRATION_DB_PASSWORD=... AUDIT_RETENTION_DB_PASSWORD=... \
 *     pnpm run db:provision-roles --apply  # run it, in one transaction
 *
 * DRY-RUN BY DEFAULT. Nothing connects without `--apply`, and the dry run prints a
 * placeholder in place of every password.
 *
 * WHY A SCRIPT, NOT A MIGRATION — the same reasons as the AI Diagnostics role
 * (`scripts/diagnostics/provision-ai-diagnostics-role.ts`, ADR-007): a role is
 * cluster state, it needs secrets the schema must never contain, and a migration
 * runs as the role this script narrows. It is idempotent; a re-run is the repair
 * path, and — because every `--apply` resets all three passwords — the rotation
 * path, so deploy straight after one.
 *
 * LOCKS. The FIRST `--apply` on a database hands every table to the migration
 * role, and `ALTER … OWNER TO` holds ACCESS EXCLUSIVE until COMMIT: run it in a
 * quiet window. Each lock wait is bounded at 5 s (`lock_timeout`), so a
 * long-open reader stops the run, with nothing changed, rather than leaving it
 * queued. The tables already handed over stay locked until the run commits,
 * though. `statement_timeout` (120 s) bounds each statement, not the run: the
 * ownership loop is one statement and can take up to that on a slow server, and
 * the statements after it run while those locks are still held. App requests
 * touching those tables wait meanwhile. Later runs only GRANT and REVOKE, which
 * wait on nothing an app holds.
 *
 * WHAT IT NEEDS. A connection as the OPERATOR — a superuser, or a role that may
 * create roles and change object owners: `DB_ROLES_PROVISION_DATABASE_URL`, or
 * `DATABASE_URL` when that still names the operator. After the switch it cannot
 * be the application role, and the script refuses one of the three roles it
 * provisions.
 *
 * WHAT IT NEVER DOES: print, log or echo a password.
 */

import { Client } from "pg";

import {
  buildDatabaseRolesSql,
  CONNECTION_STRING_UNSAFE_PASSWORD,
  DEFAULT_DATABASE_ROLE_NAMES,
  type DatabaseRoleCredential,
  type DatabaseRoleKind,
} from "../src/lib/database-roles";
import {
  DEFAULT_AI_DIAGNOSTICS_ROLE_NAME,
  isSupportedProvisionIdentifier,
  SUPPORTED_IDENTIFIER_DESCRIPTION,
} from "../src/lib/diagnostics/tools/provision-role";

const DRY_RUN_PASSWORD = "REDACTED-DRY-RUN-PLACEHOLDER";
const MINIMUM_PASSWORD_LENGTH = 20;
/** SQLSTATEs of a bounded wait that ran out: try again when the database is quiet. */
const LOCK_NOT_AVAILABLE = "55P03";
const QUERY_CANCELED = "57014";

/** Which variables name each role and carry its password. */
const ROLE_ENV: Record<DatabaseRoleKind, { user: string; password: string; label: string }> = {
  migrator: { user: "MIGRATION_DB_USER", password: "MIGRATION_DB_PASSWORD", label: "migration" },
  app: { user: "APP_DB_USER", password: "APP_DB_PASSWORD", label: "application" },
  auditRetention: {
    user: "AUDIT_RETENTION_DB_USER",
    password: "AUDIT_RETENTION_DB_PASSWORD",
    label: "audit-retention",
  },
};
const ROLE_KINDS = Object.keys(ROLE_ENV) as DatabaseRoleKind[];

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function fail(message: string): never {
  console.error(`[provision-database-roles] ${message}`);
  process.exit(1);
}

function requireSupportedIdentifier(value: string, what: string, source: string): void {
  if (isSupportedProvisionIdentifier(value)) return;
  fail(
    `Refusing to provision: ${what} "${value}" (from ${source}) cannot be used in the provisioning SQL. Use ${SUPPORTED_IDENTIFIER_DESCRIPTION}. See DEPLOYMENT.md "Least-privilege database roles".`,
  );
}

function main(): void {
  const apply = process.argv.includes("--apply");

  const adminUrl = readEnv("DB_ROLES_PROVISION_DATABASE_URL") ?? readEnv("DATABASE_URL");
  if (!adminUrl) {
    fail("Set DB_ROLES_PROVISION_DATABASE_URL (or DATABASE_URL) to the operator connection.");
  }
  let parsedAdminUrl: URL;
  try {
    parsedAdminUrl = new URL(adminUrl);
  } catch {
    fail("The provisioning connection string is not a valid URL.");
  }
  const databaseName = decodeURIComponent(parsedAdminUrl.pathname.replace(/^\//, ""));
  if (!databaseName) fail("The provisioning connection string must name a database.");
  const adminRole = decodeURIComponent(parsedAdminUrl.username);
  if (!adminRole) fail("The provisioning connection string must carry a username.");
  requireSupportedIdentifier(databaseName, "the database name", "the provisioning connection string");

  const diagnosticsRole = readEnv("AI_DIAGNOSTICS_DB_ROLE") ?? DEFAULT_AI_DIAGNOSTICS_ROLE_NAME;
  const credentials = {} as Record<DatabaseRoleKind, DatabaseRoleCredential>;
  for (const kind of ROLE_KINDS) {
    const env = ROLE_ENV[kind];
    const roleName = readEnv(env.user) ?? DEFAULT_DATABASE_ROLE_NAMES[kind];
    requireSupportedIdentifier(roleName, `the ${env.label} role`, env.user);
    if (roleName.toLowerCase() === adminRole.toLowerCase()) {
      fail(
        `Refusing to provision: ${env.user} (${roleName}) is the role this script connects as. The operator role stays separate from the ${env.label} role — connect as the operator with DB_ROLES_PROVISION_DATABASE_URL.`,
      );
    }
    if (roleName.toLowerCase() === diagnosticsRole.toLowerCase()) {
      fail(
        `Refusing to provision: ${env.user} (${roleName}) is the AI Diagnostics role, which ADR-007 keeps SELECT-only and separate.`,
      );
    }
    const password = apply ? readEnv(env.password) : DRY_RUN_PASSWORD;
    if (!password) fail(`Set ${env.password} to a long random secret (it is never printed).`);
    if (apply && password.length < MINIMUM_PASSWORD_LENGTH) {
      fail(`${env.password} must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
    }
    if (apply && CONNECTION_STRING_UNSAFE_PASSWORD.test(password)) {
      fail(
        `${env.password} contains a character a connection string cannot carry unencoded (@ / : ? # % or whitespace). Use a hex secret, e.g. \`openssl rand -hex 24\`.`,
      );
    }
    if (apply && password.includes("\\")) {
      fail(
        `${env.password} contains a backslash, which could end a SQL string literal early. Use a hex secret, e.g. \`openssl rand -hex 24\`.`,
      );
    }
    credentials[kind] = { roleName, password };
  }

  let statements: string[];
  try {
    statements = buildDatabaseRolesSql({ databaseName, ...credentials });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (!apply) {
    console.log(
      `-- DRY RUN for database ${databaseName}: nothing was executed.\n` +
        `-- Every password literal below is a PLACEHOLDER, not a secret.\n` +
        `-- Re-run with --apply to execute these ${statements.length} statements in one transaction.\n`,
    );
    for (const statement of statements) console.log(`${statement}\n`);
    return;
  }

  void run(adminUrl, statements, {
    databaseName,
    names: Object.fromEntries(ROLE_KINDS.map((kind) => [kind, credentials[kind].roleName])) as Record<
      DatabaseRoleKind,
      string
    >,
  });
}

async function run(
  adminUrl: string,
  statements: string[],
  info: { databaseName: string; names: Record<DatabaseRoleKind, string> },
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  // Server notices are surfaced, not swallowed: "relation does not exist yet,
  // re-run after the migrations" arrives as one.
  const notices: string[] = [];
  client.on("notice", (notice) => {
    notices.push(`${String(notice.severity ?? "NOTICE").toUpperCase()}: ${notice.message ?? ""}`);
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // The statement list is not echoed: it holds the password literals.
    const code = (err as { code?: string }).code;
    if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED) {
      console.error(
        "[provision-database-roles] Another session held a lock this run needed, so it stopped within its timeout and was rolled back: nothing changed. Retry in a quiet window (no long-running report, merge or open psql transaction).",
      );
    }
    console.error(
      `[provision-database-roles] Provisioning failed and was rolled back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    for (const notice of notices) console.error(`  ${notice}`);
    process.exitCode = 1;
    return;
  } finally {
    await client.end().catch(() => {});
  }

  for (const notice of notices) console.log(`  ${notice}`);
  console.log(
    [
      `[provision-database-roles] Provisioned on ${info.databaseName}: migration role "${info.names.migrator}" (owns the schema), application role "${info.names.app}", audit-retention role "${info.names.auditRetention}".`,
      "  Re-checked inside the same transaction: none is a superuser or a member of a wider role,",
      "  and the application role cannot UPDATE or DELETE the booking ledger or the audit log.",
      "",
      "  To switch the Compose stack over (blue/green, DEPLOYMENT.md \"Least-privilege database roles\"),",
      "  set these in .env with the passwords you supplied, then deploy (postgres:5432 is the",
      "  stock Compose host; use your own outside Compose):",
      `    APP_DB_USER=${info.names.app}`,
      "    APP_DB_PASSWORD=<APP_DB_PASSWORD>",
      `    MIGRATION_DB_USER=${info.names.migrator}`,
      "    MIGRATION_DB_PASSWORD=<MIGRATION_DB_PASSWORD>",
      `    AUDIT_RETENTION_DATABASE_URL=postgresql://${info.names.auditRetention}:<AUDIT_RETENTION_DB_PASSWORD>@postgres:5432/${info.databaseName}?connection_limit=2&pool_timeout=10`,
      "",
      "  Re-run with --apply after the first migration on an empty database, after a release",
      "  that adds an append-only relation, and to rotate a password. It is idempotent.",
    ].join("\n"),
  );
}

main();

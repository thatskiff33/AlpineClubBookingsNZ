/**
 * AI Diagnostics — the dedicated SELECT-only database connection (AID-5, #2374;
 * contract in ADR-007).
 *
 * This is the ONLY place in the codebase that opens a database connection with
 * the diagnostics credential, and it deliberately does NOT go through
 * `@/lib/prisma`. Two reasons, both load-bearing:
 *
 *  1. The application's Prisma client is bound to `DATABASE_URL`, whose Compose
 *     role is a SUPERUSER (`docker-compose.yml`). Reusing it — even read-only,
 *     even "just for a SELECT" — would put every diagnostics query one bug away
 *     from the encrypted credential store. ADR-007 forbids it outright.
 *  2. A raw `pg` pool is what lets each read run inside an explicit
 *     `BEGIN READ ONLY` with its own `statement_timeout`, `lock_timeout` and
 *     `idle_in_transaction_session_timeout`, and with a SQL-level row cap the
 *     executor imposes itself. Those are transaction-scoped session settings
 *     Prisma does not expose per query.
 *
 * FAIL CLOSED, TWICE OVER. The credential is refused unless it is present,
 * parseable, carries no connection parameter that would redirect it, and is
 * demonstrably NOT the application role; and the connected role is refused
 * unless the server itself confirms it is the role we vetted, is a non-superuser,
 * holds no write privilege on any relation, can read nothing outside the declared
 * `SELECT` allowlist, and has no TEMP, no CREATE, no membership in ANY other role,
 * no `SECURITY DEFINER` routine privilege and no file-reading function privilege. A
 * deployment that has not run the provisioning step gets a loud refusal, never a
 * superuser fallback.
 *
 * WHAT THIS MODULE NEVER DOES: it never accepts SQL from a caller outside the
 * server-owned registry, never interpolates a value into SQL (every argument is
 * a positional parameter), and never lets a PostgreSQL error message out of this
 * function — a driver error can quote the failing statement and its parameter
 * values, so only the SQLSTATE travels, to the log and to Sentry alike.
 */

import "server-only";

import { Pool, type PoolClient, type QueryResult } from "pg";

import logger from "@/lib/logger";
import { reportAiError } from "@/lib/observability-bridge";

import { FORBIDDEN_PREDEFINED_ROLES, SELECT_GRANTS } from "./provision-role";
import { DIAGNOSTICS_TOOL_BOUNDS } from "./types";

/**
 * The environment variable holding the dedicated SELECT-only connection string.
 * Deployment-local (ADR-006): it never travels in a config bundle, and there is
 * deliberately NO fallback to `DATABASE_URL`.
 */
export const AI_DIAGNOSTICS_DATABASE_URL_ENV = "AI_DIAGNOSTICS_DATABASE_URL";

/** Marks the diagnostics backends in `pg_stat_activity` for an operator. */
export const DIAGNOSTICS_APPLICATION_NAME = "ai-diagnostics-select-only";

export type DiagnosticsDatabaseConfigProblem =
  /** The env var is absent or blank. */
  | "not_set"
  /** The env var is not a parseable postgres:// URL. */
  | "malformed_url"
  /** The URL carries no username, so the role cannot be checked at all. */
  | "missing_role"
  /** Byte-identical to `DATABASE_URL`, or the same role as the application. */
  | "reuses_application_role"
  /** The URL carries a query parameter that would override what we vetted. */
  | "unsafe_url_parameters";

/**
 * Query parameters this module REFUSES on the diagnostics URL, because `pg` lets
 * one of them override the very thing the gate above checked.
 *
 * `pg` builds its connection from `pg-connection-string`, which copies every
 * query parameter into the config and only then falls back to the URL's own
 * userinfo (`config.user = config.user || decodeURIComponent(result.username)`),
 * and `ConnectionParameters` merges the parsed connection string OVER the pool's
 * explicit options. Measured against pg 8.22.0: with
 * `postgresql://ai_diagnostics_ro:pw@host/db?user=tac_app&password=…` the driver
 * connects as `tac_app` while `URL.username` — the name this gate compares
 * against `DATABASE_URL` — still reads `ai_diagnostics_ro`. `host`/`port` do the
 * same to the SERVER, and `statement_timeout=0`/`options=-c…` do it to the bounds
 * the pool sets.
 *
 * Refusing the parameters rather than re-parsing with the driver's own parser
 * keeps this function dependency-free (`pg-connection-string` is a transitive
 * dependency, not a declared one) and makes the equivalence exact: with no `user`
 * parameter present, the driver's effective user IS `URL.username`. The connected
 * role is then re-checked against the server's `current_user` anyway — see
 * `DiagnosticsRolePrivilegeReport.matchesConfiguredRole`.
 *
 * Everything else an operator legitimately writes — `sslmode`, `sslrootcert`,
 * `connection_limit`, `application_name` is deliberately NOT here because the
 * pool sets it and an override is cosmetic — is untouched.
 */
export const REFUSED_DIAGNOSTICS_URL_PARAMETERS: readonly string[] = [
  "user",
  "password",
  "host",
  "port",
  "options",
  "statement_timeout",
  "query_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "replication",
];

export type DiagnosticsDatabaseConfigResult =
  | { ok: true; url: string; roleName: string }
  | { ok: false; problem: DiagnosticsDatabaseConfigProblem };

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve and vet the diagnostics connection string WITHOUT connecting. Pure
 * enough to unit-test exhaustively, which matters: this is the check that stops a
 * deployment from pointing diagnostics at its superuser by copy-paste.
 *
 * The role comparison is case-insensitive on purpose. PostgreSQL role names are
 * case-sensitive only when they were created quoted; an operator who writes
 * `TAC` in one URL and `tac` in the other has still reused the application role,
 * and "the check did not fire because of capitalisation" is not a failure mode
 * worth keeping.
 */
export function resolveDiagnosticsDatabaseConfig(): DiagnosticsDatabaseConfigResult {
  const raw = readEnv(AI_DIAGNOSTICS_DATABASE_URL_ENV);
  if (!raw) return { ok: false, problem: "not_set" };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, problem: "malformed_url" };
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return { ok: false, problem: "malformed_url" };
  }

  // Before the role is read at all: a parameter that would make the driver
  // connect as somebody else turns every check below into theatre.
  for (const parameter of parsed.searchParams.keys()) {
    if (REFUSED_DIAGNOSTICS_URL_PARAMETERS.includes(parameter.toLowerCase())) {
      return { ok: false, problem: "unsafe_url_parameters" };
    }
  }

  const roleName = decodeURIComponent(parsed.username);
  if (!roleName) return { ok: false, problem: "missing_role" };

  const applicationUrl = readEnv("DATABASE_URL");
  if (applicationUrl) {
    if (applicationUrl === raw) {
      return { ok: false, problem: "reuses_application_role" };
    }
    try {
      const applicationRole = decodeURIComponent(new URL(applicationUrl).username);
      if (applicationRole && isSameRoleName(applicationRole, roleName)) {
        return { ok: false, problem: "reuses_application_role" };
      }
    } catch {
      // An unparseable DATABASE_URL is the application's problem, not ours; the
      // byte-equality check above already caught the copy-paste case.
    }
  }

  return { ok: true, url: raw, roleName };
}

/**
 * `pg_catalog` functions whose EXECUTE privilege would let this role read the
 * server's filesystem or write a file through a large object. Checked by NAME
 * across every overload, because PostgreSQL ships each signature as a separate
 * function with a separate ACL: `pg_read_file(text)`,
 * `pg_read_file(text, bigint, bigint)` and
 * `pg_read_file(text, bigint, bigint, boolean)` are three ACLs, and since
 * PostgreSQL 11 EXECUTE on ANY of them is by itself enough to read a file under
 * the data directory. Checking one hard-coded signature was a canary that could
 * not fire: measured against postgres:16, granting only the three-argument
 * overload left the old single-signature check reporting `false` while the role
 * really did read `postgresql.conf`.
 *
 * None of these carries a PUBLIC grant on a stock server (verified on
 * postgres:16.14: `has_function_privilege('public', …)` is false for all 15
 * overloads), so a correctly provisioned role reports zero and the check does not
 * refuse an untouched deployment.
 */
export const FORBIDDEN_SERVER_FILE_FUNCTIONS = [
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
] as const;

/**
 * The privileges the connected role must NOT hold. Each key is checked by the
 * server, not inferred from configuration, so a hand-edited role that drifted
 * back towards write access is caught while the process is still running — within
 * `DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs` — rather than at the next code
 * review or the next container restart.
 */
export interface DiagnosticsRolePrivilegeReport {
  /** `current_user` as the SERVER reports it, not as the URL claims it. */
  roleName: string;
  /**
   * False when the server connected us as some role OTHER than the one
   * `resolveDiagnosticsDatabaseConfig` vetted. That gate compares the URL's
   * userinfo against `DATABASE_URL`; this is the same question asked of the
   * server, so a parameter, an environment default or a future driver quirk that
   * redirected the login cannot leave the vetted name standing in for the real
   * one.
   */
  matchesConfiguredRole: boolean;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  bypassesRls: boolean;
  /** `TEMPORARY` on the current database — enables `CREATE TEMP TABLE`. */
  canCreateTempTables: boolean;
  /** `CREATE` on the current database — enables `CREATE SCHEMA`. */
  canCreateInDatabase: boolean;
  /** `CREATE` on schema `public` — enables `CREATE TABLE`. */
  canCreateInPublicSchema: boolean;
  /** EXECUTE on ANY overload of `FORBIDDEN_SERVER_FILE_FUNCTIONS`. */
  canReadServerFiles: boolean;
  /**
   * Roles OTHER than itself that this role is a member of — directly or through a
   * chain — and THE membership gate. A correctly provisioned diagnostics role is a
   * member of nothing, so the only safe answer is zero.
   *
   * It is a total count and not a list of names because the role is `NOINHERIT`, and
   * for a `NOINHERIT` role a membership is invisible to every other column in this
   * report: `rolsuper` is read for `current_user` only, and `has_table_privilege`,
   * `has_any_column_privilege`, `has_function_privilege` and
   * `pg_has_role(…, 'USAGE')` all respect `rolinherit`. Measured on postgres:16.14,
   * `GRANT "tac_app" TO "ai_diagnostics_ro"` (an ordinary non-superuser application
   * role) left every boolean false and all four other counts at zero — and one
   * `SET ROLE "tac_app"` then read `IntegrationCredential` and inserted a `Booking`.
   * `GRANT "postgres"` was equally invisible, including to `canReadServerFiles`,
   * while `SET ROLE "postgres"; pg_read_file('postgresql.conf', 0, 60)` returned the
   * file. Enumerating role names cannot close that: the escalation is whichever role
   * the operator happened to grant.
   *
   * TRANSITIVE on purpose. `SET ROLE` reachability is not limited to direct grants —
   * measured on the same server, `GRANT far TO mid; GRANT mid TO diag` gives
   * `pg_has_role(diag, far, 'MEMBER')` = true and a live session really does
   * `SET ROLE far` — so counting `pg_auth_members` rows (direct grants only) would
   * miss a two-hop chain. `pg_has_role(…, 'MEMBER')` is the closure, which is why it
   * is the predicate here.
   *
   * ONE MEMBERSHIP IS IMPLICIT and cannot be provisioned away: PostgreSQL treats the
   * owner of the current database as a member of `pg_database_owner`, with no row in
   * `pg_auth_members`. Measured — a role owning its database reports 1 here, 0
   * recorded rows, and `pg_has_role(current_user, 'pg_database_owner', 'MEMBER')`
   * true; and in this schema `public` is owned by `pg_database_owner`, so the
   * membership is a real privilege rather than a bookkeeping artefact. Refusing is
   * correct; re-provisioning cannot clear it. Nothing in the documented deployment
   * creates that situation, and `deployment.md` records it as the one refusal whose
   * remedy is "do not make the diagnostics role a database owner".
   */
  roleMemberships: number;
  /**
   * Membership count across FORBIDDEN_PREDEFINED_ROLES that exist on this server — a
   * SUBSET of `roleMemberships`, kept because it lets the refusal say what went wrong
   * ("it was granted a predefined escalation role") instead of only counting.
   * `roleMemberships === 0` is the gate; this is the better sentence for an operator.
   */
  forbiddenRoleMemberships: number;
  /**
   * WHICH predefined roles, so the refusal names them instead of only counting them.
   * The operator guide promised a named refusal and nothing emitted a name: the
   * readiness surface deliberately carries no privilege detail (it is JSON an admin
   * browser receives) and the log carried counts alone, which left "granted
   * `pg_read_all_data`" and "granted `pg_signal_backend`" indistinguishable in the
   * one place an operator would look.
   *
   * Safe to log, unlike role names in general: every value here is matched against
   * `FORBIDDEN_PREDEFINED_ROLES`, so it can only ever be one of eight names from this
   * repository's own source — PostgreSQL built-ins, not deployment secrets and not
   * server text we chose to trust. The TOTAL membership count is deliberately NOT
   * expanded into names for the same reason inverted: those are arbitrary role names
   * from the cluster.
   */
  forbiddenRoleNames: readonly string[];
  /**
   * Relations in schema `public` on which the role holds INSERT, UPDATE, DELETE or
   * TRUNCATE — at table OR column level. This is the column that makes the name
   * "SELECT-only" a server-verified fact rather than a naming convention: without
   * it nothing in the runtime path asked about a single table privilege, and a role
   * carrying full DML was reported `verified`.
   */
  writableRelations: number;
  /**
   * Relations in schema `public` the role can SELECT (table or column level) that
   * `SELECT_GRANTS` does not declare. Zero is the whole allowlist claim: a
   * hand-added `GRANT SELECT ON "IntegrationCredential"` is caught here, and a
   * tool pack's grant is only accepted once it is declared in public code.
   *
   * Scoped to `public` on purpose — it is the only schema the role is granted
   * USAGE on and the only one a registry query can name (the executor pins
   * `search_path`), and widening the scan to every schema would count the
   * `pg_catalog` relations PUBLIC can read and refuse every deployment.
   */
  undeclaredReadableRelations: number;
  /**
   * Column-restricted declarations carrying a table-level SELECT grant. This is
   * distinct from `undeclaredReadableColumns`: when a declaration currently names
   * every physical column (FamilyGroupMember), a widened table grant exposes no
   * extra column today but would silently expose the next schema column.
   */
  tableWideSelectOnColumnRestrictedRelations: number;
  /**
   * COLUMNS in schema `public` the role can SELECT that `SELECT_GRANTS` does not
   * declare — the column-level twin of the count above, and the control that makes a
   * column allowlist real (AID-6A, #2375).
   *
   * `AuditLog` is granted by COLUMN precisely because the table also carries
   * `ipAddress`, `userAgent`, `summary`, `details`, `metadata` and three
   * member-identifying columns. Without this count, a hand-added
   * `GRANT SELECT ON "AuditLog"` would leave `undeclaredReadableRelations` at zero —
   * the relation IS declared — while the role could read every one of those columns.
   * Measured on postgres:16: with the eight-column grant in place,
   * `has_table_privilege(…, 'AuditLog', 'SELECT')` is FALSE and
   * `has_any_column_privilege(…, 'SELECT')` is TRUE, so the relation-level count
   * cannot distinguish the two grants at all.
   *
   * A relation declared WITHOUT a column list is skipped here: every one of its
   * columns is legitimately readable, and enumerating them in TypeScript would make
   * the allowlist track the schema.
   */
  undeclaredReadableColumns: number;
  /** Declared relations that the connected role cannot SELECT at all. */
  missingReadableRelations: number;
  /** Declared column grants that are absent from the connected role. */
  missingReadableColumns: number;
  /**
   * `SECURITY DEFINER` routines in schema `public` the role may EXECUTE. Such a
   * routine runs with its OWNER's privileges, so one of them is a write path that
   * no table grant would show. It is checked rather than revoked because
   * PostgreSQL grants EXECUTE on every new function to PUBLIC and a PUBLIC grant
   * cannot be revoked for one role — measured on the migrated schema: 233 routines
   * in `public`, all executable by the provisioned role, none of them
   * `SECURITY DEFINER`. Counting all of them would refuse every deployment;
   * counting the `SECURITY DEFINER` ones is zero today and loud the moment one
   * appears.
   */
  executableSecurityDefinerRoutines: number;
}

/** True only when every checked privilege is absent. */
export function isDiagnosticsRolePrivilegeSafe(
  report: DiagnosticsRolePrivilegeReport,
): boolean {
  return (
    report.matchesConfiguredRole &&
    !report.isSuperuser &&
    !report.canCreateDb &&
    !report.canCreateRole &&
    !report.canReplicate &&
    !report.bypassesRls &&
    !report.canCreateTempTables &&
    !report.canCreateInDatabase &&
    !report.canCreateInPublicSchema &&
    !report.canReadServerFiles &&
    report.roleMemberships === 0 &&
    // The membership gate is the TOTAL, not the named subset: a member of any role
    // at all is one `SET ROLE` from that role's privileges, and a NOINHERIT role
    // hides the fact from every other column here.
    report.forbiddenRoleMemberships === 0 &&
    // Redundant with the count above, and kept so on purpose: this is a fail-closed
    // gate, so a future change that populated the names without the count — or a
    // server that answered with one and not the other — must still refuse.
    report.forbiddenRoleNames.length === 0 &&
    report.writableRelations === 0 &&
    report.undeclaredReadableRelations === 0 &&
    report.tableWideSelectOnColumnRestrictedRelations === 0 &&
    // The column-level twin of the line above. Not redundant with it: a relation the
    // allowlist declares BY COLUMN is excluded from the relation count, so only this
    // one notices a grant that widened to the whole table.
    report.undeclaredReadableColumns === 0 &&
    report.missingReadableRelations === 0 &&
    report.missingReadableColumns === 0 &&
    report.executableSecurityDefinerRoutines === 0
  );
}

/**
 * The privilege interrogation, as one statement so it cannot half-run. Written
 * against `pg_catalog` explicitly because `search_path` is attacker-adjacent
 * state and this query is the thing that decides whether we trust the session at
 * all.
 *
 * `pg_has_role(…, 'MEMBER')` and NOT `'USAGE'`. The provisioning pins the role
 * NOINHERIT, and for a NOINHERIT role `USAGE` is FALSE while `MEMBER` is TRUE — so
 * the `USAGE` predicate reported ZERO memberships for a role that had been handed
 * `pg_write_all_data` by hand and could reach every table with one `SET ROLE`.
 * Measured on postgres:16.14: `{usage: false, member: true}` for exactly that
 * grant, and `SET ROLE pg_read_all_data` then read a table the role held no grant
 * on. `MEMBER` is the predicate that matches how the privilege is actually
 * reachable.
 *
 * MEMBERSHIP IS COUNTED TWICE, and the TOTAL is the gate. `role_memberships` counts
 * every role other than `current_user` itself that `current_user` is a member of;
 * `forbidden_role_memberships` counts the named subset, purely so a refusal can say
 * which shape of mistake it was. Asking only about the eight named roles left the
 * same hole one step to the side: `GRANT "tac_app"` or `GRANT "postgres"` to the
 * diagnostics role is invisible to every other column of this report (a NOINHERIT
 * role's membership does not show up in `rolsuper`, in `has_table_privilege`, in
 * `has_function_privilege` or in `pg_has_role(…, 'USAGE')`) and is one `SET ROLE`
 * from reading `IntegrationCredential`, writing `Booking`, or reading
 * `postgresql.conf`. A correctly provisioned role belongs to nothing, so zero is
 * both the honest gate and a gate no valid deployment trips.
 *
 * The subject is `pg_roles` rather than `pg_auth_members` because `SET ROLE`
 * reachability is transitive: measured on the same server, `GRANT far TO mid;
 * GRANT mid TO diag` yields `pg_has_role(diag, far, 'MEMBER')` = true and a live
 * session as `diag` really does `SET ROLE far`. Counting the direct grant rows in
 * `pg_auth_members` would report 1 where the reachable set is 2.
 *
 * The relation and routine counts at the end use table AND column level predicates:
 * `GRANT INSERT (note) ON …` is a write privilege that `has_table_privilege`
 * alone reports as absent.
 *
 * The table-wide count is the direct control that tells a column-restricted grant
 * from a table-wide one even when the declaration currently names every physical
 * column. The COLUMN count (`undeclared_readable_columns`, AID-6A #2375) separately
 * counts fields gained beyond the declaration. `AuditLog` is
 * granted eight columns because the rest of that table is IP addresses, user agents,
 * free text, arbitrary JSON and member ids; a hand-added table-level
 * `GRANT SELECT ON "AuditLog"` leaves every other count in this report unchanged —
 * the relation is declared, so `undeclared_readable_relations` stays 0 — while the
 * role gains all of them. Measured on postgres:16: with the eight-column grant,
 * `has_table_privilege` is false and `has_any_column_privilege` is true, so the
 * relation-level predicates cannot separate the two grants even in principle.
 */
const ROLE_PRIVILEGE_SQL = `
SELECT
  current_user::text                                                  AS role_name,
  r.rolsuper                                                          AS is_superuser,
  r.rolcreatedb                                                       AS can_create_db,
  r.rolcreaterole                                                     AS can_create_role,
  r.rolreplication                                                    AS can_replicate,
  r.rolbypassrls                                                      AS bypasses_rls,
  pg_catalog.has_database_privilege(current_user, current_database(), 'TEMPORARY')      AS can_create_temp_tables,
  pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')         AS can_create_in_database,
  pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')                     AS can_create_in_public_schema,
  (
    SELECT count(*) > 0
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog'
      AND p.proname = ANY($2::text[])
      AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')
  )                                                                   AS can_read_server_files,
  (
    SELECT count(*)
    FROM pg_catalog.pg_roles other
    WHERE other.oid <> r.oid
      AND pg_catalog.pg_has_role(current_user, other.oid, 'MEMBER')
  )::int                                                              AS role_memberships,
  (
    SELECT count(*)
    FROM pg_catalog.pg_roles forbidden
    WHERE forbidden.rolname = ANY($1::text[])
      AND pg_catalog.pg_has_role(current_user, forbidden.oid, 'MEMBER')
  )::int                                                              AS forbidden_role_memberships,
  (
    SELECT coalesce(array_agg(forbidden.rolname::text ORDER BY forbidden.rolname), '{}'::text[])
    FROM pg_catalog.pg_roles forbidden
    WHERE forbidden.rolname = ANY($1::text[])
      AND pg_catalog.pg_has_role(current_user, forbidden.oid, 'MEMBER')
  )                                                                   AS forbidden_role_names,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
      AND (
        pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, c.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, c.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE')
        OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'UPDATE')
      )
  )::int                                                              AS writable_relations,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
      AND (
        pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'SELECT')
      )
      AND NOT ((n.nspname || '.' || c.relname) = ANY($3::text[]))
  )::int                                                              AS undeclared_readable_relations,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
      AND (n.nspname || '.' || c.relname) = ANY($3::text[])
      -- Parameter 5 contains the deliberately whole-relation declarations. Every
      -- other declared relation must remain a column ACL even when its current
      -- declaration happens to enumerate every physical column.
      AND NOT ((n.nspname || '.' || c.relname) = ANY($5::text[]))
      AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
  )::int                                                              AS table_wide_select_on_column_restricted_relations,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
      AND pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')
      -- A relation declared WITHOUT a column list: all of its columns are allowed.
      AND NOT ((n.nspname || '.' || c.relname) = ANY($5::text[]))
      -- Otherwise the column itself has to be on the allowlist. A relation the
      -- allowlist does not declare at all contributes every readable column here as
      -- well as one row to the relation count above, which is the right answer twice.
      AND NOT (
        (n.nspname || '.' || c.relname || '.' || a.attname) = ANY($4::text[])
      )
  )::int                                                              AS undeclared_readable_columns,
  (
    SELECT count(*)
    FROM pg_catalog.unnest($3::text[]) expected(relation_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
        AND (n.nspname || '.' || c.relname) = expected.relation_key
        AND (
          -- A whole-relation declaration is satisfied only by a table-level
          -- grant. One hand-granted column must not make it look provisioned:
          -- Parameter 4 has no per-column expectations for whole relations.
          (
            expected.relation_key = ANY($5::text[])
            AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
          )
          OR (
            NOT (expected.relation_key = ANY($5::text[]))
            AND (
              pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
              OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'SELECT')
            )
          )
        )
    )
  )::int                                                              AS missing_readable_relations,
  (
    SELECT count(*)
    FROM pg_catalog.unnest($4::text[]) expected(column_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relkind = ANY (ARRAY['r','v','m','f','p'])
        AND (n.nspname || '.' || c.relname || '.' || a.attname) = expected.column_key
        AND pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')
    )
  )::int                                                              AS missing_readable_columns,
  (
    SELECT count(*)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')
  )::int                                                              AS executable_security_definer_routines
FROM pg_catalog.pg_roles r
WHERE r.rolname = current_user
`;

/** The declared allowlist as the probe compares it: `schema.relation`. */
function declaredSelectGrantKeys(): string[] {
  return SELECT_GRANTS.map((grant) => `${grant.schema}.${grant.relation}`);
}

/**
 * The COLUMN allowlist as the probe compares it: `schema.relation.column`, for the
 * entries that declare a column list (AID-6A, #2375).
 */
function declaredSelectColumnKeys(): string[] {
  return SELECT_GRANTS.flatMap((grant) =>
    (grant.columns ?? []).map(
      (column) => `${grant.schema}.${grant.relation}.${column}`,
    ),
  );
}

/**
 * The relations declared for the WHOLE relation — every column of these is
 * legitimately readable, so the column-level count skips them entirely.
 */
function declaredWholeRelationGrantKeys(): string[] {
  return SELECT_GRANTS.filter((grant) => grant.columns === undefined).map(
    (grant) => `${grant.schema}.${grant.relation}`,
  );
}

/**
 * PostgreSQL folds an unquoted identifier to lower case, and an operator who
 * capitalises the role in one connection string and not the other has still named
 * the same role. Used by both role comparisons — the configured-vs-application
 * check above and the configured-vs-`current_user` check below — so "the same
 * role" means one thing in this module.
 */
function isSameRoleName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

interface PoolCacheEntry {
  url: string;
  pool: Pool;
  /** The in-flight or settled privilege verdict for this pool. */
  privileges: Promise<DiagnosticsRolePrivilegeReport>;
  /**
   * When the probe above was STARTED (not when it settled). The TTL is measured
   * from the start so a slow probe cannot extend its own freshness window.
   */
  probeStartedAt: number;
}

let cached: PoolCacheEntry | null = null;

function createPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: DIAGNOSTICS_APPLICATION_NAME,
    // Belt on top of the per-transaction `SET LOCAL`: even a connection that
    // somehow skipped the transaction wrapper cannot sit on a long query.
    statement_timeout: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
    // CLIENT-SIDE deadline, and not the same control as `statement_timeout`.
    // `connectionTimeoutMillis` bounds only acquiring a client; in pg 8.x the
    // query round trip is bounded solely by `query_timeout`, which defaults to
    // false. `statement_timeout` is the SERVER cancelling and replying — which
    // helps only if a reply can travel back. A firewall change that black-holes
    // packets, or a pooler that keeps the socket open and never answers, would
    // otherwise leave the privilege probe pending for the OS TCP retransmission
    // limit or forever, and every readiness request joins that same cached
    // promise. "We could not tell" must be a refusal, never a hang.
    //
    // It is LONGER than `statement_timeout` on purpose: the server's own
    // cancellation must win the ordinary slow-query case, so a timed-out read is
    // still reported as SQLSTATE 57014 rather than as an opaque client abort.
    query_timeout: DIAGNOSTICS_TOOL_BOUNDS.queryTimeoutMs,
    // TCP keepalives so a silently dead peer is eventually detected at all.
    keepAlive: true,
  });
}

async function readRolePrivileges(
  pool: Pool,
  configuredRoleName: string,
): Promise<DiagnosticsRolePrivilegeReport> {
  const result = await pool.query(ROLE_PRIVILEGE_SQL, [
    [...FORBIDDEN_PREDEFINED_ROLES],
    [...FORBIDDEN_SERVER_FILE_FUNCTIONS],
    declaredSelectGrantKeys(),
    declaredSelectColumnKeys(),
    declaredWholeRelationGrantKeys(),
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Diagnostics role privilege probe returned no row.");
  }
  const roleName = String(row.role_name ?? "");
  return {
    roleName,
    matchesConfiguredRole:
      roleName.length > 0 && isSameRoleName(roleName, configuredRoleName),
    isSuperuser: row.is_superuser === true,
    canCreateDb: row.can_create_db === true,
    canCreateRole: row.can_create_role === true,
    canReplicate: row.can_replicate === true,
    bypassesRls: row.bypasses_rls === true,
    canCreateTempTables: row.can_create_temp_tables === true,
    canCreateInDatabase: row.can_create_in_database === true,
    canCreateInPublicSchema: row.can_create_in_public_schema === true,
    canReadServerFiles: row.can_read_server_files === true,
    roleMemberships: Number(row.role_memberships ?? 0),
    forbiddenRoleMemberships: Number(row.forbidden_role_memberships ?? 0),
    // Re-filtered against our own constant rather than trusted as returned. The SQL
    // already restricts the rows to `$1`, so this cannot change a correct answer —
    // it means a driver, a mock or a future edit cannot put arbitrary server text
    // into the value that gets logged.
    forbiddenRoleNames: (Array.isArray(row.forbidden_role_names)
      ? row.forbidden_role_names.map((name) => String(name))
      : []
    ).filter((name): name is (typeof FORBIDDEN_PREDEFINED_ROLES)[number] =>
      (FORBIDDEN_PREDEFINED_ROLES as readonly string[]).includes(name),
    ),
    writableRelations: Number(row.writable_relations ?? 0),
    undeclaredReadableRelations: Number(row.undeclared_readable_relations ?? 0),
    tableWideSelectOnColumnRestrictedRelations: Number(
      row.table_wide_select_on_column_restricted_relations ?? 0,
    ),
    undeclaredReadableColumns: Number(row.undeclared_readable_columns ?? 0),
    missingReadableRelations: Number(row.missing_readable_relations ?? 0),
    missingReadableColumns: Number(row.missing_readable_columns ?? 0),
    executableSecurityDefinerRoutines: Number(
      row.executable_security_definer_routines ?? 0,
    ),
  };
}

/**
 * Start a probe and make sure its rejection is always handled. A caller that hits
 * the deadline below stops awaiting this promise, and an unhandled rejection can
 * take the whole Node process down — the same reason the pool carries an `error`
 * listener.
 */
function startRolePrivilegeProbe(
  pool: Pool,
  configuredRoleName: string,
): Promise<DiagnosticsRolePrivilegeReport> {
  const probe = readRolePrivileges(pool, configuredRoleName);
  void probe.catch(() => {});
  return probe;
}

/**
 * Await `promise`, or reject once `timeoutMs` has passed. Belt for the pool's
 * `query_timeout`: a probe that never settles must become a REFUSAL rather than a
 * pending promise every later caller joins.
 */
async function awaitWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        // Never hold the process open for a deadline nobody is waiting on.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The verified pool, or a typed refusal. The privilege probe is cached for at most
 * `DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs`, so a session's eight tool calls
 * normally pay for one probe — and a fresh process, a changed connection string, a
 * closed pool, a thrown probe or an UNSAFE verdict all re-probe immediately.
 *
 * The TTL is the fix for a claim this module used to make and not keep. The
 * verdict was cached for the LIFE OF THE PROCESS on the ok path, so a role
 * escalated at 10:00 on a container that first ran a tool at 09:00 kept being
 * reported `verified` until the container restarted — while both this docblock and
 * the operator guide promised the drift was caught on the next tool call. A role's
 * privileges are database state, not request state, so re-reading them once a
 * minute rather than once per call is the right cost; but "once, ever" is not a
 * check. Caching within the TTL is still not the "stale permission matrix" mistake
 * ADR-002 forbids — that is about the CALLER's authorization, which is re-read on
 * every single invocation in `authorize.ts`.
 */
export type DiagnosticsDatabaseHandle =
  | { ok: true; pool: Pool; roleName: string }
  | {
      ok: false;
      reason:
        | "database_not_configured"
        | "database_role_unsafe"
        | "database_grants_missing";
      problem?: DiagnosticsDatabaseConfigProblem;
      report?: DiagnosticsRolePrivilegeReport;
    };

export async function getDiagnosticsDatabase(): Promise<DiagnosticsDatabaseHandle> {
  const config = resolveDiagnosticsDatabaseConfig();
  if (!config.ok) {
    return {
      ok: false,
      reason: "database_not_configured",
      problem: config.problem,
    };
  }

  if (cached && cached.url !== config.url) {
    const stale = cached;
    cached = null;
    void stale.pool.end().catch(() => {});
  }
  if (!cached) {
    const pool = createPool(config.url);
    // A pool-level error listener is mandatory: an idle client that the server
    // terminates emits `error` on the Pool, and an unhandled one takes the whole
    // Node process down.
    pool.on("error", (err) => {
      reportAiError({
        tag: "diagnostics-select-only-pool",
        message: "Idle diagnostics SELECT-only connection errored",
        err,
      });
    });
    cached = {
      url: config.url,
      pool,
      privileges: startRolePrivilegeProbe(pool, config.roleName),
      probeStartedAt: Date.now(),
    };
  } else if (
    Date.now() - cached.probeStartedAt >=
    DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs
  ) {
    // The verdict has aged out: re-ask the server on the SAME pool. The timestamp
    // is stamped before the probe starts, so two concurrent callers that both see
    // a stale entry cannot both queue a probe.
    cached.probeStartedAt = Date.now();
    cached.privileges = startRolePrivilegeProbe(cached.pool, config.roleName);
  }

  /**
   * The entry THIS call is resolving, captured before any await.
   *
   * Everything below reads `entry` rather than `cached`, and only ever discards
   * `cached` when it is still identically this entry. Two concurrent callers
   * awaiting the same probe would otherwise race: the first nulls `cached`, the
   * second reads it as `null` and dereferences it (a `TypeError` that escaped as
   * `internal_error` instead of `database_role_unsafe`, losing the real reason
   * from the audit row), or worse, ends a pool a third caller has just created.
   */
  const entry = cached;
  /**
   * The probe THIS call is awaiting, captured with the entry. A later caller may
   * replace `entry.privileges` when the TTL expires; this one must await the promise
   * it decided to await, not whichever one happens to be current after the await.
   */
  const probe = entry.privileges;

  /** Discard `entry` from the cache, but only if nobody has replaced it since. */
  const discardEntry = (): void => {
    if (cached === entry) cached = null;
    void entry.pool.end().catch(() => {});
  };

  let report: DiagnosticsRolePrivilegeReport;
  try {
    report = await awaitWithDeadline(
      probe,
      DIAGNOSTICS_TOOL_BOUNDS.privilegeProbeTimeoutMs,
      "Diagnostics role privilege probe did not answer in time.",
    );
  } catch (err) {
    // Cannot prove the role is safe ⇒ do not use it. Drop the cache so the next
    // call re-probes rather than inheriting a permanent failure.
    discardEntry();
    reportAiError({
      tag: "diagnostics-select-only-privileges",
      message: "Failed to verify the diagnostics SELECT-only role privileges",
      err,
    });
    return { ok: false, reason: "database_role_unsafe" };
  }

  if (!isDiagnosticsRolePrivilegeSafe(report)) {
    reportAiError({
      tag: "diagnostics-select-only-privileges",
      message:
        "Refusing to use the diagnostics database role: it is not SELECT-only",
      // Privilege counts and booleans only — no connection string, no password, no
      // role secret. The role NAME is deployment configuration an operator needs to
      // act on the alert, and `forbiddenRoleNames` is drawn from this repository's own
      // eight-name constant, so the alert can say WHICH escalation role was granted
      // rather than only that one was. The total membership count is deliberately not
      // expanded into names: those would be arbitrary role names from the cluster.
      context: { ...report },
    });
    // Drop the cache on an UNSAFE verdict, exactly as the probe-threw branch
    // above does. A safe verdict is reused until the TTL expires so a session's
    // tool calls pay for one probe — but caching a REFUSAL even that long would
    // mean an operator who re-runs `npm run diagnostics:provision-role` to repair
    // a drifted role stays refused for another minute, with readiness still
    // reporting the old answer. Re-probing on every call is the right cost for a
    // deployment that is already being refused.
    discardEntry();
    const onlyMissingGrants =
      report.missingReadableRelations > 0 || report.missingReadableColumns > 0
        ? isDiagnosticsRolePrivilegeSafe({
            ...report,
            missingReadableRelations: 0,
            missingReadableColumns: 0,
          })
        : false;
    return {
      ok: false,
      reason: onlyMissingGrants
        ? "database_grants_missing"
        : "database_role_unsafe",
      report,
    };
  }

  return { ok: true, pool: entry.pool, roleName: report.roleName };
}

/**
 * What the ADMIN READINESS surface (AID-2, `getDiagnosticsReadiness`) is allowed
 * to know about the diagnostics credential. Metadata only: a state and, when the
 * server confirmed one, the role NAME. Never the URL, never the password, never
 * the privilege report — a readiness response is JSON an admin browser receives.
 */
export type DiagnosticsDatabaseState =
  /** `AI_DIAGNOSTICS_DATABASE_URL` is absent. Nothing was contacted. */
  | "not_configured"
  /** Present but unusable as configured: malformed, no role, or the app's role. */
  | "misconfigured"
  /** Present, but the server could not be asked — so the role is NOT trusted. */
  | "unverified"
  /**
   * Present and reachable, and the server's answer is not acceptable: the role
   * holds a privilege ADR-007 forbids, can read a relation — or a COLUMN of a
   * column-restricted relation — that the allowlist does not declare, or is not even
   * the role the connection string names.
   */
  | "over_privileged"
  /** Reachable and otherwise safe, but one or more declared grants are absent. */
  | "under_provisioned"
  /**
   * The server itself confirmed the vetted role: a non-superuser that can only
   * SELECT, and only from the declared allowlist.
   */
  | "verified";

export interface DiagnosticsDatabaseReadiness {
  state: DiagnosticsDatabaseState;
  /** Set only when the server reported it (state `verified`). */
  roleName: string | null;
}

/**
 * VERIFY the diagnostics credential for the readiness surface, rather than trust
 * that the environment variable is set (issue #2374's acceptance criterion is
 * explicit about the difference).
 *
 * It deliberately goes through `getDiagnosticsDatabase`, so readiness and tool
 * invocation share ONE implementation of the check and ONE cached probe (aged out
 * on the same TTL) — a second, readiness-shaped copy of the privilege query is
 * exactly how a readiness surface ends up reporting green while the executor
 * refuses. Never throws, and never HANGS either: the probe carries both a
 * client-side `query_timeout` and an explicit deadline, so "we could not tell" is
 * `unverified`, which is a blocker, not a pass — and not a request that never
 * returns.
 */
export async function checkDiagnosticsDatabaseReadiness(): Promise<DiagnosticsDatabaseReadiness> {
  try {
    const handle = await getDiagnosticsDatabase();
    if (handle.ok) return { state: "verified", roleName: handle.roleName };
    if (handle.reason === "database_not_configured") {
      return {
        state: handle.problem === "not_set" ? "not_configured" : "misconfigured",
        roleName: null,
      };
    }
    if (handle.reason === "database_grants_missing") {
      return { state: "under_provisioned", roleName: null };
    }
    // `database_role_unsafe` covers both "the server said no" (a report is
    // present) and "we could not ask" (it is not). They are different operator
    // actions — repair the role vs. fix connectivity — so they stay distinct.
    return {
      state: handle.report ? "over_privileged" : "unverified",
      roleName: null,
    };
  } catch (err) {
    reportAiError({
      tag: "diagnostics-select-only-readiness",
      message: "Failed to resolve diagnostics SELECT-only database readiness",
      err,
    });
    return { state: "unverified", roleName: null };
  }
}

/** Test/shutdown seam: drop the cached pool so the next call re-resolves and re-probes. */
export async function closeDiagnosticsDatabase(): Promise<void> {
  const stale = cached;
  cached = null;
  if (stale) await stale.pool.end().catch(() => {});
}

export interface DiagnosticsReadOnlyQueryInput {
  /** Server-owned SQL from the registry. NEVER caller-supplied. One statement. */
  sql: string;
  /** Positional parameters, already validated by the tool's Zod schema. */
  params: readonly unknown[];
  /**
   * The tool's row ceiling. The executor asks for `rowLimit + 1` rows so it can
   * report truncation honestly, and the cap is applied IN SQL — a tool whose own
   * SQL forgot a LIMIT is still bounded by the database.
   */
  rowLimit: number;
  /**
   * The registry key, for correlating a SQLSTATE in the server log with the tool
   * that produced it. Server-owned public code, never caller text — and the only
   * thing besides the SQLSTATE that a failure is allowed to carry, since the
   * driver's own message can quote parameter values.
   */
  toolId?: string;
}

export type DiagnosticsReadOnlyQueryResult =
  | { ok: true; rows: Record<string, unknown>[]; durationMs: number }
  | { ok: false; durationMs: number; timedOut: boolean };

/** PostgreSQL `query_canceled` — what `statement_timeout` raises. */
const QUERY_CANCELED = "57014";

/**
 * Every `$n` a statement references, in the order they appear (duplicates kept).
 *
 * Exported because `registry.test.ts` holds every entry to the same contract at
 * review time: a registry entry may reference exactly `$1..$N` where N is the
 * length of its `bind` output. A literal `$1` inside a string literal would be
 * counted here too — that is deliberate, because the alternative is parsing SQL,
 * and an entry that needs a dollar-digit in text is a review-time conversation, not
 * a runtime surprise.
 */
export function readSqlPlaceholderNumbers(sql: string): number[] {
  const numbers: number[] = [];
  const pattern = /\$(\d+)/g;
  let match: RegExpExecArray | null = pattern.exec(sql);
  while (match !== null) {
    numbers.push(Number(match[1]));
    match = pattern.exec(sql);
  }
  return numbers;
}

/**
 * Run one registry query as the SELECT-only role, inside a READ ONLY transaction
 * with its own timeouts and a SQL-level row cap.
 *
 * The wrapper subquery is the structural guarantee: whatever a registry entry's
 * SQL says, the executor's own `LIMIT` is the outermost clause, so no tool can
 * ship an unbounded scan by omission. `registry.ts`'s contract test refuses SQL
 * containing a semicolon, which is what makes wrapping safe.
 */
export async function runDiagnosticsReadOnlyQuery(
  input: DiagnosticsReadOnlyQueryInput,
  pool: Pool,
): Promise<DiagnosticsReadOnlyQueryResult> {
  // A non-finite limit must not survive the clamp: `Math.min`/`Math.max` both
  // propagate NaN, so `LIMIT (NaN)` would reach PostgreSQL and the read would fail
  // as `query_failed` — a bound turning into an error rather than a bound. Anything
  // unusable falls back to the substrate ceiling, which is still a real cap.
  const requested = Math.trunc(input.rowLimit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), DIAGNOSTICS_TOOL_BOUNDS.maxRows)
    : DIAGNOSTICS_TOOL_BOUNDS.maxRows;
  const values = [...input.params, limit + 1];
  const wrapped = `SELECT * FROM (${input.sql}) AS diagnostics_tool_result LIMIT ($${values.length})::bigint`;

  // PLACEHOLDER ARITY, checked before a connection is opened. The row cap is
  // appended as `$${values.length}`, which is correct only while the entry's own
  // SQL references exactly `$1..$params.length`. An entry that references a
  // placeholder its `bind` does not supply does NOT fail: PostgreSQL happily lets
  // the row-cap value serve as that placeholder too. Measured on postgres:16 —
  // `… WHERE g > $1 AND g < $2 … LIMIT ($2)` with values `[0, 6]` returned five
  // rows and no error, so a tool that bound one parameter short would have its
  // second predicate silently evaluated against the row cap, and the result would
  // be projected, hashed and audited as a normal success. A refusal here is the
  // only outcome that cannot be mistaken for evidence.
  const referenced = new Set(readSqlPlaceholderNumbers(input.sql));
  const expected = input.params.length;
  const arityOk =
    referenced.size === expected &&
    [...referenced].every((number) => number >= 1 && number <= expected);
  if (!arityOk) {
    reportAiError({
      tag: "diagnostics-tool-query",
      message:
        "Refusing a diagnostics read: the entry's SQL and its bound parameters disagree",
      // Counts only — never the SQL, never the values.
      context: {
        toolId: input.toolId ?? null,
        boundParameters: expected,
        referencedPlaceholders: [...referenced].sort((a, b) => a - b).join(","),
      },
    });
    return { ok: false, durationMs: 0, timedOut: false };
  }

  const startedAt = Date.now();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    // READ ONLY at the transaction level is the database's own refusal of every
    // write, DDL and TEMP-table statement (SQLSTATE 25006) — independent of the
    // role's grants, so both layers have to fail before a write is possible.
    await client.query("BEGIN READ ONLY");
    // Integer literals from a frozen constant object, never from a caller.
    await client.query(
      `SET LOCAL statement_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}`,
    );
    await client.query(
      `SET LOCAL lock_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.lockTimeoutMs}`,
    );
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.idleInTransactionTimeoutMs}`,
    );
    // Pinned per transaction so a role-level or database-level `search_path`
    // cannot redirect an unqualified relation name in a registry query.
    await client.query("SET LOCAL search_path TO public");
    // Pinned for the same reason, and it is a CORRECTNESS control, not a cosmetic
    // one. The platform stores every instant as a naive `timestamp` holding UTC, so
    // any expression that crosses between `timestamp` and `timestamptz` — comparing a
    // column against `now()`, or formatting one with `to_char` after an
    // `AT TIME ZONE` — is resolved using the SESSION's `TimeZone`. On a deployment
    // whose database or role sets `TimeZone` to `Pacific/Auckland`, the same entry
    // would silently shift a window by 12-13 hours and stamp a local time with a `Z`.
    // An entry should still be written to be timezone-independent; this makes a lapse
    // harmless rather than a wrong answer presented as evidence.
    await client.query("SET LOCAL TimeZone TO 'UTC'");

    const result: QueryResult = await client.query(wrapped, values);
    await client.query("COMMIT");
    return {
      ok: true,
      rows: result.rows as Record<string, unknown>[],
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    if (client) await client.query("ROLLBACK").catch(() => {});
    const durationMs = Date.now() - startedAt;
    const timedOut = code === QUERY_CANCELED;
    if (timedOut) {
      // A statement timeout is an EXPECTED, self-limiting, operator-triggerable
      // outcome — an admin asked a heavy question — and it is already reported to
      // them as `query_failed`. Bridging it to Sentry would raise an error-level
      // alert per heavy question, which is exactly the alert-fatigue trap #1150
      // rejected. It still goes to the server log, at warn.
      logger.warn(
        {
          scope: "ai",
          tag: "diagnostics-tool-query",
          toolId: input.toolId ?? null,
          sqlState: code,
          durationMs,
        },
        "Diagnostics SELECT-only read hit the statement timeout",
      );
    } else {
      // The SQLSTATE and the registry key, and NOTHING from the driver. A
      // PostgreSQL error message can quote the statement and its parameter values
      // verbatim — measured: `invalid input syntax for type uuid:
      // "SECRET@example.org"` for a bound argument — and `reportAiError` forwards
      // the error object to `Sentry.captureException` with no redaction at all. So
      // the driver's own message is discarded here rather than travelling to a
      // third party; the cost is that a failure is diagnosed from its SQLSTATE plus
      // the tool id, which for fixed server-owned SQL is enough.
      reportAiError({
        tag: "diagnostics-tool-query",
        message: "Diagnostics SELECT-only query failed",
        err: new Error(
          `Diagnostics SELECT-only query failed with SQLSTATE ${code || "unknown"}`,
        ),
        context: { toolId: input.toolId ?? null, sqlState: code },
      });
    }
    return {
      ok: false,
      durationMs,
      timedOut,
    };
  } finally {
    client?.release();
  }
}

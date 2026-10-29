/**
 * Least-privilege database roles (#4453; owner decision 27 Oct 2026, which
 * replaces #2240's 25 Jul 2026 decision).
 *
 * Three roles replace the one superuser the stock Compose stack connects as:
 *
 *  - the OPERATOR — the existing superuser (`POSTGRES_USER`), for people:
 *    provisioning, restores, hand repairs. No application process needs it once
 *    the roles are split; the deployment guide tells operators never to give the
 *    app a superuser connection string, including for backup restore-validation.
 *  - the MIGRATION role — owns every object in schema `public`, so it can run
 *    `prisma migrate deploy`. Not a superuser, and a member of no role.
 *  - the APPLICATION role — SELECT, INSERT, UPDATE and DELETE on ordinary tables,
 *    only SELECT on views, only INSERT and SELECT on the append-only relations
 *    below, SELECT only on the migration history, and nothing that is not a
 *    table, sequence or TEMPORARY right.
 *
 * WHAT "APPEND-ONLY" MEANS HERE, exactly. No statement the application role
 * runs can UPDATE a ledger line or an audit row, and no route can either: not a
 * view or rule over them (the re-check below refuses one), not a SECURITY
 * DEFINER routine (refused unless allow-listed), and not a parent-key UPDATE (a
 * trigger on "Booking" and "Lodge" refuses any key change, migration
 * `20261125010000_restrict_booking_ledger_key_updates`). ONE route deletes ledger
 * lines on purpose: deleting a booking removes its lines through
 * `BookingLedgerLine.bookingId`'s `ON DELETE CASCADE`, which runs with the table
 * owner's rights. Whether that should change belongs to the ledger design (#4482), not to
 * this grant.
 *
 * plus a fourth, narrow AUDIT-RETENTION role for the one job that must change
 * audit rows: `runAuditLogRetentionJob` anonymises request data after 90 days and
 * deletes expired or archived rows. Beyond SELECT on `AuditLog` it holds only
 * `UPDATE` of the anonymised columns and `DELETE` (the orchestrator's resolution
 * on #4453), so the application role never needs either.
 *
 * PURE ON PURPOSE, like `diagnostics/tools/provision-role.ts`, whose identifier
 * rules and role-creation statements it reuses rather than copies (`INV-SSOT`):
 * no database handle, no environment read, no `server-only`. Three consumers run
 * ONE definition — the operator's `pnpm run db:provision-roles`, its unit test,
 * and `database-roles.realdb.test.ts`, which proves against PostgreSQL that the
 * shipped statements really produce roles that cannot rewrite the ledger.
 *
 * DECLARATIVE, NOT ADDITIVE. Every run revokes each role's object privileges and
 * grants the declared set back, transfers ownership of anything the migration
 * role does not yet own, and re-asserts the default privileges, so a re-run is
 * both the repair path and the password-rotation path. The last statement
 * re-checks the result inside the same transaction and raises if the
 * application role can change an append-only row, so a partial or drifted run
 * rolls back rather than committing.
 *
 * WHAT IT DOES NOT DO: create the database, touch the operator role, the AI
 * Diagnostics role (ADR-007) or the audit ARCHIVE database's role, revoke
 * anything from PUBLIC, or print a password.
 */

import { AUDIT_ANONYMISED_REQUEST_COLUMNS } from "./audit-retention-classes";
import { MEMBER_MONEY_RELATIONS } from "./member-money-tables";
import {
  buildCreateLoginRoleIfAbsentSql,
  buildStripAllRoleMembershipsSql,
  LEAST_PRIVILEGE_ROLE_ATTRIBUTES,
  quoteIdentifier,
  quoteLiteral,
} from "./diagnostics/tools/provision-role";

/** The schema every application relation lives in. */
export const APPLICATION_SCHEMA = "public";

/**
 * Relations the application role may only INSERT into and SELECT from. A row in
 * one of these is a fact that is corrected by appending another row, never by
 * rewriting it: the booking ledger (`docs/design/booking-ledger.md` §4), the
 * audit log and the member-money journal. Adding a relation here — or a column to
 * `AUDIT_ANONYMISED_REQUEST_COLUMNS` — is a release that asks every deployment to
 * re-run `pnpm run db:provision-roles --apply`, and its upgrade note says so,
 * unless the migration that creates the relation narrows it itself, as the
 * journal's does (docs/BLUE_GREEN_MIGRATION_POLICY.md, the carve-out for tables
 * a migration creates).
 */
export const APPEND_ONLY_RELATIONS = [
  "BookingLedgerLine", "AuditLog", ...MEMBER_MONEY_RELATIONS,
] as const;

/** Prisma's migration history: the application reads it, only migrations write it. */
export const MIGRATION_HISTORY_RELATION = "_prisma_migrations";

/**
 * The migration that creates the newest append-only relations. A database whose
 * history lacks it runs an older release, and provisioning asks for this release's migrations first.
 */
export const APPEND_ONLY_SCHEMA_MIGRATION = "20261127010000_member_money_journal";

/**
 * The audit relation the retention role maintains. It may UPDATE only
 * `AUDIT_ANONYMISED_REQUEST_COLUMNS`, the list the job itself clears.
 */
export const AUDIT_RETENTION_RELATION = "AuditLog";

/** Table rights the application role holds on an ordinary relation. */
export const APPLICATION_TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE";

/**
 * Table privileges incompatible with INSERT/SELECT-only financial evidence, as
 * PostgreSQL's `aclexplode` names them.
 */
export const APPEND_ONLY_FORBIDDEN_PRIVILEGE_TYPES = ["UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"] as const;

/** The same privileges as one list for `has_table_privilege` and `REVOKE`. */
export const APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES = APPEND_ONLY_FORBIDDEN_PRIVILEGE_TYPES.join(", ");

/**
 * SECURITY DEFINER routines the re-check tolerates in the application schema, as
 * `regprocedure` text. EMPTY: such a routine runs as its owner — the migration
 * role, which owns the ledger — so one that writes an append-only relation would
 * hand that power to anyone with EXECUTE, which PUBLIC has by default. A release
 * that needs one adds it here with its reason, in the same pull request.
 */
export const SECURITY_DEFINER_ROUTINE_ALLOWLIST: readonly string[] = [];

/**
 * How long the provisioning transaction waits for a lock, and how long any ONE
 * statement may run. The first run hands every table to the migration role, and
 * `ALTER … OWNER TO` takes ACCESS EXCLUSIVE until COMMIT, so without a bound a
 * long-open reader would hold every table already transferred behind it for as
 * long as it stays open. Five seconds is the migrate service's own bound (#3377).
 * Both bounds are per statement, not per run (#4453 review R6): the ownership
 * loop is one statement, so it alone can hold the tables it has transferred for
 * up to `PROVISIONING_STATEMENT_TIMEOUT`, and every later statement gets its own
 * allowance before COMMIT releases them. The CLI reports a timeout as "retry in a
 * quiet window".
 */
export const PROVISIONING_LOCK_TIMEOUT = "5s";
export const PROVISIONING_STATEMENT_TIMEOUT = "120s";

/**
 * The characters a role password must not contain, because Compose interpolates
 * it into a connection string unencoded. The deploy script's
 * `require_safe_database_password` refuses the same set
 * (`database-roles-password-charset.test.ts` pins the two equal).
 */
export const CONNECTION_STRING_UNSAFE_PASSWORD = /[@/:?#%\s]/;

/** The stock role names. A deployment may choose its own. */
export const DEFAULT_DATABASE_ROLE_NAMES = {
  migrator: "tac_migrator",
  app: "tac_app",
  auditRetention: "tac_audit_retention",
} as const;

export type DatabaseRoleKind = keyof typeof DEFAULT_DATABASE_ROLE_NAMES;

export interface DatabaseRoleCredential {
  roleName: string;
  /** Quoted as a SQL literal; never logged. */
  password: string;
}

export interface DatabaseRolesProvisionInput {
  /** The database the roles may CONNECT to and whose schema is provisioned. */
  databaseName: string;
  migrator: DatabaseRoleCredential;
  app: DatabaseRoleCredential;
  auditRetention: DatabaseRoleCredential;
}

/**
 * The deploy script's post-migrate check (#4453 review O-F2, N3), as psql runs
 * it with `-v migration_role=… -v app_role=…`: the `public` relations that are
 * not owned by the migration role, not readable by the application role, a
 * view the application could write through, or an `APPEND_ONLY_RELATIONS`
 * table it could change beyond INSERT (#4513). Empty means the deploy may go on.
 * Extension members are left out, as the ownership transfer leaves them.
 *
 * ONE definition. Bash cannot import it, so
 * `scripts/run-production-blue-green-deploy.sh` carries it between its
 * `least-privilege-grants-check` markers, pinned equal to this constant by
 * `deploy-database-roles-script-contract.test.ts`, and run against PostgreSQL by
 * `database-roles.realdb.test.ts`.
 */
export const DEPLOY_GRANTS_CHECK_SQL = `SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
  )
  AND (pg_catalog.pg_get_userbyid(c.relowner) <> :'migration_role'
       OR NOT pg_catalog.has_table_privilege(:'app_role', c.oid, 'SELECT')
       OR (c.relkind IN ('v', 'm')
           AND pg_catalog.has_table_privilege(:'app_role', c.oid, 'INSERT, UPDATE, DELETE'))
       OR (c.relname IN (${APPEND_ONLY_RELATIONS.map(quoteLiteral).join(", ")})
           AND (pg_catalog.has_table_privilege(:'app_role', c.oid, '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
                OR pg_catalog.has_any_column_privilege(:'app_role', c.oid, 'UPDATE'))));`;

/** A relation name in the application schema, quoted for SQL text. */
function relation(name: string): string {
  return `${quoteIdentifier(APPLICATION_SCHEMA)}.${quoteIdentifier(name)}`;
}

/** The same name as a `regclass` literal, for `to_regclass` and `has_*_privilege`. */
function regclassLiteral(name: string): string {
  return quoteLiteral(relation(name));
}

/**
 * Hand every object in the application schema that the migration role does not
 * already own to it: tables, partitioned tables, views, materialised views,
 * foreign tables, standalone sequences, types and routines.
 *
 * Written as a catalogue loop rather than `REASSIGN OWNED BY <old owner>`,
 * because the old owner in the stock stack is the cluster's bootstrap superuser
 * (`POSTGRES_USER`), whose objects PostgreSQL refuses to reassign, and because
 * REASSIGN would also move objects outside this schema and the database itself.
 *
 * Skipped on purpose: an extension's own members (`pgcrypto`'s functions — the
 * extension keeps its owner), a sequence a column owns (it moves with its table),
 * an index (it follows its table), and the row and array types PostgreSQL derives
 * from a table or a type (they follow their parent).
 */
function buildOwnershipTransferSql(migrator: string): string {
  const schemaLiteral = quoteLiteral(APPLICATION_SCHEMA);
  const migratorLiteral = quoteLiteral(migrator);
  return `DO $$
DECLARE
  object record;
BEGIN
  FOR object IN
    SELECT c.oid::regclass::text AS name,
      CASE c.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaLiteral}
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND pg_catalog.pg_get_userbyid(c.relowner) <> ${migratorLiteral}
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
          AND d.deptype IN ('e', 'a', 'i')
      )
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', object.kind, object.name, ${migratorLiteral});
  END LOOP;

  FOR object IN
    SELECT t.oid::regtype::text AS name
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
    WHERE n.nspname = ${schemaLiteral}
      AND t.typtype IN ('e', 'd', 'r', 'c')
      AND (t.typrelid = 0 OR c.relkind = 'c')
      AND pg_catalog.pg_get_userbyid(t.typowner) <> ${migratorLiteral}
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid
          AND d.deptype = 'e'
      )
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', object.name, ${migratorLiteral});
  END LOOP;

  FOR object IN
    SELECT p.oid::regprocedure::text AS name
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ${schemaLiteral}
      AND pg_catalog.pg_get_userbyid(p.proowner) <> ${migratorLiteral}
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid
          AND d.deptype = 'e'
      )
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', object.name, ${migratorLiteral});
  END LOOP;
END
$$;`;
}

/**
 * Narrow the application role on the append-only relations and the migration
 * history, and grant the retention role its three rights. Each relation is looked
 * up first: on an empty database (provisioned before the first migration) it does
 * not exist yet, and the run says so rather than failing — re-running after the
 * migrations applies it.
 */
function buildRelationNarrowingSql(
  app: string,
  auditRetention: string,
): string {
  const lines: string[] = [];
  for (const name of APPEND_ONLY_RELATIONS) {
    lines.push(`  IF to_regclass(${regclassLiteral(name)}) IS NOT NULL THEN
    EXECUTE ${quoteLiteral(`REVOKE ${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES} ON TABLE ${relation(name)} FROM ${app}`)};
  ELSE
    RAISE NOTICE 'Relation % does not exist yet: re-run provisioning after the migrations so the application role is narrowed on it.', ${quoteLiteral(name)};
  END IF;`);
  }
  // Views and materialised views: SELECT only. An auto-updatable view runs its
  // DML with the VIEW OWNER's rights, so UPDATE on a view over the ledger would
  // be UPDATE on the ledger (#4453 review, S-F3).
  lines.push(`  FOR view_name IN
    SELECT c.oid::regclass::text FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${quoteLiteral(APPLICATION_SCHEMA)} AND c.relkind IN ('v', 'm')
    ORDER BY 1
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM %s', view_name, ${quoteLiteral(app)});
  END LOOP;`);
  lines.push(`  IF to_regclass(${regclassLiteral(MIGRATION_HISTORY_RELATION)}) IS NOT NULL THEN
    EXECUTE ${quoteLiteral(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE ${relation(MIGRATION_HISTORY_RELATION)} FROM ${app}`)};
  END IF;`);
  const columns = AUDIT_ANONYMISED_REQUEST_COLUMNS.map(quoteIdentifier).join(", ");
  lines.push(`  IF to_regclass(${regclassLiteral(AUDIT_RETENTION_RELATION)}) IS NOT NULL THEN
    EXECUTE ${quoteLiteral(`GRANT SELECT, DELETE ON TABLE ${relation(AUDIT_RETENTION_RELATION)} TO ${auditRetention}`)};
    EXECUTE ${quoteLiteral(`GRANT UPDATE (${columns}) ON TABLE ${relation(AUDIT_RETENTION_RELATION)} TO ${auditRetention}`)};
  ELSE
    RAISE NOTICE 'Relation % does not exist yet: re-run provisioning after the migrations so the audit-retention role can maintain it.', ${quoteLiteral(AUDIT_RETENTION_RELATION)};
  END IF;`);
  return `DO $$
DECLARE
  view_name text;
BEGIN
${lines.join("\n")}
END
$$;`;
}

/**
 * The re-check, inside the same transaction as everything above. A warning is
 * not a failure in PostgreSQL, so the properties this issue exists for are read
 * back from the server's own privilege functions — which count PUBLIC grants and
 * role memberships too — and any breach raises, rolling the whole run back.
 */
function buildVerificationSql(input: {
  migrator: string;
  app: string;
  auditRetention: string;
}): string {
  const app = quoteLiteral(input.app);
  const retention = quoteLiteral(input.auditRetention);
  const migrator = quoteLiteral(input.migrator);
  const auditRelation = regclassLiteral(AUDIT_RETENTION_RELATION);
  const appendOnlyChecks = APPEND_ONLY_RELATIONS.map(
    (name) => `  IF to_regclass(${regclassLiteral(name)}) IS NOT NULL AND (
       pg_catalog.has_table_privilege(${app}, ${regclassLiteral(name)}, '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
       OR pg_catalog.has_any_column_privilege(${app}, ${regclassLiteral(name)}, 'UPDATE')) THEN
    RAISE EXCEPTION 'Refusing to commit: the application role can still change rows of %.', ${quoteLiteral(name)};
  END IF;`,
  ).join("\n");
  const moneyRetentionChecks = MEMBER_MONEY_RELATIONS.map(
    (name) => `  IF to_regclass(${regclassLiteral(name)}) IS NOT NULL AND (
       pg_catalog.has_table_privilege(${retention}, ${regclassLiteral(name)}, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')
       OR pg_catalog.has_any_column_privilege(${retention}, ${regclassLiteral(name)}, 'SELECT, INSERT, UPDATE, REFERENCES')) THEN
    RAISE EXCEPTION 'Refusing to commit: the audit-retention role has money-table rights on %.', ${quoteLiteral(name)};
  END IF;`,
  ).join("\n");
  const anonymised = AUDIT_ANONYMISED_REQUEST_COLUMNS.map(quoteLiteral).join(", ");
  const appendOnlyList = APPEND_ONLY_RELATIONS.map(regclassLiteral).join(", ");
  const appendOnlyPresent = APPEND_ONLY_RELATIONS.map(
    (name) => `(${regclassLiteral(name)}, to_regclass(${regclassLiteral(name)}))`,
  ).join(", ");
  const secdefAllowlist = `ARRAY[${SECURITY_DEFINER_ROUTINE_ALLOWLIST.map(quoteLiteral).join(", ")}]::text[]`;
  return `DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offending
    FROM pg_catalog.pg_roles
    WHERE rolname IN (${migrator}, ${app}, ${retention})
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to commit: % still holds a superuser-class attribute.', offending;
  END IF;

  IF pg_catalog.pg_has_role(${app}, ${migrator}, 'MEMBER')
     OR pg_catalog.pg_has_role(${retention}, ${migrator}, 'MEMBER')
     OR pg_catalog.pg_has_role(${retention}, ${app}, 'MEMBER') THEN
    RAISE EXCEPTION 'Refusing to commit: the application or retention role can SET ROLE to a wider role.';
  END IF;

  IF pg_catalog.has_schema_privilege(${app}, ${quoteLiteral(APPLICATION_SCHEMA)}, 'CREATE')
     OR pg_catalog.has_schema_privilege(${retention}, ${quoteLiteral(APPLICATION_SCHEMA)}, 'CREATE') THEN
    RAISE EXCEPTION 'Refusing to commit: the application or retention role may create objects in schema %.', ${quoteLiteral(APPLICATION_SCHEMA)};
  END IF;

  -- A migrated schema without an append-only relation means provisioning ran
  -- against something it does not understand; narrowing nothing would pass.
  IF to_regclass(${regclassLiteral(MIGRATION_HISTORY_RELATION)}) IS NOT NULL THEN
    SELECT string_agg(expected.name, ', ' ORDER BY expected.name) INTO offending
      FROM (VALUES ${appendOnlyPresent}) AS expected(name, found)
      WHERE expected.found IS NULL;
    IF offending IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM ${relation(MIGRATION_HISTORY_RELATION)}
        WHERE migration_name = ${quoteLiteral(APPEND_ONLY_SCHEMA_MIGRATION)} AND finished_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Refusing to commit: append-only relation % is missing because this database runs an older release. Deploy this release''s migrations first, then re-run provisioning.', offending;
      END IF;
      RAISE EXCEPTION 'Refusing to commit: the schema is migrated but append-only relation % is missing.', offending;
    END IF;
  END IF;

${appendOnlyChecks}
${moneyRetentionChecks}

  -- A view or rule that reads an append-only relation and that the application
  -- may write through: its DML would run with the owner's rights (S-F3).
  SELECT string_agg(DISTINCT r.ev_class::regclass::text || ' (' || r.rulename || ')', ', ') INTO offending
    FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = r.oid
     AND d.refclassid = 'pg_catalog.pg_class'::regclass
    WHERE d.refobjid IN (SELECT to_regclass(x) FROM unnest(ARRAY[${appendOnlyList}]) AS x)
      AND pg_catalog.has_table_privilege(${app}, r.ev_class, 'INSERT, UPDATE, DELETE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to commit: the application role may write through a view or rule over an append-only relation: %.', offending;
  END IF;

  -- A SECURITY DEFINER routine runs as its owner, which owns the ledger.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO offending
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ${quoteLiteral(APPLICATION_SCHEMA)}
      AND p.prosecdef
      AND NOT (p.oid::regprocedure::text = ANY (${secdefAllowlist}));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to commit: SECURITY DEFINER routine % is not on SECURITY_DEFINER_ROUTINE_ALLOWLIST.', offending;
  END IF;

  IF to_regclass(${auditRelation}) IS NOT NULL THEN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offending
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${quoteLiteral(APPLICATION_SCHEMA)}
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND c.oid <> ${auditRelation}::regclass
        AND (pg_catalog.has_table_privilege(${retention}, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
             OR pg_catalog.has_any_column_privilege(${retention}, c.oid, 'SELECT, INSERT, UPDATE'));
    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing to commit: the audit-retention role holds rights on %.', offending;
    END IF;

    IF pg_catalog.has_table_privilege(${retention}, ${auditRelation}, 'INSERT, UPDATE, TRUNCATE') THEN
      RAISE EXCEPTION 'Refusing to commit: the audit-retention role may insert, truncate or update whole rows of %.', ${quoteLiteral(AUDIT_RETENTION_RELATION)};
    END IF;

    SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO offending
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ${auditRelation}::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_catalog.has_column_privilege(${retention}, ${auditRelation}, a.attnum, 'UPDATE')
        AND a.attname NOT IN (${anonymised});
    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing to commit: the audit-retention role may update audit columns %.', offending;
    END IF;
  END IF;
END
$$;`;
}

/**
 * The ordered statement list, run in ONE transaction by the operator CLI. Every
 * statement is safe to re-run; the order is load-bearing: roles exist and are
 * pinned before anything is granted to them, ownership moves before the
 * migration role's default privileges are declared, every role is stripped
 * before it is granted back, and the re-check runs last.
 *
 * Refuses (throws) when two of the roles share a name: the separation IS the
 * control, and one role in two slots would satisfy every statement below while
 * delivering none of it.
 */
export function buildDatabaseRolesSql(input: DatabaseRolesProvisionInput): string[] {
  const names = [input.migrator.roleName, input.app.roleName, input.auditRetention.roleName];
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error(
      "Refusing to build role SQL: the migration, application and audit-retention roles must be three different roles.",
    );
  }

  const database = quoteIdentifier(input.databaseName);
  const schema = quoteIdentifier(APPLICATION_SCHEMA);
  const migrator = quoteIdentifier(input.migrator.roleName);
  const app = quoteIdentifier(input.app.roleName);
  const retention = quoteIdentifier(input.auditRetention.roleName);
  const all = [input.migrator, input.app, input.auditRetention];

  const statements: string[] = [
    // 0. Bound every wait (#4453 review, O-F1). The first run takes ACCESS
    //    EXCLUSIVE on each table it hands over, held to COMMIT; a lock it cannot
    //    get in 5 s stops the run with nothing changed, rather than waiting on a
    //    long-open reader indefinitely. The statement timeout bounds EACH
    //    statement, not the run (#4453 review R6): locks taken early are held
    //    through every later statement to COMMIT. `LOCAL`: the CLI runs one
    //    transaction.
    `SET LOCAL lock_timeout = ${quoteLiteral(PROVISIONING_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${quoteLiteral(PROVISIONING_STATEMENT_TIMEOUT)};`,
  ];

  // 1. Create each role if it is absent, then pin its attributes and password
  //    whether it was just created or had drifted. Not a superuser, no role or
  //    database creation, no replication, row-level security applies.
  for (const credential of all) {
    statements.push(
      buildCreateLoginRoleIfAbsentSql(credential.roleName),
      `ALTER ROLE ${quoteIdentifier(credential.roleName)} WITH ${LEAST_PRIVILEGE_ROLE_ATTRIBUTES} PASSWORD ${quoteLiteral(credential.password)};`,
    );
  }

  // 2. Each role belongs to NO role. A member is one `SET ROLE` away from that
  //    role's privileges, so an application role that was a member of the
  //    migration role could rewrite the ledger through it.
  for (const credential of all) {
    statements.push(buildStripAllRoleMembershipsSql(credential.roleName));
  }

  // 3. Database and schema. CONNECT for all three; the migration role also gets
  //    CREATE on the database (a migration's `CREATE EXTENSION` of a trusted
  //    extension needs it) and USAGE, CREATE on the schema. The migration and
  //    application roles get TEMPORARY explicitly: AI Diagnostics provisioning
  //    revokes it from PUBLIC, and migrations already use `CREATE TEMP TABLE`
  //    (#4453 review, S-F10/O-F5). Nothing is revoked from PUBLIC here.
  for (const role of [migrator, app, retention]) {
    statements.push(
      `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${role};`,
      `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
      `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role};`,
    );
  }
  statements.push(
    `GRANT CREATE ON DATABASE ${database} TO ${migrator};`,
    `GRANT TEMPORARY ON DATABASE ${database} TO ${migrator};`,
    `GRANT TEMPORARY ON DATABASE ${database} TO ${app};`,
    `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${migrator};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${app};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${retention};`,
  );

  // 4. The migration role owns the schema's objects, so `prisma migrate deploy`
  //    can alter them without a superuser.
  statements.push(buildOwnershipTransferSql(input.migrator.roleName));

  // 5. Object privileges, declarative: strip the application and retention roles
  //    (this also clears column grants), then grant back.
  for (const role of [app, retention]) {
    statements.push(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role};`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role};`,
      `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${schema} FROM ${role};`,
    );
  }
  statements.push(
    `GRANT ${APPLICATION_TABLE_PRIVILEGES} ON ALL TABLES IN SCHEMA ${schema} TO ${app};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app};`,
    buildRelationNarrowingSql(app, retention),
  );

  // 6. Default privileges: a table or sequence a FUTURE migration creates (as the
  //    migration role) is usable by the application at once, with no
  //    re-provisioning. Routines need nothing: PostgreSQL grants EXECUTE to
  //    PUBLIC. Re-declared from scratch each run.
  for (const role of [app, retention]) {
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${role};`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${role};`,
    );
  }
  statements.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema} GRANT ${APPLICATION_TABLE_PRIVILEGES} ON TABLES TO ${app};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${app};`,
  );

  // 7. Read the result back and refuse to commit a breach.
  statements.push(
    buildVerificationSql({
      migrator: input.migrator.roleName,
      app: input.app.roleName,
      auditRetention: input.auditRetention.roleName,
    }),
  );

  return statements;
}

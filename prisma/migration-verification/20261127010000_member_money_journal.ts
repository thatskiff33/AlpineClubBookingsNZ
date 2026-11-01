import type { DataMigrationVerification } from "./types";

/**
 * #4513 (M1): the inert member-money journal. Every table it creates is new and
 * empty, so it rewrites no row a club holds. What it does change at migration
 * time is the ACL of its OWN seven tables: a least-privilege install's default
 * privileges hand the application role UPDATE and DELETE on each new table, and
 * the migration's last block revokes UPDATE, DELETE, TRUNCATE, TRIGGER and
 * REFERENCES from every grantee but the owner, naming no role
 * (docs/BLUE_GREEN_MIGRATION_POLICY.md, the carve-out for tables a migration
 * creates). That block is what this fixture proves.
 *
 * What must hold:
 *   - an application role given the default SELECT, INSERT, UPDATE and DELETE
 *     keeps only SELECT and INSERT on every journal table;
 *   - PUBLIC, granted through a default too, keeps nothing it could change rows with;
 *   - the owner's own rights are untouched;
 *   - a table an earlier migration created keeps every grant it had.
 */

const ROLE = "dmv_4513_app";
const TABLES = [
  "MemberMoneyApplication",
  "MemberMoneyEvent",
  "MemberMoneyJournal",
  "MemberMoneyLine",
  "MemberMoneyObligation",
  "MemberMoneySourceLink",
  "MemberMoneySourcePosting",
];
const TABLE_LIST = `unnest(ARRAY[${TABLES.map((name) => `'${name}'`).join(", ")}]) AS t(name)`;
const right = (grantee: string, privilege: string) =>
  `has_table_privilege(${grantee}, format('public.%I', t.name), '${privilege}')`;

const verification: DataMigrationVerification = {
  migration: "20261127010000_member_money_journal",
  intent:
    "Create the inert member-money journal and narrow only its own seven new tables, for every grantee but their owner and without naming a role, to rights that cannot change a row: SELECT and INSERT survive, UPDATE, DELETE, TRUNCATE, TRIGGER and REFERENCES do not. No other table's grants and no existing row change.",
  executionMode: "case_transaction",
  idempotentReRun: false,
  cases: [
    {
      name: "a least-privilege install whose default privileges give the application full table rights",
      seed: `
        CREATE ROLE ${ROLE} NOLOGIN;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO PUBLIC;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "BookingLedgerLine" TO ${ROLE};
      `,
      expectations: [
        {
          claim: "the application role keeps SELECT and INSERT, and loses UPDATE and DELETE, on every journal table",
          sql: `SELECT t.name AS "table", ${right(`'${ROLE}'`, "SELECT")} AS "select", ${right(`'${ROLE}'`, "INSERT")} AS "insert",
              ${right(`'${ROLE}'`, "UPDATE")} AS "update", ${right(`'${ROLE}'`, "DELETE")} AS "delete"
            FROM ${TABLE_LIST} ORDER BY t.name COLLATE "C"`,
          rows: TABLES.map((table) => ({ table, select: true, insert: true, update: false, delete: false })),
        },
        {
          claim: "PUBLIC keeps no right on a journal table that could change a row",
          sql: `SELECT count(*)::int AS "publicChangeRights"
            FROM ${TABLE_LIST}
            CROSS JOIN LATERAL aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass(format('public.%I', t.name)))) AS acl
            WHERE acl.grantee = 0 AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')`,
          rows: [{ publicChangeRights: 0 }],
        },
        {
          claim: "the owner's own grant on every journal table still carries UPDATE and DELETE",
          sql: `SELECT count(*)::int AS "ownerEntriesWithChangeRights"
            FROM ${TABLE_LIST}
            JOIN pg_class c ON c.oid = to_regclass(format('public.%I', t.name))
            WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = c.relowner AND acl.privilege_type = 'UPDATE')
              AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = c.relowner AND acl.privilege_type = 'DELETE')`,
          rows: [{ ownerEntriesWithChangeRights: TABLES.length }],
        },
        {
          claim: "a table an earlier migration created keeps the application's UPDATE and DELETE",
          sql: `SELECT has_table_privilege('${ROLE}', '"BookingLedgerLine"', 'UPDATE') AS "update",
              has_table_privilege('${ROLE}', '"BookingLedgerLine"', 'DELETE') AS "delete"`,
          rows: [{ update: true, delete: true }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "the narrowing block revokes nothing",
      harm: "Every least-privilege deploy stops at the post-migrate grants check, and until provisioning runs again the application could rewrite posted journal rows.",
      find: "EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);",
      replace: "NULL;",
    },
    {
      name: "the narrowing block reaches every table in the schema",
      harm: "The draining colour, and any install whose application connects as a non-owner role, loses UPDATE and DELETE on tables it writes, mid-deploy.",
      find: `      AND c.relname IN ('MemberMoneyEvent', 'MemberMoneyJournal', 'MemberMoneyLine', 'MemberMoneyObligation',
        'MemberMoneyApplication', 'MemberMoneySourceLink', 'MemberMoneySourcePosting')
`,
      replace: "",
    },
    {
      name: "the narrowing block revokes from the owner too",
      harm: "The migration role loses rights over its own tables, which later migrations and provisioning rely on.",
      find: "      AND acl.grantee <> c.relowner\n",
      replace: "",
    },
    {
      name: "the narrowing block leaves PUBLIC alone",
      harm: "A right granted to PUBLIC reaches every role, the application's included, so the journal stays changeable.",
      find: "WHERE c.relnamespace = 'public'::regnamespace",
      replace: "WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee <> 0",
    },
  ],
};

export default verification;

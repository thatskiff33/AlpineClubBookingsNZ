import type { DataMigrationVerification } from "./types";

/**
 * Ledger M8 (#4520) narrows only its new, empty, insert-only evidence table.
 * `StripePayout`, created by the same file, keeps every right: a payout's status
 * changes. Tables an earlier migration created keep theirs.
 */

const ROLE = "dmv_4520_app";
const EVIDENCE = "StripeBalanceTransactionEvidence";
const right = (grantee: string, table: string, privilege: string) =>
  `has_table_privilege(${grantee}, '"${table}"', '${privilege}')`;

const verification: DataMigrationVerification = {
  migration: "20261211010000_stripe_balance_evidence",
  intent:
    "Add the empty insert-only StripeBalanceTransactionEvidence table and the mutable StripePayout table, and narrow only the evidence table, for every grantee but its owner and without naming a role, to rights that cannot change a row: SELECT and INSERT survive, UPDATE, DELETE, TRUNCATE, TRIGGER and REFERENCES do not. StripePayout keeps UPDATE and DELETE. No other table's grants and no existing row change.",
  executionMode: "case_transaction",
  idempotentReRun: false,
  cases: [
    {
      name: "a least-privilege install whose default privileges give the application full table rights",
      seed: `
        CREATE ROLE ${ROLE} NOLOGIN;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES ON TABLES TO ${ROLE};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLES TO PUBLIC;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "BookingLedgerLine" TO ${ROLE};
      `,
      expectations: [
        {
          claim: "the application role keeps SELECT and INSERT, and loses UPDATE, DELETE, TRIGGER and REFERENCES, on the evidence table",
          sql: `SELECT ${right(`'${ROLE}'`, EVIDENCE, "SELECT")} AS "select", ${right(`'${ROLE}'`, EVIDENCE, "INSERT")} AS "insert",
              ${right(`'${ROLE}'`, EVIDENCE, "UPDATE")} AS "update", ${right(`'${ROLE}'`, EVIDENCE, "DELETE")} AS "delete",
              ${right(`'${ROLE}'`, EVIDENCE, "TRIGGER")} AS "trigger", ${right(`'${ROLE}'`, EVIDENCE, "REFERENCES")} AS "references"`,
          rows: [{ select: true, insert: true, update: false, delete: false, trigger: false, references: false }],
        },
        {
          claim: "PUBLIC keeps no right on the evidence table that could change a row",
          sql: `SELECT count(*)::int AS "publicChangeRights"
            FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('public."${EVIDENCE}"'))) AS acl
            WHERE acl.grantee = 0 AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')`,
          rows: [{ publicChangeRights: 0 }],
        },
        {
          claim: "the owner's own grant on the evidence table still carries UPDATE and DELETE",
          sql: `SELECT count(*)::int AS "ownerEntriesWithChangeRights"
            FROM pg_class c
            WHERE c.oid = to_regclass('public."${EVIDENCE}"')
              AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = c.relowner AND acl.privilege_type = 'UPDATE')
              AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = c.relowner AND acl.privilege_type = 'DELETE')`,
          rows: [{ ownerEntriesWithChangeRights: 1 }],
        },
        {
          claim: "StripePayout, created by the same file, keeps the application's UPDATE and DELETE and PUBLIC's TRUNCATE",
          sql: `SELECT ${right(`'${ROLE}'`, "StripePayout", "UPDATE")} AS "update", ${right(`'${ROLE}'`, "StripePayout", "DELETE")} AS "delete",
              ${right("'public'", "StripePayout", "TRUNCATE")} AS "publicTruncate"`,
          rows: [{ update: true, delete: true, publicTruncate: true }],
        },
        {
          claim: "a table an earlier migration created keeps the application's UPDATE and DELETE",
          sql: `SELECT ${right(`'${ROLE}'`, "BookingLedgerLine", "UPDATE")} AS "update",
              ${right(`'${ROLE}'`, "BookingLedgerLine", "DELETE")} AS "delete"`,
          rows: [{ update: true, delete: true }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "the narrowing block revokes nothing",
      harm: "Every least-privilege deploy stops at the post-migrate grants check, and until provisioning runs again the application could rewrite stored Stripe balance evidence.",
      find: "EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);",
      replace: "NULL;",
    },
    {
      name: "the narrowing block reaches every table in the schema",
      harm: "The draining colour, and any install whose application connects as a non-owner role, loses UPDATE and DELETE on tables it writes, StripePayout included, mid-deploy.",
      find: "      AND c.relname = 'StripeBalanceTransactionEvidence'\n",
      replace: "",
    },
    {
      name: "the narrowing block also narrows StripePayout",
      harm: "A payout's status change is refused on a least-privilege install, so payout evidence stops tracking Stripe.",
      find: "      AND c.relname = 'StripeBalanceTransactionEvidence'\n",
      replace: "      AND c.relname IN ('StripeBalanceTransactionEvidence', 'StripePayout')\n",
    },
    {
      name: "the narrowing block revokes from the owner too",
      harm: "The migration role loses rights over its own table, which later migrations and provisioning rely on.",
      find: "      AND acl.grantee <> c.relowner\n",
      replace: "",
    },
    {
      name: "the narrowing block leaves PUBLIC alone",
      harm: "A right granted to PUBLIC reaches every role, the application's included, so the evidence stays changeable.",
      find: "WHERE c.relnamespace = 'public'::regnamespace",
      replace: "WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee <> 0",
    },
  ],
};

export default verification;

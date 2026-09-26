import type { DataMigrationVerification } from "./types";

/**
 * #3567 (owner decision D4, stage 5 of programme #3205): "PaymentRefund"."currency"
 * loses its 'nzd' default. The migration is shape-only — the coverage gate does
 * not demand this fixture — and it ships one anyway because the two promises it
 * makes are about DATA and about what a later write may do, and an empty table
 * can prove neither:
 *
 * 1. NO EXISTING REFUND IS TOUCHED. Each row records the currency Stripe
 *    actually refunded in; rewriting one would falsify the payments history
 *    reconciled against Stripe and Xero. So a pre-existing 'nzd' row written by
 *    the old default and an 'aud' row written explicitly must both come out
 *    byte-identical.
 * 2. A WRITE THAT OMITS THE CURRENCY NOW FAILS instead of silently recording
 *    New Zealand dollars. The column stays NOT NULL, so the omitted-column
 *    insert raises `not_null_violation`; a PL/pgSQL probe records whether it
 *    did, so the claim is a row the runner can compare.
 *
 * The reverse (`rollback.sql`) restores the default and must rewrite no row.
 */

const FIXTURE_ROWS = `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "updatedAt"
  ) VALUES (
    'dmv-3567-member', 'dmv-3567@example.invalid', 'x', 'Refund', 'Owner',
    timezone('UTC', statement_timestamp())
  );
  INSERT INTO "Booking" (
    "id", "memberId", "checkIn", "checkOut", "totalPriceCents", "finalPriceCents", "updatedAt"
  ) VALUES (
    'dmv-3567-booking', 'dmv-3567-member', DATE '2026-08-01', DATE '2026-08-03',
    20000, 20000, timezone('UTC', statement_timestamp())
  );
  INSERT INTO "Payment" ("id", "bookingId", "amountCents", "updatedAt")
  VALUES (
    'dmv-3567-payment', 'dmv-3567-booking', 20000,
    timezone('UTC', statement_timestamp())
  );
  -- Written the way the old default allowed: no currency named.
  INSERT INTO "PaymentRefund" (
    "id", "paymentId", "stripeRefundId", "amountCents", "updatedAt"
  ) VALUES (
    'dmv-3567-refund-defaulted', 'dmv-3567-payment', 're_dmv_3567_defaulted',
    2500, timezone('UTC', statement_timestamp())
  );
  -- Written the way the runtime writer always has: Stripe's currency, named.
  INSERT INTO "PaymentRefund" (
    "id", "paymentId", "stripeRefundId", "amountCents", "currency", "updatedAt"
  ) VALUES (
    'dmv-3567-refund-aud', 'dmv-3567-payment', 're_dmv_3567_aud',
    1200, 'aud', timezone('UTC', statement_timestamp())
  );
`;

const EXISTING_ROWS = `
  SELECT "id", "currency", "amountCents"
  FROM "PaymentRefund"
  WHERE "id" LIKE 'dmv-3567-refund-%'
  ORDER BY "id" COLLATE "C"
`;

const EXISTING_ROWS_UNCHANGED = [
  { id: "dmv-3567-refund-aud", currency: "aud", amountCents: 1200 },
  { id: "dmv-3567-refund-defaulted", currency: "nzd", amountCents: 2500 },
];

const COLUMN_DEFINITION = `
  SELECT "column_default" AS "columnDefault", "is_nullable" AS "isNullable"
  FROM information_schema.columns
  WHERE "table_schema" = current_schema()
    AND "table_name" = 'PaymentRefund'
    AND "column_name" = 'currency'
`;

/**
 * Tries the write the default used to rescue and records what happened. A
 * temporary table rather than a raised error, so a refusal is a ROW the runner
 * compares — and so the no-migration control, where the insert succeeds,
 * reads as a mismatch rather than as a crash.
 */
const OMITTED_CURRENCY_PROBE = `
  CREATE TEMP TABLE "dmv_3567_probe" ("outcome" text NOT NULL);
  DO $dmv_3567$
  BEGIN
    INSERT INTO "PaymentRefund" (
      "id", "paymentId", "stripeRefundId", "amountCents", "updatedAt"
    ) VALUES (
      'dmv-3567-refund-probe', 'dmv-3567-payment', 're_dmv_3567_probe',
      100, timezone('UTC', statement_timestamp())
    );
    INSERT INTO "dmv_3567_probe" ("outcome") VALUES ('recorded without a currency');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO "dmv_3567_probe" ("outcome") VALUES ('refused');
  END
  $dmv_3567$;
`;

const PROBE_OUTCOME = `SELECT "outcome" FROM "dmv_3567_probe"`;

const verification: DataMigrationVerification = {
  migration: "20261012010000_drop_payment_refund_currency_default",
  intent:
    "Drop the 'nzd' default from PaymentRefund.currency, keeping the column NOT NULL, so a write that omits the currency fails instead of recording NZD, while every existing refund keeps the currency it records.",
  // The migration and its reverse carry an explicit BEGIN/COMMIT envelope, and
  // the reverse run executes rollback.sql on a cloned database: this mode.
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "a club with one refund written by the old default and one written with Stripe's currency",
      seed: FIXTURE_ROWS,
      afterMigration: OMITTED_CURRENCY_PROBE,
      expectations: [
        {
          claim: "no existing refund is rewritten: the defaulted 'nzd' row and the explicit 'aud' row are byte-identical",
          sql: EXISTING_ROWS,
          rows: EXISTING_ROWS_UNCHANGED,
        },
        {
          claim: "the column has no default and is still NOT NULL",
          sql: COLUMN_DEFINITION,
          rows: [{ columnDefault: null, isNullable: "NO" }],
        },
        {
          claim: "a write that omits the currency is refused rather than recorded as NZD",
          sql: PROBE_OUTCOME,
          rows: [{ outcome: "refused" }],
        },
      ],
      reverse: {
        runs: [
          {
            name: "rollback.sql restores the 'nzd' default and rewrites no row",
            scripts: ["20261012010000_drop_payment_refund_currency_default"],
            expectations: [
              {
                claim: "the default is back exactly as 20260509090000 created it",
                sql: COLUMN_DEFINITION,
                rows: [{ columnDefault: "'nzd'::text", isNullable: "NO" }],
              },
              {
                claim: "the reverse rewrites no refund either",
                sql: EXISTING_ROWS,
                rows: EXISTING_ROWS_UNCHANGED,
              },
            ],
          },
        ],
        mutants: [
          {
            name: "restore an upper-case default",
            harm:
              "After a rollback, a write that omits the currency records 'NZD', a spelling no other refund row uses, so reconciliation that groups by currency splits one currency in two.",
            script: "20261012010000_drop_payment_refund_currency_default",
            find: `SET DEFAULT 'nzd';`,
            replace: `SET DEFAULT 'NZD';`,
          },
          {
            name: "restore the default and re-stamp existing rows",
            harm:
              "A rollback rewrites every refund's currency to NZD, falsifying the history of refunds Stripe made in another currency.",
            script: "20261012010000_drop_payment_refund_currency_default",
            find: `SET DEFAULT 'nzd';`,
            replace: `SET DEFAULT 'nzd'; UPDATE "PaymentRefund" SET "currency" = 'nzd';`,
          },
        ],
      },
    },
  ],
  mutants: [
    {
      name: "set the default again instead of dropping it",
      harm:
        "A write that forgets the currency is still silently recorded as New Zealand dollars, whatever the club charges in.",
      find: `ALTER COLUMN "currency" DROP DEFAULT;`,
      replace: `ALTER COLUMN "currency" SET DEFAULT 'nzd';`,
    },
    {
      name: "drop NOT NULL as well as the default",
      harm:
        "A write that forgets the currency succeeds and stores NULL, so the refund is recorded in no currency at all instead of failing loudly.",
      find: `ALTER COLUMN "currency" DROP DEFAULT;`,
      replace: `ALTER COLUMN "currency" DROP DEFAULT, ALTER COLUMN "currency" DROP NOT NULL;`,
    },
    {
      name: "backfill existing rows to the club's current currency",
      harm:
        "Every refund Stripe made in NZD is relabelled AUD, falsifying the payments history reconciled against Stripe and Xero.",
      find: `ALTER TABLE "PaymentRefund" ALTER COLUMN "currency" DROP DEFAULT;`,
      replace: `ALTER TABLE "PaymentRefund" ALTER COLUMN "currency" DROP DEFAULT; UPDATE "PaymentRefund" SET "currency" = 'aud';`,
    },
  ],
};

export default verification;

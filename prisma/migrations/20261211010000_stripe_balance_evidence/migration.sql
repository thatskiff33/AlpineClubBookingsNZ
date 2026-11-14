-- Ledger M8 (#4520): Stripe balance-transaction evidence and a mutable payout
-- head. Expand-only. The deployed old code never reads these tables.
-- StripeBalanceTransactionEvidence is insert-only. StripePayout stays mutable
-- because a payout's status changes. No role is named (blue/green carve-out).

CREATE TYPE "StripePayoutStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED');

CREATE TABLE "StripeBalanceTransactionEvidence" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reportingCategory" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "feeCents" INTEGER NOT NULL,
  "netCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "feeDetails" JSONB NOT NULL,
  "sourceId" TEXT,
  "paymentIntentId" TEXT,
  "stripeRefundId" TEXT,
  "payoutId" TEXT,
  "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StripeBalanceTransactionEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StripeBalanceTransactionEvidence_stripeCreatedAt_idx" ON "StripeBalanceTransactionEvidence"("stripeCreatedAt");
CREATE INDEX "StripeBalanceTransactionEvidence_paymentIntentId_idx" ON "StripeBalanceTransactionEvidence"("paymentIntentId");
CREATE INDEX "StripeBalanceTransactionEvidence_payoutId_idx" ON "StripeBalanceTransactionEvidence"("payoutId");

CREATE TABLE "StripePayout" (
  "id" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "StripePayoutStatus" NOT NULL,
  "automatic" BOOLEAN NOT NULL,
  "arrivalDate" DATE,
  "failureBalanceTransactionId" TEXT,
  "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StripePayout_pkey" PRIMARY KEY ("id")
);

-- Least-privilege installs (#4453): default privileges give the application
-- UPDATE and DELETE on every new table. Narrow the evidence table THIS file
-- created, for every grantee but the owner, naming no role. StripePayout stays
-- ordinary: its status changes. On a single-role install this revokes nothing.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT DISTINCT c.oid::regclass AS rel,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END AS grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname = 'StripeBalanceTransactionEvidence'
      AND acl.grantee <> c.relowner
      AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);
  END LOOP;
END
$$;

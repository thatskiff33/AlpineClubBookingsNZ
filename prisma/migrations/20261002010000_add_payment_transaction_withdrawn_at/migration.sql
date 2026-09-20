BEGIN;

-- #3528 (INV-ADDPAY-040): record that an additional-payment request was
-- WITHDRAWN by an officer while it was still unpaid.
--
-- Withdrawal has to be a fact in the ledger rather than a write to the
-- Payment summary columns, because those columns are a PROJECTION:
-- reconcilePaymentAggregates rebuilds them from the latest ADDITIONAL row on
-- every reconcile, and the payment_intent.canceled webhook that a withdrawal's
-- own Stripe cancel triggers runs that reconcile. A FAILED row still projects
-- as owed - deliberately, a declined card is retried on the same intent - and
-- the row's `reason` is already the typed anchor key the repair pass and the
-- charge replay match on, so neither can carry "withdrawn". This column can:
-- a row with a withdrawnAt is no longer the live ask, and the projection
-- derives zero from it. History is preserved; the row is never deleted.
--
-- EXPAND ONLY, one nullable column, no DML, no default needed: NULL is the
-- truthful value for every stored row, because no withdrawal has ever
-- happened. A draining old colour omits the column on INSERT, never reads it,
-- and - the one stated window - would project a withdrawn ask back as owed if
-- it ran a reconcile on that payment before cutover; the new colour's next
-- reconcile of the same payment derives zero again, and nothing pays a
-- cancelled intent in between.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only on PostgreSQL
-- (no table rewrite), taking ACCESS EXCLUSIVE on "PaymentTransaction" for the
-- catalog change alone, inside this short DDL-only transaction. No index,
-- constraint, trigger or foreign key is added.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3);

COMMIT;

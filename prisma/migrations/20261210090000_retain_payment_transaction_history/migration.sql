-- #4574, D1 on #4482: financial history outlives its parent.
-- Changing an action requires DROP/ADD CONSTRAINT, so deploy with the reviewed
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS override (as for Ledger M2, #4514).
-- Old code deletes neither Payment nor PaymentTransaction in application paths;
-- demo cleanup already deletes refunds/recoveries, transactions, then payments.
-- No data changes. Nullable transaction links remain nullable.
--
-- DROP CONSTRAINT locks both ends ACCESS EXCLUSIVE. Lock parents first, hold
-- all four through validation and commit, and bound each wait to one second.
-- Any failure rolls back every key; no other session sees an unprotected key.
BEGIN;

SET LOCAL lock_timeout = '1s';
LOCK TABLE "Payment", "PaymentTransaction", "PaymentRefund", "PaymentRecoveryOperation" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_paymentId_fkey";
ALTER TABLE "PaymentRefund" DROP CONSTRAINT "PaymentRefund_paymentTransactionId_fkey";
ALTER TABLE "PaymentRecoveryOperation" DROP CONSTRAINT "PaymentRecoveryOperation_paymentTransactionId_fkey";

ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecoveryOperation" ADD CONSTRAINT "PaymentRecoveryOperation_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

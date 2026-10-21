-- #4219: marks the two ledger rows written when a credit note was spent in Xero
-- outside the app, so the release row is never planned as a spendable lot.
-- Additive nullable column: the previous app color ignores it.
ALTER TABLE "MemberCredit" ADD COLUMN "outsideSpendConvergedAt" TIMESTAMP(3);

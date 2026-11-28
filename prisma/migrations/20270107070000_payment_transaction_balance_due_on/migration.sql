-- #5008 child A (INV-ADDPAY-053): the due date of a deposit balance, on the
-- ADDITIONAL request row that carries it. Expand only: one nullable date column
-- with no default and no backfill, so every existing row reads as no balance and
-- the deployed code, which never selects it, is unaffected. No enum changes.

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN "balanceDueOn" DATE;

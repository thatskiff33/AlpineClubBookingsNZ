-- #4211 (owner decision, 17 Oct 2026: "Record the settler"). Which
-- PaymentTransaction settled the booking, written by the settle's PAID claim
-- under lock(1) and read by the duplicate-capture guard, which never refunds
-- it. ONE STATEMENT, purely additive: nullable, no default, no index, no
-- foreign key, no backfill. NULL means "not recorded" (a booking paid before
-- this release, or by the draining old colour, which never writes it); the
-- guard then keeps an arriving capture and alerts the admins instead of
-- refunding it automatically.
ALTER TABLE "Payment" ADD COLUMN "settledByTransactionId" TEXT;

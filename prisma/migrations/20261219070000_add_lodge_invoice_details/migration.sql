-- Lodge invoice details (fork #115): an optional postal address, the bank
-- account name and details for booking payments, and the GST number, edited in
-- the Lodge details panel and printed on the generated booking invoice.
--
-- Additive, blue/green-safe: nullable ADD COLUMNs are metadata-only on
-- PostgreSQL 11+ (no table rewrite), and Lodge is a tiny cold config table. No
-- DML, no hot-table or breaking-SQL matches; its BLUE_GREEN_MIGRATION_SAFETY
-- ledger row records the reasoning. Old code ignores the columns.

ALTER TABLE "Lodge" ADD COLUMN "postalAddress" VARCHAR(300);
ALTER TABLE "Lodge" ADD COLUMN "bankAccountName" VARCHAR(200);
ALTER TABLE "Lodge" ADD COLUMN "bankAccountDetails" VARCHAR(300);
ALTER TABLE "Lodge" ADD COLUMN "gstNumber" VARCHAR(40);

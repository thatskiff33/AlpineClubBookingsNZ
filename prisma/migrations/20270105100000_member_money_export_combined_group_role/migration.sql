-- Ledger M13 (#4525), the combined group invoice cohort: expand only. One more
-- export document role, the organiser's combined group-settlement invoice.
-- Alone in its migration because PostgreSQL refuses to use an enum label in
-- the transaction that added it, and the next migration's CHECK and partial
-- unique index name it. Catalog-only, no table lock, no DML. The draining
-- release never writes it. PostgreSQL cannot drop an enum value; the reverse
-- is to leave it unused.
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'COMBINED_GROUP_INVOICE';

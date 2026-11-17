-- Ledger M13 (#4525): expand only. Capture receipts join the export manifest
-- as their own document role. A receipt covers cents of one card capture under
-- its own application key, so one capture may be named by several receipts;
-- the primary booking invoice keeps billing each component whole, once. The
-- new enum values are named by no statement here: PostgreSQL cannot use a value
-- added in the same transaction. The draining release never names them.
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'CAPTURE_RECEIPT';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'CAPTURE_CENTS';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'CAPTURE_NOT_JOURNALLED';
ALTER TABLE "MemberMoneyExportCoverage" ADD COLUMN "applicationKey" TEXT;
-- The primary invoice bills a component whole and has no application key;
-- every other role covers cents under one.
ALTER TABLE "MemberMoneyExportCoverage" ADD CONSTRAINT "member_money_export_coverage_application" CHECK (
  ("documentRole" = 'PRIMARY_BOOKING_INVOICE') = ("applicationKey" IS NULL)
  AND ("applicationKey" IS NULL OR length("applicationKey") > 0));
-- The new keys exist before the old one goes, so no moment admits a duplicate.
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_whole_component_key" ON "MemberMoneyExportCoverage"("documentRole", "account", "chargeIdentity")
  WHERE "documentRole" = 'PRIMARY_BOOKING_INVOICE';
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_application_key" ON "MemberMoneyExportCoverage"("documentRole", "account", "chargeIdentity", "applicationKey")
  WHERE "applicationKey" IS NOT NULL;
DROP INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key";

-- Ledger M13's later cohort (#4525, ALP-436): expand only. Two more document
-- roles share the export manifest: an edit's supplementary invoice and the
-- update of an issued primary invoice. No DML; the draining release never
-- names the new values or the new column, and its inserts take the default.
-- A value added here is not used outside a PL/pgSQL body in this transaction.
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE 'SUPPLEMENTARY_BOOKING_INVOICE';
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE 'PRIMARY_BOOKING_INVOICE_UPDATE';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE 'REDUCTION_NETTED';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE 'PRIMARY_UNMATCHED';

-- A supplementary invoice bills the slice of the stay component one journal
-- event moved, never the component whole: '' is a whole component, anything
-- else the key of the event whose slice it is. The component key now includes
-- it, so a component is billed whole once per role and each slice once.
ALTER TABLE "MemberMoneyExportCoverage" ADD COLUMN "sliceKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MemberMoneyExportCoverage" ADD CONSTRAINT "member_money_export_coverage_slice" CHECK (
  "sliceKey" = '' OR "documentRole" <> 'PRIMARY_BOOKING_INVOICE');
DROP INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key";
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key" ON "MemberMoneyExportCoverage"("documentRole", "account", "chargeIdentity", "sliceKey");

-- An update changes descriptions and dates, never an amount: a COVERED update
-- carries no coverage of its own and stands on a COVERED primary manifest for
-- the same booking and invoice with the same total. Every other role keeps
-- the rule: a COVERED manifest's rows add up to its line total, a CONFLICT
-- has none.
CREATE OR REPLACE FUNCTION member_money_require_export_coverage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  m public."MemberMoneyExportManifest"%ROWTYPE;
  row_count bigint;
  covered numeric;
BEGIN
  IF TG_TABLE_NAME = 'MemberMoneyExportManifest' THEN
    SELECT * INTO m FROM public."MemberMoneyExportManifest" WHERE id = NEW.id;
  ELSE
    SELECT * INTO m FROM public."MemberMoneyExportManifest" WHERE id = NEW."manifestId";
  END IF;
  SELECT count(*), coalesce(sum("coveredCents"::bigint), 0) INTO row_count, covered
    FROM public."MemberMoneyExportCoverage" WHERE "manifestId" = m.id;
  IF m.outcome = 'CONFLICT' AND row_count > 0 THEN
    RAISE EXCEPTION 'member_money_invalid_export: conflict_with_coverage' USING ERRCODE = '23514';
  END IF;
  IF m."documentRole"::text = 'PRIMARY_BOOKING_INVOICE_UPDATE' THEN
    IF row_count > 0 THEN
      RAISE EXCEPTION 'member_money_invalid_export: update_with_coverage' USING ERRCODE = '23514';
    END IF;
    IF m.outcome = 'COVERED' AND NOT EXISTS (
      SELECT 1 FROM public."MemberMoneyExportManifest" p
       WHERE p."documentRole" = 'PRIMARY_BOOKING_INVOICE' AND p.outcome = 'COVERED'
         AND p."bookingId" = m."bookingId" AND p."providerInvoiceId" = m."providerInvoiceId"
         AND p."lineTotalCents" = m."lineTotalCents") THEN
      RAISE EXCEPTION 'member_money_invalid_export: update_without_primary' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF m.outcome = 'COVERED' AND covered <> m."lineTotalCents" THEN
    RAISE EXCEPTION 'member_money_invalid_export: coverage_total_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

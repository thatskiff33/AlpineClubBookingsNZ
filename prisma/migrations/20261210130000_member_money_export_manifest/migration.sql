-- Ledger M13 (#4525): expand only. The primary booking invoice's export
-- manifest and its coverage rows, created empty. The draining release never
-- names them.
CREATE TYPE "MemberMoneyExportDocumentRole" AS ENUM ('PRIMARY_BOOKING_INVOICE');
CREATE TYPE "MemberMoneyExportOutcome" AS ENUM ('COVERED', 'CONFLICT');
CREATE TYPE "MemberMoneyExportConflictReason" AS ENUM ('STAY_CENTS', 'FEE_CENTS', 'COMPONENT_UNUSABLE');
CREATE TABLE "MemberMoneyExportManifest" (
  "id" TEXT NOT NULL,
  "documentRole" "MemberMoneyExportDocumentRole" NOT NULL,
  "legacyKey" TEXT NOT NULL,
  "renderRevision" INTEGER NOT NULL,
  "bookingId" TEXT NOT NULL,
  "outcome" "MemberMoneyExportOutcome" NOT NULL,
  "reason" "MemberMoneyExportConflictReason",
  "payloadHash" TEXT NOT NULL,
  "frozenMapping" JSONB NOT NULL,
  "lineTotalCents" INTEGER NOT NULL,
  "providerInvoiceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberMoneyExportManifest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MemberMoneyExportCoverage" (
  "id" TEXT NOT NULL,
  "manifestId" TEXT NOT NULL,
  "documentRole" "MemberMoneyExportDocumentRole" NOT NULL,
  "account" "MemberMoneyAccount" NOT NULL,
  "chargeIdentity" TEXT NOT NULL,
  "coveredCents" INTEGER NOT NULL,
  "taxCode" TEXT,
  CONSTRAINT "MemberMoneyExportCoverage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MemberMoneyExportManifest_bookingId_idx" ON "MemberMoneyExportManifest"("bookingId");
CREATE UNIQUE INDEX "MemberMoneyExportManifest_documentRole_legacyKey_key" ON "MemberMoneyExportManifest"("documentRole", "legacyKey");
CREATE UNIQUE INDEX "MemberMoneyExportManifest_id_documentRole_key" ON "MemberMoneyExportManifest"("id", "documentRole");
CREATE INDEX "MemberMoneyExportCoverage_manifestId_documentRole_idx" ON "MemberMoneyExportCoverage"("manifestId", "documentRole");
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key" ON "MemberMoneyExportCoverage"("documentRole", "account", "chargeIdentity");
ALTER TABLE "MemberMoneyExportManifest" ADD CONSTRAINT "MemberMoneyExportManifest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The coverage row repeats its manifest's role, so the role-wide component key
-- below is the manifest's own role, never a copy that could disagree.
ALTER TABLE "MemberMoneyExportCoverage" ADD CONSTRAINT "MemberMoneyExportCoverage_manifestId_documentRole_fkey" FOREIGN KEY ("manifestId", "documentRole") REFERENCES "MemberMoneyExportManifest"("id", "documentRole") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyExportManifest" ADD CONSTRAINT "member_money_export_manifest_shape" CHECK (
  "renderRevision" = 1 AND length("legacyKey") > 0 AND length("providerInvoiceId") > 0
  AND "payloadHash" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("frozenMapping") = 'object'
  AND (("outcome" = 'COVERED') = ("reason" IS NULL)));
ALTER TABLE "MemberMoneyExportCoverage" ADD CONSTRAINT "member_money_export_coverage_shape" CHECK (
  "coveredCents" > 0 AND length("chargeIdentity") > 0);
CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyExportManifest"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyExportManifest"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyExportCoverage"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyExportCoverage"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();

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
      AND c.relname IN ('MemberMoneyExportManifest', 'MemberMoneyExportCoverage')
      AND acl.grantee <> c.relowner
      AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);
  END LOOP;
END
$$;

-- Cross-row manifest shape, checked at commit so the header and its coverage
-- rows land in one transaction: a COVERED manifest's rows add up to the line
-- total it hashed (none when that total is zero), and a CONFLICT has none, then
-- or later.
CREATE FUNCTION member_money_require_export_coverage() RETURNS trigger
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
  IF m.outcome = 'COVERED' AND covered <> m."lineTotalCents" THEN
    RAISE EXCEPTION 'member_money_invalid_export: coverage_total_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER member_money_export_complete AFTER INSERT ON "MemberMoneyExportManifest"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_export_coverage();
CREATE CONSTRAINT TRIGGER member_money_export_complete AFTER INSERT ON "MemberMoneyExportCoverage"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_export_coverage();

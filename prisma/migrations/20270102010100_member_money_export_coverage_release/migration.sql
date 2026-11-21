-- Ledger M13 (#4525), the combined group invoice cohort: expand only.
--
-- 1. A combined group invoice's manifest names its group settlement; no other
--    role does. Its "bookingId" is the organiser's booking.
-- 2. An invoice and the group's combined invoice bill the same kind of thing,
--    a whole booking component, so at most one of them covers a component at
--    a time. A voided (or vanished) invoice's coverage ends by an insert-only
--    release row, never by changing a manifest; the next document then covers
--    the component at the next coverage generation. Every row the draining
--    release writes takes generation 0, so every existing rule holds for it.
--
-- No DML and no backfill: every existing row is generation 0 with no
-- settlement, which the new CHECK accepts.
CREATE TYPE "MemberMoneyExportCoverageReleaseReason" AS ENUM ('VOIDED', 'NOT_FOUND');

ALTER TABLE "MemberMoneyExportManifest" ADD COLUMN "settlementId" TEXT;
CREATE INDEX "MemberMoneyExportManifest_settlementId_idx" ON "MemberMoneyExportManifest"("settlementId");
ALTER TABLE "MemberMoneyExportManifest" ADD CONSTRAINT "MemberMoneyExportManifest_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "GroupBookingSettlement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyExportManifest" ADD CONSTRAINT "member_money_export_manifest_settlement" CHECK (
  ("settlementId" IS NOT NULL) = ("documentRole" = 'COMBINED_GROUP_INVOICE'));

ALTER TABLE "MemberMoneyExportCoverage" ADD COLUMN "coverageGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MemberMoneyExportCoverage" ADD CONSTRAINT "member_money_export_coverage_generation" CHECK ("coverageGeneration" >= 0);
DROP INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key";
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key" ON "MemberMoneyExportCoverage"("documentRole", "account", "chargeIdentity", "sliceKey", "coverageGeneration");
-- Prisma cannot express a partial index; it is listed in prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX "MemberMoneyExportCoverage_invoice_component_key" ON "MemberMoneyExportCoverage"("account", "chargeIdentity", "sliceKey", "coverageGeneration") WHERE ("documentRole" IN ('PRIMARY_BOOKING_INVOICE', 'COMBINED_GROUP_INVOICE'));

CREATE TABLE "MemberMoneyExportCoverageRelease" (
  "id" TEXT NOT NULL,
  "manifestId" TEXT NOT NULL,
  "reason" "MemberMoneyExportCoverageReleaseReason" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberMoneyExportCoverageRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberMoneyExportCoverageRelease_manifestId_key" ON "MemberMoneyExportCoverageRelease"("manifestId");
ALTER TABLE "MemberMoneyExportCoverageRelease" ADD CONSTRAINT "MemberMoneyExportCoverageRelease_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "MemberMoneyExportManifest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyExportCoverageRelease"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyExportCoverageRelease"
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
      AND c.relname IN ('MemberMoneyExportCoverageRelease')
      AND acl.grantee <> c.relowner
      AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);
  END LOOP;
END
$$;

-- Release order, checked at commit: a coverage row at generation g > 0 stands
-- only when its component was covered at g - 1 by the same role group (an
-- invoice and the combined group invoice are one group; every other role is
-- its own) and every such row's manifest is released. Uniqueness itself is
-- the indexes' job, so two racing writers cannot both pass.
CREATE FUNCTION member_money_require_export_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  invoice_roles text[] := ARRAY['PRIMARY_BOOKING_INVOICE', 'COMBINED_GROUP_INVOICE'];
  roles text[];
  earlier bigint;
  unreleased bigint;
BEGIN
  IF NEW."coverageGeneration" = 0 THEN
    RETURN NULL;
  END IF;
  roles := CASE WHEN NEW."documentRole"::text = ANY (invoice_roles) THEN invoice_roles ELSE ARRAY[NEW."documentRole"::text] END;
  SELECT count(*), count(*) FILTER (WHERE r.id IS NULL) INTO earlier, unreleased
    FROM public."MemberMoneyExportCoverage" c
    LEFT JOIN public."MemberMoneyExportCoverageRelease" r ON r."manifestId" = c."manifestId"
   WHERE c."documentRole"::text = ANY (roles) AND c.account = NEW.account
     AND c."chargeIdentity" = NEW."chargeIdentity" AND c."sliceKey" = NEW."sliceKey"
     AND c."coverageGeneration" = NEW."coverageGeneration" - 1;
  IF earlier = 0 OR unreleased > 0 THEN
    RAISE EXCEPTION 'member_money_invalid_export: generation_not_released' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER member_money_export_generation AFTER INSERT ON "MemberMoneyExportCoverage"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_export_generation();

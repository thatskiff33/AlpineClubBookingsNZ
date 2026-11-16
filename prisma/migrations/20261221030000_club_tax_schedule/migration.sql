-- #4632: the club's tax treatment becomes a schedule of dated periods that
-- every Xero document renders from, each period naming its Xero tax type, and
-- records the Full Admin who scheduled it. Expand only. The deployed release
-- reads only the "default" row's gstRegistered, taxRateBasisPoints and
-- effectiveFrom, and ignores these columns and any later row.
-- No row has ever been written (#4626's no-writer census), so the UPDATE below
-- changes nothing; it is there so the CHECK can never fail on unexpected data.

-- AlterTable
ALTER TABLE "ClubTaxSettings" ADD COLUMN "xeroTaxType" TEXT DEFAULT 'OUTPUT2';
ALTER TABLE "ClubTaxSettings" ADD COLUMN "updatedByMemberId" TEXT;

UPDATE "ClubTaxSettings" SET "xeroTaxType" = NULL WHERE "gstRegistered" = false;

-- A registered period names a non-blank Xero tax type; an unregistered one names none.
ALTER TABLE "ClubTaxSettings" ADD CONSTRAINT "club_tax_xero_tax_type"
  CHECK (CASE WHEN "gstRegistered" THEN "xeroTaxType" IS NOT NULL AND btrim("xeroTaxType") <> ''
              ELSE "xeroTaxType" IS NULL END);

-- One period per start date.
-- CreateIndex
CREATE UNIQUE INDEX "ClubTaxSettings_effectiveFrom_key" ON "ClubTaxSettings"("effectiveFrom");

-- CreateIndex
CREATE INDEX "ClubTaxSettings_updatedByMemberId_idx" ON "ClubTaxSettings"("updatedByMemberId");

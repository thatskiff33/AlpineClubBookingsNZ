-- #5209: the club's tax categories mapped to its own Xero organisation's tax
-- rates. Expand only: one new enum and one new, empty table with no foreign
-- key. No row is seeded: an absent row is an unmapped category, and sales tax
-- on income stays on "ClubTaxSettings", so every document renders exactly as
-- before until a Full Admin maps a category. The deployed release names none
-- of this.

-- CreateEnum
CREATE TYPE "XeroTaxCategory" AS ENUM ('SALES_TAX_ON_EXPENSES', 'EXEMPT', 'ZERO_RATED');

-- CreateTable
CREATE TABLE "XeroTaxCategoryMapping" (
    "id" TEXT NOT NULL,
    "category" "XeroTaxCategory" NOT NULL,
    "taxType" TEXT NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XeroTaxCategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroTaxCategoryMapping_category_key" ON "XeroTaxCategoryMapping"("category");

-- CreateIndex
CREATE INDEX "XeroTaxCategoryMapping_updatedByMemberId_idx" ON "XeroTaxCategoryMapping"("updatedByMemberId");

-- A mapping always names a Xero tax type and the organisation it was chosen in.
ALTER TABLE "XeroTaxCategoryMapping" ADD CONSTRAINT "xero_tax_category_mapping_named"
  CHECK (btrim("taxType") <> '' AND btrim("xeroTenantId") <> '');

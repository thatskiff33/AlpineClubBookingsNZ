-- #4626 Ledger M3a: the club's GST treatment for member-money journal postings
-- (decision D3, docs/design/member-money-ledger.md). Expand only: one new cold
-- singleton table, no foreign key, no change to any existing table or row.
-- No row is seeded: an absent row resolves to the code defaults in
-- src/lib/club-tax-settings.ts, which these column defaults equal (registered,
-- 1500 basis points, in force from 2010-10-01). The deployed release names
-- none of this.

-- CreateTable
CREATE TABLE "ClubTaxSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 1500,
    "effectiveFrom" DATE NOT NULL DEFAULT '2010-10-01'::date,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubTaxSettings_pkey" PRIMARY KEY ("id")
);

-- Whole basis points from 0 to 10000 (MAX_TAX_RATE_BASIS_POINTS).
ALTER TABLE "ClubTaxSettings" ADD CONSTRAINT "club_tax_rate_basis_points"
  CHECK ("taxRateBasisPoints" BETWEEN 0 AND 10000);

-- #3354: the administrator-set NZD -> club-currency conversion rate for AI
-- spend, shared by the page-help assistant and AI Diagnostics. EXPAND ONLY:
-- one brand-new, cold, one-row settings table with no foreign key and no seed
-- row. The provider price tables stay in NZD cents in code; this rate converts
-- each estimate into the club's configured currency before it is booked or
-- compared with a cap. Stored as an integer in parts per million so no float
-- is ever stored. A club whose currency is NZD never reads this table; a
-- non-NZD club with no row is priced at identity, exactly as before this
-- migration, so no existing deployment's behaviour changes on deploy.

-- CreateTable
CREATE TABLE "AiSpendCurrencySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "clubUnitsPerNzdMicros" INTEGER NOT NULL,
    "rateSetAt" TIMESTAMP(3) NOT NULL,
    "rateSetByMemberId" TEXT,

    CONSTRAINT "AiSpendCurrencySettings_pkey" PRIMARY KEY ("id")
);

-- Work party (working bee) events with internal auto-applied promo codes.
-- Each event owns an internal PromoCode (hidden from listings and manual
-- entry) so redemption tracking, pricing, and the $0 confirmation path
-- reuse the existing promo machinery.

ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "internal" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "WorkPartyEvent" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "discountPercent" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "promoCodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkPartyEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkPartyEvent_promoCodeId_key" ON "WorkPartyEvent"("promoCodeId");

CREATE INDEX IF NOT EXISTS "WorkPartyEvent_active_idx" ON "WorkPartyEvent"("active");

CREATE INDEX IF NOT EXISTS "WorkPartyEvent_startDate_endDate_idx" ON "WorkPartyEvent"("startDate", "endDate");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'WorkPartyEvent_promoCodeId_fkey'
    ) THEN
        ALTER TABLE "WorkPartyEvent"
            ADD CONSTRAINT "WorkPartyEvent_promoCodeId_fkey"
            FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

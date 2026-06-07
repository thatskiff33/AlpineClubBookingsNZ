DO $$
BEGIN
    ALTER TYPE "PromoCodeType" ADD VALUE 'FIXED_NIGHTLY_PRICE';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FixedNightlyMode') THEN
        CREATE TYPE "FixedNightlyMode" AS ENUM ('SET_PRICE', 'CAP_ONLY');
    END IF;
END $$;

ALTER TABLE "PromoCode"
    ADD COLUMN "fixedNightlyPriceCents" INTEGER,
    ADD COLUMN "fixedNightlyMode" "FixedNightlyMode";

ALTER TABLE "Booking"
    ADD COLUMN "promoAdjustmentCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "Booking"
SET "promoAdjustmentCents" = -COALESCE("discountCents", 0)
WHERE COALESCE("discountCents", 0) <> 0;

ALTER TABLE "PromoRedemption"
    ADD COLUMN "priceAdjustmentCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "PromoRedemption"
SET "priceAdjustmentCents" = -COALESCE("discountCents", 0)
WHERE COALESCE("discountCents", 0) <> 0;

ALTER TABLE "PromoRedemptionAllocation"
    ADD COLUMN "priceAdjustmentCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "PromoRedemptionAllocation"
SET "priceAdjustmentCents" = -COALESCE("discountCents", 0)
WHERE COALESCE("discountCents", 0) <> 0;

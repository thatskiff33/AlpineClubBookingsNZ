BEGIN;

-- #3276 (stage 2 of programme #3272): record what each promotion took off a
-- night, or off a guest where the engine decides at guest grain. EXPAND ONLY.
-- This migration changes no stored amount and adds no column to any existing
-- table: whether a booking's build-up can be trusted is derived by summing its
-- rows against the recorded promo totals (INV-MONEY-029), never read off a
-- flag. The amount rule, the grain and the reconciliation are stated once, in
-- docs/invariants/money.md under INV-MONEY-029.
CREATE TYPE "BookingGuestNightAdjustmentKind" AS ENUM ('PROMO');

CREATE TABLE "BookingGuestNightAdjustment" (
    "id" TEXT NOT NULL,
    "kind" "BookingGuestNightAdjustmentKind" NOT NULL,
    "amountCents" INTEGER,
    "bookingGuestNightId" TEXT,
    "bookingGuestId" TEXT,
    "bookingId" TEXT NOT NULL,
    "promoRedemptionId" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "beneficiaryMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingGuestNightAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingGuestNightAdjustment_night_kind_redemption_key"
ON "BookingGuestNightAdjustment"("bookingGuestNightId", "kind", "promoRedemptionId");

CREATE UNIQUE INDEX "BookingGuestNightAdjustment_guest_kind_redemption_key"
ON "BookingGuestNightAdjustment"("bookingGuestId", "kind", "promoRedemptionId");

CREATE INDEX "BookingGuestNightAdjustment_bookingId_idx"
ON "BookingGuestNightAdjustment"("bookingId");

CREATE INDEX "BookingGuestNightAdjustment_promoRedemptionId_idx"
ON "BookingGuestNightAdjustment"("promoRedemptionId");

CREATE INDEX "BookingGuestNightAdjustment_promoCodeId_idx"
ON "BookingGuestNightAdjustment"("promoCodeId");

CREATE INDEX "BookingGuestNightAdjustment_beneficiaryMemberId_idx"
ON "BookingGuestNightAdjustment"("beneficiaryMemberId");

ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_bookingGuestNightId_fkey"
FOREIGN KEY ("bookingGuestNightId") REFERENCES "BookingGuestNight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_bookingGuestId_fkey"
FOREIGN KEY ("bookingGuestId") REFERENCES "BookingGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE, not SET NULL: a row is a decomposition of the redemption it names,
-- and every path that deletes a redemption would otherwise leave rows claiming
-- a promo amount that no promotion backs.
ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_promoRedemptionId_fkey"
FOREIGN KEY ("promoRedemptionId") REFERENCES "PromoRedemption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_promoCodeId_fkey"
FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_beneficiaryMemberId_fkey"
FOREIGN KEY ("beneficiaryMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one target. Prisma cannot express a CHECK, so it lives here and the
-- writer mirrors it; the table is created empty by this same migration, so the
-- constraint is validated against a provably empty population.
ALTER TABLE "BookingGuestNightAdjustment"
ADD CONSTRAINT "BookingGuestNightAdjustment_exactly_one_target"
CHECK (("bookingGuestNightId" IS NULL) <> ("bookingGuestId" IS NULL));

COMMIT;

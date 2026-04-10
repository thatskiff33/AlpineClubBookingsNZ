ALTER TABLE "PromoCode"
ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PromoCode_archivedAt_idx"
ON "PromoCode"("archivedAt");

CREATE TABLE IF NOT EXISTS "PromoCodeAssignment" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCodeAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PromoCodeAssignment_promoCodeId_memberId_key"
ON "PromoCodeAssignment"("promoCodeId", "memberId");

CREATE INDEX IF NOT EXISTS "PromoCodeAssignment_promoCodeId_idx"
ON "PromoCodeAssignment"("promoCodeId");

CREATE INDEX IF NOT EXISTS "PromoCodeAssignment_memberId_idx"
ON "PromoCodeAssignment"("memberId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'PromoCodeAssignment_promoCodeId_fkey'
    ) THEN
        ALTER TABLE "PromoCodeAssignment"
        ADD CONSTRAINT "PromoCodeAssignment_promoCodeId_fkey"
        FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'PromoCodeAssignment_memberId_fkey'
    ) THEN
        ALTER TABLE "PromoCodeAssignment"
        ADD CONSTRAINT "PromoCodeAssignment_memberId_fkey"
        FOREIGN KEY ("memberId") REFERENCES "Member"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;
    END IF;
END $$;

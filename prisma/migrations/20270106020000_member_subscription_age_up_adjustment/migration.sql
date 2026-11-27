-- #5190 PR 3 (INV-MONEY-051): one new, empty table for a mid-season age-up's
-- part-season top-up or credit under the "Age today" liability rule, and its two
-- enums. Expand only, no DML. Nothing writes a row until a club chooses "Age
-- today", which the after-deploy step holds back until the old colour drains.

-- CreateEnum
CREATE TYPE "AgeUpAdjustmentKind" AS ENUM ('TOP_UP', 'CREDIT');

-- CreateEnum
CREATE TYPE "AgeUpAdjustmentStatus" AS ENUM ('PENDING', 'CREDITED_ON_INVOICE', 'CREDITED_TO_ACCOUNT', 'VOIDED');

-- CreateTable
CREATE TABLE "MemberSubscriptionAgeUpAdjustment" (
    "id" TEXT NOT NULL,
    "memberSubscriptionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "ageUpDate" DATE NOT NULL,
    "kind" "AgeUpAdjustmentKind" NOT NULL,
    "status" "AgeUpAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "fromAgeTier" "AgeTier" NOT NULL,
    "toAgeTier" "AgeTier" NOT NULL,
    "coveredMonths" INTEGER NOT NULL,
    "fromAnnualCents" INTEGER NOT NULL,
    "toAnnualCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "chargeId" TEXT,
    "memberCreditId" TEXT,
    "xeroCreditNoteId" TEXT,
    "xeroInvoiceStatus" "SubscriptionStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberSubscriptionAgeUpAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubscriptionAgeUpAdjustment_chargeId_key" ON "MemberSubscriptionAgeUpAdjustment"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubscriptionAgeUpAdjustment_memberCreditId_key" ON "MemberSubscriptionAgeUpAdjustment"("memberCreditId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubscriptionAgeUpAdjustment_xeroCreditNoteId_key" ON "MemberSubscriptionAgeUpAdjustment"("xeroCreditNoteId");

-- CreateIndex
CREATE INDEX "MemberSubscriptionAgeUpAdjustment_seasonYear_kind_status_idx" ON "MemberSubscriptionAgeUpAdjustment"("seasonYear", "kind", "status");

-- CreateIndex
CREATE INDEX "MemberSubscriptionAgeUpAdjustment_memberId_idx" ON "MemberSubscriptionAgeUpAdjustment"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubscriptionAgeUpAdjustment_memberSubscriptionId_ageU_key" ON "MemberSubscriptionAgeUpAdjustment"("memberSubscriptionId", "ageUpDate");

-- AddForeignKey
ALTER TABLE "MemberSubscriptionAgeUpAdjustment" ADD CONSTRAINT "MemberSubscriptionAgeUpAdjustment_memberSubscriptionId_fkey" FOREIGN KEY ("memberSubscriptionId") REFERENCES "MemberSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubscriptionAgeUpAdjustment" ADD CONSTRAINT "MemberSubscriptionAgeUpAdjustment_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "MembershipSubscriptionCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubscriptionAgeUpAdjustment" ADD CONSTRAINT "MemberSubscriptionAgeUpAdjustment_memberCreditId_fkey" FOREIGN KEY ("memberCreditId") REFERENCES "MemberCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A top-up or credit is never for nothing.
ALTER TABLE "MemberSubscriptionAgeUpAdjustment" ADD CONSTRAINT "MemberSubscriptionAgeUpAdjustment_amount_positive" CHECK ("amountCents" > 0);

-- A TOP_UP, and only a TOP_UP, names the charge that invoices it; only a CREDIT
-- names a credit lot or a credit note.
ALTER TABLE "MemberSubscriptionAgeUpAdjustment" ADD CONSTRAINT "MemberSubscriptionAgeUpAdjustment_kind_links" CHECK (
  ("kind" = 'TOP_UP' AND "chargeId" IS NOT NULL AND "memberCreditId" IS NULL AND "xeroCreditNoteId" IS NULL)
  OR ("kind" = 'CREDIT' AND "chargeId" IS NULL AND "xeroInvoiceStatus" IS NULL)
);

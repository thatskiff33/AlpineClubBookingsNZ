-- #5204: Xero overpayments and prepayments become something the app can see
-- (the finance queue, this release) and, in later releases, turn into member
-- credit, be allocated to booking invoices, and come back on cancel. Expand
-- only, and the one migration for all three releases: a new enum, three new
-- tables, a nullable backing column on MemberCredit and on
-- AdminCreditAdjustmentRequest, their indexes, foreign keys and CHECKs. No DML.
-- The deployed release never reads or writes any of it.

-- CreateEnum
CREATE TYPE "XeroCashCreditKind" AS ENUM ('OVERPAYMENT', 'PREPAYMENT');

-- AlterTable
ALTER TABLE "AdminCreditAdjustmentRequest" ADD COLUMN     "xeroCashCreditId" TEXT;

-- AlterTable
ALTER TABLE "MemberCredit" ADD COLUMN     "xeroCashCreditId" TEXT;

-- CreateTable
CREATE TABLE "XeroCashCredit" (
    "id" TEXT NOT NULL,
    "kind" "XeroCashCreditKind" NOT NULL,
    "xeroDocumentId" TEXT NOT NULL,
    "xeroContactId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "documentDate" DATE,
    "totalCents" INTEGER NOT NULL,
    "remainingCents" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroCashCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberCreditCashAllocation" (
    "id" TEXT NOT NULL,
    "memberCreditId" TEXT NOT NULL,
    "xeroCashCreditId" TEXT NOT NULL,
    "appliedToBookingId" TEXT NOT NULL,
    "heldCents" INTEGER NOT NULL,
    "returningCents" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "xeroAllocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberCreditCashAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberCreditCashReturn" (
    "id" TEXT NOT NULL,
    "restorationCreditId" TEXT NOT NULL,
    "cashAllocationId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberCreditCashReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroCashCredit_xeroDocumentId_key" ON "XeroCashCredit"("xeroDocumentId");

-- CreateIndex
CREATE INDEX "XeroCashCredit_xeroContactId_idx" ON "XeroCashCredit"("xeroContactId");

-- CreateIndex
CREATE INDEX "XeroCashCredit_remainingCents_idx" ON "XeroCashCredit"("remainingCents");

-- CreateIndex
CREATE INDEX "MemberCreditCashAllocation_appliedToBookingId_idx" ON "MemberCreditCashAllocation"("appliedToBookingId");

-- CreateIndex
CREATE INDEX "MemberCreditCashAllocation_xeroCashCreditId_idx" ON "MemberCreditCashAllocation"("xeroCashCreditId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberCreditCashAllocation_lot_booking_key" ON "MemberCreditCashAllocation"("memberCreditId", "appliedToBookingId");

-- CreateIndex
CREATE INDEX "MemberCreditCashReturn_cashAllocationId_idx" ON "MemberCreditCashReturn"("cashAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberCreditCashReturn_restoration_slice_key" ON "MemberCreditCashReturn"("restorationCreditId", "cashAllocationId");

-- CreateIndex
CREATE INDEX "AdminCreditAdjustmentRequest_xeroCashCreditId_idx" ON "AdminCreditAdjustmentRequest"("xeroCashCreditId");

-- CreateIndex
CREATE INDEX "MemberCredit_xeroCashCreditId_idx" ON "MemberCredit"("xeroCashCreditId");

-- CreateIndex: the target of a cash slice's (lot, document) foreign key.
CREATE UNIQUE INDEX "MemberCredit_id_xeroCashCreditId_key" ON "MemberCredit"("id", "xeroCashCreditId");

-- AddForeignKey
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_xeroCashCreditId_fkey" FOREIGN KEY ("xeroCashCreditId") REFERENCES "XeroCashCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AdminCreditAdjustmentRequest" ADD CONSTRAINT "AdminCreditAdjustmentRequest_xeroCashCreditId_fkey" FOREIGN KEY ("xeroCashCreditId") REFERENCES "XeroCashCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
-- A slice draws on its own lot's document: a slice naming another document,
-- or hanging off an unbacked lot, cannot be written.
ALTER TABLE "MemberCreditCashAllocation" ADD CONSTRAINT "MemberCreditCashAllocation_memberCreditId_xeroCashCreditId_fkey" FOREIGN KEY ("memberCreditId", "xeroCashCreditId") REFERENCES "MemberCredit"("id", "xeroCashCreditId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberCreditCashAllocation" ADD CONSTRAINT "MemberCreditCashAllocation_xeroCashCreditId_fkey" FOREIGN KEY ("xeroCashCreditId") REFERENCES "XeroCashCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberCreditCashReturn" ADD CONSTRAINT "MemberCreditCashReturn_restorationCreditId_fkey" FOREIGN KEY ("restorationCreditId") REFERENCES "MemberCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberCreditCashReturn" ADD CONSTRAINT "MemberCreditCashReturn_cashAllocationId_fkey" FOREIGN KEY ("cashAllocationId") REFERENCES "MemberCreditCashAllocation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Amounts are cents and never negative; a generation counts from 1.
ALTER TABLE "XeroCashCredit" ADD CONSTRAINT "xero_cash_credit_nonnegative_cents"
  CHECK ("totalCents" >= 0 AND "remainingCents" >= 0);
ALTER TABLE "MemberCreditCashAllocation" ADD CONSTRAINT "member_credit_cash_allocation_amounts"
  CHECK ("heldCents" >= 0 AND "returningCents" >= 0 AND "generation" >= 1);
ALTER TABLE "MemberCreditCashReturn" ADD CONSTRAINT "member_credit_cash_return_amounts"
  CHECK ("amountCents" >= 0 AND "generation" >= 1);

-- A credit request is backed by a Xero document or names a grant account, never both.
-- Every existing row has a NULL backing, so the CHECK holds on existing data.
ALTER TABLE "AdminCreditAdjustmentRequest" ADD CONSTRAINT "admin_credit_request_backing_or_grant_account"
  CHECK ("xeroCashCreditId" IS NULL OR "grantAccount" IS NULL);

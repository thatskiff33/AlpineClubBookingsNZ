-- Phase 5: Pricing, Promos & Cancellation Enhancements

-- P5.1: Group Discount Setting
CREATE TABLE "GroupDiscountSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "minGroupSize" INTEGER NOT NULL DEFAULT 5,
    "summerOnly" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupDiscountSetting_pkey" PRIMARY KEY ("id")
);

-- P5.3: Promo code booking date gating
ALTER TABLE "PromoCode" ADD COLUMN "bookingStartFrom" TIMESTAMP(3);
ALTER TABLE "PromoCode" ADD COLUMN "bookingStartUntil" TIMESTAMP(3);

-- P5.4: Refund Request / Appeal workflow
CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAmountCents" INTEGER,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "approvedAmountCents" INTEGER,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefundRequest_bookingId_idx" ON "RefundRequest"("bookingId");
CREATE INDEX "RefundRequest_memberId_idx" ON "RefundRequest"("memberId");
CREATE INDEX "RefundRequest_status_idx" ON "RefundRequest"("status");

ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- P5.5: Mixed cancellation fees (fixed fee per tier)
ALTER TABLE "CancellationPolicy" ADD COLUMN "fixedFeeCents" INTEGER NOT NULL DEFAULT 0;

-- P5.4: Admin notification preference for refund requests
ALTER TABLE "NotificationPreference" ADD COLUMN "adminRefundRequest" BOOLEAN NOT NULL DEFAULT true;

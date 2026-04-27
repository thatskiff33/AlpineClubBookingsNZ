-- Require second-admin approval for manual account-credit adjustments.
CREATE TYPE "AdminCreditAdjustmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "AdminCreditAdjustmentRequest" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AdminCreditAdjustmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminCreditAdjustmentRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MemberCredit"
ADD COLUMN "requestedById" TEXT,
ADD COLUMN "approvedById" TEXT,
ADD COLUMN "approvalRequestId" TEXT;

CREATE UNIQUE INDEX "MemberCredit_approvalRequestId_key" ON "MemberCredit"("approvalRequestId");
CREATE INDEX "MemberCredit_requestedById_idx" ON "MemberCredit"("requestedById");
CREATE INDEX "MemberCredit_approvedById_idx" ON "MemberCredit"("approvedById");

CREATE INDEX "AdminCreditAdjustmentRequest_memberId_status_createdAt_idx" ON "AdminCreditAdjustmentRequest"("memberId", "status", "createdAt");
CREATE INDEX "AdminCreditAdjustmentRequest_requestedById_createdAt_idx" ON "AdminCreditAdjustmentRequest"("requestedById", "createdAt");
CREATE INDEX "AdminCreditAdjustmentRequest_reviewedById_createdAt_idx" ON "AdminCreditAdjustmentRequest"("reviewedById", "createdAt");
CREATE UNIQUE INDEX "AdminCreditAdjustmentRequest_requestedById_idempotencyKey_key" ON "AdminCreditAdjustmentRequest"("requestedById", "idempotencyKey");

ALTER TABLE "MemberCredit"
ADD CONSTRAINT "MemberCredit_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberCredit"
ADD CONSTRAINT "MemberCredit_approvedById_fkey"
FOREIGN KEY ("approvedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberCredit"
ADD CONSTRAINT "MemberCredit_approvalRequestId_fkey"
FOREIGN KEY ("approvalRequestId") REFERENCES "AdminCreditAdjustmentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AdminCreditAdjustmentRequest"
ADD CONSTRAINT "AdminCreditAdjustmentRequest_memberId_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdminCreditAdjustmentRequest"
ADD CONSTRAINT "AdminCreditAdjustmentRequest_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdminCreditAdjustmentRequest"
ADD CONSTRAINT "AdminCreditAdjustmentRequest_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

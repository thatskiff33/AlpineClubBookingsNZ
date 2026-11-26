-- #5241: expand only. Old code does not read these new tables or enums.
CREATE TYPE "AdminCreditDeductionCorrectionStatus" AS ENUM ('RESERVED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AdminCreditDeductionCorrectionMode" AS ENUM ('VOID', 'INVOICE');
CREATE TABLE "AdminCreditDeductionCorrection" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "status" "AdminCreditDeductionCorrectionStatus" NOT NULL DEFAULT 'RESERVED',
  "cancelledById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "providerMutationStartedAt" TIMESTAMP(3),
  CONSTRAINT "AdminCreditDeductionCorrection_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AdminCreditDeductionCorrectionLine" (
  "id" TEXT NOT NULL,
  "correctionId" TEXT NOT NULL,
  "memberCreditId" TEXT NOT NULL,
  "sourceMemberCreditId" TEXT NOT NULL,
  "xeroCreditNoteId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "mode" "AdminCreditDeductionCorrectionMode" NOT NULL,
  "xeroInvoiceId" TEXT,
  "xeroAllocationId" TEXT,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AdminCreditDeductionCorrectionLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminCreditDeductionCorrectionLine_positive_cents" CHECK ("amountCents" > 0)
);
CREATE UNIQUE INDEX "AdminCreditDeductionCorrection_requestId_key" ON "AdminCreditDeductionCorrection"("requestId");
CREATE INDEX "AdminCreditDeductionCorrection_memberId_status_idx" ON "AdminCreditDeductionCorrection"("memberId", "status");
CREATE INDEX "AdminCreditDeductionCorrection_cancelledById_idx" ON "AdminCreditDeductionCorrection"("cancelledById");
CREATE UNIQUE INDEX "AdminCreditDeductionCorrectionLine_memberCreditId_key" ON "AdminCreditDeductionCorrectionLine"("memberCreditId");
CREATE INDEX "AdminCreditDeductionCorrectionLine_correctionId_idx" ON "AdminCreditDeductionCorrectionLine"("correctionId");
CREATE INDEX "AdminCreditDeductionCorrectionLine_sourceMemberCreditId_idx" ON "AdminCreditDeductionCorrectionLine"("sourceMemberCreditId");
CREATE INDEX "AdminCreditDeductionCorrectionLine_xeroCreditNoteId_idx" ON "AdminCreditDeductionCorrectionLine"("xeroCreditNoteId");
ALTER TABLE "AdminCreditDeductionCorrection" ADD CONSTRAINT "AdminCreditDeductionCorrection_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AdminCreditAdjustmentRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdminCreditDeductionCorrection" ADD CONSTRAINT "AdminCreditDeductionCorrection_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdminCreditDeductionCorrection" ADD CONSTRAINT "AdminCreditDeductionCorrection_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdminCreditDeductionCorrectionLine" ADD CONSTRAINT "AdminCreditDeductionCorrectionLine_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "AdminCreditDeductionCorrection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdminCreditDeductionCorrectionLine" ADD CONSTRAINT "AdminCreditDeductionCorrectionLine_memberCreditId_fkey" FOREIGN KEY ("memberCreditId") REFERENCES "MemberCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AdminCreditDeductionCorrectionLine" ADD CONSTRAINT "AdminCreditDeductionCorrectionLine_sourceMemberCreditId_fkey" FOREIGN KEY ("sourceMemberCreditId") REFERENCES "MemberCredit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

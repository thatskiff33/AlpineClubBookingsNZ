-- #5208: the journal's GST is the figure of record on a new primary invoice
-- (owner decision 18 Nov 2026, Option A), and a Xero reply that changes it
-- pauses the overrides until finance clears it. Expand only: a new conflict
-- reason, a new enum and a new table. The deployed release never writes or
-- reads the table, and writes no TAX_CENTS manifest.

-- AlterEnum
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'TAX_CENTS';

-- CreateEnum
CREATE TYPE "XeroTaxOverrideDocumentKind" AS ENUM ('CREATE', 'UPDATE');

-- CreateTable
CREATE TABLE "XeroTaxOverrideMismatch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "xeroSyncOperationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "providerInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "documentKind" "XeroTaxOverrideDocumentKind" NOT NULL,
    "lines" JSONB NOT NULL,
    "clearedAt" TIMESTAMP(3),
    "clearedByMemberId" TEXT,
    "clearNote" TEXT,

    CONSTRAINT "XeroTaxOverrideMismatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroTaxOverrideMismatch_xeroSyncOperationId_key" ON "XeroTaxOverrideMismatch"("xeroSyncOperationId");

-- CreateIndex
CREATE INDEX "XeroTaxOverrideMismatch_clearedAt_idx" ON "XeroTaxOverrideMismatch"("clearedAt");

-- CreateIndex
CREATE INDEX "XeroTaxOverrideMismatch_bookingId_idx" ON "XeroTaxOverrideMismatch"("bookingId");

-- CreateIndex
CREATE INDEX "XeroTaxOverrideMismatch_clearedByMemberId_idx" ON "XeroTaxOverrideMismatch"("clearedByMemberId");

CREATE TYPE "FinanceSnapshotType" AS ENUM (
    'PROFIT_AND_LOSS_MONTHLY',
    'ACCOUNTS_RECEIVABLE_INVOICES',
    'ACCOUNTS_PAYABLE_INVOICES',
    'BANK_TRANSACTIONS',
    'AGED_RECEIVABLES',
    'AGED_PAYABLES',
    'BALANCE_SHEET',
    'BANK_BALANCES',
    'CONTACTS'
);

CREATE TYPE "FinanceSyncRunStatus" AS ENUM (
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'PARTIAL'
);

CREATE TYPE "FinanceSyncRunTrigger" AS ENUM (
    'MANUAL',
    'SCHEDULED',
    'BACKFILL'
);

CREATE TABLE "FinanceSyncRun" (
    "id" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "trigger" "FinanceSyncRunTrigger" NOT NULL,
    "status" "FinanceSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "snapshotCount" INTEGER NOT NULL DEFAULT 0,
    "totalRowCount" INTEGER NOT NULL DEFAULT 0,
    "xeroTenantId" TEXT,
    "requestedByMemberId" TEXT,
    "resultSummary" JSONB,
    "errorSummary" TEXT,
    "errorDetails" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotType" "FinanceSnapshotType" NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'default',
    "asOfDate" DATE NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "syncRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceSnapshot_snapshotType_scope_asOfDate_key"
ON "FinanceSnapshot"("snapshotType", "scope", "asOfDate");

CREATE INDEX "FinanceSyncRun_workflow_startedAt_idx"
ON "FinanceSyncRun"("workflow", "startedAt");

CREATE INDEX "FinanceSyncRun_status_startedAt_idx"
ON "FinanceSyncRun"("status", "startedAt");

CREATE INDEX "FinanceSyncRun_trigger_startedAt_idx"
ON "FinanceSyncRun"("trigger", "startedAt");

CREATE INDEX "FinanceSnapshot_snapshotType_asOfDate_idx"
ON "FinanceSnapshot"("snapshotType", "asOfDate");

CREATE INDEX "FinanceSnapshot_scope_asOfDate_idx"
ON "FinanceSnapshot"("scope", "asOfDate");

CREATE INDEX "FinanceSnapshot_syncRunId_idx"
ON "FinanceSnapshot"("syncRunId");

ALTER TABLE "FinanceSnapshot"
ADD CONSTRAINT "FinanceSnapshot_syncRunId_fkey"
FOREIGN KEY ("syncRunId") REFERENCES "FinanceSyncRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

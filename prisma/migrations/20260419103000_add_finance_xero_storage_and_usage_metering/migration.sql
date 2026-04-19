CREATE TABLE "FinanceXeroToken" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceXeroToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceXeroApiUsageDaily" (
    "id" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "successfulCalls" INTEGER NOT NULL DEFAULT 0,
    "failedCalls" INTEGER NOT NULL DEFAULT 0,
    "dayRateLimitHits" INTEGER NOT NULL DEFAULT 0,
    "minuteRateLimitHits" INTEGER NOT NULL DEFAULT 0,
    "lastRateLimitCategory" TEXT,
    "lastRateLimitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceXeroApiUsageDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceXeroApiUsageEvent" (
    "id" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "operation" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "workflow" TEXT,
    "success" BOOLEAN NOT NULL,
    "rateLimitCategory" TEXT,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceXeroApiUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceXeroApiUsageDaily_usageDate_key" ON "FinanceXeroApiUsageDaily"("usageDate");
CREATE INDEX "FinanceXeroApiUsageDaily_usageDate_idx" ON "FinanceXeroApiUsageDaily"("usageDate");
CREATE INDEX "FinanceXeroApiUsageEvent_usageDate_createdAt_idx" ON "FinanceXeroApiUsageEvent"("usageDate", "createdAt");
CREATE INDEX "FinanceXeroApiUsageEvent_operation_usageDate_idx" ON "FinanceXeroApiUsageEvent"("operation", "usageDate");
CREATE INDEX "FinanceXeroApiUsageEvent_workflow_usageDate_idx" ON "FinanceXeroApiUsageEvent"("workflow", "usageDate");
CREATE INDEX "FinanceXeroApiUsageEvent_success_createdAt_idx" ON "FinanceXeroApiUsageEvent"("success", "createdAt");
CREATE INDEX "FinanceXeroApiUsageEvent_rateLimitCategory_createdAt_idx" ON "FinanceXeroApiUsageEvent"("rateLimitCategory", "createdAt");

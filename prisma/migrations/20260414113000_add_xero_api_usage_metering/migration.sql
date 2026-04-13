-- CreateTable
CREATE TABLE "XeroApiUsageDaily" (
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

    CONSTRAINT "XeroApiUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroApiUsageEvent" (
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

    CONSTRAINT "XeroApiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroApiUsageDaily_usageDate_key" ON "XeroApiUsageDaily"("usageDate");

-- CreateIndex
CREATE INDEX "XeroApiUsageDaily_usageDate_idx" ON "XeroApiUsageDaily"("usageDate");

-- CreateIndex
CREATE INDEX "XeroApiUsageEvent_usageDate_createdAt_idx" ON "XeroApiUsageEvent"("usageDate", "createdAt");

-- CreateIndex
CREATE INDEX "XeroApiUsageEvent_operation_usageDate_idx" ON "XeroApiUsageEvent"("operation", "usageDate");

-- CreateIndex
CREATE INDEX "XeroApiUsageEvent_workflow_usageDate_idx" ON "XeroApiUsageEvent"("workflow", "usageDate");

-- CreateIndex
CREATE INDEX "XeroApiUsageEvent_success_createdAt_idx" ON "XeroApiUsageEvent"("success", "createdAt");

-- CreateIndex
CREATE INDEX "XeroApiUsageEvent_rateLimitCategory_createdAt_idx" ON "XeroApiUsageEvent"("rateLimitCategory", "createdAt");

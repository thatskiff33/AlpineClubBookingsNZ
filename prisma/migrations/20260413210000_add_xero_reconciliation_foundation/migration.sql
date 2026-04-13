-- CreateTable
CREATE TABLE "XeroSyncOperation" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "localModel" TEXT,
    "localId" TEXT,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "correlationKey" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "replayable" BOOLEAN NOT NULL DEFAULT true,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "xeroObjectType" TEXT,
    "xeroObjectId" TEXT,
    "xeroObjectNumber" TEXT,
    "xeroObjectUrl" TEXT,
    "createdByMemberId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroSyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroObjectLink" (
    "id" TEXT NOT NULL,
    "localModel" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "xeroObjectType" TEXT NOT NULL,
    "xeroObjectId" TEXT NOT NULL,
    "xeroObjectNumber" TEXT,
    "xeroObjectUrl" TEXT,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroObjectLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroInboundEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'webhook',
    "eventCategory" TEXT,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "eventCreatedAt" TIMESTAMP(3),
    "correlationKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "XeroSyncOperation_status_createdAt_idx" ON "XeroSyncOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_direction_status_createdAt_idx" ON "XeroSyncOperation"("direction", "status", "createdAt");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_entityType_status_createdAt_idx" ON "XeroSyncOperation"("entityType", "status", "createdAt");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_localModel_localId_createdAt_idx" ON "XeroSyncOperation"("localModel", "localId", "createdAt");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_correlationKey_idx" ON "XeroSyncOperation"("correlationKey");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_idempotencyKey_idx" ON "XeroSyncOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "XeroSyncOperation_xeroObjectType_xeroObjectId_idx" ON "XeroSyncOperation"("xeroObjectType", "xeroObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "XeroObjectLink_local_xero_role_key" ON "XeroObjectLink"("localModel", "localId", "xeroObjectType", "xeroObjectId", "role");

-- CreateIndex
CREATE INDEX "XeroObjectLink_localModel_localId_active_idx" ON "XeroObjectLink"("localModel", "localId", "active");

-- CreateIndex
CREATE INDEX "XeroObjectLink_xeroObjectType_xeroObjectId_idx" ON "XeroObjectLink"("xeroObjectType", "xeroObjectId");

-- CreateIndex
CREATE INDEX "XeroObjectLink_role_active_idx" ON "XeroObjectLink"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "XeroInboundEvent_correlationKey_key" ON "XeroInboundEvent"("correlationKey");

-- CreateIndex
CREATE INDEX "XeroInboundEvent_status_createdAt_idx" ON "XeroInboundEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "XeroInboundEvent_eventCategory_eventType_createdAt_idx" ON "XeroInboundEvent"("eventCategory", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "XeroInboundEvent_resourceId_idx" ON "XeroInboundEvent"("resourceId");

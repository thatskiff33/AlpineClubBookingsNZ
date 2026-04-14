-- CreateTable
CREATE TABLE "XeroAdminCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroAdminCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroAdminCache_cacheKey_tenantId_key" ON "XeroAdminCache"("cacheKey", "tenantId");

-- CreateIndex
CREATE INDEX "XeroAdminCache_expiresAt_idx" ON "XeroAdminCache"("expiresAt");

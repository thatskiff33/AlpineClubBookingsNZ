-- Additive only: the previous release names neither table. No backfill.
CREATE TABLE "CronRunClaim" (
    "jobName" TEXT NOT NULL,
    "owner" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CronRunClaim_pkey" PRIMARY KEY ("jobName")
);
CREATE TABLE "XeroInboundSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "silentWebhookHours" INTEGER NOT NULL DEFAULT 24,
    "lastWebhookReceivedAt" TIMESTAMP(3),
    CONSTRAINT "XeroInboundSettings_pkey" PRIMARY KEY ("id")
);

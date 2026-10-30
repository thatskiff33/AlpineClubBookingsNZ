-- Additive only: the previous release does not name this table. No backfill.
CREATE TABLE "XeroInboundSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "silentWebhookHours" INTEGER NOT NULL DEFAULT 24,
    "lastWebhookReceivedAt" TIMESTAMP(3),
    CONSTRAINT "XeroInboundSettings_pkey" PRIMARY KEY ("id")
);

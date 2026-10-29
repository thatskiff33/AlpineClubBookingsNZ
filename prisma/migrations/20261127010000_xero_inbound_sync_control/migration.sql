-- Additive only: the previous release names neither table. No backfill.
CREATE TABLE "XeroInboundSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "silentWebhookHours" INTEGER NOT NULL DEFAULT 24,
    "lastWebhookReceivedAt" TIMESTAMP(3),
    CONSTRAINT "XeroInboundSettings_pkey" PRIMARY KEY ("id")
);

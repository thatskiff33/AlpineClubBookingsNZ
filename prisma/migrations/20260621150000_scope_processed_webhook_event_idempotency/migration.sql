-- Issue #815: scope webhook idempotency per provider. Provider event IDs are
-- only unique within a provider, so the global unique on eventId could let a
-- Stripe and a Xero/SES event that happen to share an ID collide and silently
-- drop one. Replace it with a composite unique on (source, eventId).

-- DropIndex
DROP INDEX "ProcessedWebhookEvent_eventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhookEvent_source_eventId_key" ON "ProcessedWebhookEvent"("source", "eventId");

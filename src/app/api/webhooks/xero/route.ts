import { after, NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { recordWebhookLog } from "@/lib/webhook-log";
import logger from "@/lib/logger";
import { buildXeroIdempotencyKey, recordXeroInboundEvent } from "@/lib/xero-sync";
import { processStoredXeroInboundEvents } from "@/lib/xero-inbound-reconciliation";
import { isXeroConnected } from "@/lib/xero";

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

/**
 * POST /api/webhooks/xero
 * Handles Xero webhook events.
 *
 * Xero webhooks use an intent-to-receive pattern:
 * 1. First, Xero sends a validation request with a payload
 * 2. We must respond with the correct HMAC-SHA256 hash
 * 3. Then Xero starts sending actual event payloads
 */
export async function POST(request: NextRequest) {
  const webhookKey = process.env.XERO_WEBHOOK_KEY;
  if (!webhookKey) {
    return NextResponse.json(
      { error: "Xero webhook key not configured" },
      { status: 500 }
    );
  }

  const signature = request.headers.get("x-xero-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const body = await request.text();

  // Verify HMAC-SHA256 signature
  const expectedSignature = createHmac("sha256", webhookKey)
    .update(body)
    .digest("base64");

  // timingSafeEqual requires equal-length buffers; reject mismatches as invalid
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    // Xero requires a 401 response for invalid signatures
    return new NextResponse(null, { status: 401 });
  }

  // Parse the payload
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle events
  const events = payload.events ?? [];

  for (const event of events) {
    const { eventType, eventCategory, resourceId } = event;
    const eventStart = Date.now();
    const eventDateUtc =
      typeof event.eventDateUtc === "string" ? new Date(event.eventDateUtc) : null;
    const correlationKey = buildXeroIdempotencyKey(
      "xero",
      "webhook",
      eventCategory || "UNKNOWN",
      eventType || "UNKNOWN",
      resourceId || "UNKNOWN",
      typeof event.eventDateUtc === "string" ? event.eventDateUtc : "NO_DATE"
    );

    try {
      await recordXeroInboundEvent({
        source: "webhook",
        eventCategory: eventCategory ?? null,
        eventType: eventType ?? "UNKNOWN",
        resourceId: resourceId ?? null,
        eventCreatedAt: eventDateUtc,
        correlationKey,
        payload: event,
        status: "RECEIVED",
      });

      // Log for now - specific handlers can be added as needed
      logger.info({ eventCategory, eventType, resourceId }, "Xero webhook event received");

      // Handle contact updates (membership changes)
      if (eventCategory === "CONTACT" && eventType === "UPDATE") {
        // Could trigger membership re-check here
        logger.info({ resourceId }, "Xero contact updated");
      }

      // Handle invoice status changes
      if (eventCategory === "INVOICE") {
        logger.info({ eventType, resourceId }, "Xero invoice event");
      }

      // OBS-08: Record successful webhook processing
      await recordWebhookLog({
        source: "xero",
        eventType: `${eventCategory}.${eventType}`,
        eventId: resourceId || "unknown",
        status: "success",
        durationMs: Date.now() - eventStart,
      });
    } catch (err) {
      await recordXeroInboundEvent({
        source: "webhook",
        eventCategory: eventCategory ?? null,
        eventType: eventType ?? "UNKNOWN",
        resourceId: resourceId ?? null,
        eventCreatedAt: eventDateUtc,
        correlationKey,
        payload: event,
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
      });

      logger.error({ err, eventCategory, eventType, resourceId }, "Error processing Xero webhook event");

      // OBS-08: Record failed webhook processing
      await recordWebhookLog({
        source: "xero",
        eventType: `${eventCategory}.${eventType}`,
        eventId: resourceId || "unknown",
        status: "failure",
        durationMs: Date.now() - eventStart,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (events.length > 0) {
    scheduleAfterResponse(async () => {
      try {
        if (!(await isXeroConnected())) {
          return;
        }

        await processStoredXeroInboundEvents({
          limit: Math.min(Math.max(events.length, 1), 10),
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to kick Xero inbound reconciliation worker");
      }
    });
  }

  // Xero expects a 200 response
  return NextResponse.json({ status: "ok" });
}

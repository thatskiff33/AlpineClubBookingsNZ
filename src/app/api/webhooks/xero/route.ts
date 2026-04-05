import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import logger from "@/lib/logger";

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

  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
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
  }

  // Xero expects a 200 response
  return NextResponse.json({ status: "ok" });
}

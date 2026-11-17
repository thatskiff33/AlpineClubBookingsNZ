import { NextRequest, NextResponse } from "next/server";
import { ingestSesSnsEmailFeedback } from "@/lib/email";
import {
  parseSnsWebhookEnvelope,
  verifySnsWebhookMessage,
} from "@/lib/ses-sns";
import {
  claimWebhookEventLease,
  completeWebhookEventLease,
  releaseWebhookEventLease,
} from "@/lib/webhook-claim-lease";
import { recordWebhookLog } from "@/lib/webhook-log";
import logger from "@/lib/logger";
import { reportWebhookError } from "@/lib/observability-bridge";
import {
  isWebhookBodyInvalidContentLengthError,
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

export const runtime = "nodejs";
const SES_SNS_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

async function recordSesWebhookLog({
  eventType,
  eventId,
  status,
  startedAt,
  error,
}: {
  eventType: string;
  eventId: string;
  status: "success" | "failure";
  startedAt: number;
  error?: string;
}) {
  await recordWebhookLog({
    source: "ses-sns",
    eventType,
    eventId,
    status,
    durationMs: Date.now() - startedAt,
    error,
  });
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let eventId = "unknown";
  let eventType = "unknown";
  // The processingStartedAt this attempt claimed (`INV-INT-039`): completion
  // and release are fenced on it, so a slow attempt that outlived its lease
  // never completes or releases a successor's claim.
  let leaseToken: Date | null = null;

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(
        await readBoundedWebhookText(request, SES_SNS_WEBHOOK_MAX_BODY_BYTES)
      );
    } catch (error) {
      if (isWebhookBodyTooLargeError(error)) {
        await recordSesWebhookLog({
          eventType,
          eventId,
          status: "failure",
          startedAt,
          error: "Payload too large",
        });
        logger.warn(
          { maxBytes: SES_SNS_WEBHOOK_MAX_BODY_BYTES },
          "SES/SNS webhook payload exceeded size limit"
        );
        return NextResponse.json(
          { error: "Webhook payload too large" },
          { status: 413 }
        );
      }

      if (isWebhookBodyInvalidContentLengthError(error)) {
        await recordSesWebhookLog({
          eventType,
          eventId,
          status: "failure",
          startedAt,
          error: "Invalid content-length header",
        });
        logger.warn(
          { contentLength: error.contentLength },
          "SES/SNS webhook had invalid content-length header"
        );
        return NextResponse.json(
          { error: "Invalid content-length header" },
          { status: 400 }
        );
      }

      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: "Invalid JSON",
      });
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const envelope = parseSnsWebhookEnvelope(payload);
    if (!envelope) {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: "Invalid SNS envelope",
      });
      return NextResponse.json(
        { error: "Invalid SNS envelope" },
        { status: 400 }
      );
    }

    eventId = envelope.MessageId;
    eventType = envelope.Type;

    const verification = await verifySnsWebhookMessage(envelope);
    if (!verification.ok) {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: verification.error,
      });
      return NextResponse.json(
        { error: "SNS signature verification failed" },
        { status: 401 }
      );
    }

    if (!verification.topicArnConfigured) {
      logger.warn(
        { snsTopicArn: envelope.TopicArn },
        "SES_SNS_TOPIC_ARN is not configured; SNS signature was verified without a topic allowlist"
      );
    }

    if (envelope.Type !== "Notification") {
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "success",
        startedAt,
      });
      return NextResponse.json({ received: true, type: envelope.Type });
    }

    // The shared processing lease (`INV-INT-039`), as Stripe's: a crash between
    // the claim and the ingest no longer turns SNS's redelivery into a silent
    // duplicate.
    const claim = await claimWebhookEventLease({
      source: "ses-sns",
      eventId,
      eventType,
      now: new Date(startedAt),
    });
    if (claim.outcome === "duplicate_completed") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (claim.outcome === "in_progress") {
      // Another attempt holds a live lease. Never ACK feedback this attempt
      // did not record: a 503 makes SNS redeliver, and a redelivery after the
      // lease expires takes a crashed attempt's claim over.
      await recordSesWebhookLog({
        eventType,
        eventId,
        status: "failure",
        startedAt,
        error: "Concurrent delivery already in progress (lease held); forcing SNS retry",
      });
      return NextResponse.json(
        { error: "Webhook processing already in progress" },
        { status: 503 }
      );
    }
    leaseToken = claim.leaseToken;

    const result = await ingestSesSnsEmailFeedback(envelope);
    await completeWebhookEventLease({ source: "ses-sns", eventId, leaseToken });
    const feedbackEventType = result.handled
      ? `ses.${result.notificationType}`
      : "ses.unhandled";
    await recordSesWebhookLog({
      eventType: feedbackEventType,
      eventId,
      status: "success",
      startedAt,
    });

    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    if (leaseToken) {
      await releaseWebhookEventLease({ source: "ses-sns", eventId, leaseToken }).catch(
        (cleanupError) => {
          logger.error(
            { err: cleanupError, eventId },
            "Failed to release SES/SNS webhook claim after handler failure"
          );
        }
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    reportWebhookError({
      tag: "ses-sns",
      err,
      message: "Error processing SES/SNS webhook",
      context: { eventId, eventType },
    });
    await recordSesWebhookLog({
      eventType,
      eventId,
      status: "failure",
      startedAt,
      error: message,
    });

    return NextResponse.json(
      { error: "Failed to process SES/SNS webhook" },
      { status: 500 }
    );
  }
}

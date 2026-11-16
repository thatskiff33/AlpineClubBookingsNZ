/**
 * The provider-neutral `ProcessedWebhookEvent` claim lease (`INV-INT-039`; F16,
 * #1887), shared by every webhook route that dedups on a provider message id
 * and runs its handler inside the request: Stripe and SES/SNS.
 *
 * The claim row is a LEASE, not a bare "seen" marker. A redelivery hitting an
 * existing claim is a duplicate only when the claim is COMPLETED; a PROCESSING
 * claim inside {@link WEBHOOK_PROCESSING_LEASE_MINUTES} forces a provider retry,
 * and one past it (a crashed prior attempt) is taken over in one guarded write
 * and reprocessed. The `processingStartedAt` an attempt writes is its fencing
 * token: completion and release key on it, so an attempt only ever completes or
 * releases the lease it still owns.
 *
 * No advisory lock: the unique `(source, eventId)` insert and the guarded
 * `updateMany` are the claim (`INV-LOCK-001`).
 *
 * Xero's stored inbound events do not use this lease: their `XeroInboundEvent`
 * row holds the claim, and its `ProcessedWebhookEvent` row (source `xero`) is a
 * plain dedup marker the stale-event takeover clears
 * (`xero-inbound/stale-event-takeover.ts`).
 */
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { WEBHOOK_PROCESSING_LEASE_MINUTES } from "@/lib/webhook-processing-lease";

const PROCESSING = "PROCESSING";
const COMPLETED = "COMPLETED";

/** The providers whose route handler runs under this lease. */
type WebhookLeaseSource = "stripe" | "ses-sns";

/**
 * The result of a claim attempt. When `outcome === "claimed"`, `leaseToken` is
 * the `processingStartedAt` written for THIS attempt (fresh insert or takeover):
 * the fencing token the caller MUST pass to both
 * {@link completeWebhookEventLease} and {@link releaseWebhookEventLease}. Any
 * other outcome carries no token.
 *
 * - "claimed": this attempt owns the event; process it, then complete it.
 * - "duplicate_completed": a prior delivery finished it; ACK with 200.
 * - "in_progress": a sibling attempt holds a live lease, or the claim moved
 *   between our read and write; answer non-2xx so the provider redelivers,
 *   because an event this attempt did not finish is never ACKed.
 */
export type WebhookLeaseClaim =
  | { outcome: "claimed"; leaseToken: Date }
  | { outcome: "duplicate_completed" }
  | { outcome: "in_progress" };

interface WebhookLeaseKey {
  source: WebhookLeaseSource;
  eventId: string;
}

/** Claim one provider event under the processing lease. */
export async function claimWebhookEventLease({
  source,
  eventId,
  eventType,
  now,
}: WebhookLeaseKey & { eventType: string; now: Date }): Promise<WebhookLeaseClaim> {
  try {
    await prisma.processedWebhookEvent.create({
      data: {
        eventId,
        source,
        eventType,
        status: PROCESSING,
        processingStartedAt: now,
      },
    });
    return { outcome: "claimed", leaseToken: now };
  } catch (err: unknown) {
    // Anything other than the unique-constraint collision is a real failure.
    if (!isPrismaUniqueConstraintError(err)) {
      throw err;
    }
  }

  // A claim row already exists; decide on its status and lease age.
  const existing = await prisma.processedWebhookEvent.findFirst({
    where: { source, eventId },
    select: { status: true, processingStartedAt: true },
  });

  // Raced release between our failed insert and this read (a sibling attempt
  // failed and deleted its claim): let the provider retry rather than guess.
  if (!existing) {
    return { outcome: "in_progress" };
  }

  if (existing.status === COMPLETED) {
    return { outcome: "duplicate_completed" };
  }

  const leaseExpiryThreshold = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MINUTES * 60_000);
  if (existing.processingStartedAt > leaseExpiryThreshold) {
    // A sibling attempt is still within its lease. Never ACK the event while
    // an in-flight (possibly doomed) attempt owns it.
    return { outcome: "in_progress" };
  }

  // The lease expired: a prior attempt crashed without completing or releasing
  // its claim. Take it over atomically: the guards (status + an expired
  // processingStartedAt) make exactly one concurrent racer win; the loser gets
  // "in_progress". The takeover stamps `now`, our fencing token, so the
  // original (crashed but maybe alive) attempt can neither complete nor release
  // the lease we now own.
  const takeover = await prisma.processedWebhookEvent.updateMany({
    where: {
      source,
      eventId,
      status: PROCESSING,
      processingStartedAt: { lt: leaseExpiryThreshold },
    },
    data: {
      processingStartedAt: now,
      eventType,
    },
  });
  return takeover.count === 1 ? { outcome: "claimed", leaseToken: now } : { outcome: "in_progress" };
}

/**
 * Mark the lease COMPLETED, so a later redelivery is ACKed as a true duplicate.
 * Call only after every handler returned. Fenced on status + `leaseToken`: if
 * our lease expired and a successor took it over this matches nothing, so it
 * never flips the successor's in-flight claim to COMPLETED, and never re-flips a
 * completed row; the successor completes its own lease.
 */
export async function completeWebhookEventLease({
  source,
  eventId,
  leaseToken,
}: WebhookLeaseKey & { leaseToken: Date }): Promise<void> {
  await prisma.processedWebhookEvent.updateMany({
    where: {
      source,
      eventId,
      status: PROCESSING,
      processingStartedAt: leaseToken,
    },
    data: {
      status: COMPLETED,
      processedAt: new Date(),
    },
  });
}

/**
 * Release the lease after a handler failure, so the provider's redelivery
 * reprocesses at once instead of waiting out the lease. Fenced on status +
 * `leaseToken`: it never deletes a successor's live claim or a completed event.
 */
export async function releaseWebhookEventLease({
  source,
  eventId,
  leaseToken,
}: WebhookLeaseKey & { leaseToken: Date }): Promise<void> {
  await prisma.processedWebhookEvent.deleteMany({
    where: {
      eventId,
      source,
      status: PROCESSING,
      processingStartedAt: leaseToken,
    },
  });
}

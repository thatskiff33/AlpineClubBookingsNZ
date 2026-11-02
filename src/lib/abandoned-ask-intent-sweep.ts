/**
 * #4693 (`INV-PAY-120`): THE CLOSE-TIME SWEEP FOR THE INTENTS AN ASK'S RECOVERY
 * MINTED AND NEVER WROTE.
 *
 * A claim hold that throws (#4676), loses to a reclaiming runner, or never runs
 * because its worker died leaves its intent written nowhere. While the row is
 * open that proves nothing: a retry back at the same figure replays the key and
 * Stripe hands the same intent back. But a retry that re-sizes mints another
 * intent and closes the row with it, a reduction nets the waiting row off, an
 * increase folds it in, or the row fails for good - and from then on nothing
 * reads the first intent again. It stayed open in Stripe for good, never offered.
 *
 * So whoever ends the row sweeps it, after every transaction has ended:
 *
 * - the runner, after an attempt that was not the row's first ends it
 *   (`sweepAfterRunnerClose`) - a first attempt follows no earlier mint;
 * - the edit whose reduction netted a waiting row off, or whose increase folded
 *   one in, after its commit (`sweepAskRecoveriesClosedByEdit`) - the edits its
 *   own history names (`unpaidAskOffsetHistory`), rows a runner had claimed;
 * - the failure that ends the row for good (`failPaymentRecoveryOperation`).
 *
 * The sweep lists the recent intents that carry the row's own marker - which no
 * other row's intent carries - and settles each one the row does not name by
 * the lost hold's proof (`closedWithoutIntent`, `recoveryEndedBy`) and its owner check and cancel
 * (`cancelAbandonedReissuedAskIntent`): nothing new decides what may be
 * cancelled. The markers:
 *
 * - a credit-release ask's `creditReleaseId` (`processCreditReleaseAskOperation`);
 * - a re-issue's `reissuedAskKey`, its key bare or naming the intent's own amount
 *   (`planReissuedAskMint`);
 * - an ordinary ask's `askRecoveryId`, which the runner stamps on its own intent
 *   by an update after the mint (`mintOrdinaryAskIntent`). The door's request
 *   cannot carry it: the runner replays that key, and a replay must send the
 *   door's parameters. An intent without a marker - the door's own, never handed
 *   to the runner, or one minted before #4693 - is never swept.
 *
 * A review charge's row is never swept: it can be re-armed after it closes
 * (`rearmEditFinancialReviewChargeRecovery`). The scan is bounded
 * (`ABANDONED_ASK_SWEEP_MAX_SCANNED`); one that stops early settles only what it
 * read and says so. Every failure is logged and nothing throws: the sweep is
 * best-effort, as the settle it extends is.
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
} from "@prisma/client";
import type Stripe from "stripe";

import { reissueClosedUnminted } from "@/lib/additional-ask-reissue";
import { creditReleaseIdForAskRecoveryKey } from "@/lib/credit-release-ask-keys";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE, ASK_RECOVERY_METADATA_KEY } from "@/lib/ordinary-ask-request";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildReissuedAskStripeIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
  stripeIdempotencyKeyForAskAmount,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import {
  ABANDONED_REISSUE_INTENT_LOG_EVENT,
  cancelAbandonedReissuedAskIntent,
  closedWithoutIntent,
  recoveryEndedBy,
} from "@/lib/reissued-ask-abandoned-intent";
import { MINTED_INTENT_LOOKBACK_MS, REISSUED_ASK_KEY_METADATA } from "@/lib/reissued-ask-mint";
import { listRecentPaymentIntentsMatching } from "@/lib/stripe";
import {
  recordedFoldedReissuedAskModificationIds,
  recordedRetiredAskModificationIds,
} from "@/lib/unpaid-ask-offset-marker";

/** How many recent intents one scan reads at most, per customer and account-wide. */
export const ABANDONED_ASK_SWEEP_MAX_SCANNED = 500;

/** What ended the row: logged with every outcome. */
export type AbandonedAskSweepTrigger = "runner-close" | "net-off-or-fold" | "failed-for-good";

type SweptRecovery = Pick<
  PaymentRecoveryOperation,
  "id" | "type" | "bookingId" | "idempotencyKey" | "status" | "lastError" | "attempts" | "paymentIntentId" | "createdAt"
> & { payment: { stripeCustomerId: string | null } | null };

/**
 * Whether `intent` carries this recovery's own marker (above): this booking's
 * additional ask, and the row's release, re-issue key or stamped id. Null for a
 * row whose intents are never swept - a review charge's.
 */
export function askRecoveryIntentMarker(
  row: Pick<PaymentRecoveryOperation, "id" | "bookingId" | "idempotencyKey">,
): ((intent: Pick<Stripe.PaymentIntent, "amount" | "metadata">) => boolean) | null {
  if (isEditFinancialReviewAdditionalIntentRecoveryKey(row.idempotencyKey)) return null;
  const releaseId = creditReleaseIdForAskRecoveryKey(row.idempotencyKey);
  const editId = releaseId ? null : bookingModificationIdForAdditionalIntentRecoveryKey(row.idempotencyKey);
  if (!releaseId && !editId) return null;
  const reissueKey = editId ? buildReissuedAskStripeIdempotencyKey(editId) : null;
  return (intent) => {
    const metadata = intent.metadata ?? {};
    if (metadata.bookingId !== row.bookingId || metadata.type !== ADDITIONAL_ASK_INTENT_TYPE) return false;
    if (releaseId) return metadata.creditReleaseId === releaseId;
    const stampedKey = metadata[REISSUED_ASK_KEY_METADATA];
    return (
      metadata[ASK_RECOVERY_METADATA_KEY] === row.id ||
      (reissueKey !== null &&
        (stampedKey === reissueKey || stampedKey === stripeIdempotencyKeyForAskAmount(reissueKey, intent.amount)))
    );
  };
}

/**
 * Sweep one recovery row that has ended: re-read it, and when it closed or
 * failed for good (`closedWithoutIntent`), list its marked intents and settle
 * each it does not name. Never throws.
 */
export async function sweepAbandonedAskIntents(operationId: string, trigger: AbandonedAskSweepTrigger): Promise<void> {
  const context = { event: ABANDONED_REISSUE_INTENT_LOG_EVENT, operationId, trigger };
  try {
    const row: SweptRecovery | null = await prisma.paymentRecoveryOperation.findUnique({
      where: { id: operationId },
      select: {
        id: true, type: true, bookingId: true, idempotencyKey: true, status: true, lastError: true,
        attempts: true, paymentIntentId: true, createdAt: true, payment: { select: { stripeCustomerId: true } },
      },
    });
    if (row?.type !== PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT) return;
    const marker = askRecoveryIntentMarker(row);
    // The row itself must have ended: an intent it does not name is then no one's (#4052's proof).
    if (!marker || recoveryEndedBy(row) === null) return;
    const scan = await listRecentPaymentIntentsMatching({
      matches: marker,
      createdSince: new Date(row.createdAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
      customerId: row.payment?.stripeCustomerId ?? undefined,
      maxScanned: ABANDONED_ASK_SWEEP_MAX_SCANNED,
    });
    // Already cancelled - by the settle, or an earlier sweep of the same row - needs nothing.
    const open = scan.intents.filter((intent) => intent.id !== row.paymentIntentId && intent.status !== "canceled");
    for (const intent of open) {
      const closedBy = closedWithoutIntent(row, intent.id);
      if (closedBy) await cancelAbandonedReissuedAskIntent({ bookingId: row.bookingId, operationId: row.id, paymentIntentId: intent.id, closedBy });
    }
    const swept = { ...context, bookingId: row.bookingId, complete: scan.complete, sweptIntentIds: open.map((intent) => intent.id) };
    if (scan.complete) {
      logger.info({ ...swept, outcome: "swept" }, "Swept an ended ask recovery for intents it minted and never wrote (#4693)");
    } else {
      logger.warn(
        { ...swept, outcome: "sweep-incomplete" },
        "Swept an ended ask recovery, but its bounded scan stopped before reading every intent since the row was created: only those read were settled, and an older one may stay open in Stripe, never offered (#4693)",
      );
    }
  } catch (err) {
    logger.error({ err, ...context, outcome: "sweep-failed" }, "Could not sweep an ended ask recovery for intents it never wrote; any it left stay open in Stripe, never offered (#4693)");
  }
}

/**
 * The runner's half: after an attempt that ended the row (`done`), sweep - unless
 * it was the row's first attempt, which follows no earlier mint by the runner.
 */
export async function sweepAfterRunnerClose(
  operation: Pick<PaymentRecoveryOperation, "id" | "attempts">,
  outcome: string,
): Promise<void> {
  if (outcome !== "done" || operation.attempts < 2) return;
  await sweepAbandonedAskIntents(operation.id, "runner-close");
}

/**
 * The edit's half, after its commit: the waiting rows its reduction netted off or
 * its increase folded in - the edits its history names (`unpaidAskOffsetHistory`)
 * whose rows ended so (`reissueClosedUnminted`) after a runner had claimed them.
 * Never throws.
 */
export async function sweepAskRecoveriesClosedByEdit({
  bookingId,
  bookingModificationId,
}: {
  bookingId: string;
  bookingModificationId: string;
}): Promise<void> {
  let closedIds: string[];
  try {
    const edit = await prisma.bookingModification.findUnique({ where: { id: bookingModificationId }, select: { newData: true } });
    const editIds = [
      ...new Set([...recordedRetiredAskModificationIds(edit?.newData), ...recordedFoldedReissuedAskModificationIds(edit?.newData)]),
    ];
    if (editIds.length === 0) return;
    const rows = await prisma.paymentRecoveryOperation.findMany({
      where: {
        bookingId,
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        idempotencyKey: { in: editIds.map(buildAdditionalIntentRecoveryIdempotencyKey) },
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        attempts: { gte: 1 },
      },
      select: { id: true, status: true, lastError: true },
    });
    closedIds = rows.filter((row) => reissueClosedUnminted(row) !== null).map((row) => row.id);
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId, event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "sweep-failed" },
      "Could not read which ask recoveries an edit netted off or folded in; their unwritten intents are not swept (#4693)",
    );
    return;
  }
  for (const id of closedIds) await sweepAbandonedAskIntents(id, "net-off-or-fold");
}

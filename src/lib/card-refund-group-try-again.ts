import "server-only";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  GROUP_CARD_REFUND_ALREADY_ON_STRIPE,
  GROUP_CARD_REFUND_STRIPE_UNREADABLE,
  GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT,
  LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL,
} from "@/lib/card-refund-group-copy";
import { classifyOrganiserChildIntentRefunds, organiserChildRearmAt } from "@/lib/card-refund-group-intent";
import { DeadCardRefundActionError } from "@/lib/card-refund-dead-row";
import { deadRowClaimWhere, lockDeadCardRefundRow, type DeadCardRefundRowRefusals } from "@/lib/card-refund-dead-row-lock";
import { getClubFormat } from "@/lib/club-format-settings";
import logger from "@/lib/logger";
import { isGroupSettlementRefundRecoveryKey, isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
import { rearmedPaymentRecoveryOperationData } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";

/**
 * #4851: TRY THE CARD AGAIN FOR A DEAD PER-JOINER REFUND OUT OF THE ORGANISER'S
 * COMBINED CARD. The button sends nothing. It re-arms the row
 * (`rearmedPaymentRecoveryOperationData`) under `accept: "organiser-child"`
 * and `deadRowClaimWhere`.
 *
 * It does not use `tryCardAgainRefusal`, `reArmWouldSendCents` or
 * `unadoptedOwnStripeRefunds`. Those read charge slices. This row's plan is a
 * fake transaction id, and the runner never sends those slices. The runner
 * reads Stripe by `organiserChildRefundKey` on every attempt, including the
 * first, so a re-arm does not send a second refund when one is already on the
 * intent (`INV-PAY-114`).
 *
 * The old whole-group refund is not re-armed from here.
 */

const REFUSALS: DeadCardRefundRowRefusals = {
  notOwedKind: "This card refund cannot be tried again from here.",
  organiserChild: "This card refund cannot be tried again from here.",
  closed: "This card refund has already been closed.",
  notGivenUp: "This card refund is being tried again, so it is not waiting for you. Refresh the list.",
  otherBooking: "This card refund's payment belongs to another booking, so it cannot be settled here. Ask a developer to reconcile it.",
};

const CHANGED =
  "This card refund changed while you were settling it. The list has been refreshed: check it and try again.";

export interface TryOrganiserChildCardAgainInput {
  operationId: string;
  expectedOwedCents: number;
  actingMemberId: string;
}

export interface TryOrganiserChildCardAgainResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  owedCents: number;
  /** When the runner may ask. Now, or later while Stripe would replay a refusal. */
  nextRetryAt: string;
}

/** Re-arm one dead per-joiner refund. A legacy whole-group key is a 409. */
export async function tryOrganiserChildCardRefundAgain(
  input: TryOrganiserChildCardAgainInput,
): Promise<TryOrganiserChildCardAgainResult> {
  if (!Number.isSafeInteger(input.expectedOwedCents) || input.expectedOwedCents <= 0) {
    throw new DeadCardRefundActionError("Say what you saw still owed, in whole cents, more than nothing.", 400);
  }
  const preview = await prisma.paymentRecoveryOperation.findUnique({
    where: { id: input.operationId },
    select: { id: true, idempotencyKey: true, paymentIntentId: true, amountCents: true },
  });
  if (!preview) throw new DeadCardRefundActionError("Card refund not found.", 404);
  if (isGroupSettlementRefundRecoveryKey(preview.idempotencyKey)) {
    throw new DeadCardRefundActionError(LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL, 409);
  }
  if (!isOrganiserChildRefundKey(preview.idempotencyKey)) {
    throw new DeadCardRefundActionError(REFUSALS.notOwedKind, 409);
  }
  if (!preview.paymentIntentId) throw new DeadCardRefundActionError(GROUP_CARD_REFUND_STRIPE_UNREADABLE, 409);

  let refunds;
  try {
    refunds = await listRefundsForPaymentIntent(preview.paymentIntentId);
  } catch (error) {
    logger.warn({ err: error, operationId: preview.id }, "Per-joiner try-again refused: Stripe's refunds could not be read (#4851)");
    throw new DeadCardRefundActionError(GROUP_CARD_REFUND_STRIPE_UNREADABLE, 409);
  }
  const kind = classifyOrganiserChildIntentRefunds(refunds, preview.idempotencyKey, preview.amountCents);
  if (kind === "keyed") throw new DeadCardRefundActionError(GROUP_CARD_REFUND_ALREADY_ON_STRIPE, 409);
  if (kind === "unkeyed-same-amount") throw new DeadCardRefundActionError(GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT, 409);

  const now = new Date();
  const nextRetryAt = organiserChildRearmAt(refunds, preview.idempotencyKey, now);
  const format = await getClubFormat();

  return prisma.$transaction(async (tx) => {
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId, REFUSALS, "organiser-child");
    if (operation.paymentIntentId !== preview.paymentIntentId) throw new DeadCardRefundActionError(CHANGED, 409);
    if (operation.amountCents !== input.expectedOwedCents) {
      throw new DeadCardRefundActionError(
        "What is still owed on this card refund changed since you opened it. The list has been refreshed: check the amount and try again.",
        409,
      );
    }
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: { ...rearmedPaymentRecoveryOperationData(now), nextRetryAt },
    });
    if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED, 409);
    await createAuditLog(
      {
        action: "booking-payment.card-refund.try-card-again",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `The group organiser's card will be asked again for ${formatCents(operation.amountCents, format)}. Stripe is read first, and a refund it already holds is not sent again.`,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          organiserCard: true,
          owedCents: operation.amountCents,
          nextRetryAt: nextRetryAt.toISOString(),
          previousAttempts: operation.attempts,
          previousStatus: operation.status,
        },
      },
      tx,
    );
    return {
      operationId: operation.id,
      bookingId: operation.bookingId,
      paymentId: payment.id,
      owedCents: operation.amountCents,
      nextRetryAt: nextRetryAt.toISOString(),
    };
  });
}

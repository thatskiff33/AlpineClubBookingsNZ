/**
 * THE DUPLICATE-CAPTURE GUARD (#1992, #4211, `INV-PAY-043`): what a card
 * capture arriving on an already-PAID booking is.
 *
 * `already_paid` is the exactly-once replay outcome for a success that carries
 * the intent that settled the booking: webhook redelivery, the confirm-payment
 * route racing the webhook, payment-link reconcile, charge-saved-method and
 * cron-confirm-pending reruns replaying the attempt row's OWN intent (#3267),
 * confirm-pending-guests retries. A DIFFERENT capture on a PAID booking is
 * double money - the residual #1967 split-child window, where the /pay link
 * intent and the settlement cron's saved-card charge both capture, or a member
 * paying from three stale tabs (#4211) - and is refunded automatically.
 *
 * WHICH CAPTURE SETTLED THE BOOKING IS RECORDED, NOT GUESSED (#4211, owner
 * decision 17 Oct 2026, "Record the settler"). The settle's PAID claim writes
 * `Payment.settledByTransactionId` (`payment-settler.ts`). Guessing it from the
 * ledger failed in three ways: a third capture the pre-#4211 guard kept, a
 * Xero bank receipt recorded after the card paid (#3638), and a superseded
 * capture whose refund failed later (#4227) each looked like "another capture
 * holding money", so a REPLAY of the real settlement was refunded. Nor does
 * "the arriving row was already SUCCEEDED" tell a replay apart: every
 * saved-card path writes its attempt row SUCCEEDED before it settles.
 *
 * 1. **The recorded settler is never refunded.** Its replay is kept whatever
 *    else holds money on the booking.
 * 2. **Any other arriving capture is refunded** while the recorded settler
 *    still holds net cash that neither the superseded-intent machinery (a live
 *    operation, or #4227 a failed-later refund open rows owe back in full) nor
 *    a duplicate-capture refund owns. An arriving capture that machinery is
 *    still sending back (the Xero conflict's reading: an in-flight cancel, an
 *    unfinished refund, or one owed back in full) is never refunded on top,
 *    re-sent or alerted (#4283); a dead cancel leaves it a duplicate. A capture a duplicate-capture refund
 *    already owns re-sends only its own frozen refund (one operation per
 *    booking and intent, so the replay is idempotent).
 * 3. **No usable record** - paid before this release or by the draining old
 *    colour while another capture holds money (`otherSettledCaptureWhere`), or a
 *    recorded settler that no longer holds money, whether or not another does:
 *    the arriving capture is KEPT and the admins are told to check by hand.
 *    Nothing is refunded automatically, because nothing says which side is
 *    the settlement. A capture a duplicate-capture refund already owns still
 *    re-sends its own refund, which an earlier delivery decided; a released
 *    settler a live superseded-intent operation holds keeps silently.
 *
 * Every read runs under the lock(1) every caller of `markBookingPaymentSucceeded`
 * holds, so the check-then-enqueue cannot interleave with another settlement,
 * and the caller enqueues the refund in the same transaction, before any
 * Stripe call (the #1349 pattern).
 */
import {
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { claimAlertCooldownFailOpen, SETTLEMENT_MONEY_ALERT_REPEAT_MS } from "@/lib/alert-cooldown-fail-open";
import type { ClubFormat } from "@/lib/club-format";
import { listDuplicateCaptureRefundIntentIds } from "@/lib/duplicate-capture-ownership";
import { releaseAlertCooldown } from "@/lib/alert-cooldown";
import type { DuplicateCaptureKeptReason } from "@/lib/duplicate-capture-kept-note";
import { sendAdminDuplicateCaptureKeptAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { findPaymentTransactionByIntentId } from "@/lib/payment-transactions";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import {
  findLiveSupersededIntentOperation,
  listLiveSupersededIntentIds,
  listSupersededIntentIdsOwningCaptures,
} from "@/lib/superseded-intent-ownership";

/**
 * Which captures could be the settlement an arriving capture duplicates:
 * another captured PRIMARY row with net cash - a Stripe one under a different
 * intent that no superseded-intent operation (b′) and no duplicate-capture
 * refund (c, #4211) owns, or any non-Stripe one (#2262; the row this
 * settlement just wrote is always STRIPE, so it never matches that arm).
 * Fully REFUNDED rows are history, so a #1765 repay generation is never a
 * duplicate of its refunded predecessor. (b′) because a superseded intent's
 * late capture is handed to its own refund WITHOUT passing through the
 * settlement, so from the ledger alone it looks like one. Exported so the
 * real-PostgreSQL proofs repeat the exact read.
 */
export function otherSettledCaptureWhere(input: {
  paymentId: string;
  arrivingPaymentIntentId: string;
  liveSupersededIntentIds: string[];
  duplicateRefundIntentIds: string[];
}) {
  return {
    paymentId: input.paymentId,
    kind: PaymentTransactionKind.PRIMARY,
    status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
    OR: [
      {
        source: PaymentSource.STRIPE,
        stripePaymentIntentId: {
          not: input.arrivingPaymentIntentId,
          notIn: [...input.liveSupersededIntentIds, ...input.duplicateRefundIntentIds],
        },
        NOT: { stripePaymentIntentId: null },
      },
      { source: { not: PaymentSource.STRIPE } },
    ],
  } satisfies Prisma.PaymentTransactionWhereInput;
}

/** The single slice a duplicate's refund takes: exactly its own capture. */
type DuplicateRefundSlice = { paymentTransactionId: string; amountCents: number };

export type ArrivingCaptureVerdict =
  | { verdict: "keep" }
  /** Rule 3: kept, and the admins check by hand which side to refund. */
  | {
      verdict: "keep_unrecorded_settler";
      otherPaymentIntentId: string | null;
      reason: DuplicateCaptureKeptReason;
      /** False: a recorded settler released and nothing else holds money. */
      otherHoldsMoney: boolean;
    }
  | {
      verdict: "refund";
      refundPlan: DuplicateRefundSlice[];
      refundCents: number;
      /** The settlement's intent, for the alert and history; null for cash or a bank receipt. */
      settledPaymentIntentId: string | null;
    };

/**
 * Judge a card capture arriving on a booking already PAID. The caller has
 * already recorded the capture on its own row and ruled out refund history
 * (#1765); this only reads.
 */
export async function judgeCaptureOnPaidBooking(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    paymentId: string;
    /** `Payment.settledByTransactionId`, read under the caller's lock(1). */
    recordedSettlerId: string | null;
    paymentIntentId: string;
    amountCents: number;
  },
): Promise<ArrivingCaptureVerdict> {
  const arriving = await findPaymentTransactionByIntentId({
    paymentIntentId: input.paymentIntentId,
    store: tx,
  });
  // Rule 1.
  if (!arriving || arriving.id === input.recordedSettlerId) return { verdict: "keep" };

  // The Xero conflict's reading (`listSupersededIntentIdsOwningCaptures`): a
  // cancel only while in flight, a superseded refund until it SUCCEEDED, and
  // (#4227) a capture whose failed-later refund open rows owe back in full.
  const holdsForMember = new Set(
    await listSupersededIntentIdsOwningCaptures(
      tx,
      input.paymentId,
      await tx.paymentTransaction.findMany({
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
        where: {
          paymentId: input.paymentId,
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.STRIPE,
          status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
        },
        select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
      }),
    ),
  );
  // #4283: the ARRIVING capture is refunded on top only if nothing is already
  // sending its money back - read the Xero way, so a DEAD cancel (one that
  // handed the money to nobody) leaves it a duplicate like any other. Held:
  // no duplicate refund, no re-send, no alert.
  if (holdsForMember.has(input.paymentIntentId)) return { verdict: "keep" };
  // (b′) and (c′) as the OTHER capture fail safe the opposite way: any
  // operation not SUCCEEDED counts (wrongly skipping costs nothing; wrongly
  // counting refunds the real settlement), plus #4227's owed-back captures.
  const supersededOwned = [...(await listLiveSupersededIntentIds(tx, input.paymentId)), ...holdsForMember];
  const supersededOwns = async (paymentIntentId: string) =>
    holdsForMember.has(paymentIntentId) || !!(await findLiveSupersededIntentOperation(tx, paymentIntentId));

  const duplicateRefundIntentIds = await listDuplicateCaptureRefundIntentIds({
    bookingId: input.bookingId,
    store: tx,
  });
  const where = otherSettledCaptureWhere({
    paymentId: input.paymentId,
    arrivingPaymentIntentId: input.paymentIntentId,
    liveSupersededIntentIds: supersededOwned,
    duplicateRefundIntentIds,
  });
  const select = { id: true, stripePaymentIntentId: true } as const;
  // Rule 2's settlement: the recorded settler, while it still qualifies.
  const recordedSettler = input.recordedSettlerId
    ? await tx.paymentTransaction.findFirst({ where: { ...where, id: input.recordedSettlerId }, select })
    : null;
  // #4177 (`INV-PAY-133`): with no usable record, the oldest-inserted that qualifies.
  const settlement =
    recordedSettler ??
    (await tx.paymentTransaction.findFirst({ orderBy: [...LEDGER_ROWS_OLDEST_FIRST], where, select }));
  // Refund exactly this capture's outstanding amount, never a newest-first
  // allocation that could touch the settlement.
  const refundArriving = (settledPaymentIntentId: string | null): ArrivingCaptureVerdict => {
    const refundCents = Math.min(input.amountCents, arriving.amountCents - arriving.refundedAmountCents);
    return refundCents <= 0
      ? { verdict: "keep" }
      : { verdict: "refund", refundPlan: [{ paymentTransactionId: arriving.id, amountCents: refundCents }], refundCents, settledPaymentIntentId };
  };
  const arrivingOwned = duplicateRefundIntentIds.includes(input.paymentIntentId);

  if (!settlement) {
    // No record and nothing else holding money: a replay of the booking's only
    // capture, or a stray capture the stated limit covers - a silent keep.
    if (!input.recordedSettlerId) return { verdict: "keep" };
    // #4211 review: a RECORDED settler that no longer qualifies and nothing else
    // holding money. Its own intent first: a duplicate-capture refund that owns
    // the arriving capture re-sends its own refund, as under rule 3; and a
    // settler whose money a live superseded-intent operation holds makes the
    // arriving capture the settlement side, a silent keep, as (c′) below.
    const settler = await tx.paymentTransaction.findUnique({
      where: { id: input.recordedSettlerId },
      select: { stripePaymentIntentId: true },
    });
    const settlerIntent = settler?.stripePaymentIntentId ?? null;
    if (arrivingOwned) return refundArriving(settlerIntent);
    if (settlerIntent && (await supersededOwns(settlerIntent))) return { verdict: "keep" };
    // Otherwise the arriving capture may now pay for the booking or be a
    // duplicate, and only a person can say.
    return { verdict: "keep_unrecorded_settler", otherPaymentIntentId: null, reason: "settler-released", otherHoldsMoney: false };
  }

  // (c′) belt and braces: the settlement's own intent re-checked against the
  // live superseded-intent operations, by a different query shape. If one owns
  // its money, the arriving capture is the settlement side.
  if (settlement.stripePaymentIntentId && (await supersededOwns(settlement.stripePaymentIntentId))) {
    return { verdict: "keep" };
  }

  if (!recordedSettler && !arrivingOwned) {
    // Rule 3.
    return {
      verdict: "keep_unrecorded_settler",
      otherPaymentIntentId: settlement.stripePaymentIntentId,
      otherHoldsMoney: true,
      reason: input.recordedSettlerId ? "settler-released" : "not-recorded",
    };
  }

  return refundArriving(settlement.stripePaymentIntentId);
}

/**
 * Rule 3's alert, after the commit: a card capture was kept on a PAID booking
 * with no usable record of which payment settled it - while another payment on
 * it still holds money, or beside a released settler and nothing else. Its own unmuteable, delivery-locked template
 * (`admin-duplicate-capture-kept`): the duplicate-capture refund's alert says a
 * refund was made or queued, and the generic payment alert says "Payment Failed"
 * and can be muted. Once a day per (booking, capture) while repeats arrive (a
 * Stripe redelivery, a reconcile or cron re-run), sent anyway if the claim
 * cannot be read (`claimAlertCooldownFailOpen`), and the claim is given back if
 * the send throws so the next repeat tries again (`releaseAlertCooldown`, as
 * `internet-banking-hold-kept.ts`).
 */
export async function alertCaptureKeptWithoutRecordedSettler({
  booking,
  memberName,
  paymentIntentId,
  amountCents,
  otherPaymentIntentId,
  otherHoldsMoney = true,
  reason,
  format,
}: {
  booking: { id: string; checkIn: Date; checkOut: Date };
  memberName: string;
  paymentIntentId: string;
  amountCents: number;
  otherPaymentIntentId: string | null;
  otherHoldsMoney?: boolean;
  reason: DuplicateCaptureKeptReason;
  format: ClubFormat;
}) {
  const context = { bookingId: booking.id, paymentIntentId, otherPaymentIntentId, reason };
  const key = `duplicate-capture-unrecorded-settler:${booking.id}:${paymentIntentId}`;
  const claimedAt = new Date();
  const send = await claimAlertCooldownFailOpen({
    key,
    windowMs: SETTLEMENT_MONEY_ALERT_REPEAT_MS,
    now: claimedAt,
    context,
    logMessage: "Could not claim the kept-capture alert's cooldown; alerting anyway (#4211)",
  });
  logger.error(context, "A card capture on a paid booking with no usable settlement record was kept for an admin to check (#4211)");
  if (!send) return;
  try {
    await sendAdminDuplicateCaptureKeptAlert({
      memberName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      bookingId: booking.id,
      reason,
      amountCents,
      paymentIntentId,
      otherPaymentIntentId,
      otherHoldsMoney,
    }, format);
  } catch (err) {
    logger.error({ err, ...context }, "Failed to alert admins about a kept capture; giving the claim back so a repeat tries again (#4211)");
    await releaseAlertCooldown({ key, claimedAt }).catch((releaseErr) =>
      logger.error({ err: releaseErr, ...context }, "Failed to give back the kept-capture alert's claim (#4211)"),
    );
  }
}

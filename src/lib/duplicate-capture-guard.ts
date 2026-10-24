/**
 * THE DUPLICATE-CAPTURE GUARD (#1992, #4211, `INV-PAY-043`): what a card
 * capture arriving on an already-PAID booking is - or (#4285) a COMPLETED one,
 * a paid booking whose stay has ended (`isPaidLikeBookingStatus`).
 *
 * `already_paid` is the exactly-once replay outcome for a success that carries
 * the intent that settled the booking: webhook redelivery, the confirm-payment
 * route racing the webhook, payment-link reconcile, charge-saved-method and
 * cron-confirm-pending reruns replaying the attempt row's OWN intent (#3267),
 * confirm-pending-guests retries. A DIFFERENT capture on a PAID (or COMPLETED) booking is
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
 * "the arriving row was already SUCCEEDED" alone tell a replay apart: every
 * saved-card path writes its attempt row SUCCEEDED before it settles, so those
 * callers say they did (`recordedByCaller`, #4285 review), and the guard reads
 * that answer only where no other payment holds money (rule 3).
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
 *    settler a live superseded-intent operation holds keeps silently. With no
 *    record and nothing else holding money, the arriving capture keeps silently
 *    only as a replay of a capture already recorded (the booking's only
 *    capture) whose alert is not still owed; one never recorded before is kept
 *    and the admins told (#4285, `new-capture`). The caller records that alert
 *    as owed in the same transaction (`recordNewCaptureAlertOwed`), so a crash
 *    or a failed send is retried by a replay or the payments cron's drain until
 *    an alert is delivered. Every such alert names the other payment by the
 *    telling reading (`readTellingWhere`, #4285 review) and shows what the
 *    kept capture's card still holds; the verdict never reads either. Limit:
 *    a saved-card capture whose caller crashed or threw between its
 *    pre-record and the settle reads as a replay on its next arrival.
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
import { releaseAlertCooldown, settleOwedAlert } from "@/lib/alert-cooldown";
import type { CancellationRefundNote, DuplicateCaptureKeptReason } from "@/lib/duplicate-capture-kept-note";
import { sendAdminDuplicateCaptureKeptAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { findPaymentTransactionByIntentId, sumRecordedRefundsForCapture } from "@/lib/payment-transactions";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { heldStripeCapturesWhere, readSupersededOwnership } from "@/lib/superseded-capture-ownership";
import {
  listDuplicateRefundIntentIdsOwningCaptures,
  listLiveSupersededIntentIds,
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
      /** False: nothing else holds money, read the way an admin is told (`readTellingWhere`). */
      otherHoldsMoney: boolean;
      /** #4285 review: what the kept capture's CARD still holds (`sumRecordedRefundsForCapture`). */
      heldCents: number;
    }
  | {
      verdict: "refund";
      refundPlan: DuplicateRefundSlice[];
      refundCents: number;
      /** The settlement's intent, for the alert and history; null for cash or a bank receipt. */
      settledPaymentIntentId: string | null;
    };

/**
 * WHAT "ANOTHER CAPTURE HOLDING MONEY" IS, for one arriving capture - the
 * guard's one reading, shared with the owed-alert drain
 * (`duplicate-capture-kept-alert-drain.ts`, #4285 review) so the two can never
 * disagree about which payment holds money. Read-only.
 *
 * - `ownership`: the payment's superseded-machinery reading, read once in its
 *   one home (`readSupersededOwnership`, #4300) - the guard's (c′) test of a
 *   settlement (`owns`).
 * - `holdsForMember`: its Xero conflict's reading
 *   (`listSupersededIntentIdsOwningCaptures`) - a cancel only while in flight,
 *   a superseded refund until it SUCCEEDED, and (#4227) a capture whose
 *   failed-later refund open rows owe back in full.
 * - `supersededOwned`: (b′) and (c′) as the OTHER capture fail safe the
 *   opposite way - any operation not SUCCEEDED counts (wrongly skipping costs
 *   nothing; wrongly counting refunds the real settlement), plus #4227's
 *   owed-back captures.
 * - `duplicateRefundIntentIds`: captures a duplicate-capture refund owns, at any status.
 * - `where`: `otherSettledCaptureWhere` over all three - the refund-safety reading.
 * - `readTellingWhere()` (#4285 review): what an admin is TOLD holds money - the
 *   Xero conflict's reading, excluding only `holdsForMember` and the captures a
 *   duplicate-capture refund still holds (`listDuplicateRefundIntentIdsOwningCaptures`:
 *   one that succeeded and that Stripe failed later, where open rows owe back
 *   less than all it holds, stays in). A capture behind a dead cancel stays in too: that cancel handed its
 *   money to nobody. Read only by an alert's words, never by a verdict. Both
 *   readings count PRIMARY rows by ledger status: they say which payments the app
 *   counts as settling the booking, never every charge a card still holds.
 */
export async function readOtherSettledCaptureWhere(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; paymentId: string; paymentIntentId: string },
) {
  // #4300: the Xero reading and (c′) come from the one home, read once.
  const ownership = await readSupersededOwnership(tx, input.paymentId);
  const holdsForMember = ownership.holdsForMember;
  const supersededOwned = [...(await listLiveSupersededIntentIds(tx, input.paymentId)), ...holdsForMember];
  const duplicateRefundIntentIds = await listDuplicateCaptureRefundIntentIds({ bookingId: input.bookingId, store: tx });
  const reading = (owned: string[], duplicateOwned: string[]) =>
    otherSettledCaptureWhere({
      paymentId: input.paymentId,
      arrivingPaymentIntentId: input.paymentIntentId,
      liveSupersededIntentIds: owned,
      duplicateRefundIntentIds: duplicateOwned,
    });
  // Read only when an alert is worded, so the verdict's work under lock(1) stays small.
  const readTellingWhere = async () => {
    const captures = await tx.paymentTransaction.findMany({
      orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
      where: heldStripeCapturesWhere(input.paymentId),
      select: { id: true, stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
    });
    return reading(
      [...holdsForMember],
      await listDuplicateRefundIntentIdsOwningCaptures(tx, { bookingId: input.bookingId, paymentId: input.paymentId, captures }),
    );
  };
  return { ownership, holdsForMember, supersededOwned, duplicateRefundIntentIds, where: reading(supersededOwned, duplicateRefundIntentIds), readTellingWhere };
}

/**
 * #4285 review: the other payment an alert about a KEPT capture names - read
 * the way an admin is told (`readTellingWhere`), so a capture behind a dead
 * cancel, or one whose duplicate-capture refund failed later with nothing
 * owing it again, is named rather than "no other payment" - and what the kept
 * capture's card still holds. Words only: the verdict stays on `where`.
 */
async function keptCaptureAlert(
  tx: Prisma.TransactionClient,
  readTellingWhere: () => Promise<Prisma.PaymentTransactionWhereInput>,
  arriving: { id: string; amountCents: number; paymentIntentId: string },
): Promise<{ otherPaymentIntentId: string | null; otherHoldsMoney: boolean; heldCents: number }> {
  const other = await tx.paymentTransaction.findFirst({
    where: await readTellingWhere(),
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true },
  });
  return { otherPaymentIntentId: other?.stripePaymentIntentId ?? null, otherHoldsMoney: !!other, heldCents: await heldOnCard(tx, arriving) };
}

/** What a kept capture's card still holds: its amount less the card refunds recorded against it. */
async function heldOnCard(tx: Prisma.TransactionClient, arriving: { id: string; amountCents: number; paymentIntentId: string }): Promise<number> {
  return Math.max(0, arriving.amountCents - (await sumRecordedRefundsForCapture(tx, arriving)));
}

/**
 * Judge a card capture arriving on a booking already PAID or COMPLETED. The caller has
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
    /**
     * #4285 review: the arriving capture's row was SUCCEEDED before this delivery
     * - a replay of a capture already recorded - rather than new money. Read by
     * the caller before it wrote the row.
     */
    arrivingAlreadyCaptured: boolean;
  },
): Promise<ArrivingCaptureVerdict> {
  const arriving = await findPaymentTransactionByIntentId({
    paymentIntentId: input.paymentIntentId,
    store: tx,
  });
  // Rule 1.
  if (!arriving || arriving.id === input.recordedSettlerId) return { verdict: "keep" };

  const { ownership, holdsForMember, duplicateRefundIntentIds, where, readTellingWhere } = await readOtherSettledCaptureWhere(tx, input);
  const kept = { id: arriving.id, amountCents: arriving.amountCents, paymentIntentId: input.paymentIntentId };
  // #4283: the ARRIVING capture is refunded on top only if nothing is already
  // sending its money back - read the Xero way, so a DEAD cancel (one that
  // handed the money to nobody) leaves it a duplicate like any other. Held:
  // no duplicate refund, no re-send, no alert.
  if (holdsForMember.has(input.paymentIntentId)) return { verdict: "keep" };
  // (c′) for a settlement: `holdsForMember`, or a superseded-intent row on its
  // intent not SUCCEEDED - read in the one home (`readSupersededOwnership`, #4300).
  const supersededOwns = (paymentIntentId: string) => ownership.owns(paymentIntentId);

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
    // No record and nothing else holding money. #4285 review: a replay of a
    // capture already recorded (the booking's only capture) is a silent keep;
    // a capture never recorded before is new money on a booking nothing else
    // holds money for (zero cash, full credit, the $0 auto-pay, a group child) -
    // kept whatever its amount, and the admins told.
    if (!input.recordedSettlerId) {
      const alertOwed = await tx.alertCooldown.findUnique({
        where: { key: newCaptureAlertOwedKey(input.bookingId, input.paymentIntentId) },
        select: { key: true },
      });
      return input.arrivingAlreadyCaptured && !alertOwed
        ? { verdict: "keep" }
        : { verdict: "keep_unrecorded_settler", reason: "new-capture", ...(await keptCaptureAlert(tx, readTellingWhere, kept)) };
    }
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
    return { verdict: "keep_unrecorded_settler", reason: "settler-released", ...(await keptCaptureAlert(tx, readTellingWhere, kept)) };
  }

  // (c′) belt and braces: the settlement's own intent re-checked against the
  // live superseded-intent operations, by a different query shape. If one owns
  // its money, the arriving capture is the settlement side.
  if (settlement.stripePaymentIntentId && (await supersededOwns(settlement.stripePaymentIntentId))) {
    return { verdict: "keep" };
  }

  if (!recordedSettler && !arrivingOwned) {
    // Rule 3.
    // The settlement `where` found is in the telling reading too, so it is the payment named:
    // only what the card holds is read, keeping the work under lock(1) small.
    return {
      verdict: "keep_unrecorded_settler",
      otherPaymentIntentId: settlement.stripePaymentIntentId,
      otherHoldsMoney: true,
      reason: input.recordedSettlerId ? "settler-released" : "not-recorded",
      heldCents: await heldOnCard(tx, kept),
    };
  }

  return refundArriving(settlement.stripePaymentIntentId);
}

/** #4285 review: the namespace of the durable "a new-capture alert is owed" markers. */
export const NEW_CAPTURE_ALERT_OWED_PREFIX = "duplicate-capture-new-capture-owed:";

/** The owed marker of one capture's new-capture alert (`AlertCooldown`, the `markAlertOwed` family). */
export function newCaptureAlertOwedKey(bookingId: string, paymentIntentId: string): string {
  return `${NEW_CAPTURE_ALERT_OWED_PREFIX}${bookingId}:${paymentIntentId}`;
}

/**
 * #4285 review: record, inside the settle's transaction, that a new-capture
 * alert is owed - so a crash before the alert, or a send that throws, still
 * leaves a trigger: the capture's next arrival re-alerts while the marker
 * stands (rule 3), and the payments cron drains what nothing re-delivers
 * (`drainOwedNewCaptureAlerts`). Cleared only once an alert is delivered.
 * Under the caller's lock(1), so a plain upsert cannot race.
 */
export async function recordNewCaptureAlertOwed(
  tx: Pick<Prisma.TransactionClient, "alertCooldown">,
  { bookingId, paymentIntentId, now = new Date() }: { bookingId: string; paymentIntentId: string; now?: Date },
): Promise<void> {
  const key = newCaptureAlertOwedKey(bookingId, paymentIntentId);
  await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: now }, update: {} });
}

/**
 * Rule 3's alert, after the commit: a card capture was kept on a PAID (or COMPLETED) booking
 * with no usable record of which payment settled it - while another payment on
 * it still holds money, beside a released settler and nothing else, or (#4285) alone
 * and never recorded before. Its own unmuteable, delivery-locked template
 * (`admin-duplicate-capture-kept`): the duplicate-capture refund's alert says a
 * refund was made or queued, and the generic payment alert says "Payment Failed"
 * and can be muted. Once a day per (booking, capture) while repeats arrive (a
 * Stripe redelivery, a reconcile or cron re-run), sent anyway if the claim
 * cannot be read (`claimAlertCooldownFailOpen`), and the claim is given back if
 * the send throws so the next repeat tries again (`releaseAlertCooldown`, as
 * `internet-banking-hold-kept.ts`). Any delivered alert for the capture clears
 * its owed `new-capture` marker (#4285 review). Never throws; says what happened.
 */
export async function alertCaptureKeptWithoutRecordedSettler({
  booking,
  memberName,
  paymentIntentId,
  amountCents,
  otherPaymentIntentId,
  otherHoldsMoney = true,
  reason,
  cancellationRefund = null,
  format,
}: {
  booking: { id: string; checkIn: Date; checkOut: Date };
  memberName: string;
  paymentIntentId: string;
  amountCents: number;
  otherPaymentIntentId: string | null;
  otherHoldsMoney?: boolean;
  reason: DuplicateCaptureKeptReason;
  /** `new-capture-closed`: the cancellation's recorded refund, from the drain. */
  cancellationRefund?: CancellationRefundNote | null;
  format: ClubFormat;
}): Promise<"sent" | "cooldown" | "send-threw"> {
  // What the capture still holds and (closed) the cancellation's recorded refund travel in the log too.
  const context = { bookingId: booking.id, paymentIntentId, otherPaymentIntentId, reason, amountCents, ...(cancellationRefund ? { cancellationRefund } : {}) };
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
  if (!send) return "cooldown";
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
      ...(cancellationRefund ? { cancellationRefund } : {}),
    }, format);
  } catch (err) {
    logger.error({ err, ...context }, "Failed to alert admins about a kept capture; giving the claim back so a repeat tries again (#4211)");
    await releaseAlertCooldown({ key, claimedAt }).catch((releaseErr) =>
      logger.error({ err: releaseErr, ...context }, "Failed to give back the kept-capture alert's claim (#4211)"),
    );
    return "send-threw";
  }
  // #4285 review: ANY delivered alert for this capture answers an owed one, so
  // the drain never later sends "no other payment holds money" once untrue.
  await settleOwedAlert({ key: newCaptureAlertOwedKey(booking.id, paymentIntentId) }).catch((err) =>
    logger.error({ err, ...context }, "Failed to clear a delivered kept-capture alert's owed marker; it may be sent again (#4285)"),
  );
  return "sent";
}

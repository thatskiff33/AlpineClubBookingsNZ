/**
 * THE WAITING-INVOICE REAPER (#3641, `INV-PAY-104`, `INV-PAY-029`), run every
 * 15 minutes by the payments cycle (`payments-cron-runner.ts`, #3663), which
 * the cron leader and `POST /api/cron/payments` both call. Split from
 * `xero-operation-outbox.ts` so it can
 * hand a waiting invoice whose payment already arrived to the late-capture
 * release, which itself imports the outbox.
 *
 * A supplementary invoice parked WAITING_PAYMENT on a PaymentIntent is released
 * by a captured payment on that intent. This sweep decides what happens to one
 * that is still waiting:
 *   - its payment was CAPTURED and the club KEPT it: released now (or, where
 *     the capture does not cover it, cancelled unsent with an alert). That
 *     includes a cancelled booking's capture a treasurer kept (#3635);
 *   - its payment was captured and REFUNDED (`lateCaptureRefundState`: an
 *     approved treasurer task, or with no task a cancelled booking or a
 *     superseded intent): retired, never sent with a receipt for money being
 *     handed back;
 *   - its payment was captured and a treasurer is still deciding (#3635): kept
 *     waiting, so the decision is not pre-judged;
 *   - the member can still pay the ask: kept, however old, however many cards
 *     were declined against it;
 *   - Stripe has the money but our rows never recorded it for three days: kept,
 *     and an officer told once;
 *   - the booking no longer names it because a later request superseded it
 *     and carries its balance (#3403): moved to wait on that request
 *     (`followSupersededAskInvoicesSafely`), the backstop for the move at
 *     supersession - and kept while that request's cancel of it is still in
 *     flight, whose last step moves it (#4665);
 *   - the member can no longer pay it: retired (CANCELLED,
 *     `STALE_WAITING_PAYMENT`), the one state a later capture can revive.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  payableAdditionalPaymentIntentId,
  resolveAdditionalPaymentDoor,
  type AdditionalPaymentDoorInput,
} from "@/lib/additional-payment-chase";
import { getPaymentIntent } from "@/lib/stripe";
import { providerCaptureTime } from "@/lib/stripe-capture-date";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import {
  STALE_WAITING_PAYMENT_ERROR_CODE,
  lateCaptureRefundState,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
} from "@/lib/xero-supplementary-invoice-late-capture";
import { followSupersededAskInvoicesSafely, supersededAskCancelInFlight } from "@/lib/superseded-ask-invoice-carry";
import { stillWaitingOnIntentWhere } from "@/lib/xero-supplementary-invoice-statuses";

const STALE_WAITING_PAYMENT_AGE_DAYS = 14;

// F19 (#1887): a FAILED Stripe payment does not reap its WAITING_PAYMENT Xero
// op immediately. A failed PaymentIntent can be retried and SUCCEED on the same
// intent id, so cancelling the moment the transaction flips FAILED races that
// retry. Only a transaction that has stayed FAILED past this grace window is a
// candidate. #3641 corrected what this comment used to claim, that "Stripe
// intents do not stay retriable this long": a declined additional intent stays
// confirmable with another card indefinitely. So the grace only decides WHEN a
// failed ask is looked at; whether it is retired is the pay door's question.
const FAILED_TRANSACTION_REAP_GRACE_HOURS = 24;

/**
 * At most this many Stripe reads per run. A kept ask is read again on a later
 * run, and the rows read are touched (`updatedAt`) so the next run starts with
 * the ones read longest ago: a large backlog rotates through the cap instead of
 * the same rows being read on every run for ever. The touch is visible as an
 * "updated" time in the admin record-activity view and changes nothing else.
 */
const STRIPE_READS_PER_RUN = 25;

/** A background sweep's Stripe read gives up quickly and keeps the invoice. */
const STRIPE_READ_TIMEOUT_MS = 10_000;

/**
 * How long Stripe may report an intent captured while our rows still read it
 * as unpaid before an officer is told (#3641 review round, delta D3). Three
 * days is Stripe's own redelivery window for an undelivered webhook: past it,
 * no `payment_intent.succeeded` will arrive to record the capture and release
 * the invoice, so waiting longer only hides money no Xero invoice names.
 */
const PROVIDER_CAPTURE_UNRECORDED_ALERT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Stamped on a waiting invoice whose capture Stripe reports and our rows never
 * recorded. It stops further Stripe reads for that row, and a later release
 * clears it. It is NOT the alert's claim (#3635 C4): the alert goes through
 * the one once-ever rule (`sendAdminAlertOnceEver`), so a stamped row is
 * offered to it again each run and a send nobody received, or one that threw,
 * is retried rather than lost behind the stamp.
 */
const PROVIDER_CAPTURED_UNRECORDED_CODE = "PROVIDER_CAPTURED_UNRECORDED";

type WaitingOperationVerdict =
  | "retire"
  | "moved"
  | "keep"
  | "keep-deferred"
  | "captured"
  | "provider-captured-unrecorded";

export async function reapStaleWaitingPaymentXeroOutboxOperations(options?: {
  /** Override the staleness threshold in days. Defaults to 14. */
  ageInDays?: number;
  /**
   * Override the FAILED-transaction grace window in hours. Defaults to 24. A
   * FAILED Stripe transaction only reaps its WAITING_PAYMENT op once it has been
   * FAILED for at least this long (F19, #1887).
   */
  failedTransactionGraceHours?: number;
}): Promise<{ reaped: number; released: number; moved: number; queueOperationIds: string[] }> {
  const ageInDays = options?.ageInDays ?? STALE_WAITING_PAYMENT_AGE_DAYS;
  const ageThreshold = new Date(Date.now() - ageInDays * 24 * 60 * 60 * 1000);
  const failedGraceHours =
    options?.failedTransactionGraceHours ?? FAILED_TRANSACTION_REAP_GRACE_HOURS;
  const failedGraceThreshold = new Date(
    Date.now() - failedGraceHours * 60 * 60 * 1000,
  );

  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: { status: "WAITING_PAYMENT", direction: "OUTBOUND" },
    select: { id: true, createdAt: true, requestPayload: true, lastErrorCode: true },
    orderBy: { updatedAt: "asc" },
  });

  const reapable: Array<{ id: string; paymentIntentId: string | null }> = [];
  const capturedIntentIds = new Set<string>();
  const stripeReadIds: string[] = [];
  const unrecordedCaptures: Array<{ id: string; paymentIntentId: string }> = [];
  let kept = 0;
  let deferred = 0;
  let moved = 0;
  for (const operation of waitingOperations) {
    const payload = operation.requestPayload as
      | { paymentIntentId?: string | null }
      | null;
    const paymentIntentId = payload?.paymentIntentId ?? null;
    const pastAge = operation.createdAt <= ageThreshold;

    // No intent: nothing a member pays can release this row, so the age
    // backstop retires it. A failed mint's recovery attaches the intent it
    // finally mints (`INV-PAY-057`), and a failed attach now alerts
    // (`attachRecoveredIntentToWaitingSupplementaryInvoice`) rather than
    // leaving the row here to be retired while the member paid.
    if (!paymentIntentId) {
      if (pastAge) reapable.push({ id: operation.id, paymentIntentId: null });
      continue;
    }

    const verdict = await decideWaitingOperation({
      operationId: operation.id,
      paymentIntentId,
      pastAge,
      failedGraceThreshold,
      alreadyAlerted: operation.lastErrorCode === PROVIDER_CAPTURED_UNRECORDED_CODE,
      stripeReadsLeft: STRIPE_READS_PER_RUN - stripeReadIds.length,
      onStripeRead: () => stripeReadIds.push(operation.id),
    });
    if (verdict === "retire") reapable.push({ id: operation.id, paymentIntentId });
    else if (verdict === "captured") capturedIntentIds.add(paymentIntentId);
    else if (verdict === "keep") kept += 1;
    else if (verdict === "moved") moved += 1;
    else if (verdict === "keep-deferred") deferred += 1;
    else {
      kept += 1;
      unrecordedCaptures.push({ id: operation.id, paymentIntentId });
    }
  }

  const reapableIds = reapable.map((entry) => entry.id);
  // Rotate the Stripe cap: rows read this run go to the back of the next one.
  const keptAfterRead = stripeReadIds.filter((id) => !reapableIds.includes(id));
  if (keptAfterRead.length > 0) {
    await prisma.xeroSyncOperation.updateMany({
      where: { id: { in: keptAfterRead }, status: "WAITING_PAYMENT" },
      data: { updatedAt: new Date() },
    });
  }

  for (const capture of unrecordedCaptures) {
    await alertProviderCaptureUnrecorded(capture);
  }

  let released = 0;
  const releasedIds: string[] = [];
  for (const paymentIntentId of capturedIntentIds) {
    try {
      const result =
        await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
          paymentIntentId,
        );
      released += result.released;
      releasedIds.push(...result.queueOperationIds);
    } catch (err) {
      logger.error(
        { err, paymentIntentId },
        "Failed to release a waiting Xero supplementary invoice whose payment was already captured",
      );
    }
  }

  if (kept > 0 || deferred > 0 || released > 0 || moved > 0) {
    logger.info(
      { kept, deferredStripeReads: deferred, released, movedToCarrier: moved },
      "Kept WAITING_PAYMENT Xero outbox operations the member can still pay, and released those already paid",
    );
  }

  let reaped = 0;
  let reapedIds = reapableIds;
  if (reapable.length > 0) {
    // Guarded on the intent each row was judged on, as well as the status
    // (#3403): a superseded change's invoice moved onto the request that
    // carries its balance since the verdict waits on a payable ask now.
    for (const [paymentIntentId, ids] of groupByIntent(reapable)) {
      const updateResult = await prisma.xeroSyncOperation.updateMany({
        where: {
          id: { in: ids },
          status: "WAITING_PAYMENT",
          ...(paymentIntentId === null
            ? {}
            : { requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId } }),
        },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
          lastErrorMessage: "Reaped: the linked payment request can no longer be paid.",
        },
      });
      reaped += updateResult.count;
    }
    // Report only the rows this run cancelled (review X5): one moved or released since its verdict is not.
    if (reaped < reapableIds.length) {
      const cancelled = await prisma.xeroSyncOperation.findMany({
        where: { id: { in: reapableIds }, status: "CANCELLED", lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE },
        select: { id: true },
      });
      reapedIds = cancelled.map((row) => row.id);
    }
    if (reaped > 0) {
      logger.info(
        { reaped, ageInDays },
        "Reaped stale WAITING_PAYMENT Xero outbox operations",
      );
    }
  }

  return {
    reaped,
    released,
    moved,
    queueOperationIds: [...new Set([...reapedIds, ...releasedIds])],
  };
}

/** The reapable rows by the intent each was judged on (null: none named). */
function groupByIntent(
  reapable: ReadonlyArray<{ id: string; paymentIntentId: string | null }>,
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const entry of reapable) {
    groups.set(entry.paymentIntentId, [...(groups.get(entry.paymentIntentId) ?? []), entry.id]);
  }
  return groups;
}

/**
 * #3403: the backstop for the move at supersession. A superseded ask's balance
 * is carried by a later request, so its invoice is moved there first; only one
 * still waiting on this intent after that is retired.
 *
 * #4665: never while the ask's cancel is still in flight. Until it lands the
 * ask is passed over (`supersededAskCarriers`), so the move finds nothing, and
 * the cancel's terminal step moves the invoice once it does. Asked BEFORE the
 * move: the cancel marks the transaction FAILED, moves (swallowing a failure),
 * then marks itself SUCCEEDED, so one read as in flight here may still land
 * between this read and the move and leave nothing moved - kept for the next
 * run. One read as finished has committed its FAILED, so the move below sees
 * the ask as carried and is itself the cancel's move retried; only what it
 * still leaves on this intent is retired.
 */
async function moveToCarrierOrRetire(
  params: { operationId: string; paymentIntentId: string },
  paymentId: string,
): Promise<"moved" | "keep" | "retire"> {
  const cancelInFlight = await supersededAskCancelInFlight(params.paymentIntentId);
  const carried = await followSupersededAskInvoicesSafely({ paymentId });
  if (carried && carried.moved > 0) {
    const stillHere = await prisma.xeroSyncOperation.findFirst({
      where: { id: params.operationId, ...stillWaitingOnIntentWhere(params.paymentIntentId) },
      select: { id: true },
    });
    if (!stillHere) return "moved";
  }
  return cancelInFlight ? "keep" : "retire";
}

/**
 * One waiting operation on an intent. The local rows first, and Stripe only
 * where they cannot answer: an ask whose transaction is FAILED might be a
 * decline (still payable with another card) or a provider cancel (never payable
 * again), and only Stripe can tell which. A PENDING or PROCESSING ask is kept on
 * the local rows alone.
 */
async function decideWaitingOperation(params: {
  operationId: string;
  paymentIntentId: string;
  pastAge: boolean;
  failedGraceThreshold: Date;
  alreadyAlerted: boolean;
  stripeReadsLeft: number;
  onStripeRead: () => void;
}): Promise<WaitingOperationVerdict> {
  const transaction = await prisma.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: params.paymentIntentId },
    select: {
      status: true,
      updatedAt: true,
      paymentId: true,
      payment: { select: { booking: { select: { status: true } } } },
    },
  });

  // Already paid: the capture's own release did not happen (the confirm route
  // failed and the webhook never arrived, or the intent was attached after the
  // capture). Released only when the club KEEPS the money; a refunded capture
  // (an approved treasurer task, or with no task a cancelled booking or a
  // superseded intent, whose capture is refunded) is moved to the request
  // carrying its balance where there is one (#3403 review 2, F1), else
  // retired; one a treasurer is still deciding (#3635) is kept waiting,
  // whatever its age.
  if (transaction && isCapturedTransactionStatus(transaction.status)) {
    const refundState = await lateCaptureRefundState({
      paymentIntentId: params.paymentIntentId,
      bookingStatus: transaction.payment?.booking?.status,
    });
    if (refundState === "awaiting-decision") return "keep";
    return refundState === "refunded" ? moveToCarrierOrRetire(params, transaction.paymentId) : "captured";
  }

  const failed = transaction?.status === "FAILED";
  // F19 (#1887): before 14 days, only a transaction FAILED since before the
  // grace window is looked at, so a not-yet-retried failure cannot be
  // cancelled out from under a same-intent retry about to succeed. A
  // redelivered failure re-writes FAILED and restarts the grace; that can only
  // DELAY a reap, and the 14-day arm bounds it.
  if (
    !params.pastAge &&
    !(failed && transaction.updatedAt <= params.failedGraceThreshold)
  ) {
    return "keep";
  }

  const payment = await prisma.payment.findUnique({
    where: { additionalPaymentIntentId: params.paymentIntentId },
    select: {
      additionalPaymentIntentId: true,
      additionalPaymentStatus: true,
      booking: { select: { status: true, deletedAt: true } },
    },
  });
  // Found BY the intent, so no row means the booking no longer names it: the
  // superseded or withdrawn case. #3403: a superseded ask's balance is carried
  // by a later request, so its invoice is moved there first - the backstop for
  // the cancel step and the minter, which move it at supersession - and only
  // an invoice still waiting on this intent after that is retired.
  if (!payment) return transaction ? moveToCarrierOrRetire(params, transaction.paymentId) : "retire";
  const door: AdditionalPaymentDoorInput = {
    bookingStatus: payment.booking.status,
    bookingDeletedAt: payment.booking.deletedAt,
    payment,
  };
  if (payableAdditionalPaymentIntentId(door) !== params.paymentIntentId) {
    return "retire";
  }
  if (!failed) return "keep";
  // Stripe has already been read as holding this money; nothing a further
  // read could add. Offered to the once-ever alert again, which sends nothing
  // while its claim holds (#3635 C4).
  if (params.alreadyAlerted) return "provider-captured-unrecorded";
  if (params.stripeReadsLeft <= 0) return "keep-deferred";

  params.onStripeRead();
  try {
    const answer = await resolveAdditionalPaymentDoor(door, (id) =>
      getPaymentIntent(id, {
        timeoutMs: STRIPE_READ_TIMEOUT_MS,
        expand: ["latest_charge"],
      }),
    );
    if (answer.state === "closed") return "retire";
    if (answer.state === "captured-at-provider") {
      // Stripe has the money and our rows do not. Only the capture's webhook
      // (or the confirm route) records it, and this sweep reads the LOCAL
      // transaction, so it cannot release the invoice itself. It waits out
      // Stripe's redelivery window, then tells an officer once.
      const capturedFor = Date.now() - providerCaptureTime(answer.intent).getTime();
      return capturedFor >= PROVIDER_CAPTURE_UNRECORDED_ALERT_MS
        ? "provider-captured-unrecorded"
        : "keep";
    }
    return "keep";
  } catch (err) {
    // Keeping costs a warning in the repair report; retiring a live ask is the
    // bug this rule removes.
    logger.warn(
      { err, paymentIntentId: params.paymentIntentId },
      "Could not read a waiting Xero invoice's PaymentIntent from Stripe; keeping the invoice waiting",
    );
    return "keep";
  }
}

/**
 * The row stamp (written only onto a row still WAITING with no code) marks the
 * row as read; the alert itself goes through `sendAdminAlertOnceEver` (#3635
 * C4), the one rule every once-per-condition money alert shares: kept once an
 * admin has it or its copy is queued for the retry cron, held a day when
 * nobody could receive it (muted, nobody opted in, every address suppressed),
 * given back when the send throws. Never throws.
 */
async function alertProviderCaptureUnrecorded(capture: {
  id: string;
  paymentIntentId: string;
}): Promise<void> {
  try {
    const stamped = await prisma.xeroSyncOperation.updateMany({
      where: { id: capture.id, status: "WAITING_PAYMENT", lastErrorCode: null },
      data: {
        lastErrorCode: PROVIDER_CAPTURED_UNRECORDED_CODE,
        lastErrorMessage:
          "Stripe reports this payment captured, but it was never recorded here, so this invoice is still waiting.",
      },
    });
    if (stamped.count === 1) {
      logger.error(
        { ...capture },
        "Stripe reports a waiting Xero invoice's payment captured, but no capture was ever recorded",
      );
    }
  } catch (err) {
    logger.error(
      { err, operationId: capture.id },
      "Failed to mark a waiting Xero invoice's unrecorded capture; alerting anyway",
    );
  }
  await sendAdminAlertOnceEver({
    key: `xero-waiting-invoice-capture-unrecorded:${capture.id}`,
    label: "unrecorded-capture alert",
    context: { operationId: capture.id, paymentIntentId: capture.paymentIntentId },
    send: () =>
      sendAdminXeroSyncErrorAlert({
        errorType: "SUPPLEMENTARY_INVOICE_CAPTURE_UNRECORDED",
        operation: `Supplementary invoice waiting on payment ${capture.paymentIntentId}`,
        errorMessage: `Stripe has reported the card payment ${capture.paymentIntentId} as captured for more than three days, but this system never recorded it (the Stripe webhook did not arrive), so its waiting Xero supplementary invoice (outbox operation ${capture.id}) was never released. Stripe holds this money; check the Stripe webhook endpoint and record the payment, which releases the invoice.`,
        timestamp: new Date(),
      }),
  });
}

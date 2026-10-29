import {
  ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS,
  assertAdditionalAskSizingCurrent,
  lockAdditionalAskQueue,
} from "@/lib/additional-ask-queue-transaction";
import { askSizedOnBalanceCents } from "@/lib/additional-payment-ask";
import {
  PaymentSource,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import {
  EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY,
  completeEditFinancialReviewChargeRecovery,
  rearmEditFinancialReviewChargeRecovery,
} from "@/lib/edit-financial-review-charge-recovery";
import { clubFormatValues } from "@/lib/club-format-server";
import { loadPersistedClubFormatSettings } from "@/lib/club-format-settings";
import { chargeCurrencyRefusal } from "@/lib/stripe-charge-currency";
import { prisma } from "@/lib/prisma";
import {
  cancelPaymentIntentIfCancellableWithResult,
  processRefund,
} from "@/lib/stripe";
import { isPaymentIntentCancelConfirmed } from "@/lib/card-intent-retirement";
import {
  findPaymentTransactionByIntentId,
  lockPaymentForRefundedTotal,
  reconcilePaymentAggregates,
  capturedStripeTransactions,
  recordStripeRefundsAgainstTransaction,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
  type RefundAllocationSlice,
} from "@/lib/payment-transactions";
// #3372: the one plan parser, shared with the "Refunds owed" net-out.
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { checkCardRefundResend, UnattributedCardRefundBeforeResendError } from "@/lib/card-refund-resend-preflight";
import { cardRefundStillOwedCents } from "@/lib/card-refund-still-owed";
import { onPlanWhere, refundPlanOrRetryRefusals } from "@/lib/refused-card-refund-retry";
import { closePrePersistedRefundRow, type DoorCloseArgs } from "@/lib/pre-persisted-refund-close";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import {
  findWaitingSupplementaryInvoiceOperationForPaymentIntent,
  // Type-only, so it adds nothing to this module's runtime import graph.
  type XeroSupplementaryInvoiceEnqueueOutcome,
} from "@/lib/xero-operation-outbox";
import { attachRecoveredIntentToWaitingSupplementaryInvoice } from "@/lib/xero-supplementary-invoice-late-capture";
import { followSupersededAskInvoicesSafely } from "@/lib/superseded-ask-invoice-carry";
import { queueFoldedReissuedAskInvoices, queueReissuedAskSupplementaryInvoice } from "@/lib/reissued-ask-invoice";
import {
  mintedIntentCustomerId,
  mintReissuedAskIntent,
  planReissuedAskMint,
  resolveAskCustomerId,
} from "@/lib/reissued-ask-mint";
import { isRecoveryReplaySettled, sizeRecoveryReplayAsk } from "@/lib/additional-ask-recovery-replay";
import { mintOrdinaryAskIntent, refuseAdoptedIntentOnLedger } from "@/lib/ordinary-ask-mint";
import { unretryableRecoveryCause } from "@/lib/recovery-unretryable-cause";
import { ORDINARY_ASK_RECOVERY_REASON, planOrdinaryAskMint } from "@/lib/ordinary-ask-request";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { closeCancellationRefundAfterReplay, closeCapacityRaceRefundRecordingEvent, recordDuplicateCaptureRefundEvent } from "@/lib/booking-events";
import { reportSupersededPaymentRefund } from "@/lib/superseded-additional-refund";
import logger from "@/lib/logger";
import { createAuditLog } from "@/lib/audit";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE } from "@/lib/payment-recovery-constants";
import { stripeReferenceId } from "@/lib/stripe-references";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { formatCents } from "@/lib/utils";
import { isCapturedTransactionStatus, OPEN_INTENT_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { replayNotingEachRefund } from "@/lib/card-refund-own-note";
import { finishApprovedLateCaptureRefundAfterReplay } from "@/lib/late-capture-refund-credit-note";
import { holdSupersededLateCaptureIfRequired } from "@/lib/late-capture-refund-hold";
import { supersededMachineryOwnsCapture } from "@/lib/superseded-capture-ownership";
import { compareLedgerRowsNewestFirst, LEDGER_ROWS_NEWEST_FIRST, LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";

type PaymentRecoveryStore = Prisma.TransactionClient | typeof prisma;

const STALE_PROCESSING_MINUTES = 30;
/**
 * How many stale `PROCESSING` rows one sweep hands back (#3220 fix round). See
 * `resetStaleProcessingOperations`: each row now costs an alert and possibly a
 * Stripe round trip, and the sweep runs in front of the main queue. Generous
 * against any real backlog - a sweep this size means thirty minutes of workers
 * died - and the remainder is taken by the next run.
 */
const STALE_PROCESSING_SWEEP_LIMIT = 50;
// One entry per attempt: nextRetryDate(attempts) reads RETRY_BACKOFF_MINUTES[attempts - 1].
const RETRY_BACKOFF_MINUTES: readonly number[] = [5, 15, 60, 240, 720];
if (RETRY_BACKOFF_MINUTES.length !== MAX_PAYMENT_RECOVERY_ATTEMPTS) {
  throw new Error(
    "RETRY_BACKOFF_MINUTES must have exactly MAX_PAYMENT_RECOVERY_ATTEMPTS entries",
  );
}

/**
 * THE THREE STATUS SETS THIS MODULE READS, EACH SPELLED ONCE (#3220,
 * `INV-SSOT`).
 *
 * `FAILED` is not one state here, it is two readings of one column, and the
 * distinction is the whole reason #3220 exists. A `FAILED` row with attempts
 * left is a RETRY waiting its turn; a `FAILED` row with none is DEAD. The
 * `attempts < MAX` filter beside each use of
 * `CLAIMABLE_PAYMENT_RECOVERY_STATUSES` is what separates them, so it belongs to
 * the query rather than to the constant.
 *
 * BEWARE: THAT IS THIS MODULE'S DISTINCTION, AND ONLY THIS MODULE'S. The
 * booking-vs-Xero repair tool defers on `OPEN_PAYMENT_RECOVERY_STATUSES`
 * (`xero-booking-repair-load.ts`), which is `[PENDING, PROCESSING]` and carries
 * no `attempts` filter at all - so it stops deferring at the FIRST failure, not
 * at death. Do not read the two-readings rule into that query: a retry waiting
 * its turn already looks dead to it. The consequence is bounded and is stated
 * with `INV-PAY-057` rather than papered over - a retry that later succeeds
 * raises the ask and its invoice together, and a retry that runs out reaches the
 * terminal branch below, which withdraws the ask.
 *
 * They were three inline `in: [...]` literals, and the pre-decision review on
 * #3220 counted them among the module's six mentions of
 * `PaymentRecoveryOperationStatus.FAILED`. They are reads, so they can never be
 * the transition anything hangs off - but a reader looking for "where does this
 * module decide a recovery is dead" had six candidates to eliminate, and
 * `payment-recovery-terminal-failure-census.test.ts` now pins that there are
 * exactly these two plus the one write.
 */
export const CLAIMABLE_PAYMENT_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PENDING,
  PaymentRecoveryOperationStatus.FAILED,
] as const;

/** Everything a live operation can be. Excludes only the terminal SUCCEEDED. */
export const NON_TERMINAL_PAYMENT_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PENDING,
  PaymentRecoveryOperationStatus.PROCESSING,
  PaymentRecoveryOperationStatus.FAILED,
] as const;

/** What the stale-worker reaper is allowed to move a row out of. */
const STALE_PROCESSING_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PROCESSING,
] as const;

export interface PaymentRecoveryProcessResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextRetryDate(attempts: number) {
  // The attempt index is clamped into the schedule's own bounds, so it always
  // lands on a step. There is deliberately NO numeric fallback: a zero would be
  // an immediate retry, which is the worst wait this function could invent, and
  // any other number would be a backoff nobody configured. The schedule's
  // length is asserted at module load, so an empty one cannot ship — and if it
  // ever did, refusing to schedule is the safe answer (#2800).
  const step = Math.min(
    Math.max(attempts - 1, 0),
    RETRY_BACKOFF_MINUTES.length - 1
  );
  const delayMinutes = RETRY_BACKOFF_MINUTES[step];
  if (delayMinutes === undefined) {
    throw new Error(
      `The payment retry backoff schedule has no step ${step} of ${RETRY_BACKOFF_MINUTES.length}.`,
    );
  }
  return new Date(Date.now() + delayMinutes * 60 * 1000);
}

export async function enqueuePaymentIntentCancellationRecovery({
  bookingId,
  paymentId,
  paymentTransactionId,
  paymentIntentId,
  amountCents,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey = buildPaymentIntentCancelRecoveryIdempotencyKey(
    paymentTransactionId,
    paymentIntentId
  );

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
    },
  });
}

async function enqueueLedgerRefundRecovery({
  bookingId,
  paymentId,
  amountCents,
  idempotencyKey,
  stripeKeyPrefix,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  stripeKeyPrefix?: string | null;
  amountCents: number;
  idempotencyKey: string;
  /**
   * Per-transaction slices frozen by the caller BEFORE any Stripe call
   * (#1349). When present, the processor replays exactly these slices with
   * their `${prefix}_${transactionId}_${amount}` Stripe keys instead of
   * deriving an allocation from whatever progress happens to be recorded, so
   * an enqueue-then-execute caller (booking cancel) is exactly-once even when
   * the recovery cron races or resumes the inline refund.
   */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  const payment = await store.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactions: {
        orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
      },
    },
  });

  const capturedTransaction = payment?.transactions.find(
    (transaction) =>
      transaction.source === PaymentSource.STRIPE &&
      Boolean(transaction.stripePaymentIntentId) &&
      isCapturedTransactionStatus(transaction.status),
  );
  const representativePaymentIntentId =
    capturedTransaction?.stripePaymentIntentId ??
    payment?.stripePaymentIntentId ??
    null;

  if (!representativePaymentIntentId) {
    throw new Error(
      "Cannot enqueue ledger refund recovery without a payment intent",
    );
  }

  const allocationPlanJson =
    allocationPlan && allocationPlan.length > 0
      ? (allocationPlan as unknown as Prisma.InputJsonValue)
      : undefined;

  const inserted = await store.paymentRecoveryOperation.createMany({
    data: [
      {
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId,
        paymentId,
        paymentIntentId: representativePaymentIntentId,
        amountCents,
        idempotencyKey,
        stripeKeyPrefix: stripeKeyPrefix ?? null,
        allocationPlan: allocationPlanJson,
        nextRetryAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) {
    // #4103 review C2: a fresh plan with no refusal in it never resets a row a
    // refusal already re-planned (a slice on a later key, or marked made): a
    // redelivery would send the cached refusal's key again, and re-alert. Read,
    // then written compare-and-set on what was read.
    const progressed = (slices: ReadonlyArray<RefundAllocationSlice> | null | undefined) =>
      (slices ?? []).some((slice) => slice.stripeKeySuffix || slice.madeRefundId);
    let planFence: Prisma.PaymentRecoveryOperationWhereInput = {};
    if (allocationPlanJson !== undefined && !progressed(allocationPlan)) {
      const held = (await store.paymentRecoveryOperation.findUnique({ where: { idempotencyKey }, select: { allocationPlan: true } }))?.allocationPlan ?? null;
      if (progressed(parseRefundAllocationPlan(held))) return { created: false, paymentIntentId: representativePaymentIntentId };
      planFence = onPlanWhere(held);
    }
    // #4083: a repeat enqueue refreshes only a row no worker has picked up
    // (PENDING). One a worker has claimed, failed or closed keeps its amount,
    // prefix and plan: those slices may already have been sent under their keys.
    await store.paymentRecoveryOperation.updateMany({
      where: { idempotencyKey, status: PaymentRecoveryOperationStatus.PENDING, ...planFence },
      data: {
        bookingId,
        paymentId,
        paymentIntentId: representativePaymentIntentId,
        amountCents,
        stripeKeyPrefix: stripeKeyPrefix ?? null,
        // Only overwrite a frozen plan when the caller supplies a fresh one.
        ...(allocationPlanJson !== undefined ? { allocationPlan: allocationPlanJson } : {}),
      },
    });
  }
  return { created: inserted.count > 0, paymentIntentId: representativePaymentIntentId };
}

export async function enqueueBookingModificationRefundRecovery({
  bookingId,
  paymentId,
  bookingModificationId,
  amountCents,
  stripeKeyPrefix,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  amountCents: number;
  /**
   * The exact Stripe idempotency key prefix the originating route used
   * (#1152). The recovery worker replays it so a refund that succeeded on
   * Stripe but was never recorded locally is replayed, not re-minted.
   */
  stripeKeyPrefix?: string | null;
  /** #3984: the whole read plan, with made slices marked; omitted only before Stripe or by legacy callers. */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey:
      buildBookingModificationRefundRecoveryIdempotencyKey(bookingModificationId),
    stripeKeyPrefix,
    allocationPlan,
    store,
  });
}

/**
 * Durable retry for a booking edit's additional PaymentIntent whose creation
 * failed transiently (#1096). One row per charge debt (unique idempotency key),
 * replayable by the recovery cron. `paymentIntentId` holds the Stripe
 * idempotency key until the intent exists — Stripe answers a repeated key with
 * the same intent, so a retry can never mint a second collectable instrument —
 * and is updated to the real intent id once created.
 *
 * #3170: `idempotencyKey` is now a REQUIRED argument rather than derived from
 * `bookingModificationId` inside. The ordinary edit path still passes the
 * modification-scoped key and behaves identically; the review-completion charge
 * passes its own EDIT-scoped key from `payment-recovery-keys.ts`. Both are keyed
 * on the same `BookingModification` in different namespaces, so the two paths'
 * debts are separate rows - while the two review tasks of ONE edit deliberately
 * share a row, because the owner's 30 Aug 2026 decision makes their two shares
 * one debt against one request. (An earlier draft of this paragraph said the
 * review key was TASK-scoped. It was, for one round, and that scoping is what
 * let a second share mint a second intent and cancel the first.) Passing the key
 * rather than a flag is what stops a future caller getting the scoping wrong by
 * omission (`INV-SSOT`: a required argument beats a rule).
 *
 * #3170 ALSO STOPPED THE UPSERT REWRITING `amountCents`. An `update` clause
 * carrying the amount means a colliding second caller silently rewrites a debt
 * the cron may already be part way through — the exact hazard
 * `buildEditFinancialReviewRefundRecoveryIdempotencyKey` was task-scoped to avoid
 * on the refund side, sitting unremarked on the charge side. Under a correct key
 * a repeat carries the SAME amount, so dropping it from the update changes
 * nothing that is right and makes the wrong thing unrepresentable. `bookingId`
 * and `paymentId` stay, because a repeat cannot change either and refreshing them
 * costs nothing.
 *
 * #3181: `hadIssuedXeroInvoice` IS REQUIRED, AND IT IS THE EDIT'S ANSWER, NOT THE
 * REPLAY'S. The replay raises the supplementary invoice the edit deferred, and
 * whether an edit had a primary invoice to supplement is a fact about the moment
 * it dispatched - a booking whose primary invoice is minted AFTER the edit gets
 * billed for the edit by that invoice, so a replay re-deriving `true` hours later
 * would queue a second ask for the same money. A required argument rather than an
 * optional one because every caller already holds the value it fed
 * `queueXeroBookingEditSettlement`, and an omission would be indistinguishable
 * from a recorded `false` (`INV-SSOT`: unrepresentable beats policed). It is
 * written on `create` ONLY, for the same reason `amountCents` is: a colliding
 * second caller for one debt must not rewrite a fact the cron may already be
 * acting on, and first-writer-wins keeps the EARLIEST edit-time answer, which is
 * the conservative one.
 */
export async function enqueueAdditionalPaymentIntentRecovery({
  bookingId,
  paymentId,
  idempotencyKey,
  amountCents,
  stripeIdempotencyKey,
  hadIssuedXeroInvoice,
  nextRetryAt = new Date(),
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  /**
   * #3954 review round 4: when the runner may first claim it. Now, for a mint
   * that already failed; a short grace for a price reduction's re-issue,
   * written in the edit's transaction BEFORE the door's own mint runs, so the
   * runner does not race a mint that is about to succeed.
   */
  nextRetryAt?: Date;
  /**
   * The recovery-operation dedup key. Build it with
   * `buildAdditionalIntentRecoveryIdempotencyKey` (an ordinary edit) or
   * `buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey` (a review
   * completion). Both are scoped to the `BookingModification` and neither is
   * scoped to a task: one edit raises one request, so its two review shares are
   * one debt and share one recovery row.
   */
  idempotencyKey: string;
  amountCents: number;
  stripeIdempotencyKey: string;
  /**
   * Whether this booking's PRIMARY Xero invoice had already been issued when the
   * edit dispatched - `hasIssuedPrimaryXeroInvoice`, as the edit itself read it.
   * `null` only from the recovery replay's own re-entry, where the row already
   * exists and this value is therefore never written.
   */
  hadIssuedXeroInvoice: boolean | null;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: additionalIntentRecoveryRow({ bookingId, paymentId, idempotencyKey, amountCents, stripeIdempotencyKey, hadIssuedXeroInvoice, nextRetryAt }),
    update: {
      bookingId,
      paymentId,
    },
  });
}

type AdditionalIntentRecoveryRowInput = Omit<Parameters<typeof enqueueAdditionalPaymentIntentRecovery>[0], "store"> & { nextRetryAt: Date };

/** The row an additional-intent recovery is created as: one shape for the upsert above and the insert below. */
function additionalIntentRecoveryRow(input: AdditionalIntentRecoveryRowInput) {
  return {
    type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
    status: PaymentRecoveryOperationStatus.PENDING,
    bookingId: input.bookingId,
    paymentId: input.paymentId,
    paymentIntentId: input.stripeIdempotencyKey,
    amountCents: input.amountCents,
    hadIssuedXeroInvoice: input.hadIssuedXeroInvoice,
    idempotencyKey: input.idempotencyKey,
    nextRetryAt: input.nextRetryAt,
  };
}

/**
 * #4253 release 2 (`INV-ADDPAY-050`): the same row, created only where no row has the key, and
 * whether THIS call created it (`INSERT ... ON CONFLICT DO NOTHING`). For a caller that counts and
 * audits the rows it raised: two overlapping payment cycles both see the upsert succeed, so both
 * counted the same release and wrote two batch rows for it.
 */
export async function createAdditionalPaymentIntentRecoveryOnce(
  input: Omit<AdditionalIntentRecoveryRowInput, "nextRetryAt"> & { nextRetryAt?: Date },
): Promise<boolean> {
  const created = await prisma.paymentRecoveryOperation.createMany({
    data: [additionalIntentRecoveryRow({ ...input, nextRetryAt: input.nextRetryAt ?? new Date() })],
    skipDuplicates: true,
  });
  return created.count === 1;
}

/**
 * #3402 (`INV-PAY-112`): make ONE booking edit's review-charge debt durable on
 * its one recovery row, and make sure that row will run again
 * (`rearmEditFinancialReviewChargeRecovery` says why and how). The single home
 * for the row's two keys and its frozen `hadIssuedXeroInvoice`: the sync's
 * deferral and unminted arm, and `executeEditReviewCharge`'s refusal catch.
 */
export async function enqueueEditFinancialReviewChargeRecovery({
  bookingId,
  paymentId,
  bookingModificationId,
  advisoryAmountCents,
  hadIssuedXeroInvoice,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  /** Diagnostic only: the replay re-derives the total from the settled shares. */
  advisoryAmountCents: number;
  /** #3181: NOT advisory - the replay's answer to "was there an invoice to supplement". */
  hadIssuedXeroInvoice: boolean | null;
}) {
  const idempotencyKey =
    buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(bookingModificationId);
  await enqueueAdditionalPaymentIntentRecovery({
    bookingId,
    paymentId,
    idempotencyKey,
    amountCents: advisoryAmountCents,
    stripeIdempotencyKey: buildEditFinancialReviewAdditionalIntentStripeKey(bookingModificationId),
    hadIssuedXeroInvoice,
  });
  await rearmEditFinancialReviewChargeRecovery(idempotencyKey);
}

/**
 * #3402: is the edit's ONE recovery row DEAD - in a claimable status that no
 * claim will ever take again (no retry time, or its attempts spent)? The re-arm
 * deliberately leaves such a row so (`INV-PAY-057`); every other row runs again
 * or is reopened by the deferral that needs it. The sync asks this before it
 * re-checks an `already-paid` answer, so a deferred share's `ask-closed` audit is
 * written once - by the replay, or by the holder when no replay will come.
 */
export async function isEditFinancialReviewChargeRecoveryDead(
  bookingModificationId: string,
): Promise<boolean> {
  const row = await prisma.paymentRecoveryOperation.findUnique({
    where: {
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(bookingModificationId),
    },
    select: { status: true, attempts: true, nextRetryAt: true },
  });
  if (!row) return false;
  // Not `!isPaymentRecoveryOperationInFlight`: a PENDING row with no retry time
  // or its attempts spent is dead here, in flight there (see its docblock).
  const claimable = (CLAIMABLE_PAYMENT_RECOVERY_STATUSES as readonly PaymentRecoveryOperationStatus[])
    .includes(row.status);
  return claimable && (row.nextRetryAt === null || row.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS);
}

/**
 * Durable recovery for an approved refund appeal whose Stripe refund failed
 * (#1039 item 1, PR #846 residual). The approval claim stands and the refund
 * completes through the recovery cron. When the approve route passes the
 * `allocationPlan` it froze BEFORE the inline Stripe call (#1510), the processor
 * replays exactly those per-transaction slices under their original
 * `refund_request_<id>_<txn>_<amount>` Stripe keys — so a multi-transaction
 * partial-progress replay is answered by Stripe with the original refunds and
 * the `PaymentRefund` ledger dedupes on refund id, instead of a re-derived,
 * shifted allocation minting fresh keys. Operations enqueued before #1510 carry
 * no frozen plan and fall back to the processor's derive-at-replay behaviour
 * (unchanged; post-#1507 single-transaction payments — the dominant case —
 * already share slice keys with the inline refund).
 */
export async function enqueueRefundRequestRefundRecovery({
  bookingId,
  paymentId,
  refundRequestId,
  amountCents,
  allocationPlan,
  notesEachRefund = false,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  refundRequestId: string;
  amountCents: number;
  /** Slices frozen by the approve route BEFORE the inline Stripe refund (#1510). */
  allocationPlan?: RefundAllocationSlice[];
  /**
   * #4312 (`INV-ADDPAY-047`): the approval queued no Xero note for this card
   * part (a bank-transfer payment), so the replay notes each refund it makes.
   * Recorded as the row's Stripe key prefix - the one the replay sends under
   * anyway - so a row an older approval wrote, which noted the part itself,
   * carries none (`refundRequestRecoveryNotesEachRefund`).
   */
  notesEachRefund?: boolean;
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildRefundRequestRefundRecoveryIdempotencyKey(refundRequestId),
    ...(notesEachRefund ? { stripeKeyPrefix: buildRefundRequestRefundStripeKeyPrefix(refundRequestId) } : {}),
    allocationPlan,
    store,
  });
}

/** #4312: whether a refund request's recovery row was written by an approval that left its card part's notes to each refund (`notesEachRefund`). */
export function refundRequestRecoveryNotesEachRefund(operation: { idempotencyKey: string; stripeKeyPrefix: string | null }): boolean {
  if (!isRefundRequestRefundRecoveryKey(operation.idempotencyKey)) return false;
  return operation.stripeKeyPrefix === buildRefundRequestRefundStripeKeyPrefix(operation.idempotencyKey.slice(REFUND_REQUEST_REFUND_RECOVERY_PREFIX.length));
}

import {
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX,
  buildBookingCancellationRefundIdempotencyKey,
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildBookingModificationRefundRecoveryIdempotencyKey,
  buildCapacityClaimFailedRefundRecoveryIdempotencyKey,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundStripeKeyPrefix,
  duplicateCaptureIntentIdForRecoveryKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
  buildEditFinancialReviewRefundRecoveryIdempotencyKey,
  buildEditFinancialReviewRefundStripeKeyPrefix,
  buildGroupSettlementRefundRecoveryIdempotencyKey,
  buildLateCaptureApprovalRefundRecoveryIdempotencyKey,
  buildLateCaptureRefundStripeKeyPrefix,
  buildPaymentIntentCancelRecoveryIdempotencyKey,
  buildRefundRequestRefundMetadata,
  buildRefundRequestRefundRecoveryIdempotencyKey,
  buildRefundRequestRefundStripeKeyPrefix,
  cardRefundOperationRefundMetadata,
  buildSupersededPaymentRefundRecoveryIdempotencyKey,
  buildLegacyModificationRefundStripeKeyPrefix,
  REFUND_REQUEST_REFUND_RECOVERY_PREFIX,
  isLateCaptureRefundStripeKeyPrefix,
  bookingModificationIdForAdditionalIntentRecoveryKey,
  bookingModificationRefundReasonForKeyPrefix,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
  groupSettlementIdForRefundRecoveryKey,
  isGroupSettlementRefundRecoveryKey,
  isOrganiserChildRefundKey,
  isRefundRequestRefundRecoveryKey,
} from "./payment-recovery-keys";
import { isCreditReleaseAskRecoveryKey } from "./credit-release-ask-keys";
export {
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
};

/**
 * #3032 (epic #2797): the refund debt for a COMPLETED edit-financial-review task,
 * persisted inside the completion's own transaction BEFORE the Stripe call -
 * booking-cancel's #1349 pattern, on the same infrastructure, for the same
 * reason.
 *
 * The completion holds no advisory lock across the refund (the locking guide
 * forbids `lock(1)` across a provider round trip; since #3582 it is released at
 * commit), so its only single-flight guarantee then is the status-guarded
 * claim, committed by the time the refund is sent. Without this row a crash
 * between the commit and the Stripe call would leave a COMPLETED task, an
 * untouched `refundedAmountCents` and no trace at all that money was owed - a
 * worse state than the booking-edit path's, because the Stripe route writes
 * nothing in-transaction. With it, the cron replays the frozen plan under the
 * stored task-scoped prefix and Stripe answers a repeat with the original refund.
 *
 * One row per TASK, never per `BookingModification`: two review tasks can share
 * one modification anchor, and this upsert overwrites `amountCents` and
 * `stripeKeyPrefix` on its update branch.
 */
export async function enqueueEditFinancialReviewRefundRecovery({
  bookingId,
  paymentId,
  taskId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  taskId: string;
  amountCents: number;
  /** Slices frozen inside the completion transaction, before any Stripe call. */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey:
      buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId),
    stripeKeyPrefix: buildEditFinancialReviewRefundStripeKeyPrefix(taskId),
    allocationPlan,
    store,
  });
}

/**
 * Happy-path close of the edit-financial-review refund recovery operation after
 * the inline refund completed. Best-effort, exactly as #1349's is: a lost close
 * leaves the operation open, and its replay re-requests the identical frozen
 * slices under the identical Stripe keys, so Stripe answers with the original
 * refunds and the ledger dedupes on refund id. #4144: only on the plan the door
 * sent (`closePrePersistedRefundRow`), on the key its `closeDoorRow` builds
 * once. Each door keeps a named close, as the seam its suites observe.
 */
export const markEditFinancialReviewRefundRecoverySucceeded = (args: DoorCloseArgs) => closePrePersistedRefundRow(args);

/** #3639: a treasurer-approved late-capture refund's debt, as the edit-review one above; replayed under the webhook's own prefix. */
export async function enqueueLateCaptureApprovalRefundRecovery({
  bookingId,
  paymentId,
  paymentIntentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  allocationPlan: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey:
      buildLateCaptureApprovalRefundRecoveryIdempotencyKey(paymentIntentId),
    stripeKeyPrefix: buildLateCaptureRefundStripeKeyPrefix(
      bookingId,
      paymentIntentId,
    ),
    allocationPlan,
    store,
  });
}

/**
 * Durable recovery for a booking cancellation whose inline Stripe card refund
 * failed (#1160). The cancellation CLAIM (status -> CANCELLED) already stands;
 * the outstanding refund completes through the recovery cron. The processor
 * reuses the inline cancel Stripe key prefix (`booking_cancel_refund_<id>`) so
 * a refund that succeeded on Stripe but was never recorded is replayed by
 * Stripe, not issued a second time. One row per booking (unique key).
 */
export async function enqueueBookingCancellationRefundRecovery({
  bookingId,
  paymentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  amountCents: number;
  /** Slices frozen inside the cancellation claim transaction (#1349). */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId),
    allocationPlan,
    store,
  });
}

/**
 * Mark the booking-cancellation refund recovery operation SUCCEEDED after the
 * inline refund completed (#1349). The operation is persisted inside the
 * claim transaction BEFORE the Stripe call; this is the happy-path close. If
 * this update is lost (crash, DB blip) the operation stays open and the
 * recovery cron replays the frozen plan — Stripe answers the replayed keys
 * with the original refunds and the ledger dedupes on refund id, so the close
 * being best-effort is safe. #4144: only on the plan the door sent.
 */
export const markBookingCancellationRefundRecoverySucceeded = (args: DoorCloseArgs) => closePrePersistedRefundRow(args);

/**
 * Record why the inline cancellation refund failed on the already-persisted
 * recovery operation (#1349), for operator visibility on the health surfaces.
 * Only touches a PENDING row: once the cron has claimed (PROCESSING) or
 * resolved the operation, its own lifecycle owns lastError.
 */
export async function recordBookingCancellationRefundRecoveryInlineError({
  bookingId,
  message,
  store = prisma,
}: {
  bookingId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

/**
 * Durable recovery for the capacity-race auto-refund: member A's
 * payment_intent.succeeded arrived after member B claimed the last beds, so
 * A's booking was cancelled inside the reconciliation transaction and A's full
 * charge must be handed back. Enqueued INSIDE that transaction — atomic with
 * the CANCELLED flip, with the refund allocation frozen from the same locked
 * read, BEFORE any Stripe call (the #1349 enqueue-then-execute pattern) — so a
 * transient inline refund failure, or a process death anywhere after the
 * commit, leaves a PENDING operation the recovery cron replays with backoff
 * and alerts only at exhaustion, instead of a stranded charge whose only
 * remediation was an admin reading a (best-effort) alert email. The processor
 * replays the frozen plan under the stored inline Stripe key prefix
 * (`capacity_claim_failed_<bookingId>_<paymentIntentId>`), so a refund that
 * succeeded on Stripe but was never recorded is replayed, never repeated.
 */
export async function enqueueCapacityClaimFailedRefundRecovery({
  bookingId,
  paymentId,
  paymentIntentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  /** Slices frozen inside the reconciliation claim transaction. */
  allocationPlan?: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
      bookingId,
      paymentIntentId,
    ),
    stripeKeyPrefix: buildCapacityClaimFailedRefundStripeKeyPrefix(
      bookingId,
      paymentIntentId,
    ),
    allocationPlan,
    store,
  });
}

/**
 * Happy-path close of the capacity-race refund recovery operation after the
 * inline refund completed. Best-effort (mirrors #1349): a lost close leaves an
 * open operation whose replay re-requests the identical frozen slices under
 * the identical Stripe keys — Stripe answers with the original refunds and the
 * ledger dedupes on refund id, so no second money movement is possible.
 * #4144: only on the plan the door sent.
 */
export const markCapacityClaimFailedRefundRecoverySucceeded = (args: DoorCloseArgs) => closePrePersistedRefundRow(args);

/**
 * Record why the inline capacity-race refund failed on the already-persisted
 * recovery operation, for operator visibility on the health surfaces. Only
 * touches a PENDING row (mirrors the #1349 recorder): once the cron has
 * claimed or resolved the operation, its own lifecycle owns lastError.
 */
export async function recordCapacityClaimFailedRefundRecoveryInlineError({
  bookingId,
  paymentIntentId,
  message,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildCapacityClaimFailedRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

/**
 * Durable recovery for the duplicate-capture auto-refund (#1992): a SECOND,
 * distinct Stripe capture arrived on an already-PAID booking — the residual
 * #1967 split-child window where an in-flight /pay link PaymentIntent (client
 * secret already in the member's browser) and the settlement cron's saved-card
 * charge both capture. Enqueued INSIDE the reconciliation transaction (under
 * lock(1), with the refund allocation pinned to exactly the duplicate
 * transaction's captured amount, BEFORE any Stripe call — the #1349
 * enqueue-then-execute pattern), so a transient inline refund failure or a
 * process death after the commit leaves a PENDING operation the recovery cron
 * replays with backoff. The processor replays the frozen plan under the stored
 * inline Stripe key prefix (`duplicate_capture_refund_<bookingId>_<pi>`), so a
 * refund that succeeded on Stripe but was never recorded is replayed, never
 * repeated. One operation per (booking, duplicate intent); its key names the
 * capture it refunds and so OWNS it: the guard reads owned intents through
 * `listDuplicateCaptureRefundIntentIds` (`duplicate-capture-ownership.ts`)
 * and never counts one as the settlement (#4211).
 */
export async function enqueueDuplicateCaptureRefundRecovery({
  bookingId,
  paymentId,
  paymentIntentId,
  amountCents,
  allocationPlan,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  paymentId: string;
  amountCents: number;
  /** The single slice pinned to the duplicate capture's own transaction. */
  allocationPlan: RefundAllocationSlice[];
  store?: PaymentRecoveryStore;
}) {
  return enqueueLedgerRefundRecovery({
    bookingId,
    paymentId,
    amountCents,
    idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
      bookingId,
      paymentIntentId,
    ),
    stripeKeyPrefix: buildDuplicateCaptureRefundStripeKeyPrefix(
      bookingId,
      paymentIntentId,
    ),
    allocationPlan,
    store,
  });
}

/**
 * Happy-path close of the duplicate-capture refund recovery operation after
 * the inline refund completed (#1992). Best-effort (mirrors #1349): a lost
 * close leaves an open operation whose replay re-requests the identical
 * frozen slice under the identical Stripe keys — Stripe answers with the
 * original refund and the ledger dedupes on refund id. #4144: only on the plan
 * the door sent.
 */
export const markDuplicateCaptureRefundRecoverySucceeded = (args: DoorCloseArgs) => closePrePersistedRefundRow(args);

/**
 * Record why the inline duplicate-capture refund failed on the
 * already-persisted recovery operation (#1992), for operator visibility on the
 * health surfaces. Only touches a PENDING row (mirrors the #1349 recorder):
 * once the cron has claimed or resolved the operation, its own lifecycle owns
 * lastError.
 */
export async function recordDuplicateCaptureRefundRecoveryInlineError({
  bookingId,
  paymentIntentId,
  message,
  store = prisma,
}: {
  bookingId: string;
  paymentIntentId: string;
  message: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        bookingId,
        paymentIntentId,
      ),
      status: PaymentRecoveryOperationStatus.PENDING,
    },
    data: {
      lastError: message,
    },
  });
}

/**
 * Durable retry for a group organiser-cancel settlement refund (F3, #1351,
 * owner-decided auto-retry). Enqueued BEFORE the inline Stripe refund (the
 * #1349 enqueue-then-execute pattern) with a short delay so the cron only
 * picks it up when the inline run failed or died; the inline happy path marks
 * it SUCCEEDED. The processor replays the settlement's PERSISTED refund plan
 * verbatim under the same `group_cancel_refund_<settlementId>` Stripe key —
 * a >24h retry never recomputes the cancellation tier, and an ambiguous
 * failure (Stripe refunded, response lost) is replayed, not repeated. The
 * recovery machinery supplies backoff and alerts ONLY on exhaustion.
 *
 * `paymentId` is an anchor row for the schema FK (the organiser's own
 * payment): the processor never reads it — the group-settlement branch
 * dispatches on the idempotency-key prefix before any payment lookup.
 */
export async function enqueueGroupSettlementRefundRecovery({
  organiserBookingId,
  paymentId,
  settlementId,
  paymentIntentId,
  amountCents,
  retryDelayMs = 0,
  lastError,
  store = prisma,
}: {
  organiserBookingId: string;
  paymentId: string;
  settlementId: string;
  paymentIntentId: string;
  amountCents: number;
  retryDelayMs?: number;
  lastError?: string;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey =
    buildGroupSettlementRefundRecoveryIdempotencyKey(settlementId);
  const nextRetryAt = new Date(Date.now() + retryDelayMs);

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId: organiserBookingId,
      paymentId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt,
      lastError: lastError ?? null,
    },
    update: {
      amountCents,
      // Re-arming after an inline failure pulls the retry forward; a FAILED
      // row keeps its status/attempts, so an exhausted operation stays
      // exhausted (alert already sent) until the retry itself succeeds.
      nextRetryAt,
      ...(lastError !== undefined ? { lastError } : {}),
    },
  });
}

/**
 * Happy-path close after the inline settlement refund + flip completed
 * (#1351). Best-effort: a lost close leaves a PENDING row whose replay is a
 * no-op (the settlement is no longer SUCCEEDED, so the processor only
 * re-applies any missing per-child mirrors idempotently).
 */
export async function markGroupSettlementRefundRecoverySucceeded({
  settlementId,
  store = prisma,
}: {
  settlementId: string;
  store?: PaymentRecoveryStore;
}) {
  return store.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey:
        buildGroupSettlementRefundRecoveryIdempotencyKey(settlementId),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

async function enqueueSupersededPaymentRefundRecovery({
  bookingId,
  paymentId,
  paymentTransactionId,
  paymentIntentId,
  amountCents,
  store = prisma,
}: {
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  amountCents: number;
  store?: PaymentRecoveryStore;
}) {
  const idempotencyKey = buildSupersededPaymentRefundRecoveryIdempotencyKey(
    paymentTransactionId,
    paymentIntentId
  );

  return store.paymentRecoveryOperation.upsert({
    where: { idempotencyKey },
    create: {
      type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
      idempotencyKey,
      nextRetryAt: new Date(),
    },
    update: {
      bookingId,
      paymentId,
      paymentTransactionId,
      paymentIntentId,
      amountCents,
    },
  });
}

/**
 * Terminal SUCCEEDED close, STATUS-FENCED (#2262 H2). `updateMany` rather than
 * update-by-id, so an operation the manual-mark-paid reversal DELETED mid-flight
 * simply matches nothing instead of throwing P2025 — a closed/deleted operation
 * can never be resurrected by a worker that still holds an in-memory copy. The
 * fence excludes only SUCCEEDED (already terminal): the webhook-side closers
 * (completeCanceledSupersededPaymentIntentRecovery and the succeeded-intent
 * handoff) legitimately close PENDING/FAILED rows whose work verifiably
 * finished, so fencing to PROCESSING-only would break them.
 *
 * IT RETURNS WHETHER THIS CALL IS THE ONE THAT CLOSED IT (#3340 fix round).
 * Because the fence lets exactly one concurrent or repeated attempt match, that
 * verdict is a claim a caller can hang a once-only epilogue off - rather than
 * off a re-derived condition that a partially-applied replay can make true
 * twice. #4125: `store` closes it inside a caller's transaction; `lossExpected`
 * logs a lost close at debug, for a replay whose inline door can close the same
 * row first - the duplicate capture, the treasurer-approved late capture and
 * the capacity race - where losing is an expected outcome, not an anomaly.
 */
async function completePaymentRecoveryOperation(
  operationId: string,
  { store = prisma, lossExpected = false }: { store?: PaymentRecoveryStore; lossExpected?: boolean } = {},
): Promise<boolean> {
  const closed = await store.paymentRecoveryOperation.updateMany({
    where: {
      id: operationId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
  if (closed.count === 0) {
    logger[lossExpected ? "debug" : "warn"](
      { operationId },
      "Payment recovery completion matched no live operation (already succeeded, or deleted by a manual mark-paid reversal); nothing was resurrected"
    );
  }
  return closed.count === 1;
}

async function alertPaymentRecoveryFailure(operation: PaymentRecoveryOperation, message: string, format: ClubFormat) {
  await alertPaymentRecoveryOfficers({
    bookingId: operation.bookingId,
    operationId: operation.id,
    amountCents: await cardRefundStillOwedCents(operation), // #4117: read after the final attempt
    errorMessage: `Stripe payment recovery ${operation.type} failed after ${operation.attempts} attempt${operation.attempts === 1 ? "" : "s"}: ${message}`,
    paymentIntentId: operation.paymentIntentId,
  }, format);
}

/**
 * THE ONE PLACE A `PaymentRecoveryOperation` BECOMES `FAILED` (#3220,
 * `INV-PAY-056`, `INV-SSOT`).
 *
 * Before this function there were three of them - the worker's own catch, and
 * the stale-`PROCESSING` reaper's two arms - each spelling out its own status
 * write, its own `nextRetryAt` policy and its own idea of whether the row was
 * finished. The pre-decision review on #3220 counted the module's references to
 * `PaymentRecoveryOperationStatus.FAILED` and found six, which is why the issue
 * says six; three of those are `where` filters that READ the status and cannot
 * be a transition (they are named constants now, immediately below). What
 * mattered is the same either way: "this recovery is dead" was expressed in more
 * than one place, so anything that has to happen when a recovery dies had to be
 * bolted onto each of them and would silently miss the ones nobody remembered.
 *
 * TERMINAL IS AN ARGUMENT, NOT A DERIVATION. The worker knows it has burnt an
 * attempt, or met a failure no retry fixes (#4081); the reaper knows the row
 * never came back; a re-derivation from `attempts` would be a fourth opinion.
 * When terminal, `nextRetryAt` is forced `null` (a row keeping a retry time is
 * re-claimable, so not terminal) and `attempts` to the ceiling every dead-row
 * reader tests (`INV-PAY-092`).
 *
 * STATUS-FENCED, like `completePaymentRecoveryOperation` and for the same
 * reason. The worker's arm used `update` by id, which throws `P2025` when a
 * manual mark-paid reversal has DELETED the row mid-flight - and it is called
 * from inside the loop's `catch`, so that throw escaped the loop and abandoned
 * every remaining operation in the batch. `updateMany` matches nothing instead,
 * and the fence also stops a `SUCCEEDED` row being dragged back to `FAILED` by a
 * worker holding a stale in-memory copy.
 */
type PaymentRecoveryFailureOutcome = "failed" | "retry" | "gone";

async function markPaymentRecoveryOperationFailed({
  operation,
  message,
  terminal,
  nextRetryAt,
  fromStatuses,
  fromProcessingStartedAt,
  fromAttempts,
  format,
  handBackAttempt = false,
}: {
  operation: PaymentRecoveryOperation;
  /** Recorded verbatim on `lastError`, and quoted in the exhaustion alert. */
  message: string;
  /** Whether this failure ENDS the operation: nothing will replay it again. */
  terminal: boolean;
  /** When the next attempt is due. Ignored - and forced `null` - when terminal. */
  nextRetryAt: Date;
  /** The statuses this transition may move FROM. Anything else is left alone. */
  fromStatuses: readonly PaymentRecoveryOperationStatus[];
  /**
   * When supplied, the transition ALSO requires `processingStartedAt` to be
   * unchanged - "still the exact attempt I read".
   *
   * #3220 fix round. The stale-worker reaper reads its rows and writes them one
   * by one, and status alone does not fence that gap. A row it read as stale can
   * legitimately be marked failed by a CONCURRENT reaper, re-armed with
   * `nextRetryAt` of now, and re-claimed straight back into `PROCESSING` before
   * this loop reaches it - whereupon a `status: PROCESSING` fence matches, and
   * the reaper kills a LIVE attempt that a worker is in the middle of, on the
   * strength of a timestamp that is no longer there. The bulk `updateMany` this
   * replaced could not do that: its own `where` carried
   * `processingStartedAt < staleBefore`, so a freshly re-claimed row fell out of
   * it. Pinning the exact value restores that and is stricter than restating the
   * threshold, because it also fences `attempts`: the claim increments it as it
   * rewrites `processingStartedAt`, and a terminal failure raises it to the
   * ceiling in the write that sets FAILED and clears `processingStartedAt`.
   */
  fromProcessingStartedAt?: Date | null;
  /**
   * #4083: when supplied, the transition ALSO requires this attempt's count and
   * a live claim (`processingStartedAt` set), so a worker the reaper gave up on
   * cannot write FAILED over the row once it is reaped (`processingStartedAt`
   * null) or claimed again (`attempts` moved on). Not the claim time itself: an
   * attempt may re-stamp that on its own row (`holdAdditionalIntentRecoveryClaim`,
   * the superseded hand-off), and its own failure must still land.
   */
  fromAttempts?: number;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
  /**
   * #4253 release 2: hand back the attempt this worker's claim took, for a row that is WAITING on
   * something that clears on its own rather than failing (`waitPaymentRecoveryOperation`). Only
   * with `terminal: false`, which it can never make terminal.
   */
  handBackAttempt?: boolean;
}): Promise<PaymentRecoveryFailureOutcome> {
  // Both fences apply when both are given: each is its own clause, so neither
  // can overwrite the other's `processingStartedAt`.
  const claimFence = fromProcessingStartedAt === undefined ? undefined : { processingStartedAt: fromProcessingStartedAt };
  const attemptFence = fromAttempts === undefined ? undefined : { attempts: fromAttempts, processingStartedAt: { not: null } };
  const marked = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: { in: [...fromStatuses] },
      ...(claimFence && attemptFence ? { AND: [claimFence, attemptFence] } : { ...claimFence, ...attemptFence }),
    },
    data: {
      status: PaymentRecoveryOperationStatus.FAILED,
      lastError: message,
      processingStartedAt: null,
      ...(terminal
        ? { nextRetryAt: null, attempts: Math.max(operation.attempts, MAX_PAYMENT_RECOVERY_ATTEMPTS) }
        : { nextRetryAt, ...(handBackAttempt ? { attempts: Math.max(operation.attempts - 1, 0) } : {}) }),
    },
  });

  if (marked.count === 0) {
    logger.warn(
      { operationId: operation.id, terminal },
      "Payment recovery failure matched no live operation (already succeeded, or deleted by a manual mark-paid reversal); nothing was marked failed"
    );
    return "gone";
  }

  if (!terminal) {
    return "retry";
  }

  await alertPaymentRecoveryFailure(operation, message, format).catch((alertError) =>
    logger.error(
      { err: alertError, operationId: operation.id },
      "Failed to send payment recovery failure alert"
    )
  );

  // AFTER the status write, and unable to prevent it. See this function's own
  // docblock and `cancelStrandedAdditionalIntentForDeadRecovery`.
  await cancelStrandedAdditionalIntentForDeadRecovery(operation);

  return "failed";
}

/**
 * THE ASK DIES WITH THE RECOVERY THAT OWED IT (#3220, `INV-PAY-057`).
 *
 * A `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery exists because a booking edit
 * raised money the member has not been asked for yet. While it is PENDING or
 * PROCESSING the booking-vs-Xero repair tool DEFERS - it must not raise the
 * edit's supplementary invoice, because the replay is going to raise the ask and
 * the invoice belongs to that ask. Once the row leaves those two statuses that
 * deferral stops (`OPEN_PAYMENT_RECOVERY_STATUSES`, the #3202 control), and the
 * repair tool raises the invoice UNPAID.
 *
 * NOTE THE ASYMMETRY, because it decides what this function can and cannot fix.
 * The repair tool stops deferring at the FIRST failure; this withdrawal fires
 * only at the LAST one. Between them a retrying row can meet an unpaid invoice
 * while its ask is still live - the same two-instrument shape, but transient and
 * self-healing, because the retry either raises ask and invoice together or runs
 * out and lands here. Cancelling on a non-terminal failure would be wrong: the
 * replay still intends to collect against that very ask.
 *
 * So if an ask DOES exist at that moment, the club now has two live instruments
 * for one debt: an unpaid Xero invoice, and a Stripe PaymentIntent the member
 * can still pay. Pay the intent and the two records describe the same money
 * differently, and an officer has to work out which is right - #3187 accepted
 * that as visible-but-unfixed, and #3220 is the decision to fix it.
 *
 * HOW AN ASK CAN EXIST ON A PATH THAT FAILED TO MAKE ONE. The replay's later
 * steps can fail after the mint succeeded - the intent is written to the ledger
 * by the minter, and raising the deferred supplementary invoice afterwards can
 * throw. The next attempt then finds the existing ask and returns `raised`, so
 * the intent survives every remaining attempt and is still standing when the
 * last one is spent.
 *
 * THIS REMOVES THE DUPLICATE INSTRUMENT. IT DOES NOT WRITE OFF THE DEBT. The
 * unpaid invoice still stands and is collected the ordinary way; what goes away
 * is the second way to pay it.
 *
 * AND IT ONLY REMOVES A DUPLICATE WHEN THERE IS ONE (#3220 fix round). The same
 * replay path that leaves an ask standing can also have ATTACHED this change's
 * supplementary invoice operation to it, parked `WAITING_PAYMENT`. That row
 * blocks the repair pass from raising the invoice at all, so nothing is
 * duplicated - and cancelling the intent underneath it would take away the only
 * live route to the money and strand the row until the fourteen-day reaper. So
 * the withdrawal steps around that one case, in the branch below.
 *
 * IDEMPOTENT BY CONSTRUCTION, NOT BY CARE. `cancelPaymentIntentIfCancellable-
 * WithResult` reads the intent first and returns `canceled: false` WITHOUT
 * calling Stripe unless the status is one it can cancel. A replay therefore sees
 * `canceled` (not a cancellable status) and makes no provider call at all, and
 * an intent the member paid in the meantime sees `succeeded` and is left
 * strictly alone - which is also why a paid ask can never be cancelled by this.
 *
 * A REFUSAL LEAVES THE RECOVERY EXACTLY AS NOT TRYING WOULD. Everything here is
 * best-effort and after the fact:
 *
 *   * it runs AFTER the status write, so a Stripe outage cannot stop a recovery
 *     being marked dead - which would re-block the repair tool for ever and
 *     break the #3202 control this issue is required to keep;
 *   * it NEVER throws. `failPaymentRecoveryOperation` is called from inside the
 *     worker loop's own `catch`, and a throw there abandons every remaining
 *     operation in the batch - the exact bug the chokepoint fixed. A rejection
 *     is logged and recorded, never propagated;
 *   * `processing` is in Stripe's cancellable set and Stripe routinely REFUSES
 *     to cancel a processing intent, so the refusal branch is a live path rather
 *     than a theoretical one. It leaves today's state - a live intent against an
 *     invoice raised unpaid - which is what #3187 already makes visible.
 *
 * A refusal is written to the audit log rather than only logged, because a
 * `logger.error` is not a record an officer can find, and this one asks them to
 * do something: check the ask by hand before the member pays it.
 */
async function cancelStrandedAdditionalIntentForDeadRecovery(
  operation: PaymentRecoveryOperation
) {
  if (
    operation.type !==
    PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT
  ) {
    return;
  }

  /**
   * Scoped to the completed-financial-review shape, which is the one the repair
   * tool's deferral covers (`xero-booking-repair-load.ts` queries exactly these
   * rows) and therefore the only shape that can reach the two-instrument state
   * this function exists to prevent. Fail-closed on an unrecognised key, like
   * every other reader of it.
   */
  const bookingModificationId =
    bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey
    );
  if (
    !bookingModificationId ||
    !isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)
  ) {
    return;
  }

  try {
    // Dynamic import for the reason every other cross-import in this module is
    // dynamic: `edit-financial-review-charge` imports this module.
    const { findEditReviewChargeRequest } = await import(
      "@/lib/edit-financial-review-charge-request"
    );
    const request = await findEditReviewChargeRequest({
      paymentId: operation.paymentId,
      bookingModificationId,
    });

    // THE ORDINARY ENDING. The mint never produced anything, which is why the
    // recovery existed at all, so there is no second instrument and nothing to
    // do. No provider call is made on this path.
    if (!request?.stripePaymentIntentId) {
      return;
    }

    /**
     * A captured ask is money the member has already paid. The Stripe helper
     * would leave it alone anyway (`succeeded` is not a cancellable status), so
     * this is a second lock on the same door rather than the only one - but it
     * also saves a provider round trip on the one case where getting it wrong
     * would take money back off a member who paid.
     */
    if (isCapturedTransactionStatus(request.status)) {
      logger.info(
        {
          operationId: operation.id,
          bookingModificationId,
          paymentIntentId: request.stripePaymentIntentId,
        },
        "Dead additional-payment recovery left its ask alone: the member has already paid it"
      );
      return;
    }

    /**
     * THE ONE ASK THIS WITHDRAWAL LEAVES ALONE (#3220 fix round).
     *
     * A supplementary invoice parked `WAITING_PAYMENT` on this very intent is
     * released by a CONFIRMED payment on it and by nothing else. While it sits
     * there the repair pass reports the change as `BLOCKED_BY_XERO_OPERATION`
     * and does NOT raise the invoice - so the premise of this whole function is
     * absent: there is no unpaid invoice, and therefore no second instrument to
     * remove. Cancelling anyway would destroy the only live route to collecting
     * the debt AND strand the outbox row, leaving the change with no invoice at
     * all until the fourteen-day reaper retires it, while the operator's signal
     * says the club is waiting for a payment that can never arrive. That is
     * verbatim the harm the already-paid branch of the review-charge replay
     * refuses to create, and this is the same rule read from the other end.
     *
     * The window is real rather than theoretical: the replay attaches the
     * waiting operation to the intent it just minted and can then throw while
     * raising the deferred invoice, so every remaining attempt finds the ask
     * standing and the last one arrives here.
     */
    const blockingWaitingOperation =
      await findWaitingSupplementaryInvoiceOperationForPaymentIntent({
        bookingModificationId,
        paymentIntentId: request.stripePaymentIntentId,
      });
    if (blockingWaitingOperation) {
      logger.info(
        {
          operationId: operation.id,
          bookingId: operation.bookingId,
          bookingModificationId,
          paymentIntentId: request.stripePaymentIntentId,
          xeroOperationId: blockingWaitingOperation.id,
        },
        "Dead additional-payment recovery left its ask alone: this booking change's supplementary invoice is still waiting on that very payment, so no invoice has been raised against it"
      );
      return;
    }

    const result = await cancelPaymentIntentIfCancellableWithResult(
      request.stripePaymentIntentId,
      // NOT `requested_by_customer`. The member never declined this; the club
      // ran out of attempts to raise it.
      { cancellationReason: "abandoned" }
    );

    logger.info(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        bookingModificationId,
        paymentIntentId: request.stripePaymentIntentId,
        canceled: result.canceled,
        intentStatus: result.paymentIntent.status,
      },
      result.canceled
        ? "Cancelled the stranded additional PaymentIntent of a dead payment recovery"
        : "Dead additional-payment recovery left its ask alone: it is no longer in a cancellable state"
    );
  } catch (err) {
    logger.error(
      { err, operationId: operation.id, bookingModificationId },
      "Failed to cancel the stranded additional PaymentIntent of a dead payment recovery"
    );
    await recordRefusedStrandedIntentCancellation({
      operation,
      bookingModificationId,
      err,
    }).catch((auditError) =>
      logger.error(
        { err: auditError, operationId: operation.id },
        "Failed to record the audit trace for a refused stranded-intent cancellation"
      )
    );
  }
}

/**
 * The durable, officer-findable record that a dead recovery's ask could NOT be
 * withdrawn (#3220). Written on the refusal path only - a successful cancel
 * needs no officer.
 *
 * `payment` category: this is a fact about a money instrument on a booking, and
 * it asks an officer to act before the member pays something the club has
 * already invoiced.
 */
async function recordRefusedStrandedIntentCancellation({
  operation,
  bookingModificationId,
  err,
}: {
  operation: PaymentRecoveryOperation;
  bookingModificationId: string;
  err: unknown;
}) {
  await createAuditLog({
    action: "payment.recovery.strandedIntentCancellationRefused",
    targetId: operation.bookingId,
    entityType: "Booking",
    entityId: operation.bookingId,
    category: "payment",
    // `important`, not `critical`: nothing is lost or mis-stated yet, and the
    // remedy is a reconciliation an officer does by hand. It matches the
    // severity `recordUncollectedEditReviewChargeShare` writes for the sibling
    // "a settled share met an ask it could not join" record. `critical` is also
    // the tier `audit-retention.ts` keeps for ever, which this does not need.
    severity: "important",
    outcome: "failure",
    summary:
      "A card request for a booking change could not be withdrawn after its retries ran out",
    details:
      "A booking change raised money the member owed, and the card request for it could not be set up at the time, so the system kept retrying in the background. Those retries have now run out. Because they have, the invoice for this change will be raised in Xero as unpaid and collected the ordinary way - but the card request that was already sitting against this change could NOT be withdrawn from the card provider, so the member may still be able to pay it. If they do, the club will hold a payment and an unpaid invoice for the same money. Check this booking change against Xero and against the card provider, and withdraw the card request by hand if it is still live. Nothing has been written off: the money is still owed and the invoice still stands.",
    metadata: {
      operationId: operation.id,
      bookingModificationId,
      idempotencyKey: operation.idempotencyKey,
      reason: errorMessage(err),
    },
  });
}

async function failPaymentRecoveryOperation(
  operation: PaymentRecoveryOperation,
  error: unknown,
  format: ClubFormat,
) {
  const cause = error instanceof UnattributedCardRefundBeforeResendError
    ? error.message
    : await unretryableRecoveryCause(operation, error);
  const terminal = cause !== null || operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;
  const outcome = await markPaymentRecoveryOperationFailed({
    operation,
    format,
    message: cause ?? errorMessage(error),
    terminal,
    nextRetryAt: nextRetryDate(operation.attempts),
    // Everything but SUCCEEDED, matching `completePaymentRecoveryOperation`'s
    // fence: the row was PROCESSING when this worker claimed it, but the
    // webhook-side closers can move it underneath us and a finished operation
    // must never be reopened as a failure.
    fromStatuses: NON_TERMINAL_PAYMENT_RECOVERY_STATUSES,
    // #4083: only the attempt this worker holds.
    fromAttempts: operation.attempts,
  });

  if (outcome === "failed" && error instanceof UnattributedCardRefundBeforeResendError) {
    // The hold has committed and the officer alert has gone. A failed audit
    // write must not abandon the rest of the recovery batch.
    await createAuditLog({
      category: "payment",
      action: "booking-payment.card-refund.resend-held",
      targetId: operation.bookingId,
      entityType: "PaymentRecoveryOperation",
      entityId: operation.id,
      severity: "important",
      outcome: "failure",
      summary: error.message,
      metadata: { stripeRefundIds: error.stripeRefundIds, paymentId: operation.paymentId },
    }).catch((auditError: unknown) => {
      logger.error({ err: auditError, operationId: operation.id }, "Failed to write the card refund re-send hold audit");
    });
  }

  /**
   * A row that matched nothing was deleted by a manual mark-paid reversal or
   * had already finished, so there is no state left for this attempt to change.
   * It is still tallied as the outcome this attempt WOULD have had, and that is
   * a deliberate choice rather than parity with the old code: the worker's
   * `update` by id used to THROW `P2025` on the deleted row, from inside the
   * loop's own `catch`, abandoning every remaining operation in the batch - and
   * on the stale-copy path it counted a failure only after wrongly dragging a
   * `SUCCEEDED` row back to `FAILED`. So a row that turns out to have succeeded
   * now lands in `result.failed`. That number is a count of what this pass
   * attempted, not a claim about the row, and nothing downstream branches on
   * it; a fourth outcome for the caller to sum would buy a more precise figure
   * that no reader has asked for.
   */
  return outcome === "gone" ? (terminal ? "failed" : "retry") : outcome;
}

/**
 * #4253 release 2 (`INV-ADDPAY-045`): a row that must WAIT, not fail - a released-credit request
 * blocked by an unpaid edit request. Back to a non-terminal retry at the longest interval with its
 * claim's attempt handed back, so it never runs out of attempts, goes terminal or alerts. Through
 * the one chokepoint, fenced on this worker's own attempt.
 */
async function waitPaymentRecoveryOperation(operation: PaymentRecoveryOperation, message: string, format: ClubFormat) {
  return markPaymentRecoveryOperationFailed({
    operation,
    format,
    message,
    terminal: false,
    // The schedule's last (longest) step: the attempt index clamps to it.
    nextRetryAt: nextRetryDate(MAX_PAYMENT_RECOVERY_ATTEMPTS),
    fromStatuses: NON_TERMINAL_PAYMENT_RECOVERY_STATUSES,
    fromAttempts: operation.attempts,
    handBackAttempt: true,
  });
}

async function claimPaymentRecoveryOperation(operationId: string) {
  const now = new Date();
  const claim = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operationId,
      status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
      attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      nextRetryAt: { lte: now },
    },
    data: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      attempts: { increment: 1 },
      processingStartedAt: now,
      lastError: null,
    },
  });

  if (claim.count !== 1) {
    return null;
  }

  return prisma.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
  });
}

/**
 * A worker that died mid-attempt leaves its row `PROCESSING` for ever, because
 * nothing else moves it and no exception fires from this process. This reaper
 * hands those rows back.
 *
 * ONE READ, TWO ENDINGS (#3220). It used to be a bulk `updateMany` for the rows
 * with attempts left plus a separate `findMany`/loop for the exhausted ones, and
 * the two spelled the same transition differently: only the second was fenced,
 * only the second alerted, and each carried its own copy of the status write.
 * Both endings now go through `markPaymentRecoveryOperationFailed`, which is
 * what decides what "dead" costs.
 *
 * THE READ AND THE WRITE ARE FENCED TOGETHER (#3220 fix round). Splitting the
 * old bulk `updateMany` into read-then-write opened a gap the bulk form did not
 * have: its `where` carried `processingStartedAt < staleBefore`, so a row that
 * had been re-claimed since could not match, while a fence of `status:
 * PROCESSING` alone matches a row that left `PROCESSING` and came straight back.
 * That path is real - a concurrent reaper marks the row failed with a
 * `nextRetryAt` of NOW, and the very next queue read claims it - and taking it
 * would kill a live attempt and leave the terminality this loop read one attempt
 * out of date. `fromProcessingStartedAt` pins the exact attempt, which fences
 * `attempts` too: the claim increments it as it replaces `processingStartedAt`,
 * and a terminal failure raises it to the ceiling as it sets FAILED and clears it.
 */
async function resetStaleProcessingOperations(format: ClubFormat) {
  const staleBefore = new Date(
    Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000
  );

  const stale = await prisma.paymentRecoveryOperation.findMany({
    where: {
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    // OLDEST FIRST, AND BOUNDED (#3220 fix round). This sweep runs BEFORE the
    // main queue and each row it takes now costs an alert and, on a dead
    // additional-payment recovery, a Stripe read and possibly a cancel - where
    // the bulk `updateMany` it replaced made no provider call at all. A backlog
    // is self-draining, because every row it touches leaves `PROCESSING` for
    // good, so an unbounded read could only ever stall ONE run - but that run is
    // every queued recovery waiting behind a provider that has gone slow, and
    // there is no reason to accept that when the leftovers are handled by the
    // next sweep a minute later. Oldest first so the cap cannot starve a row.
    orderBy: { processingStartedAt: "asc" },
    take: STALE_PROCESSING_SWEEP_LIMIT,
  });

  for (const operation of stale) {
    const terminal = operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;

    await markPaymentRecoveryOperationFailed({
      operation,
      format,
      message: terminal
        ? "Payment recovery worker timed out on the final attempt before completion."
        : "Payment recovery worker timed out before completion.",
      terminal,
      nextRetryAt: new Date(),
      fromStatuses: STALE_PROCESSING_RECOVERY_STATUSES,
      // The exact attempt this loop read. See the parameter's docblock: without
      // it, a row re-claimed between the read and this write is killed mid-flight
      // by a fence that only looks at status.
      fromProcessingStartedAt: operation.processingStartedAt,
      // #4083: and the attempt it read, in the same fence.
      fromAttempts: operation.attempts,
    });
  }
}

async function markSupersededTransactionFailed(
  operation: PaymentRecoveryOperation
) {
  if (!operation.paymentTransactionId) {
    return;
  }

  const updated = await prisma.paymentTransaction.updateMany({
    where: {
      id: operation.paymentTransactionId,
      status: { in: [...OPEN_INTENT_TRANSACTION_STATUS_LIST] },
    },
    data: {
      status: PaymentStatus.FAILED,
      reason: "zero_dollar_batch_modification_superseded",
    },
  });

  if (updated.count > 0) {
    await reconcilePaymentAggregates({ paymentId: operation.paymentId });
  }
  // #3403 (`INV-PAY-140`): its change's waiting invoice follows the request carrying its balance, before the row completes.
  await followSupersededAskInvoicesSafely({ paymentId: operation.paymentId });
}

async function markSupersededTransactionSucceeded({
  operation,
  amountCents,
  paymentMethodId,
  store = prisma,
}: {
  operation: PaymentRecoveryOperation;
  amountCents: number;
  paymentMethodId?: string | null;
  store?: Prisma.TransactionClient | typeof prisma; // #4320: the hand-off's, holding the Payment row
}) {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  await store.paymentTransaction.update({
    where: { id: operation.paymentTransactionId },
    data: {
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      ...(paymentMethodId !== undefined
        ? { paymentMethodId: paymentMethodId ?? null }
        : {}),
      reason: "zero_dollar_batch_modification_late_capture",
    },
  });

  await reconcilePaymentAggregates({ paymentId: operation.paymentId, store });
}

async function handoffSucceededSupersededIntentToRefund({
  operation,
  amountCents,
  paymentMethodId,
  takenFromOutside = false,
}: {
  operation: PaymentRecoveryOperation;
  amountCents: number;
  paymentMethodId?: string | null;
  /**
   * #4083: the webhook takes the row from outside any worker's attempt, so
   * its claim counts as an attempt of its own - a worker that held the row
   * then cannot write FAILED over it (`failPaymentRecoveryOperation` is fenced
   * on the attempt). The worker's own hand-off stays inside its attempt.
   */
  takenFromOutside?: boolean;
}): Promise<boolean> {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  // #2262 H2 — RE-CLAIM the operation immediately before the money-adjacent
  // writes: a manual mark-paid reversal can DELETE the row after the worker
  // read it (its disarm, `reverseManualBookingPayment`), and a stale copy must
  // not flip the transaction SUCCEEDED and queue a refund the disarm never saw.
  // A status-fenced WRITE: a deleted row matches nothing, a SUCCEEDED one is
  // terminal, and PENDING/FAILED are included for the webhook-side hand-off.
  // #4320 (`INV-LOCK-002`): claim, flip and rebuild commit together under the
  // Payment row (then the recovery row, then the transaction row), which the
  // reversal holds from its "no settled Stripe transaction" check to its
  // commit. A hand-off first makes it refuse; a reversal first leaves nothing
  // to claim. Apart, a flip after that check charged and refunded the member
  // on a booking left unpaid. No provider call runs inside.
  const claimed = await prisma.$transaction(async (tx) => {
    await lockPaymentForRefundedTotal(tx, operation.paymentId);
    const claim = await tx.paymentRecoveryOperation.updateMany({
      where: { id: operation.id, status: { in: [...NON_TERMINAL_PAYMENT_RECOVERY_STATUSES] } },
      data: {
        status: PaymentRecoveryOperationStatus.PROCESSING,
        processingStartedAt: new Date(),
        ...(takenFromOutside ? { attempts: { increment: 1 } } : {}),
      },
    });
    if (claim.count === 1) await markSupersededTransactionSucceeded({ operation, amountCents, paymentMethodId, store: tx });
    return claim;
  });
  if (claimed.count === 0) {
    logger.error(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        paymentIntentId: operation.paymentIntentId,
      },
      "Superseded-intent refund handoff ABANDONED: the operation is gone or already terminal (deleted by a manual mark-paid reversal, or completed elsewhere). No transaction flip, no refund enqueued."
    );
    return false;
  }
  // #3403 review 2 (F1, `INV-PAY-140`): captured late, it is refunded and the request after it carries its balance.
  await followSupersededAskInvoicesSafely({ paymentId: operation.paymentId });

  // #3639: on a CANCELLED booking this capture is a late capture, so it follows
  // the club's setting like every other - held for a treasurer, no refund.
  if (
    await holdSupersededLateCaptureIfRequired({
      ...operation,
      paymentTransactionId: operation.paymentTransactionId,
      amountCents,
    })
  ) {
    await completePaymentRecoveryOperation(operation.id);
    return true;
  }

  await enqueueSupersededPaymentRefundRecovery({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentTransactionId: operation.paymentTransactionId,
    paymentIntentId: operation.paymentIntentId,
    amountCents,
  });

  await completePaymentRecoveryOperation(operation.id);
  return true;
}

async function processCancelPaymentIntentOperation(
  operation: PaymentRecoveryOperation
) {
  const result = await cancelPaymentIntentIfCancellableWithResult(
    operation.paymentIntentId
  );

  // Stripe can transition a PaymentIntent from a cancellable status to
  // "succeeded" between our retrieve and our cancel call, and the cancel
  // API can race with a parallel capture. Check the actual status before
  // treating this as a cancellation, otherwise we would mark a captured
  // payment FAILED and skip the refund handoff.
  if (result.paymentIntent.status === "succeeded") {
    await handoffSucceededSupersededIntentToRefund({
      operation,
      amountCents: result.paymentIntent.amount,
      paymentMethodId:
        typeof result.paymentIntent.payment_method === "string"
          ? result.paymentIntent.payment_method
          : result.paymentIntent.payment_method?.id ?? null,
    });
    return;
  }

  if (isPaymentIntentCancelConfirmed(result)) {
    await markSupersededTransactionFailed(operation);
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  throw new Error(
    `PaymentIntent ${operation.paymentIntentId} could not be canceled from status ${result.paymentIntent.status}`
  );
}

async function processRefundSupersededPaymentOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
) {
  if (!operation.paymentTransactionId) {
    throw new Error("Payment recovery operation is missing paymentTransactionId");
  }

  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id: operation.paymentTransactionId },
  });

  if (!transaction) {
    throw new Error("Payment transaction not found for refund recovery");
  }

  if (!isCapturedTransactionStatus(transaction.status)) {
    await markSupersededTransactionSucceeded({
      operation,
      amountCents: Math.max(transaction.amountCents, operation.amountCents),
    });
  }

  const refreshedTransaction = await prisma.paymentTransaction.findUnique({
    where: { id: operation.paymentTransactionId },
  });

  if (!refreshedTransaction) {
    throw new Error("Payment transaction not found for refund recovery");
  }

  const persistedPlan = parseRefundAllocationPlan(operation.allocationPlan);
  const preflightPlan = await checkCardRefundResend({
    operation,
    stripeKeyPrefix: operation.idempotencyKey,
    plan: persistedPlan ?? [{ paymentTransactionId: refreshedTransaction.id, amountCents: operation.amountCents }],
    transactions: [refreshedTransaction],
  });

  const outstandingCents = Math.max(
    Math.min(
      operation.amountCents,
      refreshedTransaction.amountCents - refreshedTransaction.refundedAmountCents
    ),
    0
  );

  if (outstandingCents <= 0) {
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  const metadata = cardRefundOperationRefundMetadata(operation);
  // #4103 (`INV-PAY-130`): a refusal is never closed or reported. The first ask
  // keeps the row's own key, so a refund made but unrecorded is replayed; a
  // refusal moves to a one-slice plan on a fresh key, which later attempts send.
  const plan = persistedPlan ? preflightPlan : [{ paymentTransactionId: refreshedTransaction.id, amountCents: outstandingCents }];
  await refundPlanOrRetryRefusals({
    operation,
    plan,
    format,
    refund: async (allocation) => {
      if (persistedPlan) {
        return refundPaymentTransactions({
          format,
          paymentId: operation.paymentId,
          amountCents: allocation.reduce((sum, slice) => sum + slice.amountCents, 0),
          allocation,
          metadata,
          idempotencyKeyPrefix: operation.idempotencyKey,
        });
      }
      const refund = await processRefund({
        paymentIntentId: operation.paymentIntentId,
        amountCents: outstandingCents,
        reason: "requested_by_customer",
        metadata,
        idempotencyKey: operation.idempotencyKey,
      });

      // Idempotent by the ledger (#3640, the one writer every card refund uses):
      // a retry that Stripe answers with the same refund records nothing new and
      // adds nothing. The ledger row, the transaction row and the payment aggregate
      // commit together. A row an older attempt left behind still lifts a mirror
      // with no credit on it to the card refunds on record (the ledger floor); with
      // a credit it cannot, and the refunded-total audit lists it.
      const recorded = await recordStripeRefundsAgainstTransaction({
        paymentId: operation.paymentId,
        paymentTransactionId: refreshedTransaction.id,
        refunds: [refund],
        fallbackPaymentIntentId: operation.paymentIntentId,
      });
      // #4104 review (ML2): a replayed key reads Stripe's original answer; the
      // ledger knows the refund failed since, and this row moves it itself.
      const status = recorded.readAsRefused.includes(refund.id) ? "failed" : (refund.status ?? null);
      return {
        refunds: [{ status, slice: plan[0]!, refundId: refund.id, paymentIntentId: operation.paymentIntentId }],
      };
    },
  });

  /**
   * #3340: the club's own record of the refund, and the member's explanation.
   *
   * AFTER the reconcile, so the "still owing" figure it quotes is the
   * post-refund one. It never throws - see its own docblock - so it cannot cost
   * the operation its terminal transition.
   *
   * FENCED ON THE COMPLETION CLAIM (#3340 fix round), which is why it now runs
   * after it rather than before. The `outstandingCents <= 0` short-circuit above
   * is NOT an idempotence gate: it only becomes true once the transaction row's
   * `refundedAmountCents` has been written, and a failure between the Stripe
   * refund and that write re-enters with the refund already made. Stripe answers
   * the replay with the same refund and the ledger dedupes on the refund id, so
   * the MONEY is safe - but the epilogue would run a second time, sending the
   * member a second "we have refunded you" email and the admins a second alert,
   * on a change whose entire point is not confusing members about card movement.
   * `completePaymentRecoveryOperation`'s `updateMany` is fenced on
   * `status != SUCCEEDED`, so exactly one attempt can win it, and that attempt
   * is the one that speaks.
   */
  const closed = await completePaymentRecoveryOperation(operation.id);
  if (!closed) {
    logger.warn(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        paymentIntentId: operation.paymentIntentId,
      },
      "Superseded-payment refund replayed against an operation that was already closed; the refund is idempotent and the notices were sent by the attempt that closed it",
    );
    return;
  }

  await reportSupersededPaymentRefund({
    format,
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId: operation.paymentIntentId,
    refundedAmountCents: plan.reduce((sum, slice) => sum + slice.amountCents, 0),
  });
}

async function processBookingModificationRefundOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
) {
  // #3653: an organiser child's refund out of the group's combined card payment.
  // Before anything reads the child's transactions, of which it has none; the
  // executor closes the row in the transaction that records the refund.
  if (isOrganiserChildRefundKey(operation.idempotencyKey)) {
    const { processOrganiserChildRefundOperation } = await import("@/lib/organiser-child-refund-executor");
    await processOrganiserChildRefundOperation(operation, format);
    return;
  }
  // Group settlement refund replay (F3, #1351): dispatch on the key prefix
  // BEFORE any payment lookup — these operations anchor paymentId to the
  // organiser's own payment purely for the schema FK, and deriving a refund
  // from that payment's transactions would refund the wrong money. The
  // executor replays the settlement's persisted plan under the inline
  // `group_cancel_refund_<settlementId>` Stripe key and applies the
  // per-child refundedAmountCents mirrors idempotently.
  if (isGroupSettlementRefundRecoveryKey(operation.idempotencyKey)) {
    const settlementId = groupSettlementIdForRefundRecoveryKey(operation.idempotencyKey);
    // Dynamic import: group-cancel imports this module for the enqueue/mark
    // helpers (same pattern as booking-payment-cleanup above).
    const { executeGroupSettlementRefundPlan } = await import(
      "@/lib/group-cancel"
    );
    await executeGroupSettlementRefundPlan(settlementId, format);
    await completePaymentRecoveryOperation(operation.id);
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: { transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] } },
  });

  if (!payment) {
    throw new Error(
      `Payment ${operation.paymentId} not found for booking modification refund recovery`,
    );
  }

  // The allocation freezes before Stripe: cancellations (#1349), refund
  // requests (#1510) and edits (#3984) persist the inline attempt's slices.
  // Only a legacy row or pre-Stripe planning failure freezes its plan on first
  // processing (#1097).
  // A retry then re-requests exactly those per-transaction slices — with the
  // identical Stripe idempotency keys, which Stripe answers with the original
  // refunds and the ledger dedupes by refund id — never a re-derived allocation
  // whose shifted slice amounts would mint fresh keys (over-refunding) or
  // misread replayed refunds as new progress (under-refunding). Operations
  // enqueued before their freeze existed carry no plan and derive-at-replay
  // below (single-transaction payments, the dominant case, already share slice
  // keys — see #1510).
  // Recoveries reuse the route's original Stripe idempotency key prefix so a
  // retry after a refund that succeeded on Stripe but was never recorded
  // replays the same refund instead of issuing a new one: refund-request
  // recoveries reconstruct it (refund_request_<id>, #1039 item 1), booking
  // cancellation recoveries reconstruct the inline cancel prefix
  // (booking_cancel_refund_<bookingId>, #1160), and modification recoveries
  // read the prefix stored at enqueue time (#1152). Legacy modification rows
  // without a stored prefix keep their operation-scoped prefix.
  // A refund request's own key only: an appeal's organiser-card debt is not this route's.
  const refundRequestId = isRefundRequestRefundRecoveryKey(operation.idempotencyKey)
    ? operation.idempotencyKey.slice(REFUND_REQUEST_REFUND_RECOVERY_PREFIX.length)
    : null;
  const isBookingCancellationRecovery = operation.idempotencyKey.startsWith(
    BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  );

  // #4104 review (CM): the body comes from the one builder a failed-later
  // refund's owner check reads too (`cardRefundOperationRefundMetadata`).
  const metadata = cardRefundOperationRefundMetadata(operation);
  let idempotencyKeyPrefix: string;
  if (refundRequestId) {
    // #1507: replay the inline appeal-refund body VERBATIM. The admin approve
    // route and this branch both build the metadata from
    // buildRefundRequestRefundMetadata, so under the shared
    // `refund_request_<id>` idempotency key Stripe replays the original refund
    // rather than rejecting the reused key with idempotency_error (which
    // previously sent the inline-succeeded-but-unrecorded scenario to
    // retry-exhaustion). The shape reconstructs purely from the persisted
    // bookingId + refundRequestId, so pre-fix rows replay through this same path
    // (the inline body — reason:"refund_appeal_approved" — is unchanged, so no
    // pre-deploy sliver).
    idempotencyKeyPrefix = buildRefundRequestRefundStripeKeyPrefix(refundRequestId);
  } else if (isBookingCancellationRecovery) {
    // #1494: replay the inline cancel body VERBATIM - the same
    // buildBookingCancellationRefundMetadata helper builds both, from the
    // persisted bookingId alone - so under the shared
    // `booking_cancel_refund_<bookingId>` key Stripe replays the original
    // refund rather than reject the key with idempotency_error.
    idempotencyKeyPrefix = `booking_cancel_refund_${operation.bookingId}`;
  } else {
    // #1507: replay the inline modification-refund body VERBATIM. The inline
    // settlement helper stamps a per-path reason (date change / batch / guest
    // removal); this branch reconstructs that exact reason from the persisted
    // Stripe key prefix (#1152) via bookingModificationRefundReasonForKeyPrefix
    // and builds the body from the same buildBookingModificationRefundMetadata
    // helper the inline path uses, so under the shared stored prefix Stripe
    // replays the original refund instead of rejecting the reused key with
    // idempotency_error. Legacy rows without a stored prefix fall back to the
    // historical recovery reason + operation-scoped key (they were never
    // shared-key with the inline refund).
    idempotencyKeyPrefix =
      operation.stripeKeyPrefix ??
      buildLegacyModificationRefundStripeKeyPrefix(operation.id);
  }

  let plan = parseRefundAllocationPlan(operation.allocationPlan);
  const preflightPlan = await checkCardRefundResend({
    operation,
    stripeKeyPrefix: idempotencyKeyPrefix,
    plan:
      plan ??
      capturedStripeTransactions(payment.transactions)
        .filter((row) => row.amountCents - row.refundedAmountCents > 0)
        .map((row) => ({ paymentTransactionId: row.id, amountCents: row.amountCents })),
    transactions: payment.transactions,
  });
  if (plan) plan = preflightPlan;

  if (!plan) {
    const refundableTransactions = payment.transactions
      .filter((transaction) =>
        isCapturedTransactionStatus(transaction.status),
      )
      .filter(
        (transaction) =>
          transaction.amountCents - transaction.refundedAmountCents > 0,
      )
      .sort(compareLedgerRowsNewestFirst); // #4132 (INV-PAY-133): a tie's last-inserted row first

    const refundableCents = refundableTransactions.reduce(
      (sum, transaction) =>
        sum + (transaction.amountCents - transaction.refundedAmountCents),
      0,
    );

    const outstandingCents = Math.min(operation.amountCents, refundableCents);

    if (outstandingCents <= 0) {
      await completePaymentRecoveryOperation(operation.id);
      return;
    }

    let remainingCents = outstandingCents;
    plan = [];
    for (const transaction of refundableTransactions) {
      if (remainingCents <= 0) break;
      const sliceCents = Math.min(
        remainingCents,
        transaction.amountCents - transaction.refundedAmountCents,
      );
      plan.push({
        paymentTransactionId: transaction.id,
        amountCents: sliceCents,
      });
      remainingCents -= sliceCents;
    }

    // Persist the plan before any Stripe call: if the process dies mid-refund
    // the retry replays these exact slices instead of re-deriving.
    await prisma.paymentRecoveryOperation.update({
      where: { id: operation.id },
      data: { allocationPlan: plan as unknown as Prisma.InputJsonValue },
    });
  }

  // #4083 (`INV-PAY-128`): a slice Stripe refused fails the attempt, retried under a fresh key.
  // #4312 (`INV-ADDPAY-047`): a bank transfer's approval left each refund's note to it - every refund made, on any outcome.
  // Round 7 (#4104): any other row notes a late capture's refund, and one its slice sent again for a failure noted on its
  // own record (the slice marked made with it) - `charge.refunded`'s rule for the same refund (`queueAnsweringRefundNotes`).
  const notesEachRefund = refundRequestRecoveryNotesEachRefund(operation);
  const notes = { paymentId: operation.paymentId, operationId: operation.id, notesEachRefund, plan };
  const refundId = await replayNotingEachRefund(notes, (send) => refundPlanOrRetryRefusals({ operation, plan, format, refund: (allocation) =>
    send(() => refundPaymentTransactions({
      format,
      paymentId: operation.paymentId,
      amountCents: allocation.reduce((sum, slice) => sum + slice.amountCents, 0),
      allocation,
      metadata,
      idempotencyKeyPrefix,
    })),
  }));

  // #2008 — the #1992 duplicate-capture auto-refund replays through this generic
  // modification-refund executor (its durable operation is a
  // REFUND_BOOKING_MODIFICATION carrying a `duplicate_capture_<bookingId>_<pi>`
  // idempotency key). On this recovery-replay path record the admin-only
  // history event, gated on the terminal SUCCEEDED transition actually flipping
  // the operation (`completePaymentRecoveryOperation` true) so it lands EXACTLY
  // ONCE across the inline and cron paths: if the inline refund already closed
  // the operation and recorded the event, this replay records nothing. #4125,
  // #4145: the capacity race's and a member cancel's REFUNDED event, the same
  // way, for what the plan refunded, in the close's own transaction.
  if (isBookingCancellationRecovery || operation.idempotencyKey.startsWith(CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX)) {
    const refunded = { bookingId: operation.bookingId, amountCents: plan.reduce((sum, slice) => sum + slice.amountCents, 0) };
    const close = (tx: Prisma.TransactionClient) => completePaymentRecoveryOperation(operation.id, { store: tx, lossExpected: true });
    await (isBookingCancellationRecovery
      ? closeCancellationRefundAfterReplay({ ...refunded, format }, close)
      : closeCapacityRaceRefundRecordingEvent({ ...refunded, actorMemberId: null }, close));
    return;
  }
  // The duplicate intent id is the suffix of the operation's per-booking
  // idempotency key.
  const duplicatePaymentIntentId = duplicateCaptureIntentIdForRecoveryKey(
    operation.bookingId,
    operation.idempotencyKey,
  );
  if (duplicatePaymentIntentId !== null) {
    if (await completePaymentRecoveryOperation(operation.id, { lossExpected: true })) {
      await recordDuplicateCaptureRefundEvent({
        bookingId: operation.bookingId,
        amountCents: operation.amountCents,
        // The settling intent is not persisted on the operation, so the replay
        // records it as null (the inline path, which owns the common case,
        // carries the settling intent).
        duplicatePaymentIntentId,
        settledPaymentIntentId: null,
      });
    }
    return;
  }

  // #3639: a replayed treasurer-approved late-capture refund writes the record
  // and queues the Xero correction its inline attempt would have - only on the
  // replay that actually moves the operation to SUCCEEDED (delta D6), so an
  // inline success whose close was lost is not recorded twice.
  if (isLateCaptureRefundStripeKeyPrefix(operation.stripeKeyPrefix)) {
    if (await completePaymentRecoveryOperation(operation.id, { lossExpected: true })) {
      const amountCents = plan.reduce((sum, slice) => sum + slice.amountCents, 0);
      await finishApprovedLateCaptureRefundAfterReplay({ ...operation, amountCents, refundId });
    }
    return;
  }

  await completePaymentRecoveryOperation(operation.id);
}

/**
 * WHAT THE DEFERRED SUPPLEMENTARY INVOICE ATTEMPT DID (#3181).
 *
 * Three answers rather than a nullable outcome, because the caller has to tell
 * "the enqueue answered" from "there was nothing to ask" from "the ask failed" -
 * and on the review fork those three lead to three different records.
 */
type DeferredSupplementaryInvoiceAttempt =
  | { status: "queued"; outcome: XeroSupplementaryInvoiceEnqueueOutcome }
  | { status: "not-recorded" }
  | { status: "failed" };

/**
 * RAISE THE SUPPLEMENTARY INVOICE THE EDIT PATH DEFERRED, now that the intent it
 * was waiting for exists (#3181, epic #2797).
 *
 * The defect this closes is one assumption held in two halves. The inline edit
 * path SKIPS the supplementary invoice when an additional Stripe payment is
 * required and its intent could not be minted - correctly, because there is
 * nothing to invoice against - and defers to "the intent's recovery replay". The
 * replay, until now, only ever ATTACHED a recovered intent to an operation
 * already waiting for one, and there was no such operation precisely because the
 * inline attempt had skipped it. The member got a collectable payment request and
 * the club's accounts got no record of the charge.
 *
 * BOTH FORKS OF THE REPLAY NEED THIS, which is why it is a function rather than
 * two spellings. The processor below splits on the recovery key: an ordinary
 * booking edit bills the `BookingModification`'s own signed components, and a
 * completed edit-financial-review charge bills the combined total re-derived from
 * its settled shares. Everything after "which figure" is identical.
 *
 * `hadIssuedXeroInvoice` IS THE EDIT'S ANSWER, READ BACK - NEVER THIS MOMENT'S.
 * The two differ, and the difference double-bills. A booking whose primary Xero
 * invoice had not been minted when the edit committed has NOTHING to supplement,
 * so the edit queued nothing; the primary invoice, minted later by its own
 * outbox operation from the booking's CURRENT state, then bills the edit itself.
 * A replay re-reading `payment.xeroInvoiceId` hours later would find it set,
 * classify a supplementary invoice, and raise a second ask for money the primary
 * invoice already carries. So the value is frozen on the recovery row at enqueue
 * time and read back here - which is also what makes the convergence claim below
 * true rather than merely asserted.
 *
 * `null` means the row predates that column: not recorded, therefore not
 * answerable, therefore NOT RAISED. The asymmetry is the argument - an invoice
 * this pass fails to raise is surfaced by the booking-vs-Xero repair pass as a
 * `MISSING_SUPPLEMENTARY_INVOICE`, while a duplicate invoice it raises in error
 * is surfaced by nobody and lands on the member. Since #3199 that finding is the
 * critical, one-click kind only where that pass can establish from the Xero
 * operation history that the primary invoice went out FIRST; where it cannot, it
 * still names the booking, at `manual_review` and without an action. Surfaced
 * either way, which is all this asymmetry rests on.
 *
 * BEST-EFFORT, AND NOT A RETRY, which is the one thing here that is not obvious.
 * Throwing would hand the row to `failPaymentRecoveryOperation` and buy a retry -
 * except that on the ordinary fork the retry cannot work: the replay has by then
 * written this edit's `ADDITIONAL` PaymentTransaction, and the processor's own
 * "a LATER edit superseded this one" check tests for an additional transaction
 * created after the operation, which that row now is. Before #4442 a second
 * pass found its own transaction, read it as a supersession, and completed
 * having done nothing at all. A retry now recognises its own row and resumes
 * these steps (`ownRow` in the replay), but a throw would still mark the
 * recovery FAILED for a failure this function already records and alerts, so
 * it stays best-effort.
 *
 * The failure is therefore recorded rather than retried, and it is recoverable
 * where it lands: the booking-vs-Xero repair pass classifies a positive-net
 * modification with a primary invoice and no supplementary invoice as a finding
 * and offers `QUEUE_SUPPLEMENTARY_INVOICE`, built from the same two components
 * this function passes. The log line names the anchor an operator needs to run
 * it. THAT ARGUMENT COVERS THE ORDINARY FORK ONLY - a parked review charge's
 * `BookingModification` can carry a zero net, which the repair pass's
 * `netAmountCents > 0` gate never looks at - so the review fork writes its own
 * durable record and does not rely on this one.
 */
async function raiseDeferredSupplementaryInvoiceForRecoveredIntent(params: {
  operationId: string;
  bookingId: string;
  bookingModificationId: string;
  paymentIntentId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  hadIssuedXeroInvoice: boolean | null;
  originalPaymentStatus: PaymentStatus | string | null;
}): Promise<DeferredSupplementaryInvoiceAttempt> {
  if (params.hadIssuedXeroInvoice === null) {
    logger.warn(
      {
        operationId: params.operationId,
        bookingId: params.bookingId,
        bookingModificationId: params.bookingModificationId,
        paymentIntentId: params.paymentIntentId,
      },
      "Recovered additional payment carries no record of whether its edit had an issued Xero invoice - no supplementary invoice was raised, and the booking-vs-Xero repair pass can queue it for this booking modification",
    );
    return { status: "not-recorded" };
  }
  try {
    // Dynamic import: keeps the Xero outbox's provider-client import graph out of
    // every module that imports this worker, exactly as the two dynamic imports
    // below it do for their own modules.
    //
    // INSIDE the try, and that is load-bearing rather than tidy (#3181 fix
    // round). A module that fails to load throws exactly like a call that fails,
    // and this function's whole contract is that it does not throw - the docblock
    // above argues at length that a throw from here cannot retry, because the
    // ordinary fork's replay has already written its ADDITIONAL transaction (a
    // retry now resumes from it rather than reading it as a supersession, #4442,
    // but a throw still marks the recovery FAILED for a failure recorded here).
    // An `await import` sitting outside the catch is precisely the throw that
    // argument does not cover.
    const { completeDeferredXeroSupplementaryInvoice } = await import(
      "@/lib/xero-booking-edit-settlement"
    );
    const outcome = await completeDeferredXeroSupplementaryInvoice({
      bookingId: params.bookingId,
      bookingModificationId: params.bookingModificationId,
      paymentIntentId: params.paymentIntentId,
      priceDiffCents: params.priceDiffCents,
      changeFeeCents: params.changeFeeCents,
      hasIssuedXeroInvoice: params.hadIssuedXeroInvoice,
      originalPaymentStatus: params.originalPaymentStatus,
    });
    return { status: "queued", outcome };
  } catch (err) {
    logger.error(
      {
        err,
        operationId: params.operationId,
        bookingId: params.bookingId,
        bookingModificationId: params.bookingModificationId,
        paymentIntentId: params.paymentIntentId,
        priceDiffCents: params.priceDiffCents,
        changeFeeCents: params.changeFeeCents,
      },
      "Failed to queue the Xero supplementary invoice a recovered additional payment was deferring - the booking-vs-Xero repair pass can queue it for this booking modification",
    );
    return { status: "failed" };
  }
}

/**
 * Re-create a booking edit's additional PaymentIntent whose original
 * post-transaction creation failed (#1096). Idempotent: the stored Stripe
 * idempotency key (`mod_*_{bookingModificationId}`) makes Stripe answer a
 * retry with the same intent, the ADDITIONAL transaction row is an upsert,
 * and an additional intent minted by a *later* edit supersedes this one — in
 * that case the operation completes without creating anything.
 *
 * #3954 ("retry nets it off", owner decision 9 Oct 2026; `INV-PAY-120`): a price
 * reduction saved while this waits re-checks what the booking owes before the
 * retry can mint the old figure. It sizes this row exactly as the replay below
 * would (`sizeRecoveryReplayAsk`), sets the reduction against it, closes the row
 * under the edit's locks from the state it read - unclaimed, no attempt since -
 * and mints only what is left, or nothing (`retireUnpaidAskChain`). A netted
 * row is therefore never claimed here, and a row claimed first refuses that
 * edit (409) rather than be minted beside a smaller ask.
 */
/**
 * #3954 review round 4: WRITE THE REPLAY'S ROW ONLY WHILE THIS WORKER STILL
 * HOLDS ITS CLAIM, in one transaction with the write.
 *
 * A price reduction nets off an ask waiting on this replay (`readUnpaidPriceAsk`)
 * and closes the recovery under the edit's locks - an unclaimed one, or one
 * whose claim is older than `RECENT_RECOVERY_CLAIM_MS`, a worker presumed
 * stalled or dead. A slow worker that is in fact alive must then not write the
 * old figure beside the reduction's smaller ask.
 *
 * THE FENCE IS A WRITE THAT MOVES WHAT THE REDUCTION FENCES ON. The claim is
 * re-asserted (still PROCESSING, same attempt, same claim time) and
 * `processingStartedAt` re-stamped, row-locking the recovery for the rest of
 * this transaction. A reduction's close is fenced on the claim time it read,
 * so whichever commits first wins: the close first, and this matches nothing
 * and writes nothing; this first, and the close matches nothing and rolls the
 * edit back (409), and for the next two minutes the fresh claim time refuses
 * a reduction outright while the supersede and invoice below finish.
 */
async function holdAdditionalIntentRecoveryClaim<T>(
  operation: Pick<PaymentRecoveryOperation, "id" | "paymentId" | "attempts" | "processingStartedAt">,
  write: (store: Prisma.TransactionClient) => Promise<T>,
  /**
   * #4442 review C-F1: `"payment-row"` for a re-stamp that writes nothing - the
   * reduction it fences orders on the Payment row, so it waits on no global holder.
   */
  locks: "queue" | "payment-row" = "queue",
): Promise<{ value: T; heldAt: Date } | null> {
  return prisma.$transaction(async (tx) => {
    // #4217, #4442 (`INV-LOCK-002`): the global key, then the Payment row, before the recovery row, as a reduction netting this ask off takes them.
    if (locks === "queue") await lockAdditionalAskQueue(tx, operation.paymentId);
    else await lockPaymentForRefundedTotal(tx, operation.paymentId);
    const heldAt = new Date();
    const held = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: operation.id,
        status: PaymentRecoveryOperationStatus.PROCESSING,
        attempts: operation.attempts,
        processingStartedAt: operation.processingStartedAt,
      },
      data: { processingStartedAt: heldAt },
    });
    if (held.count !== 1) return null;
    return { value: await write(tx), heldAt };
  }, ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS);
}

async function processCreateAdditionalPaymentIntentOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
): Promise<PaymentRecoveryProcessOutcome> {
  /**
   * #3170 (epic #2797): the `BookingModification` this operation belongs to, read
   * back through the ONE parser rather than by slicing a prefix off the key
   * inline. The inline slice assumed the ordinary edit key's shape and produced a
   * fragment (`"tent_recovery_<id>"`) for the review-charge key, because the
   * builder had been moved into `payment-recovery-keys.ts` and made a required
   * argument while the parser was left here. Fail-closed: null means "not a shape
   * this knows", and every use below tests for it.
   */
  /**
   * #4253: a credit-release request has no `BookingModification`, so it never
   * reaches the replay below - that replay would read the unknown key as "a newer
   * ask settled this" and close the debt, or mint beside a live edit's ask without
   * carrying it. Its own module owns the whole branch (`INV-ADDPAY-045`).
   */
  if (isCreditReleaseAskRecoveryKey(operation.idempotencyKey)) {
    const { processCreditReleaseAskOperation } = await import("@/lib/credit-release-ask");
    const answer = await processCreditReleaseAskOperation(operation, format, {
      holdClaim: holdAdditionalIntentRecoveryClaim,
      complete: (operationId) => completePaymentRecoveryOperation(operationId),
      wait: (waiting, message) => waitPaymentRecoveryOperation(waiting, message, format),
    });
    return answer === "waited" ? "waited" : "done";
  }

  const bookingModificationId =
    bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey,
    );

  /**
   * #3170: a completed EDIT_FINANCIAL_REVIEW charge replays DIFFERENTLY, and must
   * not fall through to the ordinary path below.
   *
   * Two reasons, both of which cost money if ignored. First, its debt is not the
   * amount frozen on this row - one booking edit can raise two review tasks and
   * the request asks for their SUM, so the replay re-derives the total from the
   * settled shares. Second, the "a newer additional supersedes this one" check
   * below would see the request THIS EDIT ALREADY MINTED, treat it as a later
   * edit's collectable and complete the operation having minted nothing - which
   * is precisely how the first round's second share was dropped.
   */
  if (
    bookingModificationId &&
    isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)
  ) {
    // Dynamic import: edit-financial-review-charge imports this module.
    const { syncEditFinancialReviewChargeRequest } = await import(
      "@/lib/edit-financial-review-charge"
    );
    const booking = await prisma.booking.findUnique({
      where: { id: operation.bookingId },
      select: {
        status: true,
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
        // #3181: `status` joins the select because the deferred supplementary
        // invoice this replay now raises is classified partly from it (the
        // primary invoice's local paid/refunded state). Whether an invoice
        // EXISTS to supplement is deliberately NOT read here: that is the edit's
        // answer, frozen on the recovery row.
        payment: {
          select: {
            stripeCustomerId: true,
            status: true,
          },
        },
      },
    });
    if (!booking) {
      throw new Error(
        `Booking ${operation.bookingId} not found for edit-financial-review charge recovery`,
      );
    }
    // #1358: the cancel flow retired a cancelled booking's asks, so a mint here would resurrect one
    // nobody can pay (#4272). Its uncollected shares are recorded and the row closed instead.
    const { closeCancelledEditReviewChargeReplay } = await import("@/lib/edit-financial-review-charge-cancelled");
    const cancelledReplay = { format, operation, bookingModificationId, memberId: bookingOwner(booking).member.id ?? null };
    if (await closeCancelledEditReviewChargeReplay({ ...cancelledReplay, status: booking.status })) return "done";
    const synced = await syncEditFinancialReviewChargeRequest({
      format,
      bookingId: operation.bookingId,
      bookingModificationId,
      paymentId: operation.paymentId,
      // #3369: the edit-review charge request is raised against a PERSON's
      // Stripe customer, so a booking with no member carries none. The sync
      // already models an absent member, which is the branch a school takes.
      member: bookingOwner(booking).member.id
        ? {
            id: bookingOwner(booking).member.id as string,
            email: bookingOwner(booking).member.email,
            name: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
            stripeCustomerId: booking.payment?.stripeCustomerId ?? null,
          }
        : null,
      // #3181: the settlement's own answer, read back off this row. The sync
      // writes it onward only into an enqueue that cannot fire (this row already
      // exists), so passing it is honesty rather than plumbing - but a re-derived
      // value here would be a second, disagreeing answer in the one place the
      // frozen one exists to prevent.
      hasIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
    });
    if (synced.paymentIntentId) {
      await attachRecoveredIntentToWaitingSupplementaryInvoice({
        bookingModificationId,
        paymentIntentId: synced.paymentIntentId,
        recoveryOperationId: operation.id,
      });
      await prisma.paymentRecoveryOperation.update({
        where: { id: operation.id },
        data: { paymentIntentId: synced.paymentIntentId },
      });
      /**
       * #3181: the review charge re-enters the ordinary price-increase path, so
       * it deferred its supplementary invoice for the same reason and the replay
       * has to complete it for the same reason. What differs is the figure: a
       * review charge bills the edit's COMBINED total, re-derived from the
       * settled shares by the sync above, because one booking edit raises one
       * ask (#3170's owner decision) - never this replay's own `amountCents`,
       * which that same decision demoted to advisory. No change fee: the fee, if
       * any, belongs to the structural edit that raised the review, and its own
       * dispatch billed it.
       *
       * NOT ON AN ALREADY-PAID ASK. `already-paid` is the sync saying this edit's
       * request was captured before the replay reached it - its webhook has fired
       * and cannot fire again. A supplementary invoice queued WAITING_PAYMENT
       * against that intent is a row nothing will ever release, cancelled by the
       * 14-day reaper with no invoice raised at all - and while it sits there it
       * makes the operator's signal WORSE, not better: the repair pass reads an
       * anchor carrying a live-but-unretryable operation as
       * `BLOCKED_BY_XERO_OPERATION` (warning, not auto-appliable, no action
       * offered, reported as waiting for a Stripe payment that has already
       * happened) instead of the critical, one-click
       * `MISSING_SUPPLEMENTARY_INVOICE` it would otherwise raise. The share that
       * could not join the ask already has its durable record, written by the
       * sync on the `payment-request` leg.
       */
      if (synced.outcome === "already-paid") {
        logger.warn(
          {
            operationId: operation.id,
            bookingId: operation.bookingId,
            bookingModificationId,
            paymentIntentId: synced.paymentIntentId,
          },
          "Recovered edit-financial-review charge was already paid - no supplementary Xero invoice was queued against it, and the booking-vs-Xero repair pass can queue one for this booking modification",
        );
      } else {
        const attempt =
          await raiseDeferredSupplementaryInvoiceForRecoveredIntent({
            operationId: operation.id,
            bookingId: operation.bookingId,
            bookingModificationId,
            paymentIntentId: synced.paymentIntentId,
            priceDiffCents: synced.totalCents,
            changeFeeCents: 0,
            hadIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
            originalPaymentStatus: booking.payment?.status ?? null,
          });
        const {
          recordShortEditReviewChargeInvoice,
          recordUncollectedEditReviewChargeShare,
        } = await import("@/lib/edit-financial-review-charge-request");
        if (attempt.status === "queued") {
          // The same record the inline dispatch writes, through the same
          // function: a short outcome is the enqueue saying this edit's invoice
          // had left the queue and could not be raised to the settled total.
          // What counts as short - and, since #3193, whether the difference can
          // be billed on its own invoice - belongs there, not to two callers.
          await recordShortEditReviewChargeInvoice({
            format,
            outcome: attempt.outcome,
            bookingId: operation.bookingId,
            bookingModificationId,
            /**
             * #3193: NO SECOND ASK FROM THIS FORK, and that is a refusal rather
             * than an omission.
             *
             * The second ask bills ONE settled share, anchored on the task that
             * settled it, which is what makes it safe: that share is provably
             * absent from the invoice that went out, so billing it adds exactly
             * what is missing. This replay holds no task. It re-derives the
             * edit's COMBINED total across every share and cannot say which part
             * of it the sent invoice already carries - so the only figure it
             * could raise an invoice for is the whole total, and that would
             * charge the member a second time for money they have already been
             * asked for. Strictly worse than the shortfall.
             *
             * Nulls here therefore reach `raiseSecondEditReviewChargeInvoice` as
             * `unavailable`, which is a named outcome with its own officer
             * instruction naming the booking-vs-Xero repair pass - not a silent
             * skip and not `failed`, which would tell an officer to bill a
             * difference by hand that nothing here can state.
             */
            reviewTaskId: null,
            shareCents: null,
            memberId: bookingOwner(booking).member?.id ?? null,
            totalCents: synced.totalCents,
          }).catch((err) =>
            logger.error(
              { err, operationId: operation.id, bookingModificationId },
              "Failed to record a short Xero supplementary invoice for a recovered edit-financial-review charge",
            ),
          );
        } else {
          /**
           * #3181 fix round: THE REVIEW FORK CANNOT FALL BACK ON THE REPAIR PASS,
           * so it leaves its own record.
           *
           * A parked edit's `BookingModification` carries only the readable
           * strands' money, so an edit whose ONLY money-affecting strand was the
           * parked one has `priceDiffCents + changeFeeCents == 0` - and the
           * booking-vs-Xero repair pass gates its missing-supplementary finding
           * on `netAmountCents > 0`, so it never looks. Without this an officer
           * settles at $230, the member pays it, and the club's only account of
           * the charge is a `logger.error` in a stream nobody reads. `INV-PAY`:
           * every path that settles a share without producing a request leaves a
           * durable trace, and a log line is not one.
           */
          await recordUncollectedEditReviewChargeShare({
            format,
            leg: "xero-invoice",
            /**
             * #3181 fix round: THE TWO NON-QUEUED OUTCOMES ARE DIFFERENT FACTS,
             * and filing them under one cause tells an officer to do something
             * that can bill the member twice.
             *
             * `failed` is "an invoice was owed and the queue refused it" - raise
             * it by hand. `not-recorded` is the row predating
             * `hadIssuedXeroInvoice`, where the whole position taken above is
             * that the club CANNOT TELL whether one was owed: if this booking's
             * primary Xero invoice had not been minted when the edit committed,
             * that invoice bills the charge itself and a hand-raised
             * supplementary is a second ask for the same money. Only the
             * booking-vs-Xero repair pass can answer it, and
             * `ask-owed-unknown`'s officer text says exactly that.
             */
            cause:
              attempt.status === "not-recorded"
                ? "ask-owed-unknown"
                : "ask-not-raised",
            // #3193: no ask exists here for a second one to follow, so the
            // second-ask question does not arise. `null`, not `unavailable`,
            // which is specifically "an ask exists and the difference cannot be
            // worked out".
            secondAsk: null,
            bookingId: operation.bookingId,
            bookingModificationId,
            memberId: bookingOwner(booking).member?.id ?? null,
            derivedTotalCents: synced.totalCents,
            // No ask exists to be short of, so there is no figure to compare
            // against - the same refusal to invent one the shortfall record makes.
            requestedTotalCents: null,
          }).catch((err) =>
            logger.error(
              { err, operationId: operation.id, bookingModificationId },
              "Failed to record an unraised Xero supplementary invoice for a recovered edit-financial-review charge",
            ),
          );
        }
      }
    }
    /**
     * #3170 fix round: THE REPLAY CLOSES THE DEBT ONLY IF THE ASK NOW EXISTS.
     *
     * This used to complete unconditionally, and the reason that lost money is
     * worth stating exactly, because nothing about it looks wrong at the call
     * site. The mint below the sync is
     * `createModificationAdditionalPaymentIntent`, which SWALLOWS its provider
     * failure and re-enqueues a recovery row - and the row it re-enqueues is
     * THIS row, whose upsert `update` branch deliberately does not reset
     * `status`. So on a replay while the provider is still down the re-enqueue
     * was a no-op on a PROCESSING row, and the next line marked the operation
     * SUCCEEDED with nothing minted. Two shares of $200 and $30 both read
     * COMPLETED and the club collected nothing.
     *
     * Throwing hands the row to `failPaymentRecoveryOperation`, which is the
     * machinery that already exists for exactly this: back off, retry, and on
     * exhaustion mark the operation FAILED and raise the admin payment-failure
     * alert. So the debt stays visible and recoverable instead of being closed.
     *
     * Deliberately NOT the two other shapes considered. Not "stop swallowing in
     * the minter": that function is shared with the ordinary edit path, where
     * swallowing is correct - the member's saved change must still return, and
     * the recovery row IS the retry. Not "enqueue a fresh recovery row": the row
     * being processed is already this debt's durable retry, and a second row for
     * one debt is a second debt.
     */
    // #4272: a cancellation landing mid-replay takes the cancelled path, not a retry.
    if (synced.outcome === "not-raised" && (await closeCancelledEditReviewChargeReplay(cancelledReplay))) return "done";
    if (!EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY[synced.outcome]) {
      throw new Error(
        `Edit financial review charge request for booking modification ${bookingModificationId} was not raised (${formatCents(synced.totalCents, format)} still owed); leaving the recovery operation open to retry`,
      );
    }
    await completeEditFinancialReviewChargeRecovery(operation);
    return "done";
  }

  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: {
      transactions: { orderBy: [...LEDGER_ROWS_OLDEST_FIRST] },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      booking: { include: { member: true, organisation: { select: { name: true, email: true } } } },
    },
  });

  if (!payment || !payment.booking) {
    throw new Error(
      `Payment ${operation.paymentId} not found for additional intent recovery`,
    );
  }

  /**
   * #3181: THE EDIT'S SIGNED COMPONENTS, READ BEFORE ANYTHING IS WRITTEN.
   *
   * They are only needed at the very bottom of this function, to bill the
   * supplementary invoice the inline dispatch deferred - but the read has to
   * happen HERE, and the position is the point (#3181 fix round). Below the
   * `upsertPaymentIntentTransaction` this replay is about to perform, a transient
   * database error on this one query throws into `failPaymentRecoveryOperation`,
   * and before #4442 the retry it bought could not work: the "a LATER edit
   * superseded this one" check found the row THIS replay wrote, read it as a
   * supersession, and completed having done nothing, so a $50 guest add was
   * collected with no invoice behind it. A retry now finds its own row first
   * (`ownRow`) and resumes the invoice steps, but reading here still keeps a
   * transient error before any intent or row exists, where it costs nothing.
   *
   * Read here instead and a throw costs nothing: no intent has been minted, no
   * transaction row written, and the next attempt re-runs the whole replay -
   * which is a real retry, not a self-supersession. Nothing between here and the
   * bill writes these two columns, so the value is the same one the old position
   * read. Wrapping the late read in its own `catch` was the alternative; it
   * degrades a transient blip to a manual repair, where this recovers by itself.
   */
  const modificationToBill = bookingModificationId
    ? await prisma.bookingModification.findUnique({
        where: { id: bookingModificationId },
        // #3954 round 6: `newData` for the waiting re-issues it folded in.
        select: { priceDiffCents: true, changeFeeCents: true, newData: true },
      })
    : null;

  // #3954 review round 4: sized before the overtake check, because a
  // re-issued ask's replay is settled by a different rule (below).
  const replay = sizeRecoveryReplayAsk({
    frozenAmountCents: operation.amountCents,
    modification: modificationToBill,
    payment,
  });
  const reissuesReducedAsk = replay.kind === "reissue";

  // A booking ended after the edit (#1358; #4316, `INV-ADDPAY-044`: CANCELLED or BUMPED)
  // has nothing to collect. A retry after a failed retirement retires its own ask first
  // (throws to retry) - before the settled check, which reads that ask as settled. Cycle: dynamic.
  const guard = await import("@/lib/ended-booking-ask-guard");
  if (await guard.bookingEndedBeforeAskMint(operation.bookingId, bookingModificationId)) {
    await guard.retireOutstandingAskOnEndedBooking({ format, bookingId: operation.bookingId, paymentId: operation.paymentId });
    await completePaymentRecoveryOperation(operation.id);
    return "done";
  }

  /**
   * The steps after this recovery's row is written: re-stamp the claim, point
   * the edit's waiting invoice at the intent, raise the invoice the edit
   * deferred, complete. One closure so a retry that finds its OWN row runs
   * exactly them (#4442 review C-F1).
   */
  const finishRecoveredAsk = async (paymentIntentId: string, claimedAt: Date | null) => {
    // #3954 round 6: the Stripe cancels before this can take a while. A price
    // reduction may have netted this ask off since (a claim older than
    // `RECENT_RECOVERY_CLAIM_MS` reads as a stalled worker), retiring the row
    // just written - so the claim is re-checked, and re-stamped, before any
    // invoice is queued to wait on this intent. A lost claim queues none: the
    // reduction accounted for this ask's money in its own invoice and history.
    const stillHeld = await holdAdditionalIntentRecoveryClaim(
      { id: operation.id, paymentId: operation.paymentId, attempts: operation.attempts, processingStartedAt: claimedAt },
      async () => true,
      "payment-row",
    );
    if (stillHeld === null) {
      logger.warn(
        { operationId: operation.id, bookingId: operation.bookingId, paymentIntentId },
        "Additional intent recovery lost its claim after writing its row (a price reduction retired the ask, #3954); no supplementary invoice queued for it",
      );
      return;
    }

    // A supplementary Xero invoice op enqueued at modification time waited on
    // an intent that never existed; point it at the recovered one so the
    // payment webhook can release it. The anchor comes from the shared parser at
    // the top of this function, never from a prefix slice spelled here (#3170).
    if (bookingModificationId) {
      // #3641: a failed attach alerts an officer rather than stranding the
      // invoice on no intent until the age backstop retires it.
      await attachRecoveredIntentToWaitingSupplementaryInvoice({
        bookingModificationId,
        paymentIntentId,
        recoveryOperationId: operation.id,
      });
    }

    /**
     * #3181: and now raise the invoice the edit deferred. The attach above only
     * ever points an EXISTING waiting operation at the recovered intent; where the
     * inline dispatch skipped the queue entirely there is nothing for it to point
     * at, which is the whole defect.
     *
     * The figure comes from the `BookingModification` itself rather than from
     * `operation.amountCents`. They are different quantities: the recovery row
     * carries what Stripe is collecting, and the invoice bills the edit's SIGNED
     * components, which a mixed-sign edit (a price reduction plus a larger
     * late-change fee) separates - the pair is what `INV-MONEY`/#1356 requires and
     * what the booking-vs-Xero repair pass reads for the same invoice.
     */
    // #3954 decision A: a re-issued ask's invoice is its reducing edit's own,
    // sized by that edit (`queueReissuedAskSupplementaryInvoice`), not the edit's
    // signed components - which are a reduction.
    if (bookingModificationId && reissuesReducedAsk) {
      await queueReissuedAskSupplementaryInvoice({
        bookingId: operation.bookingId,
        bookingModificationId,
        paymentIntentId,
      });
    }
    if (bookingModificationId && !reissuesReducedAsk) {
      // Read above the mint, deliberately: see the hoist's own comment.
      if (modificationToBill) {
        await raiseDeferredSupplementaryInvoiceForRecoveredIntent({
          operationId: operation.id,
          bookingId: operation.bookingId,
          bookingModificationId,
          paymentIntentId,
          priceDiffCents: modificationToBill.priceDiffCents,
          changeFeeCents: modificationToBill.changeFeeCents,
          // The EDIT's answer, frozen on this row when the mint failed. Re-reading
          // `payment.xeroInvoiceId` here is the double-bill the helper describes.
          hadIssuedXeroInvoice: operation.hadIssuedXeroInvoice,
          originalPaymentStatus: payment.status,
        });
        // #3954 round 6: the re-issues this increase folded in are asked for on
        // this intent, so their own invoices wait on it.
        await queueFoldedReissuedAskInvoices({
          bookingId: operation.bookingId,
          increaseModificationId: bookingModificationId,
          paymentIntentId,
        });
      } else {
        logger.error(
          {
            operationId: operation.id,
            bookingId: operation.bookingId,
            bookingModificationId,
          },
          "Recovered additional intent has no booking modification to bill - no Xero supplementary invoice was raised",
        );
      }
    }

    await completePaymentRecoveryOperation(operation.id);
  };

  // #4442 review C-F1: THIS recovery's own row, written by an earlier attempt
  // that then failed before the steps above (its re-stamp timed out behind a
  // long holder, say). It is not an overtake: completing here would collect the
  // ask with no invoice behind it, so the steps run now.
  const ownRow = payment.transactions.find(
    (row) => row.kind === PaymentTransactionKind.ADDITIONAL && row.stripePaymentIntentId === operation.paymentIntentId,
  );
  if (ownRow?.stripePaymentIntentId) {
    // A reduction that retired the ask while this recovery sat PENDING has
    // already accounted for its money; an invoice parked on the withdrawn
    // intent would only wait for the reaper, so finish as the lost claim does.
    // FAILED alone is not the test: a superseded row is FAILED with no
    // `withdrawnAt`, and its invoice correctly follows the carry.
    if (ownRow.withdrawnAt) {
      logger.warn(
        { operationId: operation.id, bookingId: operation.bookingId, paymentIntentId: ownRow.stripePaymentIntentId },
        "Additional intent recovery found its own row already withdrawn by a price reduction (#4442); no supplementary invoice queued for it",
      );
      await completePaymentRecoveryOperation(operation.id);
      return "done";
    }
    await finishRecoveredAsk(ownRow.stripePaymentIntentId, operation.processingStartedAt);
    return "done";
  }

  // A later edit already created a fresh additional intent: it superseded
  // this modification's collectable, so resurrecting ours would offer the
  // member two instruments for overlapping money. The later edit repriced
  // from current state, so its intent is the whole truth. A RE-ISSUED ask is
  // the exception: it is settled only by its own row, and a later ask that did
  // not fold it in is carried and superseded (`isRecoveryReplaySettled`, #3954).
  // The rule a price reduction reads too, before it nets this recovery off.
  if (
    isRecoveryReplaySettled(replay, operation, payment.transactions) ||
    operation.amountCents <= 0
  ) {
    await completePaymentRecoveryOperation(operation.id);
    return "done";
  }

  // #3954 round 7: one resolution, shared with the door's re-issue mint, so
  // the two minters of one key send one request (`resolveAskCustomerId`).
  const customerId = await resolveAskCustomerId(payment);

  /**
   * #3340 fix round: THE ASK IS RE-DERIVED HERE, NOT REPLAYED FROM THE ROW.
   *
   * `operation.amountCents` was frozen when the mint failed, and since #3340 the
   * ask is no longer a fact about an edit (a delta, which never goes stale) but
   * a fact about a MOMENT - the edit's net plus whatever was still unpaid on the
   * ask it supersedes. A frozen moment can OVERCHARGE: edit 1 raises $70 and is
   * not cancelled because the mint that would have superseded it failed, the
   * member pays that $70 while edit 2's recovery row sits frozen at $140, and
   * the replay then asks for $140 against $70 genuinely outstanding.
   *
   * Re-deriving against the Payment as it stands now gives $70 in that case and
   * the identical $140 when nothing was paid in between, so the correction only
   * ever removes an over-ask. `modificationToBill` is the edit's own signed
   * components, already read above the mint for #3181's reasons; with no
   * modification to read from - or a modification whose own net is not positive,
   * which an ordinary edit's row should never be - there is nothing better than
   * the frozen figure. It runs only with no additional capture on the ledger;
   * otherwise its carried part is unknown and the replay refuses below.
   *
   * The `EDIT_FINANCIAL_REVIEW` fork returns far above this, so the components
   * read here are always the ordinary edit's own. A review charge's debt is the
   * sum of its settled shares and is re-derived by its own sync function.
   */
  // #3954: one sizing for this replay and for a reduction that nets this
  // recovery off before it runs (`sizeRecoveryReplayAsk`). A REDUCTION's ask is
  // the unpaid ask it shrank, re-issued smaller: all of it carried, none of it
  // this edit's own, and frozen at the edit - the ask it replaced was retired in
  // that edit's transaction, so there is nothing on the Payment to re-derive it
  // from.
  // #4442: a frozen figure cannot separate this edit's debt from an earlier
  // ask's balance. After a capture, accepting a fresh zero-balance snapshot
  // would let the next retry charge that balance again. Refuse every retry
  // rather than guess a subtraction; normal recovery exhaustion alerts officers.
  // Read the ledger, not just the current mirror: a later ask can hide a capture.
  if (replay.kind === "frozen" && payment.transactions.some(
    (row) => row.kind === PaymentTransactionKind.ADDITIONAL && isCapturedTransactionStatus(row.status),
  )) {
    throw new Error(
      "Additional intent recovery cannot safely replay its frozen amount after an additional capture; reconcile the booking's payments and collect only the unpaid balance",
    );
  }

  if (modificationToBill && replay.kind === "frozen") {
    // Belt and braces, and deliberately NOT a completion. An ordinary edit only
    // reaches this processor because its own net was positive, so a zero net
    // here means the modification row and the frozen figure disagree - and
    // completing on that reading would retire a real debt for an arithmetic
    // reason nobody has checked. With no additional capture, keep the frozen
    // amount and say so; after a capture the refusal above prevents overcharging.
    logger.warn(
      {
        operationId: operation.id,
        bookingId: operation.bookingId,
        editNetCents:
          modificationToBill.priceDiffCents + modificationToBill.changeFeeCents,
        frozenAmountCents: operation.amountCents,
      },
      "Additional intent recovery could not re-derive the ask (the modification's net is not positive); replaying the frozen amount",
    );
  }
  const ask =
    replay.kind === "frozen"
      ? // #3371: the frozen fallback carried nothing that this replay can name.
        // The row records an amount and no provenance, and inventing one here
        // would be worse than recording none - a 0 says "nothing known to have
        // been absorbed", which is the truth about a figure frozen before this
        // column existed.
        // #4442 review C-F2: but the live balance it was minted over is still
        // known - the read above - and the queue re-reads it like any other.
        { amountCents: replay.amountCents, carriedCents: 0, paymentBalanceCents: askSizedOnBalanceCents(payment) }
      : replay.ask;
  const askCents = ask.amountCents;

  /**
   * The Stripe key still pins a replay of the SAME ask to the same intent, and
   * gains the amount only when the re-derivation moved. The rule and the reasons
   * are `stripeIdempotencyKeyForAskAmount`'s, which the edit-review charge's own
   * re-derived mint reaches too (#3371 fix round) rather than spelling the
   * suffix a second time. Here the base key is the ORIGINAL inline attempt's,
   * frozen on the row, so an unmoved amount must keep it bare to converge on
   * that attempt; the review path builds its base fresh at every attempt and has
   * no bare form to preserve. #4036: `planOrdinaryAskMint` applies the rule.
   */
  // #3954 round 6: a RE-ISSUED ask sends the one request its door's mint sends
  // under the same key (`planReissuedAskMint`), so whichever of the two runs
  // second is answered with the first's intent, never an `idempotency_error`.
  const reissuePlan = reissuesReducedAsk
    ? planReissuedAskMint({
        bookingId: operation.bookingId,
        recovery: { amountCents: operation.amountCents, stripeKey: operation.paymentIntentId },
        payment,
      })
    : null;
  const rowReason = reissuePlan?.reason ?? ORDINARY_ASK_RECOVERY_REASON;
  const { intent: pi, adopted } = reissuePlan
    ? { intent: await mintReissuedAskIntent({ format, plan: reissuePlan, customerId, recoveryCreatedAt: operation.createdAt }), adopted: false }
    : // #4036: the one request its door sent (`planOrdinaryAskMint`, `INV-MOD-060`).
      await mintOrdinaryAskIntent({
        format,
        plan: planOrdinaryAskMint({
          bookingId: operation.bookingId,
          bookingModificationId,
          stripeKey: operation.paymentIntentId,
          frozenAmountCents: operation.amountCents,
          amountCents: askCents,
        }),
        customerId,
        recovery: { id: operation.id, createdAt: operation.createdAt },
      });

  // The new intent's row FIRST, then the supersede - see the same ordering and
  // the same reasoning in `createModificationAdditionalPaymentIntent` (#3340
  // fix round). A cancel reconciles the payment, and a reconcile run before this
  // row exists mirrors the intent being retired back over the Payment.
  //
  // #3954 review round 4: written only while this worker still holds its claim
  // (`holdAdditionalIntentRecoveryClaim`). A price reduction may have closed
  // this recovery while the mint was in flight - it nets off a claim older than
  // `RECENT_RECOVERY_CLAIM_MS` - and a row written now would be the old figure
  // live beside the reduction's smaller ask.
  // The supersede's durable rows ride the same transaction, so a reduction
  // that closes this recovery first leaves no row AND no cancellation of the
  // smaller ask it re-issued; the Stripe cancels run after commit.
  // Dynamic import: booking-payment-cleanup imports this module.
  const { queueSupersededAdditionalIntentCancellationRows, cancelSupersededAdditionalIntentsNow } =
    await import("@/lib/booking-payment-cleanup");
  const held = await holdAdditionalIntentRecoveryClaim(operation, async (store) => {
    await assertAdditionalAskSizingCurrent(store, operation.paymentId, ask);
    // #4036 review: an adopted intent another ask recorded meanwhile is never written over.
    await refuseAdoptedIntentOnLedger(store, { intent: pi, adopted });
    await upsertPaymentIntentTransaction({
      paymentId: operation.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: askCents,
      // #3371: the same value that sized the amount says what it absorbed, so the
      // replay's row carries the provenance the inline mint would have written.
      carriedAskCents: ask.carriedCents,
      status: PaymentStatus.PENDING,
      reason: rowReason,
      // #3954 round 7: the customer the intent was minted for, which an intent
      // the re-issue's metadata lookup recovered need not share with this run.
      // #4036 review: never an ADOPTED intent's, whose customer is not known to be this
      // payment's - writing it would split the saved-card pair (`saved-payment-method.ts`).
      ...(adopted ? {} : { stripeCustomerId: mintedIntentCustomerId(pi, customerId) }),
      // #3954 round 7: the edit's frozen invoice answer rides onto its row.
      ...(operation.hadIssuedXeroInvoice !== null ? { hadIssuedXeroInvoice: operation.hadIssuedXeroInvoice } : {}),
      // Round 8: and the edit whose ask it is, for a reduction that retires it.
      ...(bookingModificationId ? { bookingModificationId } : {}),
      store,
    });
    // #3954: the row names this attempt's intent from the moment it exists, so
    // a retry after a later failure recognises its own row (`ownRecoveryRow`).
    await store.paymentRecoveryOperation.update({
      where: { id: operation.id },
      data: { paymentIntentId: pi.id },
    });
    return queueSupersededAdditionalIntentCancellationRows({
      bookingId: operation.bookingId,
      paymentId: operation.paymentId,
      newPaymentIntentId: pi.id,
      store,
    });
  });
  if (held === null) {
    logger.warn(
      { operationId: operation.id, bookingId: operation.bookingId, paymentIntentId: pi.id },
      "Additional intent recovery lost its claim before writing its row (a price reduction netted it off, #3954); nothing written - the minted intent was never offered to anyone and is left uncollectable",
    );
    return "done";
  }
  await cancelSupersededAdditionalIntentsNow({
    format,
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    queued: held.value,
    newPaymentIntentId: pi.id,
  });

  // #4316: a cancel committed since that check could not see this intent; retired as the
  // cancel retires one (a failure throws, to retry), the debt closes - no invoice is owed.
  if (await guard.replayRetiresAskOnEndedBooking({ format, bookingId: operation.bookingId, paymentId: operation.paymentId, paymentIntentId: pi.id })) {
    await completePaymentRecoveryOperation(operation.id);
    return "done";
  }

  await finishRecoveredAsk(pi.id, held.heldAt);
  return "done";
}

/**
 * What one processed operation came to: `done`, or `waited` when it was put back to wait
 * (`waitPaymentRecoveryOperation`, #4253) - which the run counts as a retry, never a success.
 */
type PaymentRecoveryProcessOutcome = "done" | "waited";

async function processPaymentRecoveryOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
): Promise<PaymentRecoveryProcessOutcome> {
  if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
    await processCancelPaymentIntentOperation(operation);
    return "done";
  }

  if (
    operation.type ===
    PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION
  ) {
    await processBookingModificationRefundOperation(operation, format);
    return "done";
  }

  if (
    operation.type ===
    PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT
  ) {
    return processCreateAdditionalPaymentIntentOperation(operation, format);
  }

  if (
    operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT
  ) {
    await processRefundSupersededPaymentOperation(operation, format);
    return "done";
  }

  // #2262: the dispatch is EXHAUSTIVE, never a fall-through. The final arm
  // used to execute any unknown enum member as a superseded-payment REFUND —
  // which is why a "task a cron must never execute" (ManualRefundTask) was
  // modeled as its own table rather than a new PaymentRecoveryOperationType.
  // An unhandled member now fails its operation loudly (the worker's normal
  // failure path records it and alerts on exhaustion) instead of moving money.
  throw new Error(
    `Unhandled payment recovery operation type: ${operation.type}`
  );
}

const PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS = 30 * 60 * 1000;
const PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
// #1211: shared AlertCooldown key that all instances contend on so the stale
// payment-recovery-queue alert fires at most once per cooldown window across
// the whole fleet, not once per process.
const STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY = "payment-recovery:stale-queue";

// #3567: card charges are not a stalled cron while card payments are off (the
// admin banner says so), nor within this window of the club format last changing:
// charges that waited out a refusal are old, and the next run claims them.
async function alertStalePaymentRecoveryQueueIfNeeded(format: ClubFormat, chargesRefused: boolean) {
  const now = new Date();
  const staleThreshold = new Date(
    now.getTime() - PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS,
  );
  const formatChangedAt = chargesRefused ? null : (await loadPersistedClubFormatSettings())?.updatedAt;
  const quietCharges = chargesRefused || (formatChangedAt != null && formatChangedAt > staleThreshold);
  const oldest = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      status: PaymentRecoveryOperationStatus.PENDING,
      createdAt: { lt: staleThreshold },
      ...PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE, // #4104: a dead row is not a stalled cron
      ...(quietCharges ? { type: { not: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT } } : {}),
    },
    orderBy: { createdAt: "asc" },
    // #3369: the owner may be an Organisation; bookingOwner() reads both.
    include: { booking: { include: { member: true, organisation: { select: { name: true, email: true } } } } },
  });
  if (!oldest) return;

  // Shared cross-instance cooldown: atomically CLAIM the window before sending
  // so N instances raise at most one alert per
  // PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS (not one per instance). The
  // claim-before-send pattern was extracted verbatim to @/lib/alert-cooldown
  // under #2262 so the manual-settlement conflict alert can share it.
  const holdsClaim = await claimAlertCooldown({
    key: STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY,
    windowMs: PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS,
    now,
  });
  if (!holdsClaim) return;
  // We hold the claim → send exactly once cross-instance. The provider call is
  // claim-first and outside any DB transaction; the tiny residual double-send
  // window (two instances reading between claim attempts) is bounded and this
  // is a noise-only alert.
  await sendAdminPaymentFailureAlert({
    memberName:
      oldest.booking && bookingOwner(oldest.booking).member
      ? `${bookingOwner(oldest.booking).member.firstName} ${bookingOwner(oldest.booking).member.lastName}`
      : "Unknown member",
    checkIn: oldest.booking?.checkIn ?? null,
    checkOut: oldest.booking?.checkOut ?? null,
    amountCents: oldest.amountCents,
    errorMessage:
      "Stripe payment recovery queue is stalled. Confirm the cron leader's 15-minute payments cycle is running (payment-recovery on admin cron health).",
    paymentIntentId: oldest.paymentIntentId,
  }, format).catch((alertError) =>
    logger.error(
      { err: alertError, operationId: oldest.id },
      "Failed to send stale payment recovery queue alert",
    ),
  );
}

/**
 * Run ONE already-enqueued recovery operation right now, best-effort (#3340).
 *
 * WHY THIS EXISTS. A superseded ADDITIONAL PaymentIntent used to stay
 * confirmable until the five-minute recovery cron reached it. In the live case
 * that window was 4 minutes 5 seconds, and a member holding the old client
 * secret confirmed a $65 charge while the page read "Total: $300". The mint site
 * therefore drains its own cancellation before it hands the new client secret
 * back, so the old secret is dead by the time anything can be confirmed against
 * it.
 *
 * IT REUSES THE PROCESSOR RATHER THAN DUPLICATING IT. Cancelling a Stripe intent
 * has a genuinely hard case - Stripe can move the intent from cancellable to
 * `succeeded` between the retrieve and the cancel, which has to hand off to a
 * refund instead of marking the transaction FAILED - and that logic already
 * lives in `processCancelPaymentIntentOperation`. A second copy at the mint site
 * is the class of defect this repository keeps re-finding, so this claims the
 * row and runs the same processor (`INV-SSOT-001`).
 *
 * IT NEVER THROWS, and it is never the durable guarantee. The enqueued row is,
 * and it is written BEFORE this runs: a claim that loses (another worker got
 * there first), a Stripe outage, or a failure of any kind leaves the row for the
 * cron exactly as before #3340. The only thing this changes is latency.
 */
export async function runPaymentRecoveryOperationNow(
  operationId: string,
  /** The club's format (#3565), resolved once by the caller — never per queued row. */
  format: ClubFormat,
): Promise<"succeeded" | "not-claimed" | "failed"> {
  const operation = await claimPaymentRecoveryOperation(operationId).catch(
    (err) => {
      logger.error(
        { err, operationId },
        "Could not claim a payment recovery operation for immediate processing; the queued row stands",
      );
      return null;
    },
  );
  if (!operation) {
    /**
     * #3340 fix round: NOT-CLAIMED USED TO BE SILENT, and the case that makes
     * that expensive is the second supersede.
     *
     * `enqueuePaymentIntentCancellationRecovery` upserts on its idempotency key
     * and its UPDATE branch deliberately does not reset `status` or
     * `nextRetryAt`. So when a first cancel attempt has failed, the row sits
     * FAILED with a `nextRetryAt` five minutes out, and the claim below - which
     * requires `nextRetryAt <= now` - cannot match. The immediate attempt this
     * function exists to make does not happen, and the superseded intent stays
     * confirmable for the remainder of that backoff: precisely the window the
     * live incident was measured in. The durable row still finishes the job, but
     * nothing recorded that the fast path had declined.
     */
    logger.warn(
      { operationId },
      "Immediate payment recovery did not claim the operation (already terminal, already processing, out of attempts, or still in retry backoff); only the queued row will act",
    );
    return "not-claimed";
  }

  try {
    await processPaymentRecoveryOperation(operation, format);
    return "succeeded";
  } catch (error) {
    logger.error(
      { err: error, operationId, type: operation.type },
      "Immediate payment recovery attempt failed; the durable queued operation remains",
    );
    await failPaymentRecoveryOperation(operation, error, format).catch((markErr) =>
      logger.error(
        { err: markErr, operationId },
        "Could not record the failed immediate payment recovery attempt",
      ),
    );
    return "failed";
  }
}

export async function processPaymentRecoveryOperations(options?: {
  limit?: number;
  /**
   * #3653, #4104: also read card refunds still recorded pending back from
   * Stripe - organiser children's (`reconcilePendingOrganiserChildRefunds`)
   * and every other one (`reconcilePendingCardRefunds`) - despite the name,
   * kept for its callers. The payments cron passes it; the inline drain after
   * an edit does not, so a member's request never waits on those provider reads.
   */
  reconcilePendingChildRefunds?: boolean;
}): Promise<PaymentRecoveryProcessResult> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  // #3567: while the stored currency cannot be charged in, card CHARGES wait,
  // excluded IN THE QUERY so they never fill the batch and starve refunds.
  const chargeRefusal = chargeCurrencyRefusal(format);
  const waitingCharges = chargeRefusal ? { type: { not: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT } } : {};
  await resetStaleProcessingOperations(format);
  await alertStalePaymentRecoveryQueueIfNeeded(format, chargeRefusal !== null);

  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.paymentRecoveryOperation.findMany({
    where: {
      status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
      attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      nextRetryAt: { lte: new Date() },
      ...waitingCharges,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const result: PaymentRecoveryProcessResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
  };

  // Said only while a refused charge is actually waiting, not on every run.
  if (chargeRefusal && (await prisma.paymentRecoveryOperation.findFirst({ where: { status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] }, type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT }, select: { id: true } }))) {
    logger.warn(`Payment recovery is leaving card charges unclaimed: ${chargeRefusal.message}`);
  }
  for (const queuedOperation of queuedOperations) {
    const operation = await claimPaymentRecoveryOperation(queuedOperation.id);
    if (!operation) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    try {
      // #4253: an operation put back to wait is a retry, never a completion.
      if ((await processPaymentRecoveryOperation(operation, format)) === "waited") result.retried += 1;
      else result.succeeded += 1;
    } catch (error) {
      logger.error(
        { err: error, operationId: operation.id, type: operation.type },
        "Payment recovery operation failed"
      );
      const outcome = await failPaymentRecoveryOperation(operation, error, format);
      if (outcome === "failed") {
        result.failed += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  // #3653: an organiser child refund Stripe accepted as pending and later
  // failed is owed again. The combined intent has no Payment for the webhook to
  // resolve, so the cron's run reads those refunds back. Isolated: a failure
  // here never fails the run that has already processed the queue above.
  if (options?.reconcilePendingChildRefunds) {
    try {
      const { reconcilePendingOrganiserChildRefunds } = await import("@/lib/organiser-child-refund-executor");
      await reconcilePendingOrganiserChildRefunds();
    } catch (err) {
      logger.error({ err }, "Could not re-read pending organiser child refunds (#3653)");
    }
    // #4104: and every other pending card refund, so one that failed later is owed again.
    await import("@/lib/card-refund-status-sync")
      .then(({ reconcilePendingCardRefunds }) => reconcilePendingCardRefunds())
      .catch((err: unknown) => logger.error({ err }, "Could not re-read pending card refunds (#4104)"));
  }

  return result;
}

export async function completeCanceledSupersededPaymentIntentRecovery({
  paymentIntentId,
}: {
  paymentIntentId: string;
}) {
  const operation = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      paymentIntentId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!operation) {
    return false;
  }

  await markSupersededTransactionFailed(operation);
  await completePaymentRecoveryOperation(operation.id);
  return true;
}

/**
 * THE CHECK every door that brings a succeeded intent back asks before it
 * settles a booking with it (#4300, `INV-PAY-138`): the webhook,
 * `confirm-payment`, and the pay step's and `/pay` link's reconcile arms.
 * `true`: the superseded machinery owns the capture, so the door settles
 * nothing. A cancel row not SUCCEEDED hands it on here (to its refund, or held
 * for the treasurer on a cancelled booking, `holdSupersededLateCaptureIfRequired`);
 * otherwise, or when that hand-off lost its claim, the shared reading answers
 * (`supersededMachineryOwnsCapture`). Unlocked; the settle asks that reading
 * again under lock(1).
 */
export async function queueSupersededPaymentIntentRefundRecovery(
  paymentIntent: Pick<Stripe.PaymentIntent, "id" | "amount" | "payment_method">,
): Promise<boolean> {
  const operation = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      paymentIntentId: paymentIntent.id,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    orderBy: { createdAt: "desc" },
  });

  // A hand-off abandoned on its claim (the row went terminal or was deleted
  // meanwhile) moved nothing: ask the rows again rather than assume.
  if (
    operation &&
    (await handoffSucceededSupersededIntentToRefund({
      operation,
      amountCents: paymentIntent.amount,
      paymentMethodId: getStripePaymentMethodId(paymentIntent),
      takenFromOutside: true,
    }))
  ) {
    return true;
  }

  // The intent's own ledger row names its payment (the one lookup every reader
  // of an intent uses, backfilling a pre-ledger payment).
  const row = await findPaymentTransactionByIntentId({ paymentIntentId: paymentIntent.id });
  return supersededMachineryOwnsCapture(prisma, { paymentId: row?.paymentId ?? null, paymentIntentId: paymentIntent.id });
}

/**
 * A named derivation of `stripeReferenceId` (`stripe-references.ts`, the one
 * home for "the id behind a Stripe expandable reference" — #3266). Kept under
 * its own name so the charge call sites that read it did not all have to move
 * in the same lane; #3267 routes their inline copies when it edits them.
 */
export function getStripePaymentMethodId(
  paymentIntent: Pick<Stripe.PaymentIntent, "payment_method">
) {
  return stripeReferenceId(paymentIntent.payment_method);
}

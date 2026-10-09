/**
 * A PRICE REDUCTION RETIRES THE UNPAID ASK BEFORE IT RETURNS ANY MONEY (#3954,
 * owner decision 8 Oct 2026; `INV-PAY-047`, `INV-MOD-011`).
 *
 * A booking that grew carries an unpaid additional card ask until the member
 * pays it. A later edit that brings the price back down used to settle against
 * money already paid - a refund, account credit or give-back - and leave the
 * ask live, so a member who then paid it left the club holding more than the
 * booking cost. Now the reduction is set against the ask first
 * (`setReductionAgainstUnpaidAsk`, the arithmetic's one home) and only what is
 * left of it is refunded or credited.
 *
 * This module holds the database halves:
 *
 * - `readReductionAgainstUnpaidAsk` - the ONE read per edit of which ask a
 *   reduction may be set against (`readUnpaidPriceAsk`): the ledger rows' ask,
 *   plus any ask whose mint failed and still waits on its recovery (owner
 *   decision 9 Oct 2026, "retry nets it off"), never an officer's review charge
 *   (decision B). The settlement options, the save and the quote all take that
 *   one read (review round 4), so a capture between two reads cannot split them.
 * - `retireUnpaidAskChain` - inside the edit's transaction: the ask's rows are
 *   FAILED and stamped `withdrawnAt` (the projection reads past them,
 *   `INV-ADDPAY-040`), each intent's Stripe cancellation is queued durably, a
 *   waiting recovery is closed before its retry can mint the old figure, any
 *   Xero supplementary invoice parked on them is read for what it bills and
 *   retired, and the `Payment` mirror is reconciled. A smaller ask, when one is
 *   left, is made durable in the same transaction (`queueReissuedAskRecovery`)
 *   and minted after commit (`writeReissuedAskUnderRecovery`).
 * - `foldWaitingReissuedAsks` - a later increase asks for a waiting re-issue too.
 *
 * And the after-commit half, `cancelRetiredAdditionalAsksNow`, which the minter
 * runs before minting anything.
 *
 * THE RACE WITH A PAYMENT. The webhook does not take the edit's locks, so the
 * member can pay the ask while the reduction is being saved. Two outcomes, both
 * safe. A capture that lands after the read leaves the row captured, the
 * retire's fence matches nothing, and the whole edit rolls back
 * (`AdditionalAskChangedDuringReductionError`, 409). A capture after the fence
 * finds the queued cancellation, and the existing superseded-capture path
 * refunds it in full (`queueSupersededPaymentIntentRefundRecovery`,
 * `processCancelPaymentIntentOperation`).
 *
 * THE RACE WITH A RETRY. The recovery runner does not take the edit's locks
 * either. A waiting ask is closed only from the state it was read in - same
 * status, attempts and claim time. A retry claimed within
 * `RECENT_RECOVERY_CLAIM_MS` refuses the edit for a moment; an older claim is a
 * stalled worker and is closed, and the runner writes its row only while it
 * still holds its claim (`holdAdditionalIntentRecoveryClaim`), re-stamping the
 * claim time as it does - so whichever commits first wins, and the other
 * changes nothing.
 */
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";

import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { setReductionAgainstUnpaidAsk } from "@/lib/additional-payment-ask";
import {
  isRecoveryReplaySettled,
  recoveryAskBeyondPaymentAskCents,
  sizeRecoveryReplayAsk,
} from "@/lib/additional-ask-recovery-replay";
import {
  ADDITIONAL_ASK_BEING_RAISED_MESSAGE,
  AdditionalAskChangedDuringReductionError,
} from "@/lib/additional-ask-reduction-error";
import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import type { ClubFormat } from "@/lib/club-format";
import { isEditReviewChargeRequestRow } from "@/lib/edit-financial-review-charge-shape";
import logger from "@/lib/logger";
import {
  enqueueAdditionalPaymentIntentRecovery,
  enqueuePaymentIntentCancellationRecovery,
  runPaymentRecoveryOperationNow,
} from "@/lib/payment-recovery";
import { prisma } from "@/lib/prisma";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildReissuedAskStripeIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "@/lib/payment-recovery-keys";
import {
  CAPTURED_TRANSACTION_STATUS_LIST,
  isCapturedTransactionStatus,
} from "@/lib/payment-transaction-status";
import { reconcilePaymentAggregates } from "@/lib/payment-transactions";
import {
  ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE,
  recordedReissuedAskInvoiceCents,
} from "@/lib/unpaid-ask-offset-marker";
import { waitingSupplementaryInvoiceOperationsWhere } from "@/lib/xero-supplementary-invoice-statuses";

/** What a recovery a reduction netted off says about itself (#3954). */
export const PENDING_ASK_NETTED_BY_REDUCTION_NOTE =
  "Not minted: a price reduction set this unminted card request against the booking's lower price before its retry ran; anything still owed was asked for afresh (#3954).";

/**
 * How long after its claim a retry minting an ask is presumed alive (#3954
 * review round 4). A claim this recent refuses the reduction with a 409 "try
 * again in a moment" - the mint takes seconds. An older claim is a worker that
 * stalled or died: the reduction closes it under the attempts and claim-time
 * fence rather than wait out the 30-minute stale reaper, and a slow worker
 * that wakes afterwards finds its claim gone and writes nothing
 * (`holdAdditionalIntentRecoveryClaim`). The owner's "no edit is blocked"
 * (9 Oct 2026) holds outside this window.
 */
export const RECENT_RECOVERY_CLAIM_MS = 2 * 60 * 1000;

/** One unpaid row of the ask a reduction is set against. */
export type UnpaidPriceAskRow = {
  id: string;
  amountCents: number;
  stripePaymentIntentId: string | null;
};

/**
 * An ask whose mint failed and waits on its recovery (#3954, "retry nets it
 * off"): owed, but not yet a row. `attempts` is the fence - only a claim moves
 * it, so a retire that still matches it knows no retry ran in between.
 */
export type PendingAskRecovery = {
  id: string;
  bookingModificationId: string;
  /** An increase's failed mint, or a reduction's smaller re-issue (`sizeRecoveryReplayAsk`). */
  kind: "increase" | "reissue";
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  /**
   * The claim's own timestamp, part of the fence: a runner re-stamps it as it
   * writes its row (`holdAdditionalIntentRecoveryClaim`), so a close that
   * still matches it knows that runner wrote nothing since the read.
   */
  processingStartedAt: Date | null;
  /**
   * What the recovery adds to the rows' ask (`recoveryAskBeyondPaymentAskCents`).
   * 0 for a claimed retry a later row already overtook: nothing more is owed
   * for it, but it is still closed (or refuses the edit) so it cannot write.
   */
  askCents: number;
  /**
   * The supplementary invoice its replay would have raised once minted (#3954
   * decision A): an increase's own net where its edit had an issued primary
   * invoice (`hadIssuedXeroInvoice`), a re-issue's recorded figure
   * (`recordedReissuedAskInvoiceCents`), else 0.
   */
  invoiceCents: number;
};

export type UnpaidPriceAsk = {
  /** What the member is still asked for; 0 when nothing can be set against. */
  askCents: number;
  /**
   * The live ask and every unpaid ask it superseded since the last paid one -
   * all of it retires together, so the mirror cannot fall back to an older
   * unpaid row and read it as owed.
   */
  rows: readonly UnpaidPriceAskRow[];
  /** Asks still waiting on their mint's recovery; they retire with the rows. */
  recoveries: readonly PendingAskRecovery[];
};

export const NO_UNPAID_PRICE_ASK: UnpaidPriceAsk = { askCents: 0, rows: [], recoveries: [] };

/**
 * ONE EDIT'S NET, SET AGAINST THE ASK READ FOR IT - read ONCE per edit
 * (`readReductionAgainstUnpaidAsk`) and handed to everything that sizes or
 * settles that edit: the settlement options, `applyPaymentAdjustments`, a
 * guest acceptance's return route and the quote (#3954 review round 4).
 *
 * Two reads in one transaction could disagree: a capture landing between them
 * left the options sized on an ask the save no longer saw, so the save either
 * refunded the netted part untiered or tripped its guard with a 500. One read
 * means the retire's fence is the only place a capture can be noticed, and it
 * rolls the edit back with a 409. `netChargeCents` travels with the read so a
 * consumer handed a read for a different net refuses it.
 */
export type ReductionAgainstUnpaidAsk = {
  readonly netChargeCents: number;
  readonly ask: UnpaidPriceAsk;
} & ReturnType<typeof setReductionAgainstUnpaidAsk>;

/** Nothing set against: an increase, an unpriced edit, or a booking with no ask. */
export function noReductionAgainstUnpaidAsk(netChargeCents: number): ReductionAgainstUnpaidAsk {
  return {
    netChargeCents,
    ask: NO_UNPAID_PRICE_ASK,
    ...setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents: 0 }),
  };
}

/**
 * Read the booking's unpaid price ask for an edit whose own net is
 * `netChargeCents`, and set the reduction against it. An increase reads
 * nothing. The ONE read per edit; see `ReductionAgainstUnpaidAsk`.
 */
export async function readReductionAgainstUnpaidAsk(
  db: UnpaidAskDb,
  booking: UnpaidAskBooking,
  netChargeCents: number,
): Promise<ReductionAgainstUnpaidAsk> {
  if (netChargeCents >= 0) return noReductionAgainstUnpaidAsk(netChargeCents);
  const ask = await readUnpaidPriceAsk(db, booking);
  return {
    netChargeCents,
    ask,
    ...setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents: ask.askCents }),
  };
}

/**
 * The guard every consumer runs: the read it was handed was taken for THIS
 * edit's net. A mismatch is a caller bug, never a race, so it is a plain error.
 */
export function assertReductionReadForNet(
  reduction: ReductionAgainstUnpaidAsk,
  netChargeCents: number,
  bookingId: string,
): void {
  if (reduction.netChargeCents !== netChargeCents) {
    throw new Error(
      `INV-PAY-120 (#3954): booking ${bookingId}'s unpaid ask was read for a different net than the edit it was handed to; read it once for this edit (readReductionAgainstUnpaidAsk).`,
    );
  }
}

export type UnpaidAskDb = Pick<
  Prisma.TransactionClient,
  "paymentTransaction" | "bookingModification" | "paymentRecoveryOperation"
>;

type UnpaidAskBooking = {
  id: string;
  status: string;
  payment: {
    id: string;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
    additionalPaymentIntentId: string | null;
  } | null;
};

/**
 * The unpaid price ask a reduction on this booking may be set against, or
 * nothing: the ask the ledger rows carry, plus any ask whose mint failed and is
 * waiting on its recovery (#3954, owner decision 9 Oct 2026). The settlement
 * options, the save and the quote all read this, so they agree; anything it
 * cannot size safely nets nothing, and the reduction settles as before.
 */
export async function readUnpaidPriceAsk(
  db: UnpaidAskDb,
  booking: UnpaidAskBooking,
): Promise<UnpaidPriceAsk> {
  const payment = booking.payment;
  if (!payment) return NO_UNPAID_PRICE_ASK;
  const operations = await inFlightAskRecoveries(db, booking, payment);
  if (operations.length === 0 && !isAdditionalPaymentOwed({ bookingStatus: booking.status, payment })) {
    return NO_UNPAID_PRICE_ASK;
  }
  const transactions = await db.paymentTransaction.findMany({
    where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      source: true,
      status: true,
      reason: true,
      amountCents: true,
      stripePaymentIntentId: true,
      createdAt: true,
      withdrawnAt: true,
    },
  });
  // Read only once something needs it: a chain whose rows match its mirror, or
  // a waiting recovery to size.
  let modifications: EditFigures[] | null = null;
  const loadModifications = async () =>
    (modifications ??= await db.bookingModification.findMany({
      where: { bookingId: booking.id },
      select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true },
    }));
  const chain = await unpaidChain(booking, payment, transactions, loadModifications);
  if (!chain) return NO_UNPAID_PRICE_ASK;
  const recoveries =
    operations.length > 0
      ? pendingAskRecoveries(booking, payment, operations, transactions, await loadModifications())
      : [];
  if (!recoveries) return NO_UNPAID_PRICE_ASK;
  const askCents =
    chain.askCents + recoveries.reduce((sum, recovery) => sum + recovery.askCents, 0);
  return askCents > 0 ? { askCents, rows: chain.rows, recoveries } : NO_UNPAID_PRICE_ASK;
}

type EditFigures = { id: string; priceDiffCents: number; changeFeeCents: number; newData?: unknown };

type AskTransaction = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
  amountCents: number;
  stripePaymentIntentId: string | null;
  createdAt: Date;
  withdrawnAt: Date | null;
};

/**
 * The ask the ledger rows carry. The `Payment` mirror says whether one is owed
 * (`isAdditionalPaymentOwed`, the chase's own predicate); the rows say which
 * they are. Null - net nothing - when the mirror disagrees with its newest row
 * or a row is review-raised.
 */
async function unpaidChain(
  booking: UnpaidAskBooking,
  payment: NonNullable<UnpaidAskBooking["payment"]>,
  transactions: readonly AskTransaction[],
  loadModifications: () => Promise<readonly EditFigures[]>,
): Promise<{ askCents: number; rows: UnpaidPriceAskRow[] } | null> {
  if (!isAdditionalPaymentOwed({ bookingStatus: booking.status, payment })) {
    return { askCents: 0, rows: [] };
  }
  const rows = transactions.filter((row) => !row.withdrawnAt);
  let lastPaid = -1;
  rows.forEach((row, index) => {
    if (isCapturedTransactionStatus(row.status)) lastPaid = index;
  });
  const chain = rows.slice(lastPaid + 1);
  const live = chain.at(-1);
  // The mirror is derived from the newest row (`reconcilePaymentAggregates`);
  // a disagreement is a mirror this edit did not write, and it is not guessed at.
  if (
    !live ||
    live.source !== PaymentSource.STRIPE ||
    live.amountCents !== payment.additionalAmountCents ||
    live.stripePaymentIntentId !== payment.additionalPaymentIntentId
  ) {
    logger.warn(
      { bookingId: booking.id, paymentId: payment.id },
      "An unpaid additional ask does not match its ledger row; a reduction settles without setting against it (#3954)",
    );
    return null;
  }
  const modifications = await loadModifications();
  const reviewRaised = chain.some((row) =>
    modifications.some((modification) => isEditReviewChargeRequestRow(row, modification.id)),
  );
  if (reviewRaised) return null;
  return {
    askCents: live.amountCents,
    rows: chain.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      stripePaymentIntentId: row.stripePaymentIntentId,
    })),
  };
}

/** The additional-ask recoveries the runner will still make (`isPaymentRecoveryOperationInFlight`). */
async function inFlightAskRecoveries(
  db: UnpaidAskDb,
  booking: UnpaidAskBooking,
  payment: NonNullable<UnpaidAskBooking["payment"]>,
): Promise<AskRecoveryOperation[]> {
  // The replay mints nothing for a cancelled booking (#1358).
  if (booking.status === BookingStatus.CANCELLED) return [];
  const operations = await db.paymentRecoveryOperation.findMany({
    where: {
      paymentId: payment.id,
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      // Everything not finished, as the replay's own completion fences it;
      // which of those will still run is `isPaymentRecoveryOperationInFlight`'s.
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      attempts: true,
      nextRetryAt: true,
      processingStartedAt: true,
      idempotencyKey: true,
      paymentIntentId: true,
      amountCents: true,
      hadIssuedXeroInvoice: true,
      createdAt: true,
    },
  });
  return operations.filter(
    (operation) => isPaymentRecoveryOperationInFlight(operation) && operation.amountCents > 0,
  );
}

type AskRecoveryOperation = {
  id: string;
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  nextRetryAt: Date | null;
  processingStartedAt: Date | null;
  idempotencyKey: string;
  /** The Stripe key until its replay mints, then that intent's id. */
  paymentIntentId: string;
  amountCents: number;
  hadIssuedXeroInvoice: boolean | null;
  createdAt: Date;
};

/**
 * Asks whose mint failed and that their recovery will still mint, each sized
 * exactly as that replay will size it (`sizeRecoveryReplayAsk`), less what it
 * would carry from the rows' ask, which `unpaidChain` already counts. A
 * recovery with nothing left to mint (`isRecoveryReplaySettled`, the replay's
 * own rule) is not owed. Null - net nothing - for one this cannot size.
 *
 * ONLY THE MEMBER'S OWN PRICE ASKS (#3954, owner decision 9 Oct 2026, "Only
 * the member's request"). A review charge's recovery is an officer's money
 * (`INV-ADDPAY-040`): it is left exactly as set - not counted, not closed -
 * and the reduction still nets against the price asks beside it. (It used to
 * turn netting off for the whole booking.) When it mints, it carries what the
 * price ask then is, the reduction's smaller re-issue included.
 */
function pendingAskRecoveries(
  booking: UnpaidAskBooking,
  payment: NonNullable<UnpaidAskBooking["payment"]>,
  operations: readonly AskRecoveryOperation[],
  transactions: readonly AskTransaction[],
  modifications: readonly EditFigures[],
): PendingAskRecovery[] | null {
  const pending: PendingAskRecovery[] = [];
  for (const operation of operations) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) continue;
    const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(
      operation.idempotencyKey,
    );
    const modification = modifications.find((row) => row.id === bookingModificationId) ?? null;
    const replay = bookingModificationId
      ? sizeRecoveryReplayAsk({ frozenAmountCents: operation.amountCents, modification, payment })
      : null;
    const askCents = replay ? recoveryAskBeyondPaymentAskCents(replay) : null;
    if (!bookingModificationId || !replay || replay.kind === "frozen" || askCents === null) {
      logger.warn(
        { bookingId: booking.id, paymentId: payment.id, operationId: operation.id },
        "An additional ask waiting on its recovery cannot be sized; a reduction settles without setting against it (#3954)",
      );
      return null;
    }
    // CLAIMED FIRST, THEN SETTLED (review round 4). A retry already minting
    // may have written its own row and still be on its way to its supersede
    // and its invoice; skipping it as settled would leave it free to finish
    // beside this reduction. So a claimed retry is always carried to the
    // retire, which refuses or fences it; it adds nothing to the ask when a
    // row already carries it.
    const claimed = operation.status === PaymentRecoveryOperationStatus.PROCESSING;
    const settled = isRecoveryReplaySettled(replay, operation, transactions);
    if (settled && !claimed) continue;
    pending.push({
      id: operation.id,
      bookingModificationId,
      kind: replay.kind,
      status: operation.status,
      attempts: operation.attempts,
      // Never `undefined`: an undefined filter is no filter at all in Prisma.
      processingStartedAt: operation.processingStartedAt ?? null,
      askCents: settled ? 0 : askCents,
      invoiceCents: settled
        ? 0
        : replay.kind === "reissue"
          ? recordedReissuedAskInvoiceCents(modification?.newData)
          : operation.hadIssuedXeroInvoice === true
            ? askCents
            : 0,
    });
  }
  return pending;
}

/** A retired ask's intent, and the durable cancellation queued for it. */
export type RetiredAdditionalAsk = {
  paymentTransactionId: string;
  paymentIntentId: string;
  cancelOperationId: string;
};

/**
 * Retire the ask a reduction was set against, inside the edit's transaction and
 * under its locks. Throws `AdditionalAskChangedDuringReductionError` (409) when
 * a row was captured since it was read, so the edit rolls back rather than
 * release a member from money they just paid - or when a pending ask's retry
 * claimed it since, or claimed it moments ago and may be minting it now.
 */
export async function retireUnpaidAskChain(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    ask,
    now = new Date(),
  }: {
    bookingId: string;
    paymentId: string;
    ask: UnpaidPriceAsk;
    now?: Date;
  },
): Promise<RetiredUnpaidAsk> {
  const retired: RetiredAdditionalAsk[] = [];
  for (const row of ask.rows) {
    // THE FENCE: still unpaid and still unretired, or the whole edit rolls back.
    const stamped = await tx.paymentTransaction.updateMany({
      where: {
        id: row.id,
        withdrawnAt: null,
        status: { notIn: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      },
      data: { status: PaymentStatus.FAILED, withdrawnAt: now },
    });
    if (stamped.count !== 1) {
      throw new AdditionalAskChangedDuringReductionError();
    }
    if (!row.stripePaymentIntentId) continue;
    const operation = await enqueuePaymentIntentCancellationRecovery({
      bookingId,
      paymentId,
      paymentTransactionId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      amountCents: row.amountCents,
      store: tx,
    });
    // An older row an earlier supersede already cancelled keeps its finished
    // operation (the upsert never reopens one); there is nothing to run now.
    if (operation.status === PaymentRecoveryOperationStatus.SUCCEEDED) continue;
    retired.push({
      paymentTransactionId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      cancelOperationId: operation.id,
    });
  }

  await closeWaitingAskRecoveries(tx, ask.recoveries, now);

  const intentIds = ask.rows.flatMap((row) =>
    row.stripePaymentIntentId ? [row.stripePaymentIntentId] : [],
  );
  let parkedInvoicedCents = 0;
  const parkedAnchors = new Set<string>();
  if (intentIds.length > 0 || ask.recoveries.length > 0) {
    // The increase's supplementary invoice waits on its card payment and is
    // never raised before it, so nothing reached Xero for the ask; the parked
    // operation is retired, as a withdrawal retires one (`INV-ADDPAY-040`).
    // An unminted ask's invoice, if one was parked, waits on its edit instead.
    const parkedWhere = {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      OR: [
        ...intentIds.map((intentId) => ({
          requestPayload: { path: ["paymentIntentId"], equals: intentId },
        })),
        ...ask.recoveries.map((recovery) =>
          waitingSupplementaryInvoiceOperationsWhere(recovery.bookingModificationId),
        ),
      ],
    } satisfies Prisma.XeroSyncOperationWhereInput;
    // Decision A (#3954, 9 Oct 2026): what those parked invoices would have
    // billed, so the smaller re-issued ask's own invoice bills exactly what is
    // left of it - read in this transaction, before they are retired.
    for (const parked of await tx.xeroSyncOperation.findMany({
      where: parkedWhere,
      select: { localModel: true, localId: true, requestPayload: true },
    })) {
      const payload = parked.requestPayload && typeof parked.requestPayload === "object" && !Array.isArray(parked.requestPayload)
        ? (parked.requestPayload as Record<string, unknown>)
        : {};
      const priceDiffCents = Number.isInteger(payload.priceDiffCents) ? (payload.priceDiffCents as number) : 0;
      const changeFeeCents = Number.isInteger(payload.changeFeeCents) ? (payload.changeFeeCents as number) : 0;
      parkedInvoicedCents += Math.max(0, priceDiffCents + changeFeeCents);
      if (parked.localModel === "BookingModification" && parked.localId) parkedAnchors.add(parked.localId);
    }
    await tx.xeroSyncOperation.updateMany({
      where: parkedWhere,
      data: {
        status: "CANCELLED",
        completedAt: now,
        lastErrorCode: ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE,
        lastErrorMessage:
          "Retired: a price reduction cancelled or re-issued the unpaid card request this invoice was waiting on (#3954).",
      },
    });
  }

  await reconcilePaymentAggregates({ paymentId, store: tx });
  // A waiting ask had no parked invoice to read: what its replay would have
  // raised once minted is carried on it (`PendingAskRecovery.invoiceCents`).
  const unparkedInvoicedCents = ask.recoveries
    .filter((recovery) => !parkedAnchors.has(recovery.bookingModificationId))
    .reduce((sum, recovery) => sum + recovery.invoiceCents, 0);
  return {
    retired,
    invoicedCents: parkedInvoicedCents + unparkedInvoicedCents,
    retiredAskModificationIds: [
      ...new Set([...parkedAnchors, ...ask.recoveries.map((recovery) => recovery.bookingModificationId)]),
    ],
  };
}

/**
 * What `retireUnpaidAskChain` retired: the intents to cancel at Stripe, what
 * the retired asks' supplementary invoices would have billed (decision A sizes
 * the re-issue's invoice from it), and the edits whose asks they were - parked
 * invoices' anchors and waiting recoveries' edits - for the reduction's history.
 */
export type RetiredUnpaidAsk = {
  retired: RetiredAdditionalAsk[];
  invoicedCents: number;
  retiredAskModificationIds: string[];
};

/**
 * Close asks still waiting on their failed mint's recovery, under the caller's
 * locks, so the retry cannot mint their old figure: the reduction that nets
 * them off (`retireUnpaidAskChain`) and the increase that folds a waiting
 * re-issue in (`foldWaitingReissuedAsks`). Throws
 * `AdditionalAskChangedDuringReductionError` (409) when one moved since it was
 * read, or was claimed moments ago and is minting now.
 */
async function closeWaitingAskRecoveries(
  tx: Pick<Prisma.TransactionClient, "paymentRecoveryOperation">,
  recoveries: readonly PendingAskRecovery[],
  now: Date,
  note: string = PENDING_ASK_NETTED_BY_REDUCTION_NOTE,
): Promise<void> {
  for (const recovery of recoveries) {
    // THE RETRY NETS IT OFF (#3954, owner decision 9 Oct 2026): an ask whose
    // mint failed is closed here, under the edit's locks, and what is left of
    // it is minted after commit with the rest (`reissueUnpaidAdditionalAsk`).
    // A retry claimed moments ago is minting it right now and refuses the edit
    // for a moment: closing the row under it would leave its old figure live
    // beside the smaller ask. An older claim is a stalled or dead worker - it
    // is closed like any other, and the fence below is what stops it writing.
    if (
      recovery.status === PaymentRecoveryOperationStatus.PROCESSING &&
      (recovery.processingStartedAt === null ||
        now.getTime() - recovery.processingStartedAt.getTime() < RECENT_RECOVERY_CLAIM_MS)
    ) {
      throw new AdditionalAskChangedDuringReductionError(ADDITIONAL_ASK_BEING_RAISED_MESSAGE);
    }
    // THE FENCE: exactly the state read. Only a claim moves `attempts`, and a
    // claimed runner re-stamps `processingStartedAt` in the same statement that
    // lets it write its row (`holdAdditionalIntentRecoveryClaim`). So a retry
    // that claimed or wrote since the read rolls this edit back, and one that
    // comes after finds nothing to claim or to write.
    const closed = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: recovery.id,
        status: recovery.status,
        attempts: recovery.attempts,
        processingStartedAt: recovery.processingStartedAt,
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
        processingStartedAt: null,
        succeededAt: now,
        lastError: note,
      },
    });
    if (closed.count !== 1) {
      throw new AdditionalAskChangedDuringReductionError();
    }
  }
}

/** What a waiting re-issue an increase folded in says about itself (#3954 round 4). */
export const WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE =
  "Not minted: a later price increase asked for this re-issued card request together with its own extra, on one fresh ask (#3954).";

/**
 * #3954 review round 4: A LATER INCREASE ASKS FOR A WAITING RE-ISSUE TOO.
 *
 * A reduction's smaller re-issue waits on its recovery until it is minted - for
 * the door's one-minute grace, or longer when that mint failed. Nothing on the
 * `Payment` shows it, so an increase sized off the `Payment` alone
 * (`sizeAdditionalAsk`) asked only for its own money; its mint then overtook
 * the re-issue and, under #3340's rule, the re-issue's whole figure was lost -
 * or, inside the grace, the door's re-issue minted after it and superseded the
 * increase's ask instead. The increase now folds every waiting re-issue into
 * its own ask as carried money (`INV-PAY-098`) and closes it under its locks,
 * fenced exactly as a reduction closes one (`closeWaitingAskRecoveries`), so
 * one fresh ask asks for both. Returns what it folded, for `sizeAdditionalAsk`.
 *
 * Re-issues only. An increase's own failed mint keeps #3340's rule, under
 * which a later ask overtakes it; that is not this change's to move.
 */
export async function foldWaitingReissuedAsks(
  tx: UnpaidAskDb,
  booking: UnpaidAskBooking,
  now: Date = new Date(),
): Promise<number> {
  const payment = booking.payment;
  if (!payment) return 0;
  const operations = await inFlightAskRecoveries(tx, booking, payment);
  if (operations.length === 0) return 0;
  const [transactions, modifications] = await Promise.all([
    tx.paymentTransaction.findMany({
      where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
      select: { kind: true, createdAt: true, stripePaymentIntentId: true },
    }),
    tx.bookingModification.findMany({
      where: { bookingId: booking.id },
      select: { id: true, priceDiffCents: true, changeFeeCents: true },
    }),
  ]);
  const waiting: PendingAskRecovery[] = [];
  for (const operation of operations) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) continue;
    const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(operation.idempotencyKey);
    if (!bookingModificationId) continue;
    const replay = sizeRecoveryReplayAsk({
      frozenAmountCents: operation.amountCents,
      modification: modifications.find((row) => row.id === bookingModificationId) ?? null,
      payment,
    });
    if (replay.kind !== "reissue" || isRecoveryReplaySettled(replay, operation, transactions)) continue;
    waiting.push({
      id: operation.id,
      bookingModificationId,
      kind: replay.kind,
      status: operation.status,
      attempts: operation.attempts,
      processingStartedAt: operation.processingStartedAt ?? null,
      askCents: replay.frozenCents,
      invoiceCents: 0,
    });
  }
  await closeWaitingAskRecoveries(tx, waiting, now, WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE);
  return waiting.reduce((sum, recovery) => sum + recovery.askCents, 0);
}

/**
 * After commit: cancel the retired asks' intents at Stripe now, rather than at
 * the recovery cron's next pass. Best-effort - the queued rows written in the
 * edit's transaction are the guarantee, and a capture before the cancel lands
 * is refunded by the superseded-capture path.
 */
export async function cancelRetiredAdditionalAsksNow({
  format,
  bookingId,
  retired,
}: {
  format: ClubFormat;
  bookingId: string;
  retired: readonly RetiredAdditionalAsk[];
}): Promise<void> {
  for (const entry of retired) {
    const outcome = await runPaymentRecoveryOperationNow(entry.cancelOperationId, format).catch(
      (err) => {
        logger.error(
          { err, bookingId, paymentIntentId: entry.paymentIntentId },
          "Immediate cancellation of an ask a reduction retired did not run; the queued recovery operation stands",
        );
        return "failed" as const;
      },
    );
    if (outcome !== "succeeded") {
      logger.warn(
        { bookingId, paymentIntentId: entry.paymentIntentId, operationId: entry.cancelOperationId, outcome },
        "An ask a reduction retired was not cancelled immediately; it stays confirmable until the queued recovery operation runs, and a capture in that window is refunded (#3954)",
      );
    }
  }
}

/**
 * How long the door's own after-commit mint has a re-issued ask to itself
 * before the recovery runner may claim it (#3954 review round 4).
 */
export const REISSUED_ASK_INLINE_MINT_GRACE_MS = 60 * 1000;

/**
 * #3954 review round 4: THE RE-ISSUED ASK IS DURABLE FROM THE EDIT'S COMMIT.
 *
 * A reduction that shrinks an unpaid ask retires the old one inside its
 * transaction and used to mint the smaller one only after commit - so a
 * process dying in between left the member asked for nothing, with nothing to
 * retry. The edit now writes, in its own transaction and once its
 * `BookingModification` row exists, a PENDING `CREATE_ADDITIONAL_PAYMENT_INTENT`
 * recovery carrying the re-issued figure under a Stripe key scoped to the edit
 * (`buildReissuedAskStripeIdempotencyKey`), claimable only after
 * `REISSUED_ASK_INLINE_MINT_GRACE_MS`. The door's own mint after commit reads
 * the row and completes it (`writeReissuedAskUnderRecovery`); if that never
 * happens, the runner replays it under the same key, so the two converge on
 * one intent. Its edit's own net is negative, which is how the replay knows it
 * as a re-issue (`sizeRecoveryReplayAsk`). Nothing for any other edit.
 */
export async function queueReissuedAskRecovery(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    bookingModificationId,
    settled,
    now = new Date(),
  }: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    settled: { additionalAsk: AdditionalAsk; hasIssuedXeroInvoice: boolean };
    now?: Date;
  },
): Promise<void> {
  if (!settled.additionalAsk.reissuesUnpaidAsk || settled.additionalAsk.amountCents <= 0 || !paymentId) {
    return;
  }
  await enqueueAdditionalPaymentIntentRecovery({
    bookingId,
    paymentId,
    idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId),
    amountCents: settled.additionalAsk.amountCents,
    stripeIdempotencyKey: buildReissuedAskStripeIdempotencyKey(bookingModificationId),
    hadIssuedXeroInvoice: settled.hasIssuedXeroInvoice,
    nextRetryAt: new Date(now.getTime() + REISSUED_ASK_INLINE_MINT_GRACE_MS),
    store: tx,
  });
}

/** A re-issued ask's recovery, as the door's after-commit mint reads it. */
export type ReissuedAskRecovery = {
  id: string;
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  processingStartedAt: Date | null;
  /** The Stripe key frozen in the edit's transaction. */
  paymentIntentId: string;
};

/** The recovery `queueReissuedAskRecovery` wrote for this edit, if any. */
export async function readReissuedAskRecovery(
  bookingModificationId: string,
): Promise<ReissuedAskRecovery | null> {
  return prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId) },
    select: { id: true, status: true, attempts: true, processingStartedAt: true, paymentIntentId: true },
  });
}

/**
 * The door's own mint of a re-issued ask, WRITTEN ONLY WHILE ITS RECOVERY IS
 * STILL UNCLAIMED: the recovery is completed - fenced on exactly the state the
 * mint read - in one transaction with the ask's row and its supersede's durable
 * rows (`write`). A later reduction that netted the waiting re-issue off, or a
 * runner that claimed it after the grace, moved that state, so this writes
 * nothing (null) and the member is asked through whichever owns it now.
 */
export async function writeReissuedAskUnderRecovery<T>(
  recovery: ReissuedAskRecovery,
  paymentIntentId: string,
  write: (store: Prisma.TransactionClient) => Promise<T>,
  now: Date = new Date(),
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const completed = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: recovery.id,
        status: PaymentRecoveryOperationStatus.PENDING,
        attempts: recovery.attempts,
        processingStartedAt: recovery.processingStartedAt ?? null,
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        paymentIntentId,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: null,
        succeededAt: now,
      },
    });
    if (completed.count !== 1) return null;
    return write(tx);
  });
}

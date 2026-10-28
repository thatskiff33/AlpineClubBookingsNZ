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

import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { readOrganiserExtraReduction, organiserExtraUnpaidCents, type OrganiserExtraReduction } from "@/lib/organiser-extra-state";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { reductionLeftAfterUnpaidAskCents, setReductionAgainstUnpaidAsk } from "@/lib/additional-payment-ask";
import { pendingAskRecoveries, type AskRecoveryOperation } from "@/lib/additional-ask-pending-recoveries";
import {
  AdditionalAskChangedDuringReductionError,
  isWriteConflictOrDeadlock,
} from "@/lib/additional-ask-reduction-error";
import { closeWaitingAskRecoveries } from "@/lib/additional-ask-recovery-close";
import { isEditReviewChargeRequestRow } from "@/lib/edit-financial-review-charge-shape";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { enqueuePaymentIntentCancellationRecovery } from "@/lib/payment-recovery";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import {
  CAPTURED_TRANSACTION_STATUS_LIST,
  isCapturedTransactionStatus,
} from "@/lib/payment-transaction-status";
import {
  CREDIT_RELEASE_ASK_REASON,
  CREDIT_RELEASE_ASK_RECOVERY_PREFIX,
} from "@/lib/credit-release-ask-keys";
import { lockPaymentForRefundedTotal, reconcilePaymentAggregates } from "@/lib/payment-transactions";
import { ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE } from "@/lib/unpaid-ask-offset-marker";
import { waitingSupplementaryInvoiceOperationsWhere } from "@/lib/xero-supplementary-invoice-statuses";
import { supplementaryInvoiceWaitedFirstOn } from "@/lib/supplementary-invoice-parked-from";

/** One unpaid row of the ask a reduction is set against. */
export type UnpaidPriceAskRow = {
  id: string;
  amountCents: number;
  stripePaymentIntentId: string | null;
  /** #3954 round 6: what Xero billed of it is read from these (`unpaidAskBillingEvidence`). */
  carriedAskCents: number;
  reason: string | null;
  createdAt: Date;
  /** Round 7: the asking edit's own invoice answer, stamped by its door's mint (null: not recorded). */
  hadIssuedXeroInvoice: boolean | null;
  /** Round 8: the edit whose ask the row is, stamped by its mint (null: not recorded). */
  bookingModificationId: string | null;
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
  /**
   * #3954 round 6: what the invoices of the re-issues an increase folded in
   * bill (`recordedFoldedReissuedAskInvoiceCents`) - queued only once that
   * increase mints, so never parked anywhere yet; 0 for a re-issue.
   */
  foldedInvoiceCents: number;
  /**
   * #3954 round 6: an increase's recovery that recorded no answer to whether
   * the primary invoice existed when it was saved (`hadIssuedXeroInvoice`
   * null, a pre-#3181 row): what Xero billed of it cannot be established.
   * Round 8: or a re-issue whose reduction recorded its invoice as unsure
   * (`reissuedAskInvoiceUnsureCents`).
   */
  invoiceUnknown: boolean;
  /** Round 8: an increase folded in a re-issue whose reduction was unsure of its invoice. */
  foldedInvoiceUnknown: boolean;
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
  readonly organiserExtras?: OrganiserExtraReduction;
} & ReturnType<typeof setReductionAgainstUnpaidAsk>;

/**
 * Round 7 (`INV-SSOT-001`): what of THIS edit's reduction is left to refund,
 * credit or note once the unpaid ask took its offset - 0 for an increase. The
 * one reading of a read's `netChargeLeftCents` for the quote, the options'
 * guard and a guest acceptance's return route, said by the rule the repair
 * pass reads off recorded history (`reductionLeftAfterUnpaidAskCents`).
 */
export function reductionLeftAfterAskCents(
  reduction: Pick<ReductionAgainstUnpaidAsk, "netChargeCents" | "offsetCents">,
): number {
  return reductionLeftAfterUnpaidAskCents({
    netAmountCents: reduction.netChargeCents,
    unpaidAskOffsetCents: reduction.offsetCents,
  });
}

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
  booking: ReductionBooking,
  netChargeCents: number,
): Promise<ReductionAgainstUnpaidAsk> {
  if (netChargeCents >= 0) return noReductionAgainstUnpaidAsk(netChargeCents);
  // #4299 (N1-N4): an organiser-paid bank place's reduction nets its unpaid extra invoices first.
  if (paidByOrganiserInternetBanking(booking)) {
    const organiserExtras = await readOrganiserExtraReduction(db, booking.id, -netChargeCents);
    if (organiserExtras.invoices.length > 0) {
      const unpaidAskCents = organiserExtras.invoices.reduce((sum, invoice) => sum + organiserExtraUnpaidCents(invoice), 0);
      return { netChargeCents, ask: NO_UNPAID_PRICE_ASK, organiserExtras, ...setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents }) };
    }
  }
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
  // #4217: `$executeRaw` for the Payment row lock a fold-close takes first.
  "paymentTransaction" | "bookingModification" | "paymentRecoveryOperation" | "$executeRaw" | "xeroObjectLink" | "xeroSyncOperation"
>;

export type UnpaidAskBooking = {
  id: string;
  status: string;
  payment: {
    id: string;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
    additionalPaymentIntentId: string | null;
  } | null;
};

/** #4299: what the reduction reader also needs, to know an organiser-paid bank place. */
export type ReductionBooking = UnpaidAskBooking & {
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: (NonNullable<UnpaidAskBooking["payment"]> & { source: string }) | null;
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
    // #4132 (INV-PAY-133): insertion order on a tie, so the chain's last row
    // is the row the mirror was derived from (`latestTransactionOfKind`).
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: {
      id: true,
      kind: true,
      source: true,
      status: true,
      reason: true,
      amountCents: true,
      carriedAskCents: true,
      stripePaymentIntentId: true,
      createdAt: true,
      withdrawnAt: true,
      hadIssuedXeroInvoice: true,
      bookingModificationId: true,
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

export type EditFigures = { id: string; priceDiffCents: number; changeFeeCents: number; newData: unknown };

export type AskTransaction = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
  amountCents: number;
  carriedAskCents: number;
  stripePaymentIntentId: string | null;
  createdAt: Date;
  withdrawnAt: Date | null;
  hadIssuedXeroInvoice: boolean | null;
  bookingModificationId: string | null;
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
  // #4253: a credit-release request is not an edit's price ask either. Netting a reduction
  // against it would retire it and re-issue a smaller one under the reissue reason, which the
  // Xero payment sweep (`credit-release-xero-payment.ts`) does not recognise.
  if (chain.some((row) => row.reason === CREDIT_RELEASE_ASK_REASON)) return null;
  return {
    askCents: live.amountCents,
    rows: chain.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      stripePaymentIntentId: row.stripePaymentIntentId,
      carriedAskCents: row.carriedAskCents,
      reason: row.reason,
      createdAt: row.createdAt,
      hadIssuedXeroInvoice: row.hadIssuedXeroInvoice,
      bookingModificationId: row.bookingModificationId,
    })),
  };
}

/** The additional-ask recoveries the runner will still make (`isPaymentRecoveryOperationInFlight`). */
export async function inFlightAskRecoveries(
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
      // #4253: a credit-release request is not an edit's price ask - it has no edit to
      // size from, and its money rides on the booking's own invoice (`INV-ADDPAY-045`).
      NOT: { idempotencyKey: { startsWith: CREDIT_RELEASE_ASK_RECOVERY_PREFIX } },
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
  try {
    return await retireUnpaidAskChainUnderLocks(tx, { bookingId, paymentId, ask, now });
  } catch (err) {
    // Round 6: a deadlock with the webhook or the runner is the same 409.
    // Round 7: logged, and kept as the 409's cause, so the database's own
    // error is not lost behind the member's "try again".
    if (isWriteConflictOrDeadlock(err)) {
      logger.warn(
        { err, bookingId, paymentId },
        "A price reduction's retire of the unpaid ask deadlocked or met a write conflict; the edit rolls back with a 409 (#3954)",
      );
      throw new AdditionalAskChangedDuringReductionError(undefined, { cause: err });
    }
    throw err;
  }
}

async function retireUnpaidAskChainUnderLocks(
  tx: Prisma.TransactionClient,
  { bookingId, paymentId, ask, now }: { bookingId: string; paymentId: string; ask: UnpaidPriceAsk; now: Date },
): Promise<RetiredUnpaidAsk> {
  // #4217 (`INV-LOCK-002`): the Payment row FIRST, then the waiting
  // recoveries, then the ask's rows - the one order the capture webhook
  // (Payment, then its row), the runner's claim hold and the re-issue door
  // (Payment, then the recovery, then the row) and a give-back that already
  // wrote the Payment row all take. Either row before the Payment row is a
  // deadlock with one of them.
  await lockPaymentForRefundedTotal(tx, paymentId);
  await closeWaitingAskRecoveries(tx, ask.recoveries, now);

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

  const intentIds = ask.rows.flatMap((row) =>
    row.stripePaymentIntentId ? [row.stripePaymentIntentId] : [],
  );
  let parkedInvoicedCents = 0;
  const parkedAnchors = new Set<string>();
  const parkedOps: ParkedAskInvoice[] = [];
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
      const anchorId = parked.localModel === "BookingModification" ? parked.localId : null;
      if (anchorId) parkedAnchors.add(anchorId);
      parkedOps.push({
        // #3403: the row whose own money it bills, even once moved onto a carrier.
        intentId: supplementaryInvoiceWaitedFirstOn(payload),
        anchorId,
      });
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
  const unparkedInvoicedCents =
    ask.recoveries
      .filter((recovery) => !parkedAnchors.has(recovery.bookingModificationId))
      .reduce((sum, recovery) => sum + recovery.invoiceCents, 0) +
    // Round 6: a folded re-issue's invoice is queued only once its increase mints.
    ask.recoveries.reduce((sum, recovery) => sum + recovery.foldedInvoiceCents, 0);
  return {
    retired,
    invoicedCents: parkedInvoicedCents + unparkedInvoicedCents,
    // Round 8: and every retired row's own edit, stamped by its mint - a door
    // that minted the row but has not yet queued its edit's invoice leaves no
    // parked anchor, and the repair pass must still read that edit's ask as
    // retired here rather than bill it again.
    retiredAskModificationIds: [
      ...new Set([
        ...parkedAnchors,
        ...ask.recoveries.map((recovery) => recovery.bookingModificationId),
        ...ask.rows.flatMap((row) => (row.bookingModificationId ? [row.bookingModificationId] : [])),
      ]),
    ],
    parkedOps,
    invoiceEvidenceUnknown: ask.recoveries.some(
      (recovery) =>
        (recovery.invoiceUnknown && !parkedAnchors.has(recovery.bookingModificationId)) ||
        recovery.foldedInvoiceUnknown,
    ),
  };
}

/** A parked supplementary invoice the retire read: the intent it waited on, and the edit it bills for. */
export type ParkedAskInvoice = { intentId: string | null; anchorId: string | null };

/**
 * What `retireUnpaidAskChain` retired: the intents to cancel at Stripe, what
 * the retired asks' supplementary invoices would have billed (decision A sizes
 * the re-issue's invoice from it), and the edits whose asks they were - parked
 * invoices' anchors, waiting recoveries' edits and (round 8) each retired row's
 * own edit - for the reduction's history.
 */
export type RetiredUnpaidAsk = {
  retired: RetiredAdditionalAsk[];
  invoicedCents: number;
  retiredAskModificationIds: string[];
  /** Round 6: the parked invoices it read, for what of the rows they cover (`unpaidAskBillingEvidence`). */
  parkedOps: ParkedAskInvoice[];
  /** Round 6: a waiting increase whose invoice answer was never recorded; round 8: or a waiting re-issue, or fold, recorded as unsure. */
  invoiceEvidenceUnknown: boolean;
};

import "server-only";

import { ManualRefundTaskKind, PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  PaidAnotherWayXeroChangedError,
  paidAnotherWayXeroAuditFollowUp,
  paidAnotherWayCardNoteCoversCents,
  paidAnotherWayXeroPlan,
  paidAnotherWayXeroPromise,
  queuePaidAnotherWayXero,
  type PaidAnotherWayXeroPlan,
  type PaidAnotherWayXeroPromise,
  type PaidAnotherWayXeroQueued,
} from "@/lib/card-refund-paid-another-way-xero";
import { PAID_BACK_CHOICES, type PaidBackChoice, type PaidBackRestChoice } from "@/lib/card-refund-paid-back";
import { closePaidAnotherWayRest, paidAnotherWayOutcome, paidBackChoiceRefusal, paidBackRestRefusal } from "@/lib/card-refund-paid-another-way-rest";
import { resolveBookingMoneyPostingContext } from "@/lib/member-money/doors";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { getClubFormat } from "@/lib/club-format-settings";
import { recordCardRefundMadeBeforePaidAnotherWay } from "@/lib/cancel-card-refund-paid-another-way-event";
import type { ClubTimeZone } from "@/lib/club-time";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX, normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { paidAnotherWayCardNoteCoverContext } from "@/lib/card-refund-paid-another-way-cash";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import {
  DEAD_CARD_REFUND_OPERATION_SELECT,
  DEAD_CARD_REFUND_PAYMENT_SELECT,
  DeadCardRefundActionError as CardRefundPaidAnotherWayError,
  deadCardRefundOperationWhere,
  deadCardRefundStillOwed,
  lastErrorSuggestsStripeMayHaveRefunded,
  laterStripeRefundsCovering,
  paidAnotherWayRefusal,
  supersededCloseFillsItsCharge,
  tryCardAgainRefusal,
  type LaterStripeRefund,
} from "@/lib/card-refund-dead-row";
import { deadRowClaimWhere, lockDeadCardRefundRow } from "@/lib/card-refund-dead-row-lock";
import { isOwedCardRefundOperation } from "@/lib/open-card-refund-owed";
import { prisma } from "@/lib/prisma";
import { isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
import {
  applyLocalRefundAllocation,
  RefundAllocationExceedsCapturedError,
  RefundAllocationRacedError,
} from "@/lib/payment-transactions";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"; 8 Oct 2026: "Keep it
 * together"): A DEAD CARD REFUND, CLOSED AS PAID ANOTHER WAY (`INV-PAY-122`).
 *
 * A card refund operation whose retries are spent stays owed - in "Refunds
 * owed" and off Net Collected (`openCardRefundOwedCents`) - until the treasurer
 * says the member was paid back another way, for example by bank transfer.
 * This is that close. It is the card refund's equivalent of completing a
 * by-hand hand-back (`resolveManualRefundTask`, local-allocation route), and
 * records the money the same way.
 *
 * - THE TERMINAL STATE IS THE EXISTING ONE. The operation moves to `SUCCEEDED`,
 *   the status every reader already takes as "nothing more to send"; no new
 *   enum value. `lastError` carries `PAID_ANOTHER_WAY_MARKER` for a person
 *   reading the row; NOTHING parses it - the persisted record is the task
 *   below. `nextRetryAt` is cleared, so no claim can take it again.
 * - DEAD MEANS THE RECOVERY MODULE'S DEAD (#3220): a status the worker would
 *   claim with no attempts left (`deadCardRefundOperationWhere`). The close is a
 *   status-guarded `updateMany` on exactly that, so a retry, a second click or a
 *   second treasurer loses the claim and nothing else is written.
 * - THE MONEY: `applyLocalRefundAllocation`, as a by-hand hand-back records it,
 *   placed first on the charges the card refund still had to send (its unsent
 *   slices, `cardRefundSlicesByOperation`). It raises `refundedAmountCents`, so
 *   the payment's refunded total says the money went back. No Stripe call: the
 *   card refund is over.
 * - FULL OR PART, SAID EXPLICITLY (owner, 8 Oct 2026: "Difference is gone",
 *   and "need a way for Treasurer to mark a partial versus only a full
 *   payment"). The treasurer chooses `paidBack`: "full" closes for exactly what
 *   is still owed; "partial" for more than nothing and less than that. Never
 *   for nothing, of any kind (#3924 round 7, M6), and only against the owed
 *   figure the treasurer saw (`expectedOwedCents`, round 7, C7). The
 *   choice is never inferred from the amount. #4516: a part close also says
 *   what happens to the rest, with no default (`card-refund-paid-another-way-rest.ts`).
 * - A SUPERSEDED INTENT'S REFUND closes in full only, on its own transaction,
 *   only while what it owes IS what that transaction still holds, never capped
 *   and never for nothing (#3924 round 5, F3): the reconciliation reads a
 *   closed one as that transaction refunded (`payment-reconciliation.ts`,
 *   predicate (b)).
 * - THE RECORD (#3924 round 4, M2): a `ManualRefundTask` born COMPLETED, of the
 *   hand-back kind, under `cardRefundPaidAnotherWayOccurrenceKey`, for the
 *   amount paid back - `raisedAmountCents` keeps what was still owed when it
 *   closed, and its reason says full or part - and the booking ledger's
 *   `BANK_REFUND` line anchored on it (`planHandBackLine`), keyed on the task.
 *   The census then explains the raised refunded total as a hand-back
 *   (`REFUND_MIRROR_HAND_BACK`), and the Xero cash evidence reads this row, not
 *   the wording above, to tell the bank transfer from a card refund
 *   (`readPaidAnotherWayCash`). It is never OPEN, so no queue, count or
 *   reopen sees it (`isCardRefundPaidAnotherWayTask`). The line is posted on a
 *   card payment, which `postHandBackLedgerLine` refuses: there the card refund
 *   posts from its refund row, and here there is none (`INV-MONEY-035`).
 * - XERO (#3924 round 4, M3; round 5, owner 8 Oct 2026: "Raise a refund note
 *   for all"): EVERY kind of card refund takes a refund note worded as a bank
 *   transfer (`INV-PAY-101`) - a cancellation's, an approved refund request's,
 *   an edit's or an edit review's, a late capture's and a superseded intent's.
 *   It is queued on this transaction for exactly the amount paid back and keyed
 *   on the record (`paidAnotherWayTaskId`), so it is sized on its own beside any
 *   card note. Each needs an invoice to credit (`paidAnotherWayXeroPlan`, F4).
 *   With none, no note is queued: the dialog says so before the close, and the
 *   record's key says so after it, for the cash evidence.
 * - A LATE CARD CHARGE XERO HOLDS NO RECEIPT FOR (#3924 round 6; owner, 8 Oct
 *   2026: "Record receipt, then credit"). The charge is still in the Stripe
 *   account, so the close records it first: it queues the charge's receipt -
 *   the kept-charge invoice paid from the Stripe account (`INV-PAY-110`), on
 *   the approval task - and the receipt's worker queues the bank-transfer note
 *   against it once it is in Xero (`notePaidAnotherWayCloseOnReceipt`). Xero
 *   then nets that charge to nil and shows both movements, matching the Stripe
 *   deposit and the bank payment. Never the booking's invoice, which the
 *   cancellation already cleared (#3635). The key says the note waits
 *   (`after-receipt`), and until the receipt is in Xero nothing may size a note
 *   for the money (`readPaidAnotherWayCash`).
 * - NOT HERE: an organiser child's refund (#3653) comes out of the organiser's
 *   combined card payment, which the child's payment has no ledger rows for; a
 *   group organiser-cancel settlement's refund is not owed on the payment it
 *   hangs on (`isOwedCardRefundOperation`). Both are refused.
 *
 * LOCKS (`INV-LOCK-001`; `lockDeadCardRefundRow`, shared with the other two
 * settlements of a dead row since #4368): the global key first - it moves a payment's refunded
 * total and closes a refund debt, which every edit, acceptance, paid cancel and
 * refund appeal reads separately to size a refund net of what is promised back
 * - then the operation is re-read, then the PAYMENT ROW
 * (`lockPaymentForRefundedTotal`, #3924 round 4, C1) BEFORE the payment is read,
 * so the owed figure the close is checked against cannot move under it: every
 * refunded-total writer without lock(1) - every Stripe refund recorder, and a
 * cancellation hand-back's completion - takes the Payment row first. Then the
 * claim, the allocation (which re-takes the row it holds), the record and the
 * line. No provider call runs under them; the Xero note is an outbox row,
 * kicked after the commit.
 *
 * A late capture's refund also takes its approval task's row
 * (`lockKeptLateCaptureTask`, #3924 round 6) after the payment row and BEFORE
 * it reads whether Xero has the charge's receipt: the receipt's worker writes
 * that receipt and queues a waiting close's note under the same row, so a close
 * either reads the receipt recorded and queues its note itself, or commits
 * first and is found by the worker. #4324 (CONC-1): a change capture's anchor
 * follows it (`lockKeptCaptureAnchor`): global -> Payment -> task row -> anchor.
 */

/** What `lastError` says on an operation closed here, for a person reading the row. Nothing parses it. */
export const PAID_ANOTHER_WAY_MARKER = "Closed by the treasurer: paid another way (#3372)";

/** The card refund operations the worker will never claim again (`card-refund-dead-row.ts`, #4368). */
export { deadCardRefundOperationWhere };

/**
 * A refusal with the status the route answers. Thrown before or inside the
 * transaction, so nothing commits. The one refusal class of every settlement of
 * a dead row (`DeadCardRefundActionError`, #4368 review D).
 */
export { CardRefundPaidAnotherWayError };

/** #3924 round 4 (M7): moved to `card-refund-dead-row.ts` (#4368), which "Try the card again" reads too. */
export { lastErrorSuggestsStripeMayHaveRefunded };

export interface DeadCardRefundRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  /** When the refund was started (ISO instant). */
  raisedAt: string;
  /** What it still owes, which a full close is for. */
  owedCents: number;
  /** A superseded intent's refund closes only for the whole of what it owes. */
  wholeAmountOnly: boolean;
  /**
   * How a close is recorded in Xero (`paidAnotherWayXeroPlan`): its refund note
   * queued with it (`now`), the late charge's receipt first and the note after
   * it (`after-receipt`), the note after a receipt already on its way to Xero
   * (`after-receipt-on-its-way`, round 8), the note after a receipt that
   * reaches Xero only through an officer's retry (`after-receipt-failed`,
   * `after-receipt-held-for-officer`, round 9), or no note (`none`).
   */
  xeroRefundNote: PaidAnotherWayXeroPromise;
  /**
   * #4104: how much of it a card refund note already in Xero answers - a refund
   * Stripe accepted, noted and failed later (`failedLaterCardNoteCoverCents`);
   * 0 for none. With it, `xeroRefundNote` is `covered-by-card-note`.
   */
  cardNoteCoversCents: number;
  /** Its last failure looked like a timeout or a network error, so Stripe may have refunded after all. */
  stripeMayHaveRefunded: boolean;
  /**
   * #4368: with nothing left owed (`owedCents` 0, and nothing of its own unsent),
   * the Stripe refunds the attribution gives it, which its "Nothing left owed"
   * close names (`laterStripeRefundsCovering`); empty while something is owed.
   */
  laterStripeRefunds: LaterStripeRefund[];
  /** #4368 (decision 5): why "Try the card again" may not re-arm it, or null when it may (`tryCardAgainRefusal`). */
  tryCardAgainRefusal: string | null;
  paidAnotherWayRefusal: string | null;
}

/**
 * The dead card refunds the treasurer can settle, oldest first, with what each
 * still owes. Organiser child refunds and group settlement refunds are left
 * out, as every action on the list refuses them. #4368 (owner decision, 25 Oct
 * 2026; review C): one that owes nothing stays on the list while Stripe
 * refunds the attribution gives it cover all of its own slices, naming them,
 * for its "Nothing left owed" close - "Paid
 * another way" never records $0 (#3924 round 7, M6), and no Xero plan is read
 * for it. One that owes nothing with no such refund is left out, as before: it
 * still counts among the payment recovery operations the stuck-states page
 * says need reconciling, for a developer.
 */
export async function listDeadCardRefunds(): Promise<DeadCardRefundRow[]> {
  const operations = await prisma.paymentRecoveryOperation.findMany({
    where: deadCardRefundOperationWhere,
    orderBy: { createdAt: "asc" },
    select: {
      ...DEAD_CARD_REFUND_OPERATION_SELECT,
      payment: { select: DEAD_CARD_REFUND_PAYMENT_SELECT },
      // #4368 review S1: a superseded intent's charge, which "Try the card again"'s check reads.
      paymentTransaction: { select: { paymentId: true, amountCents: true, refundedAmountCents: true } },
    },
  });
  const paymentIds = [...new Set(operations.map((operation) => operation.paymentId))];
  const charges =
    paymentIds.length === 0
      ? []
      : await prisma.paymentTransaction.findMany({
          where: { paymentId: { in: paymentIds } },
          select: { id: true, paymentId: true, amountCents: true, refundedAmountCents: true },
        });
  const listed = operations
    .filter(
      (operation) => isOwedCardRefundOperation(operation) && !isOrganiserChildRefundKey(operation.idempotencyKey),
    )
    .map((operation) => ({ operation, owed: deadCardRefundStillOwed(operation.payment, operation.id) }))
    .map((row) => ({ ...row, later: row.owed.owedCents === 0 ? laterStripeRefundsCovering(row.operation.payment, row.operation.id) : [] }))
    // #4368 review C: with nothing owed and no Stripe refund the attribution gives this row - a $0 off the payment's
    // cap alone, or a slice handed to a failed-later row - there is nothing to settle here (`INV-PAY-142`'s stated limit).
    .filter(({ owed, later }) => owed.owedCents > 0 || later.length > 0);
  return Promise.all(
    listed.map(async ({ operation, owed, later }) => {
      const xeroPlan = owed.owedCents > 0
        ? await paidAnotherWayXeroPlan(prisma, operation, operation.payment, { lockApprovalTask: false })
        : null;
      const bankCloseRefusal = paidAnotherWayRefusal(operation.payment, operation, owed,
        charges.filter((charge) => charge.paymentId === operation.paymentId));
      return {
        operationId: operation.id,
        bookingId: operation.bookingId,
        bookingReference: formatBookingReference(operation.bookingId),
        raisedAt: operation.createdAt.toISOString(),
        owedCents: owed.owedCents,
        wholeAmountOnly: operation.type === "REFUND_SUPERSEDED_PAYMENT",
        xeroRefundNote: xeroPlan ? paidAnotherWayXeroPromise(xeroPlan) : "none",
        cardNoteCoversCents: xeroPlan?.xeroRefundNote === "now" ? (xeroPlan.cardNoteCoversCents ?? 0) : 0,
        stripeMayHaveRefunded: lastErrorSuggestsStripeMayHaveRefunded(operation.lastError),
        laterStripeRefunds: later,
        tryCardAgainRefusal: tryCardAgainRefusal(operation.payment, operation, owed, bankCloseRefusal),
        paidAnotherWayRefusal: bankCloseRefusal,
      };
    }),
  );
}

export interface CardRefundPaidAnotherWayInput {
  operationId: string;
  /** What the treasurer paid back, in cents: exactly what is owed for "full", less than it for "partial". */
  amountCents: number;
  /** Paid back in full, or in part - the treasurer's explicit choice. */
  paidBack: PaidBackChoice;
  /** #4516 (owner, 2 Nov 2026): a part close's rest, kept by the club or still owed; required for part, absent for full. */
  rest?: PaidBackRestChoice | null;
  /**
   * What the treasurer saw still owed when they chose (#3924 round 7,
   * concurrency C7). A close against a figure that has since moved is refused
   * with a 409, so the page refreshes and they choose again against the new one.
   */
  expectedOwedCents: number;
  /** How it was paid. Required. */
  note: string | null | undefined;
  actingMemberId: string;
}

export interface CardRefundPaidAnotherWayResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  amountCents: number;
  owedCents: number;
  paidBack: PaidBackChoice;
  rest: PaidBackRestChoice | null; stillOwedOperationId: string | null; // #4516: the choice, and the row a still-owed rest moved to
  /** What was queued in Xero for this close. */
  xeroQueued: PaidAnotherWayXeroQueued;
}

/** The record's reason: what happened, and what the treasurer chose for the rest. */
function paidAnotherWayReason(bookingId: string, paidBack: PaidBackChoice, rest: PaidBackRestChoice | null): string {
  return `A card refund on booking ${formatBookingReference(bookingId)} that Stripe gave up on was ${paidAnotherWayOutcome(paidBack, rest, " by the treasurer")} (#3372).`.slice(
    0,
    MANUAL_REFUND_TASK_REASON_MAX,
  );
}

/**
 * A superseded intent's refund closes only while what it owes is exactly what
 * its transaction still holds, so the whole of it lands there and the
 * transaction reads fully refunded (#3924 round 4, M7). Anything else is a
 * state the close cannot make true; a developer reconciles it.
 */
async function assertSupersededCloseFillsItsTransaction(
  tx: Prisma.TransactionClient,
  operation: { paymentTransactionId: string | null; paymentId: string },
  owed: { ownCents: number; owedCents: number },
): Promise<void> {
  const transaction = operation.paymentTransactionId
    ? await tx.paymentTransaction.findUnique({
        where: { id: operation.paymentTransactionId },
        select: { paymentId: true, amountCents: true, refundedAmountCents: true },
      })
    : null;
  // #4368 review R2 (`INV-SSOT`): the one rule (`supersededCloseFillsItsCharge`), which "Try the card again" reads too.
  if (!supersededCloseFillsItsCharge(transaction, operation.paymentId, owed)) {
    throw new CardRefundPaidAnotherWayError(
      "This superseded payment's refund no longer matches what its charge still holds, so it cannot be closed here. Ask a developer to reconcile it.",
      409,
    );
  }
}

/**
 * Post the booking ledger's line for the money paid back, on the record. Built
 * in pure code, caught and logged, so a planning fault leaves the close
 * standing and the gap for the census to report; written unwrapped, as
 * `postHandBackLedgerLine` writes. Keyed on the record, so a replay posts nothing.
 */
async function postPaidAnotherWayLine(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; lodgeId: string; taskId: string; amountCents: number; officerMemberId: string },
): Promise<void> {
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    rows = buildBookingLedgerRows([
      planHandBackLine({
        bookingId: input.bookingId,
        lodgeId: input.lodgeId,
        manualRefundTaskId: input.taskId,
        amountCents: input.amountCents,
        settlementMethod: "INTERNET_BANKING",
        officerMemberId: input.officerMemberId,
      }),
    ]);
  } catch (error) {
    logger.error(
      { err: error, bookingId: input.bookingId, manualRefundTaskId: input.taskId },
      "Booking ledger: could not build the paid-another-way line; the close stands and the gap is the census's to report (#3924)",
    );
    return;
  }
  await writeBookingLedgerRows(tx, rows);
}

/** The record's `reviewContext` for a card-note cover, or nothing (A-F1). */
function cardNoteCoverReviewContext(cardNoteCoversCents: number): { reviewContext?: Prisma.InputJsonObject } {
  const reviewContext = paidAnotherWayCardNoteCoverContext(cardNoteCoversCents);
  return reviewContext ? { reviewContext } : {};
}

/** Close one dead card refund as paid another way. See the module comment. */
export async function closeCardRefundPaidAnotherWay(
  input: CardRefundPaidAnotherWayInput,
): Promise<CardRefundPaidAnotherWayResult> {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) {
    throw new CardRefundPaidAnotherWayError("Say how the member was paid back - a note is required.", 400);
  }
  // #3924 round 7 (money M6): never for nothing, whatever the kind. A close
  // records money paid back; one for $0 would close a refund nobody paid.
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new CardRefundPaidAnotherWayError("The amount paid back must be whole cents, more than nothing.", 400);
  }
  if (!(PAID_BACK_CHOICES as readonly string[]).includes(input.paidBack)) {
    throw new CardRefundPaidAnotherWayError("Say whether it was paid back in full or in part.", 400);
  }
  if (!Number.isSafeInteger(input.expectedOwedCents) || input.expectedOwedCents < 0) {
    throw new CardRefundPaidAnotherWayError("Say what you saw still owed, in whole cents.", 400);
  }
  const rest = input.rest ?? null;
  const restRefusal = paidBackRestRefusal(input.paidBack, rest); // #4516: no default for a part close's rest
  if (restRefusal) throw new CardRefundPaidAnotherWayError(restRefusal, 400);
  // `INV-LOCK-004`: the club's zone, for a late charge's receipt date, is read
  // before the transaction.
  const clubZone: ClubTimeZone = await readClubTimeZoneOutsideRequest();
  const format = await getClubFormat(); // #4145: a cancel's made part's event, below
  const journal = await resolveBookingMoneyPostingContext({ zone: clubZone }); // #4516: R14, before the transaction

  const result = await prisma.$transaction(async (tx) => {
    // `lock(1)`, the row re-read, then (C1) the payment row before the payment is read (`lockDeadCardRefundRow`, #4368 review D).
    // The record and its line are read by the booking (the census loads both by it), so the payment's booking must be the row's.
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId, {
      notOwedKind: "This is not a card refund that can be closed here.",
      organiserChild: "This refund comes out of the group organiser's card payment, so it cannot be closed here. Ask a developer to reconcile it.",
      closed: "This card refund has already been closed.",
      notGivenUp: "This card refund is still being retried, so it cannot be closed yet.",
      otherBooking: "This card refund's payment belongs to another booking, so it cannot be closed here. Ask a developer to reconcile it.",
    });
    const owed = deadCardRefundStillOwed(payment, operation.id);
    const { ownCents, owedCents, unsentTransactionIds, unsent } = owed;
    // C7: the figure the treasurer chose against, read under the payment row.
    if (owedCents !== input.expectedOwedCents) {
      throw new CardRefundPaidAnotherWayError(
        "What is still owed on this card refund changed since you opened it. The list has been refreshed: check the amount and close it again.",
        409,
      );
    }
    const charges = await tx.paymentTransaction.findMany({
      where: { paymentId: payment.id },
      select: { id: true, amountCents: true, refundedAmountCents: true },
    });
    const refusal = paidAnotherWayRefusal(payment, operation, owed, charges);
    if (refusal) throw new CardRefundPaidAnotherWayError(refusal, 409);
    if (input.amountCents > owedCents) {
      throw new CardRefundPaidAnotherWayError(
        "That is more than this refund still owes. Refresh and check the amount.",
        409,
      );
    }
    const choiceRefusal = paidBackChoiceRefusal(input.paidBack, input.amountCents, owedCents); // the full-or-part rule (8 Oct 2026)
    if (choiceRefusal) throw new CardRefundPaidAnotherWayError(choiceRefusal, 400);
    if (operation.type === "REFUND_SUPERSEDED_PAYMENT") {
      if (input.paidBack !== "full") {
        throw new CardRefundPaidAnotherWayError(
          "A superseded payment's refund closes only for the whole of what it still owes.",
          400,
        );
      }
      // F3: never capped below its own unsent amount, and never for nothing -
      // either would read the transaction refunded when it is not.
      if (ownCents === 0 || owedCents !== ownCents) {
        throw new CardRefundPaidAnotherWayError(
          "This superseded payment's refund no longer matches what its payment still holds, so it cannot be closed here. Ask a developer to reconcile it.",
          409,
        );
      }
      await assertSupersededCloseFillsItsTransaction(tx, operation, { ownCents, owedCents });
    }
    // F4 / round 6: decided before the record, whose key carries the answer;
    // a late capture's approval task row is taken before its receipt is read.
    const xeroPlan: PaidAnotherWayXeroPlan = await paidAnotherWayXeroPlan(tx, operation, payment, {
      lockApprovalTask: true,
    });

    const closedAt = new Date();
    // #4312 F2 (`INV-ADDPAY-047`): on the plan the owed figure was read from,
    // so a re-send's mark (`markResentSlices`, `pairResendRecordedFirst`)
    // landing in between fails the claim - one plan, read and closed.
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: closedAt,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: PAID_ANOTHER_WAY_MARKER,
      },
    });
    if (claimed.count === 0) {
      throw new CardRefundPaidAnotherWayError(
        "This card refund changed while you were closing it - refresh and try again.",
        409,
      );
    }

    // The money moves only after the claim, so a lost claim moves nothing.
    try {
      await applyLocalRefundAllocation({
        paymentId: payment.id,
        amountCents: input.amountCents,
        preferTransactionIds: unsentTransactionIds,
        store: tx,
      });
    } catch (error) {
      // C3: only the allocation's two refusals are the operator's to act on;
      // anything else is a fault, for the route's 500.
      if (error instanceof RefundAllocationRacedError || error instanceof RefundAllocationExceedsCapturedError) {
        logger.warn({ err: error, operationId: operation.id }, "Paid-another-way close refused by the refund allocation");
        throw new CardRefundPaidAnotherWayError(
          error instanceof RefundAllocationRacedError
            ? "This payment's refunds changed while you were closing it - refresh and try again."
            : "The payment no longer holds that much to refund. Refresh and check the amount.",
          409,
        );
      }
      throw error;
    }

    const record = await tx.manualRefundTask.create({
      data: {
        bookingId: booking.id,
        paymentId: payment.id,
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operation.id, {
          xeroRefundNote: xeroPlan.xeroRefundNote,
        }),
        amountCents: input.amountCents,
        // #4516: a still-owed rest moves to its own row, so this record closes exactly what it paid.
        raisedAmountCents: rest === "still-owed" ? input.amountCents : owedCents,
        status: "COMPLETED",
        completedAt: closedAt,
        completedByMemberId: input.actingMemberId,
        note,
        reason: paidAnotherWayReason(booking.id, input.paidBack, rest),
        // #4104 delta review (A-F1): what a card note already in Xero answers
        // of the close, so its share counts it covered.
        ...cardNoteCoverReviewContext(paidAnotherWayCardNoteCoversCents(xeroPlan, input.amountCents)),
      },
      select: { id: true },
    });
    await postPaidAnotherWayLine(tx, {
      bookingId: booking.id,
      lodgeId: booking.lodgeId,
      taskId: record.id,
      amountCents: input.amountCents,
      officerMemberId: input.actingMemberId,
    });
    // #4145 (`INV-PAY-134`): a cancel's slices made before this close went back to the card.
    await recordCardRefundMadeBeforePaidAnotherWay(tx, operation, { payment, format });
    // #4516 (`INV-PAY-122`): a still-owed rest's own row, then R14 and a kept rest's close-out in the journal.
    const { restCents, stillOwedOperationId } = await closePaidAnotherWayRest(tx, journal, { operation, recordId: record.id, amountCents: input.amountCents,
      owedCents, paidBack: input.paidBack, rest, unsent, unsentTransactionIds, closedAt, actingMemberId: input.actingMemberId });

    // M3 / round 5 / round 6: the note now, or the late charge's receipt first.
    let xeroQueued: PaidAnotherWayXeroQueued;
    try {
      xeroQueued = await queuePaidAnotherWayXero(tx, xeroPlan, {
        operationId: operation.id,
        bookingId: booking.id,
        paymentId: payment.id,
        recordId: record.id,
        amountCents: input.amountCents,
        actingMemberId: input.actingMemberId,
        clubZone,
        closedAt,
      });
    } catch (error) {
      // Round 8: the receipt changed under the plan; nothing commits.
      if (error instanceof PaidAnotherWayXeroChangedError) {
        throw new CardRefundPaidAnotherWayError(
          "This late card charge's Xero record changed while you were closing it - refresh and try again.",
          409,
        );
      }
      throw error;
    }

    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-another-way",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Card refund Stripe gave up on closed as ${paidAnotherWayOutcome(input.paidBack, rest)}${paidAnotherWayXeroAuditFollowUp(xeroQueued)}`,
        details: note,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          paidBack: input.paidBack,
          rest, stillOwedOperationId,
          amountCents: input.amountCents,
          owedCents,
          noLongerOwedCents: rest === "still-owed" ? 0 : restCents, stillOwedCents: rest === "still-owed" ? restCents : 0,
          manualRefundTaskId: record.id,
          xeroQueued,
        },
      },
      tx,
    );

    return {
      operationId: operation.id,
      bookingId: operation.bookingId,
      paymentId: payment.id,
      amountCents: input.amountCents,
      owedCents,
      paidBack: input.paidBack, rest, stillOwedOperationId,
      xeroQueued,
    };
  });

  // Round 10: only a close that queued a row - its note, or the receipt its
  // note follows - kicks the outbox; a close whose note waits on another
  // invoice, or on an officer, queued nothing to run.
  if (
    result.xeroQueued === "refund-note" ||
    result.xeroQueued === "refund-note-beyond-card-note" ||
    result.xeroQueued === "receipt-then-refund-note"
  ) {
    // The note's (or the receipt's) row committed with the close: only the kick is left.
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error: unknown) =>
      logger.error({ err: error, operationId: result.operationId }, "Failed to kick the Xero outbox after a paid-another-way close"),
    );
  }
  return result;
}

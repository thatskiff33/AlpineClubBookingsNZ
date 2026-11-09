import "server-only";

import { PaymentRecoveryOperationStatus, PaymentSource } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  DeadCardRefundActionError,
  deadCardRefundStillOwed,
  deadRowSettleHint,
  foreignRefundsSizingSupersededRow,
  laterStripeRefundsCovering,
  tryCardAgainRefusal,
  unadoptedOwnStripeRefunds,
  type LaterStripeRefund,
  type ListedStripeRefund,
} from "@/lib/card-refund-dead-row";
import { deadRowClaimWhere, lockDeadCardRefundRow, type DeadCardRefundRowRefusals } from "@/lib/card-refund-dead-row-lock";
import logger from "@/lib/logger";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { prisma } from "@/lib/prisma";
import { rearmedPaymentRecoveryOperationData } from "@/lib/payment-recovery-constants";
import { listRefundsOnCardCharge } from "@/lib/card-refund-stripe-refunds";

/**
 * #4368 (owner decision, 25 Oct 2026: "build as shown in the mock-up";
 * `INV-PAY-149`): THE TWO OTHER WAYS TO SETTLE A CARD REFUND STRIPE GAVE UP ON.
 * "Paid another way" (`card-refund-paid-another-way.ts`) records money the
 * treasurer paid back; these two record none.
 *
 * - **Nothing left owed** (`closeCardRefundNothingLeftOwed`). A dead row with
 *   nothing of its own left unsent, its slices filled by Stripe refunds the
 *   owed figure's attribution gives it (`laterStripeRefundsCovering`, review
 *   C), closes naming those refunds. It moves no money, makes no Stripe call,
 *   makes no Xero change and posts nothing to the booking journal: the refunds
 *   that covered it were recorded when they arrived. The row goes to SUCCEEDED,
 *   the status every reader takes as "nothing more to send", with `lastError`
 *   saying why (`NOTHING_LEFT_OWED_MARKER`; nothing parses it). Refused (409)
 *   unless, under the locks, nothing is owed, the attribution names a refund,
 *   and the refunds it names are the ones the treasurer saw. A $0 read off the
 *   payment's cap alone names no refund that paid the row: a developer's.
 * - **Try the card again** (`tryDeadCardRefundAgain`, decision 5). The row is
 *   put back to run from the start (`rearmedPaymentRecoveryOperationData`):
 *   PENDING, attempts reset, due now. Nothing is sent here. The runner claims
 *   it as any row, and its charge-backed preflight (`INV-PAY-145`, #4359) reads
 *   Stripe before any slice is sent: a refund carrying the slice's key is
 *   adopted (`INV-PAY-147`), and one made outside the app holds the row again.
 *   A re-arm runs outside Stripe's 24-hour key window, so where the app cannot
 *   show a new request would not pay twice it refuses (409): the rules of
 *   `tryCardAgainRefusal` (among them, review F1: what the runner would send -
 *   every unmarked plan slice - must be exactly the row's own unsent figure),
 *   and (review B) a refund this booking's same kind of refund made that
 *   carries no slice key and no slice is marked with
 *   (`unadoptedOwnStripeRefunds`), read from Stripe before the locks for the
 *   plan the row still holds under them (review F4). Also refused unless the
 *   owed figure is the one the treasurer saw.
 *
 * ONE ROW, ONE WINNER (#4492). "Paid another way" and these two take the same
 * locks and the same claim (`card-refund-dead-row-lock.ts`): whichever commits
 * second matches nothing and writes nothing - a closed row is never re-armed,
 * and a re-armed row is offered no close until it is given up again. No
 * provider call runs under the locks.
 */

/** What `lastError` says on a row closed with nothing left owed, for a person reading it. Nothing parses it. */
export const NOTHING_LEFT_OWED_MARKER = "Closed by the treasurer: nothing left owed, a later Stripe refund covers it (#4368)";

/** The one refusal class of every settlement of a dead row (`card-refund-dead-row.ts`). */
export { DeadCardRefundActionError };

/** What these two say when the row is not one they may settle (`lockDeadCardRefundRow`). */
const REFUSALS: DeadCardRefundRowRefusals = {
  notOwedKind: "This card refund cannot be settled here. Ask a developer to reconcile it.",
  organiserChild: "This card refund cannot be settled here. Ask a developer to reconcile it.",
  closed: "This card refund has already been closed.",
  notGivenUp: "This card refund is being tried again, so it is not waiting for you. Refresh the list.",
  otherBooking: "This card refund's payment belongs to another booking, so it cannot be settled here. Ask a developer to reconcile it.",
};

const CHANGED_WHILE_SETTLING = "This card refund changed while you were settling it. The list has been refreshed: check it and try again.";

export interface NothingLeftOwedInput {
  operationId: string;
  /** The later Stripe refunds the dialog named; a different set under the locks is a 409. */
  expectedStripeRefundIds: readonly string[];
  actingMemberId: string;
}

export interface NothingLeftOwedResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  coveredBy: LaterStripeRefund[];
}

/** Close a dead card refund with nothing left owed. See the module comment. */
export async function closeCardRefundNothingLeftOwed(input: NothingLeftOwedInput): Promise<NothingLeftOwedResult> {
  const expected = [...new Set(input.expectedStripeRefundIds)].sort();
  if (expected.length === 0 || expected.length !== input.expectedStripeRefundIds.length) {
    throw new DeadCardRefundActionError("Name the Stripe refunds that cover this card refund, each once.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId, REFUSALS);
    const { ownCents, owedCents } = deadCardRefundStillOwed(payment, operation.id);
    if (owedCents !== 0) {
      throw new DeadCardRefundActionError(
        "Something is owed on this card refund again, so it cannot be closed with nothing left owed. The list has been refreshed: check what is owed.",
        409,
      );
    }
    // Review C: only the refunds the attribution gives this row, and only once nothing of its own is unsent - a $0
    // read off the payment's cap alone names nothing that paid it.
    const coveredBy = laterStripeRefundsCovering(payment, operation.id);
    if (coveredBy.length === 0) {
      throw new DeadCardRefundActionError(
        "No Stripe refund on this payment is matched to this card refund, so it cannot be closed here. Ask a developer to reconcile it.",
        409,
      );
    }
    const found = coveredBy.map((refund) => refund.stripeRefundId).sort();
    if (found.length !== expected.length || found.some((id, index) => id !== expected[index])) {
      throw new DeadCardRefundActionError(
        "The Stripe refunds on this payment changed since you opened it. The list has been refreshed: check them and close it again.",
        409,
      );
    }

    const closedAt = new Date();
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: closedAt,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: NOTHING_LEFT_OWED_MARKER,
      },
    });
    if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED_WHILE_SETTLING, 409);

    await createAuditLog(
      {
        action: "booking-payment.card-refund.nothing-left-owed",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Card refund Stripe gave up on closed with nothing left owed: covered by Stripe refund ${found.join(", ")}. No money moved.`,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          ownUnsentCents: ownCents,
          owedCents,
          coveredBy: coveredBy.map((refund) => ({ ...refund })),
        },
      },
      tx,
    );
    return { operationId: operation.id, bookingId: operation.bookingId, paymentId: payment.id, coveredBy };
  });
}

export interface TryCardAgainInput {
  operationId: string;
  /** What the dialog showed still owed: the amount the card will be asked for. A moved figure is a 409. */
  expectedOwedCents: number;
  actingMemberId: string;
}

export interface TryCardAgainResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  owedCents: number;
}

/** Re-arm a dead card refund so the runner asks the card again. See the module comment. */
export async function tryDeadCardRefundAgain(input: TryCardAgainInput): Promise<TryCardAgainResult> {
  if (!Number.isSafeInteger(input.expectedOwedCents) || input.expectedOwedCents <= 0) {
    throw new DeadCardRefundActionError("Say what you saw still owed, in whole cents, more than nothing.", 400);
  }
  // Review B: Stripe's refunds on the row's charges, read before any lock (no provider call runs under them).
  const read = await stripeRefundsOnRowCharges(input.operationId);
  return prisma.$transaction(async (tx) => {
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId, REFUSALS);
    const owed = deadCardRefundStillOwed(payment, operation.id);
    // Review S1: a superseded intent's charge, read under the Payment row its refund writers take: its runner sizes
    // one request on it, and "Paid another way" closes it only while it holds exactly what the row owes.
    const charge =
      operation.type === "REFUND_SUPERSEDED_PAYMENT" && operation.paymentTransactionId
        ? await tx.paymentTransaction.findUnique({
            where: { id: operation.paymentTransactionId },
            select: { paymentId: true, amountCents: true, refundedAmountCents: true },
          })
        : null;
    const rowWithCharge = { ...operation, paymentTransaction: charge };
    const refusal = tryCardAgainRefusal(payment, rowWithCharge, owed);
    if (refusal) throw new DeadCardRefundActionError(refusal, 409);
    // Review F4: Stripe was read for the charges of the plan read then; a plan moved since is not the one checked.
    if (read !== null && JSON.stringify(read.allocationPlan ?? null) !== JSON.stringify(operation.allocationPlan ?? null)) {
      throw new DeadCardRefundActionError(CHANGED_WHILE_SETTLING, 409);
    }
    // Review R1: a plan-less superseded row's ledger sizing is trusted only while every refund the owed figure gives
    // it is one its own request made.
    const foreign = foreignRefundsSizingSupersededRow(payment, operation, read?.listed ?? []);
    if (foreign.length > 0) {
      throw new DeadCardRefundActionError(
        `This refund's card charge was part refunded by another refund (${foreign.join(", ")}), and if that refund failed later the app would owe it twice, so the card cannot be tried again. ${deadRowSettleHint(rowWithCharge, owed)}`,
        409,
      );
    }
    const unadopted = unadoptedOwnStripeRefunds(payment, operation, read?.listed ?? []);
    if (unadopted.length > 0) {
      throw new DeadCardRefundActionError(
        `Stripe holds a refund made by this booking's same kind of refund (${unadopted.join(", ")}) that the app cannot match to what is owed, so a new request could pay the member twice and the card cannot be tried again. Check it in the Stripe dashboard, and settle anything still owed with Paid another way.`,
        409,
      );
    }
    if (owed.owedCents !== input.expectedOwedCents) {
      throw new DeadCardRefundActionError(
        "What is still owed on this card refund changed since you opened it. The list has been refreshed: check the amount and try again.",
        409,
      );
    }

    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: rearmedPaymentRecoveryOperationData(new Date()),
    });
    if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED_WHILE_SETTLING, 409);

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
        summary: "Card refund Stripe gave up on put back to try the card again. Stripe is checked before anything is sent.",
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          owedCents: owed.owedCents,
          previousAttempts: operation.attempts,
          previousStatus: operation.status,
          previousLastError: operation.lastError?.slice(0, 500) ?? null,
        },
      },
      tx,
    );
    return { operationId: operation.id, bookingId: operation.bookingId, paymentId: payment.id, owedCents: owed.owedCents };
  });
}

const STRIPE_UNREADABLE =
  "Stripe's refunds on this card could not be read just now, so the app cannot check that a new request would not pay the member twice. Try again in a few minutes, or settle it with Paid another way.";

/**
 * #4368 review (B): the refunds Stripe lists on the charges this row would
 * refund - its plan's, a superseded intent's own, or (a legacy row with
 * neither) every card charge of its payment - read before the transaction,
 * through the preflight's own bounded read (`listRefundsOnCardCharge`,
 * `INV-PAY-145`), with the plan they were read for (review F4). Anything Stripe will not answer in full refuses the re-arm:
 * nothing unread can show a re-send is safe. Read unlocked; the decision
 * (`unadoptedOwnStripeRefunds`) is taken under the locks.
 */
async function stripeRefundsOnRowCharges(
  operationId: string,
): Promise<{ allocationPlan: unknown; listed: ListedStripeRefund[] } | null> {
  const row = await prisma.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
    select: { paymentId: true, paymentTransactionId: true, allocationPlan: true },
  });
  if (!row) return null; // The transaction refuses it (404).
  const planned = [...new Set((parseRefundAllocationPlan(row.allocationPlan) ?? []).map((slice) => slice.paymentTransactionId).filter((id) => id !== ""))];
  const ids = planned.length > 0 ? planned : row.paymentTransactionId ? [row.paymentTransactionId] : null;
  const charges = await prisma.paymentTransaction.findMany({
    where: { paymentId: row.paymentId, ...(ids ? { id: { in: ids } } : { source: PaymentSource.STRIPE }), stripePaymentIntentId: { not: null } },
    select: { stripePaymentIntentId: true },
  });
  const listed: ListedStripeRefund[] = [];
  for (const intent of [...new Set(charges.flatMap((charge) => (charge.stripePaymentIntentId ? [charge.stripePaymentIntentId] : [])))]) {
    let refunds: Awaited<ReturnType<typeof listRefundsOnCardCharge>>;
    try {
      refunds = await listRefundsOnCardCharge(intent);
    } catch (err) {
      logger.warn({ err, operationId, paymentIntentId: intent }, "Try the card again refused: Stripe's refunds could not be read (#4368)");
      throw new DeadCardRefundActionError(STRIPE_UNREADABLE, 409);
    }
    for (const refund of refunds) listed.push({ id: refund.id, status: refund.status ?? null, metadata: refund.metadata ?? null });
  }
  // Review F4: the plan these charges were read for, checked against the row under the locks.
  return { allocationPlan: row.allocationPlan, listed };
}

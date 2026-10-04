/**
 * #3653 (`INV-PAY-114`): an organiser-settled child's refund out of the
 * organiser's COMBINED card payment.
 *
 * An organiser-pays group is settled by ONE Stripe PaymentIntent for the whole
 * group (`GroupBookingSettlement.stripePaymentIntentId`). Each joiner's booking
 * then carries a `Payment` mirror marked `SUCCEEDED` - but no
 * `PaymentTransaction`, because no intent of its own ever existed. The ordinary
 * refund machinery allocates refunds across a payment's transactions, so for a
 * joiner it found nothing to refund: an edit that reduced a joiner's booking
 * committed, its refund became recovery work that completed having refunded
 * nothing, and the organiser was never paid back.
 *
 * The contract here, for an edit's reduction and for a group cancellation alike:
 *
 *  1. THE DEBT IS WRITTEN FIRST, in the transaction that decides it, under the
 *     global `lock(1)` that transaction already holds: one
 *     `PaymentRecoveryOperation` per refund (`reserveOrganiserChildRefund`). Its
 *     amount is frozen there. The reservation refuses (an edit) or clamps (a
 *     cancellation, which cannot be refused) any amount that would take the
 *     joiner past what was paid for them, or the group past what the organiser
 *     was charged - counting refunds already recorded AND every debt still owed,
 *     so two reductions cannot both spend the same captured cents.
 *  2. THE PROVIDER CALL IS ONE IDEMPOTENT REFUND PER CHILD against the combined
 *     intent (`processOrganiserChildRefundOperation`), outside any transaction,
 *     keyed by the operation's own key. A replay first looks for a refund Stripe
 *     already holds under that key, because Stripe forgets a key after 24 hours.
 *  3. NOTHING IS CALLED REFUNDED UNTIL STRIPE ANSWERED. The child's
 *     `PaymentRefund` row (Stripe's own refund id), its `refundedAmountCents`
 *     mirror, its Xero refund credit note, the settlement's status and the
 *     operation's close all commit in ONE transaction, after the refund exists.
 *
 * A failed or ambiguous call leaves the operation owed; the recovery cron
 * replays it and alerts on exhaustion. No synthetic `PaymentTransaction` is
 * written for the combined intent (the issue rejects it): the refund row names
 * the combined intent and belongs to the child's `Payment`.
 */
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  type PaymentRecoveryOperation,
  type Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import {
  cancelRefundableBaseCents,
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import { organiserHasPaidSettlement, paidByOrganiserCard } from "@/lib/group-organiser-paid";
import { calculateRefundAmount, type CancellationRule } from "@/lib/cancellation";
import logger from "@/lib/logger";
import {
  buildOrganiserChildCancellationRefundKey,
  buildOrganiserChildModificationRefundKey,
  ORGANISER_CHILD_REFUND_KEY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { readPerChildRefundPlan } from "@/lib/group-settlement-refund-plan";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

type Db = Prisma.TransactionClient;

/** The combined card settlement a child's refund comes out of. */
export type CombinedCardSettlement = {
  id: string;
  stripePaymentIntentId: string;
  amountCents: number;
};

/**
 * The organiser's combined CARD settlement behind an organiser-settled child, or
 * null when the booking is not one (an ordinary booking, or a group the
 * organiser settled by Internet Banking, which moves no card money).
 */
export async function findCombinedCardSettlementForChild(
  db: Db,
  booking: { organiserSettled: boolean; parentBookingId: string | null },
): Promise<(CombinedCardSettlement & { status: string; refundPlan: Prisma.JsonValue }) | null> {
  if (!booking.organiserSettled || !booking.parentBookingId) return null;
  const settlement = await db.groupBookingSettlement.findFirst({
    where: {
      groupBooking: { organiserBookingId: booking.parentBookingId },
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: { not: null },
    },
    select: { id: true, stripePaymentIntentId: true, amountCents: true, status: true, refundPlan: true },
  });
  if (!settlement?.stripePaymentIntentId) return null;
  return { ...settlement, stripePaymentIntentId: settlement.stripePaymentIntentId };
}

/** The refusal an edit gets when its reduction cannot be returned from the combined payment. */
export class OrganiserChildRefundRefusedError extends ApiError {
  constructor(message: string) {
    super(message, 409);
  }
}

/**
 * What an edit's reduction of an organiser-settled child will return to the
 * organiser's card, decided inside the edit's transaction. Null when the edit
 * returns nothing through Stripe. THROWS before the edit commits when the
 * booking was paid by the organiser's card but that payment cannot be found or
 * no longer holds the money, rather than letting the edit commit a refund that
 * cannot happen.
 */
export async function planOrganiserChildModificationRefund(
  db: Db,
  booking: {
    organiserSettled: boolean;
    parentBookingId: string | null;
    payment: { source: string } | null;
  },
  pendingRefundAmountCents: number,
): Promise<{ settlement: CombinedCardSettlement; amountCents: number } | null> {
  if (!paidByOrganiserCard(booking) || pendingRefundAmountCents <= 0) return null;
  const settlement = await findCombinedCardSettlementForChild(db, booking);
  if (!settlement || !organiserHasPaidSettlement(settlement)) {
    throw new OrganiserChildRefundRefusedError(
      "This booking was paid for by the group organiser, and the organiser's card payment can no longer be refunded, so this reduction cannot be saved. Contact the club to change it.",
    );
  }
  return { settlement, amountCents: pendingRefundAmountCents };
}

/** The child payment fields the caps read. */
type ChildPayment = { id: string; status: string; amountCents: number; refundedAmountCents: number };

type ReserveInput = {
  key: string;
  settlement: CombinedCardSettlement;
  childBookingId: string;
  childPayment: ChildPayment;
  amountCents: number;
  /** An edit is refused before it commits; a cancellation cannot be, so it clamps. */
  overCap: "refuse" | "clamp";
};

/**
 * What is already spoken for on the combined intent and on this child: counted
 * refunds Stripe has made, plus every child-refund debt not yet closed. A debt
 * whose refund is recorded closes in the SAME transaction (step 3 above), so
 * nothing is counted twice.
 */
async function committedCents(db: Db, paymentIntentId: string, childPaymentId: string) {
  const [recorded, owed] = await Promise.all([
    db.paymentRefund.aggregate({
      where: { stripePaymentIntentId: paymentIntentId, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
      _sum: { amountCents: true },
    }),
    db.paymentRecoveryOperation.findMany({
      where: {
        paymentIntentId,
        idempotencyKey: { startsWith: ORGANISER_CHILD_REFUND_KEY_PREFIX },
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
      select: { paymentId: true, amountCents: true },
    }),
  ]);
  return {
    recordedCents: recorded._sum.amountCents ?? 0,
    owedCents: owed.reduce((sum, op) => sum + op.amountCents, 0),
    childOwedCents: owed
      .filter((op) => op.paymentId === childPaymentId)
      .reduce((sum, op) => sum + op.amountCents, 0),
  };
}

/**
 * THE ONE ANSWER to "how much has already gone back to the organiser for this
 * child" (#3653 fix round). The larger of the child's stored mirror and the
 * refunds Stripe recorded against it (`PaymentRefund`, by Stripe's own id).
 *
 * The stored mirror alone is not safe to size from. `reconcilePaymentAggregates`
 * recomputes `refundedAmountCents` from the payment's TRANSACTION rows, and a
 * child has none for its combined-intent refunds, so any writer that reconciles
 * the child (an additional ask, say) zeroes it; the Xero inbound repair can
 * write an absolute, older figure. Either would re-promise refunded money to a
 * later reduction or cancellation. The refund rows survive both. The mirror
 * still wins when it is larger, because a group cancelled before #3653 wrote
 * its children's shares to the mirror with no per-child refund row.
 */
export async function organiserChildRefundedCents(
  db: Db,
  payment: { id: string; refundedAmountCents: number },
): Promise<number> {
  const recorded = await db.paymentRefund.aggregate({
    where: { paymentId: payment.id, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
    _sum: { amountCents: true },
  });
  return Math.max(payment.refundedAmountCents, recorded._sum.amountCents ?? 0);
}

/**
 * What a cancellation of this child must treat as already handed back: the
 * refunds made (`organiserChildRefundedCents`) plus every child-refund debt
 * still owed. The base a cancellation tiers from, for the organiser's cancel
 * and the joiner's own alike.
 */
export async function organiserChildCommittedRefundCents(
  db: Db,
  payment: { id: string; refundedAmountCents: number },
  paymentIntentId: string,
): Promise<number> {
  const [refundedCents, committed] = await Promise.all([
    organiserChildRefundedCents(db, payment),
    committedCents(db, paymentIntentId, payment.id),
  ]);
  return refundedCents + committed.childOwedCents;
}

/**
 * A joiner's OWN cancellation of a booking the organiser paid for by card
 * (#3653): the combined payment its refund comes out of - null when that
 * payment no longer holds money (so nothing can be returned) - and what the
 * policy must treat as already handed back. Read in the cancel's claim, under
 * its `lock(1)`, the lodge key, the joiner's member credit-ledger key (#3792)
 * and the payment row lock.
 */
export async function organiserChildCancelBasis(
  db: Db,
  booking: { organiserSettled: boolean; parentBookingId: string | null },
  payment: { id: string; refundedAmountCents: number },
): Promise<{ settlement: CombinedCardSettlement | null; committedRefundCents: number }> {
  const found = await findCombinedCardSettlementForChild(db, booking);
  if (!found || !organiserHasPaidSettlement(found)) {
    return { settlement: null, committedRefundCents: await organiserChildRefundedCents(db, payment) };
  }
  const settlement = {
    id: found.id,
    stripePaymentIntentId: found.stripePaymentIntentId,
    amountCents: found.amountCents,
  };
  return {
    settlement,
    committedRefundCents: await organiserChildCommittedRefundCents(db, payment, settlement.stripePaymentIntentId),
  };
}

/**
 * The debt the organiser's cancellation of the group already wrote for this
 * child, or null. It shares its key with the joiner's own cancellation, so a
 * joiner cancelling behind the group refunds nothing of its own: the group's
 * cancellation tiered this child and owes its refund. The executed cancel and
 * its preview both ask through here, so the preview can never quote a refund
 * the cancel will not make (#1491).
 */
export async function findGroupCancellationChildDebt(
  db: Db,
  settlementId: string,
  childBookingId: string,
): Promise<{ id: string; amountCents: number } | null> {
  return db.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildOrganiserChildCancellationRefundKey(settlementId, childBookingId) },
    select: { id: true, amountCents: true },
  });
}

/** What a joiner's cancel behind the group's says about the group's refund, for the cancel and its preview alike. */
export function groupCancellationRefundNote(amountCents: number, format: ClubFormat): string {
  return `The group organiser's cancellation is already refunding ${formatCents(amountCents, format)} for this booking to the organiser's card.`;
}

/**
 * The allocation an organiser child refund debt carries: one slice naming a
 * transaction that cannot exist (see `reserveOrganiserChildRefund`), so a
 * worker older than #3653 fails the row rather than closing it. The executor
 * reads one thing from it - `reopenedAfterRefundId`, written when the cron
 * reopens a debt whose recorded refund Stripe later failed. The reopen restarts
 * the retry budget at 0 attempts, so the attempts count alone cannot say an
 * earlier refund failed; this marker survives every claim, which `lastError`
 * does not.
 */
export function organiserChildRefundAllocationPlan(
  key: string,
  amountCents: number,
  reopenedAfterRefundId?: string,
): Prisma.InputJsonValue {
  return [
    reopenedAfterRefundId
      ? { paymentTransactionId: key, amountCents, reopenedAfterRefundId }
      : { paymentTransactionId: key, amountCents },
  ];
}

/** Whether this organiser child refund debt was reopened after Stripe failed a refund it had recorded. */
export function organiserChildRefundWasReopened(allocationPlan: Prisma.JsonValue): boolean {
  return (
    Array.isArray(allocationPlan) &&
    allocationPlan.some(
      (slice) =>
        typeof slice === "object" &&
        slice !== null &&
        !Array.isArray(slice) &&
        typeof slice.reopenedAfterRefundId === "string",
    )
  );
}

/**
 * Write one child refund's debt (step 1). The CALLER holds `lock(1)`, which is
 * what makes the headroom read and the insert one decision: every writer of a
 * child refund debt and every recorder of one take it. Idempotent on `key`: an
 * existing row is returned unchanged, its amount frozen.
 */
export async function reserveOrganiserChildRefund(
  db: Db,
  input: ReserveInput,
): Promise<PaymentRecoveryOperation | null> {
  const existing = await db.paymentRecoveryOperation.findUnique({ where: { idempotencyKey: input.key } });
  if (existing) return existing;

  const [committed, childRefundedCents] = await Promise.all([
    committedCents(db, input.settlement.stripePaymentIntentId, input.childPayment.id),
    organiserChildRefundedCents(db, input.childPayment),
  ]);
  const headroomCents = Math.max(
    0,
    Math.min(
      input.settlement.amountCents - committed.recordedCents - committed.owedCents,
      getRemainingRefundableCents({ ...input.childPayment, refundedAmountCents: childRefundedCents }) -
        committed.childOwedCents,
    ),
  );
  let amountCents = input.amountCents;
  if (amountCents > headroomCents) {
    if (input.overCap === "refuse") {
      throw new OrganiserChildRefundRefusedError(
        "The group organiser's card payment no longer holds enough to refund this reduction, so it cannot be saved. Contact the club to change it.",
      );
    }
    logger.error(
      { key: input.key, plannedCents: amountCents, headroomCents },
      "Organiser child refund clamped to what the combined payment still holds (#3653)",
    );
    amountCents = headroomCents;
  }
  if (amountCents <= 0) return null;

  return db.paymentRecoveryOperation.create({
    data: {
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: PaymentRecoveryOperationStatus.PENDING,
      bookingId: input.childBookingId,
      paymentId: input.childPayment.id,
      paymentIntentId: input.settlement.stripePaymentIntentId,
      amountCents,
      idempotencyKey: input.key,
      // A worker still running the code before #3653 reads this as an ordinary
      // modification refund. Pointing its frozen allocation at a transaction
      // that cannot exist makes that worker FAIL the row (and retry it) instead
      // of finding nothing to refund and closing it as done.
      allocationPlan: organiserChildRefundAllocationPlan(input.key, amountCents),
      nextRetryAt: new Date(),
    },
  });
}

/**
 * The organiser-cancel refund of every paid child, planned under `lock(1)` and
 * written as one debt per child plus the settlement's frozen plan, in one
 * transaction. Each child gets the cancellation policy applied to what remains
 * of its payment - paid, less refunds made or owed, capped at what the booking
 * is now worth, less its non-refundable change fee (`cancelRefundableBaseCents`,
 * `INV-PAY-018`). Returns the plan, or the plan an earlier run froze.
 */
export async function planOrganiserCancelChildRefunds({
  settlementId,
  organiserBookingId,
  activeChildStatuses,
  daysUntilCheckIn,
  policy,
}: {
  settlementId: string;
  organiserBookingId: string;
  activeChildStatuses: readonly BookingStatus[];
  daysUntilCheckIn: number;
  policy: CancellationRule[];
}): Promise<Map<string, number>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const settlement = await tx.groupBookingSettlement.findUnique({ where: { id: settlementId } });
    if (!settlement?.stripePaymentIntentId) return new Map();
    const frozen = readPerChildRefundPlan(settlement.refundPlan);
    if (frozen) return frozen;
    if (settlement.refundPlan != null) return new Map(); // a pre-#3653 plan: not ours to extend
    if (!organiserHasPaidSettlement(settlement)) return new Map();
    const combined = {
      id: settlement.id,
      stripePaymentIntentId: settlement.stripePaymentIntentId,
      amountCents: settlement.amountCents,
    };
    const children = await tx.booking.findMany({
      where: {
        parentBookingId: organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: { in: [...activeChildStatuses] },
      },
      include: { payment: true },
      orderBy: { id: "asc" },
    });
    const plan = new Map<string, number>();
    for (const child of children) {
      const payment = child.payment;
      if (
        child.status !== BookingStatus.PAID ||
        !payment ||
        payment.source !== PaymentSource.STRIPE ||
        !hasCapturedPayment(payment)
      ) {
        continue;
      }
      const baseCents = cancelRefundableBaseCents({
        amountCents: payment.amountCents,
        refundedAmountCents: await organiserChildCommittedRefundCents(tx, payment, combined.stripePaymentIntentId),
        finalPriceCents: child.finalPriceCents,
        changeFeeCents: payment.changeFeeCents,
      });
      if (baseCents <= 0) continue;
      const { refundAmountCents } = calculateRefundAmount(baseCents, daysUntilCheckIn, policy, "card");
      if (refundAmountCents <= 0) continue;
      const debt = await reserveOrganiserChildRefund(tx, {
        key: buildOrganiserChildCancellationRefundKey(settlement.id, child.id),
        settlement: combined,
        childBookingId: child.id,
        childPayment: payment,
        amountCents: refundAmountCents,
        overCap: "clamp",
      });
      if (debt) plan.set(child.id, debt.amountCents);
    }
    if (plan.size > 0) {
      await tx.groupBookingSettlement.update({
        where: { id: settlement.id },
        data: { refundPlan: serializePerChildRefundPlan(plan) },
      });
    }
    return plan;
  });
}

function serializePerChildRefundPlan(plan: Map<string, number>): Prisma.InputJsonValue {
  return { perChildRefunds: Object.fromEntries(plan) };
}

/**
 * An edit door's half of step 1: write the debt `applyPaymentAdjustments`
 * decided (`organiserChildRefund`), keyed by this edit's `BookingModification`,
 * in the edit's own transaction and before it commits. A refusal here rolls the
 * edit back. `executeBookingModificationRefund` finds the row by the same key
 * after commit and runs it.
 */
export async function reserveOrganiserChildModificationRefund(
  db: Db,
  {
    plan,
    bookingId,
    payment,
    bookingModificationId,
  }: {
    plan: { settlement: CombinedCardSettlement; amountCents: number } | null;
    bookingId: string;
    payment: ChildPayment | null;
    bookingModificationId: string;
  },
): Promise<PaymentRecoveryOperation | null> {
  if (!plan) return null;
  if (!payment) throw new Error(`Organiser child ${bookingId} has a refund to return but no payment row`);
  return reserveOrganiserChildRefund(db, {
    key: buildOrganiserChildModificationRefundKey(bookingModificationId),
    settlement: plan.settlement,
    childBookingId: bookingId,
    childPayment: payment,
    amountCents: plan.amountCents,
    overCap: "refuse",
  });
}

/**
 * The most an organiser child's cash mirror may read: what it reads now, or the
 * refunds Stripe recorded against it if more. A Xero note is not that evidence -
 * a mirror raised from one would shrink what a later cancellation returns to the
 * organiser. Used by the Xero inbound credit-note repair.
 */
export async function capOrganiserChildMirrorAtStripeRefunds(
  db: Db,
  payment: { id: string; refundedAmountCents: number },
  proposedCents: number,
): Promise<number> {
  const backedCents = await organiserChildRefundedCents(db, payment);
  if (proposedCents > backedCents) {
    logger.warn(
      { paymentId: payment.id, backedCents, proposedCents },
      "Xero-derived refund total exceeds the organiser child's Stripe refunds; not raising the mirror (#3653)",
    );
  }
  return Math.min(proposedCents, backedCents);
}

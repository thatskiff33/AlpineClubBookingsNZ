import type { Prisma } from "@prisma/client";
import { netCollectedBookingSelect, netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { openTaskOwedCents } from "@/lib/manual-refund-task-settlement-rules";
import { isGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back-rules";
import {
  readMemberCreditBalances,
  sumOutstandingCreditCents,
} from "@/lib/member-credit-balances";
import { OPEN_CARD_REFUND_OPERATION_WHERE } from "@/lib/open-card-refund-owed";
import { legacyGroupSettlementRefundUnsentCents } from "@/lib/group-settlement-refund-plan";
import {
  getNetCollectedCashParts,
  netCollectedPaymentTookMoney,
  refundsOwedOfCashParts,
} from "@/lib/payment-net-collected";
import {
  GROUP_SETTLEMENT_REFUND_RECOVERY_WHERE,
  groupSettlementIdForRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import type { RefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed-shared";

/**
 * A payment that owes anything back, with the very columns Net Collected reads
 * (`netCollectedPaymentSelect`) and its id to read it once, so its owed parts
 * come from the one per-payment rule (`getNetCollectedCashParts`).
 */
const OWING_PAYMENT_SELECT = { id: true, ...netCollectedPaymentSelect } as const satisfies Prisma.PaymentSelect;

/**
 * Every open task, with the booking's payment, if it has one. Its `reason`
 * (in the Net Collected task select) tells a legacy late capture apart (#4848).
 */
const OPEN_TASK_QUERY = {
  where: { status: "OPEN" },
  select: {
    ...netCollectedBookingSelect.manualRefundTasks.select,
    booking: { select: { payment: { select: OWING_PAYMENT_SELECT } } },
  },
} as const satisfies Prisma.ManualRefundTaskFindManyArgs;

/** Every unclosed card refund, with the payment it hangs on. */
const OPEN_CARD_REFUND_QUERY = {
  where: OPEN_CARD_REFUND_OPERATION_WHERE,
  select: { payment: { select: OWING_PAYMENT_SELECT } },
} as const satisfies Prisma.PaymentRecoveryOperationFindManyArgs;

/** Every group settlement refund not yet closed (open, or dead with its retries spent). */
const OPEN_GROUP_SETTLEMENT_REFUND_QUERY = {
  where: { ...GROUP_SETTLEMENT_REFUND_RECOVERY_WHERE, status: { not: "SUCCEEDED" } },
  select: { idempotencyKey: true },
} as const satisfies Prisma.PaymentRecoveryOperationFindManyArgs;

/** A group settlement, as the club-wide line reads it. */
export interface LegacyGroupSettlementRefundRow {
  status: string;
  stripePaymentIntentId: string | null;
  refundPlan: unknown;
}

/**
 * #3372 (owner, 8 Oct 2026: "Separate club-wide line"): WHAT THE UNCLOSED
 * GROUP SETTLEMENT CARD REFUNDS STILL HAVE TO SEND, club-wide, in cents.
 *
 * A group organiser-cancel settlement's refund written before #3653 is ONE
 * Stripe refund for the whole group, out of the settlement's combined intent,
 * owed to the children in its frozen `{childId: cents}` plan; its operation's
 * payment is only an anchor (`isOwedCardRefundOperation`), so it cannot be
 * owed against any booking. The owner's decision counts it in "Refunds owed" as
 * one club-wide amount, never against a booking and never in Net Collected.
 *
 * What each settlement still has to send is `legacyGroupSettlementRefundUnsentCents`,
 * the one rule the refund appeal's wait reads too (`INV-SSOT`).
 */
export function legacyGroupSettlementRefundOwedCents(
  settlements: ReadonlyArray<LegacyGroupSettlementRefundRow>,
): number {
  let owedCents = 0;
  for (const settlement of settlements) {
    owedCents += legacyGroupSettlementRefundUnsentCents(settlement);
  }
  return owedCents;
}

/**
 * #3372 (owner, 7 Oct 2026): "Refunds owed" and "Credits owed", as at today and
 * club-wide (`RefundsAndCreditsOwed`).
 *
 * - Refunds owed: for every payment that owes anything back - an open task on
 *   its booking, or an unclosed card refund on it - what Net Collected took off
 *   it for refunds owed (`refundsOwedOfCashParts` of
 *   `getNetCollectedCashParts`): its open hand-back and late card charge
 *   awaiting the treasurer (`openTaskOwedCents`, one task counted once) and its
 *   card refunds not yet paid by Stripe (`openCardRefundOwedCents`), each capped
 *   at what the ones before it left of the payment. Computed per payment ONCE,
 *   by the rule Net Collected uses, so the two figures agree for every payment
 *   (#3924 money review, F5) - a soft-deleted booking's included, which Net
 *   Collected leaves out of its scope but whose refund is still owed. Plus open
 *   tasks on a booking with no payment, or on a payment that shows no capture
 *   (round 4, M7), which nothing caps; an open group organiser's hand-back
 *   (#4042), at its own amount and never through the organiser's payment; and,
 *   as ONE club-wide amount against no
 *   booking (owner, 8 Oct 2026: "Separate club-wide line"), what the unclosed
 *   group settlement card refunds from before #3653 still have to send
 *   (`legacyGroupSettlementRefundOwedCents`).
 * - Credits owed: the members' credit-ledger balances
 *   (`sumOutstandingCreditCents`).
 */
export async function readRefundsAndCreditsOwed(
  db: Pick<
    Prisma.TransactionClient,
    "manualRefundTask" | "memberCredit" | "paymentRecoveryOperation" | "groupBookingSettlement"
  > = prisma,
): Promise<RefundsAndCreditsOwed> {
  const [openTasks, openCardRefunds, openGroupRefunds, balances] = await Promise.all([
    db.manualRefundTask.findMany(OPEN_TASK_QUERY),
    db.paymentRecoveryOperation.findMany(OPEN_CARD_REFUND_QUERY),
    db.paymentRecoveryOperation.findMany(OPEN_GROUP_SETTLEMENT_REFUND_QUERY),
    readMemberCreditBalances(db),
  ]);
  // One payment, read once, however many tasks and refunds it carries.
  const owingPayments = new Map<string, Prisma.PaymentGetPayload<{ select: typeof OWING_PAYMENT_SELECT }>>();
  let uncappedTaskOwedCents = 0;
  for (const task of openTasks) {
    // #4042 (`INV-PAY-124`): a group organiser's hand-back is money the club
    // still owes the organiser, and the joiners' payments already read
    // refunded, so it counts once, at its own amount - never through the
    // organiser's payment, whose Net Collected leaves it out.
    if (isGroupOrganiserHandBackTask(task)) {
      uncappedTaskOwedCents += openTaskOwedCents([task]).handBackCents;
      continue;
    }
    const payment = task.booking.payment;
    // #3924 round 4 (M7): a task on a payment that shows no capture
    // (`netCollectedPaymentTookMoney`) is still promised back. Net Collected
    // counts nothing for that payment, so there is nothing to cap it at: it
    // counts at its own amount, as a task with no payment does.
    if (payment && netCollectedPaymentTookMoney(payment)) {
      owingPayments.set(payment.id, payment);
      continue;
    }
    const owed = openTaskOwedCents([task]);
    uncappedTaskOwedCents += owed.handBackCents + owed.lateCaptureCents;
  }
  for (const { payment } of openCardRefunds) owingPayments.set(payment.id, payment);

  let paymentOwedCents = 0;
  for (const payment of owingPayments.values()) {
    paymentOwedCents += refundsOwedOfCashParts(getNetCollectedCashParts(payment));
  }

  // Owner, 8 Oct 2026: one club-wide line, against no booking.
  const settlementIds = openGroupRefunds.map((operation) => groupSettlementIdForRefundRecoveryKey(operation.idempotencyKey));
  const groupSettlementOwedCents =
    settlementIds.length === 0
      ? 0
      : legacyGroupSettlementRefundOwedCents(
          await db.groupBookingSettlement.findMany({
            where: { id: { in: settlementIds } },
            select: { status: true, stripePaymentIntentId: true, refundPlan: true },
          }),
        );

  return {
    refundsOwedCents: paymentOwedCents + uncappedTaskOwedCents + groupSettlementOwedCents,
    creditsOwedCents: sumOutstandingCreditCents(balances),
  };
}

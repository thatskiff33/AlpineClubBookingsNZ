import type { Prisma } from "@prisma/client";
import { netCollectedBookingSelect, netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { openTaskOwedCents } from "@/lib/manual-refund-task-settlement-rules";
import {
  readMemberCreditBalances,
  sumOutstandingCreditCents,
} from "@/lib/member-credit-balances";
import { OPEN_CARD_REFUND_OPERATION_WHERE } from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts, refundsOwedOfCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import type { RefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed-shared";

/**
 * A payment that owes anything back, with the very columns Net Collected reads
 * (`netCollectedPaymentSelect`) and its id to read it once, so its owed parts
 * come from the one per-payment rule (`getNetCollectedCashParts`).
 */
const OWING_PAYMENT_SELECT = { id: true, ...netCollectedPaymentSelect } as const satisfies Prisma.PaymentSelect;

/**
 * Every open task, each with its booking's `deletedAt` (which tells a legacy
 * late capture apart) and the booking's payment, if it has one.
 */
const OPEN_TASK_QUERY = {
  where: { status: "OPEN" },
  select: {
    ...netCollectedBookingSelect.manualRefundTasks.select,
    booking: { select: { deletedAt: true, payment: { select: OWING_PAYMENT_SELECT } } },
  },
} as const satisfies Prisma.ManualRefundTaskFindManyArgs;

/** Every unclosed card refund, with the payment it hangs on. */
const OPEN_CARD_REFUND_QUERY = {
  where: OPEN_CARD_REFUND_OPERATION_WHERE,
  select: { payment: { select: OWING_PAYMENT_SELECT } },
} as const satisfies Prisma.PaymentRecoveryOperationFindManyArgs;

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
 *   tasks on a booking with no payment, which nothing caps.
 * - Credits owed: the members' credit-ledger balances
 *   (`sumOutstandingCreditCents`).
 */
export async function readRefundsAndCreditsOwed(
  db: Pick<Prisma.TransactionClient, "manualRefundTask" | "memberCredit" | "paymentRecoveryOperation"> = prisma,
): Promise<RefundsAndCreditsOwed> {
  const [openTasks, openCardRefunds, balances] = await Promise.all([
    db.manualRefundTask.findMany(OPEN_TASK_QUERY),
    db.paymentRecoveryOperation.findMany(OPEN_CARD_REFUND_QUERY),
    readMemberCreditBalances(db),
  ]);
  // One payment, read once, however many tasks and refunds it carries.
  const owingPayments = new Map<string, Prisma.PaymentGetPayload<{ select: typeof OWING_PAYMENT_SELECT }>>();
  let paymentlessOwedCents = 0;
  for (const task of openTasks) {
    const payment = task.booking.payment;
    if (payment) {
      owingPayments.set(payment.id, payment);
      continue;
    }
    const owed = openTaskOwedCents([task], task.booking);
    paymentlessOwedCents += owed.handBackCents + owed.lateCaptureCents;
  }
  for (const { payment } of openCardRefunds) owingPayments.set(payment.id, payment);

  let paymentOwedCents = 0;
  for (const payment of owingPayments.values()) {
    paymentOwedCents += refundsOwedOfCashParts(getNetCollectedCashParts(payment));
  }
  return {
    refundsOwedCents: paymentOwedCents + paymentlessOwedCents,
    creditsOwedCents: sumOutstandingCreditCents(balances),
  };
}

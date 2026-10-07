import type { Prisma } from "@prisma/client";
import { netCollectedBookingSelect, netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { openTaskOwedCents } from "@/lib/manual-refund-task-settlement-rules";
import {
  readMemberCreditBalances,
  sumOutstandingCreditCents,
} from "@/lib/member-credit-balances";
import {
  OPEN_CARD_REFUND_OPERATION_WHERE,
  openCardRefundOwedCents,
} from "@/lib/open-card-refund-owed";
import { prisma } from "@/lib/prisma";
import type { RefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed-shared";

/**
 * The open tasks the "Refunds owed" figure reads, in the shape the rule takes,
 * with the booking's `deletedAt` that tells a legacy late capture apart.
 */
const OPEN_TASK_QUERY = {
  where: { status: "OPEN" },
  select: {
    ...netCollectedBookingSelect.manualRefundTasks.select,
    booking: { select: { deletedAt: true } },
  },
} as const satisfies Prisma.ManualRefundTaskFindManyArgs;

/**
 * The card refunds not yet paid, each with its payment's figures and recorded
 * refunds - the same columns Net Collected reads (`netCollectedCardRefundSelect`),
 * so the two cannot disagree. Read from the operations, the small set, and
 * grouped by payment below.
 */
const OPEN_CARD_REFUND_QUERY = {
  where: OPEN_CARD_REFUND_OPERATION_WHERE,
  select: {
    paymentId: true,
    ...netCollectedCardRefundSelect.recoveryOperations.select,
    payment: {
      select: {
        status: true,
        amountCents: true,
        refundedAmountCents: true,
        refunds: netCollectedCardRefundSelect.refunds,
      },
    },
  },
} as const satisfies Prisma.PaymentRecoveryOperationFindManyArgs;

/**
 * #3372 (owner, 7 Oct 2026): "Refunds owed" and "Credits owed", as at today and
 * club-wide (`RefundsAndCreditsOwed`). Each part is read by the one rule Net
 * Collected uses to take it off, so the two figures reconcile:
 *
 * - Refunds owed: every open task's refund owed by hand and late card charge
 *   awaiting the treasurer (`openTaskOwedCents`, one task counted once), plus
 *   every payment's card refunds not yet paid by Stripe
 *   (`openCardRefundOwedCents`, net of what is already recorded, capped per
 *   payment).
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
  const taskOwedCents = openTasks.reduce((sum, task) => {
    const owed = openTaskOwedCents([task], task.booking);
    return sum + owed.handBackCents + owed.lateCaptureCents;
  }, 0);
  // One payment, all its open card refunds: the net-out and the cap are per payment.
  const byPayment = new Map<
    string,
    (typeof openCardRefunds)[number]["payment"] & { recoveryOperations: typeof openCardRefunds }
  >();
  for (const operation of openCardRefunds) {
    const payment = byPayment.get(operation.paymentId);
    if (payment) payment.recoveryOperations.push(operation);
    else byPayment.set(operation.paymentId, { ...operation.payment, recoveryOperations: [operation] });
  }
  const cardRefundOwedCents = [...byPayment.values()].reduce(
    (sum, payment) => sum + openCardRefundOwedCents(payment),
    0,
  );
  return {
    refundsOwedCents: taskOwedCents + cardRefundOwedCents,
    creditsOwedCents: sumOutstandingCreditCents(balances),
  };
}

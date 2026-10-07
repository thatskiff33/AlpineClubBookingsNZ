import type { Prisma } from "@prisma/client";
import { netCollectedBookingSelect } from "@/lib/additional-ledger-gap";
import { openHandBackOwedCents } from "@/lib/manual-refund-task-settlement-rules";
import {
  readMemberCreditBalances,
  sumOutstandingCreditCents,
} from "@/lib/member-credit-balances";
import { prisma } from "@/lib/prisma";
import type { RefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed-shared";

/** The open tasks the "Refunds owed" figure reads, in the shape the rule takes. */
const OPEN_TASK_QUERY = {
  where: { status: "OPEN" },
  select: netCollectedBookingSelect.manualRefundTasks.select,
} as const satisfies Prisma.ManualRefundTaskFindManyArgs;

/**
 * #3372 (owner, 7 Oct 2026): "Refunds owed" and "Credits owed", as at today and
 * club-wide (`RefundsAndCreditsOwed`). Each figure is read by its one rule:
 * the open hand-backs Net Collected also subtracts (`openHandBackOwedCents`),
 * and the members' credit-ledger balances (`sumOutstandingCreditCents`).
 */
export async function readRefundsAndCreditsOwed(
  db: Pick<Prisma.TransactionClient, "manualRefundTask" | "memberCredit"> = prisma,
): Promise<RefundsAndCreditsOwed> {
  const [openTasks, balances] = await Promise.all([
    db.manualRefundTask.findMany(OPEN_TASK_QUERY),
    readMemberCreditBalances(db),
  ]);
  return {
    refundsOwedCents: openHandBackOwedCents(openTasks),
    creditsOwedCents: sumOutstandingCreditCents(balances),
  };
}

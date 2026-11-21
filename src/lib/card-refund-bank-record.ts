import type { ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";

import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  COMPLETED_CANCEL_CARD_SHORTFALL_TASK_WHERE,
  isCancelCardShortfallTask,
  isCardRefundPaidAnotherWayTask,
} from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4488 (`INV-PAY-141`, `INV-SSOT`): A CARD REFUND'S BANK RECORD - a completed
 * task recording bank money paid back for card money a card refund could not
 * carry. It is a "Paid another way" close (`INV-PAY-122`) or a COMPLETED card
 * refund shortfall, a cancel's or a capacity race's (`INV-PAY-129`,
 * `INV-PAY-135`: one key prefix holds both). Its money stands once recorded:
 * #4162's undo never takes one (`bank-refund-void-scan.ts` asks the predicate
 * below), and only a dismissed task reopens. So the card-refund writer's floor
 * counts it (`readCardRefundBankCashByPayment`). An ordinary bank hand-back is
 * not one: #4162 can undo it while its task still reads completed.
 */
export const CARD_REFUND_BANK_RECORD_TASK_WHERE = {
  OR: [CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, COMPLETED_CANCEL_CARD_SHORTFALL_TASK_WHERE],
} satisfies Prisma.ManualRefundTaskWhereInput;

/** The same question of one task: is it a card refund's bank record? */
export function isCardRefundBankRecordTask(task: {
  kind: ManualRefundTaskKind | string | null;
  status: ManualRefundTaskStatus | string;
  occurrenceKey: string | null;
}): boolean {
  return task.status === "COMPLETED" && (isCardRefundPaidAnotherWayTask(task) || isCancelCardShortfallTask(task));
}

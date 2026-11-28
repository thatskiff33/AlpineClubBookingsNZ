import type { BookingImportRowStatus, ManualRefundTaskStatus } from "@prisma/client";

import { isCancellationOwnHandBack } from "@/lib/manual-refund-task-hand-back-journal";
import type { HandBackFacts } from "@/lib/manual-refund-task-hand-back-population";

/**
 * #5005 child D (owner decision O1, 11 Nov 2026): WHICH REFUND TASKS MAY BE GIVEN AS ACCOUNT CREDIT. The one rule
 * the writer (`refund-credit.ts`) asks under its locks and the refund queue's payload asks to offer the button
 * (`INV-SSOT`), so the screen never offers a control the server refuses.
 *
 * Only a cancelled imported booking's own hand-back qualifies: the task a cancellation raised for the payment the
 * import recorded, on a booking whose import row is still IMPORTED. `INV-PAY-044` stands for every other cash
 * booking, so an ordinary cash or Internet Banking booking's hand-back is paid back by hand as before. An edit's,
 * an appeal's or a card shortfall's hand-back is not the cancellation's, and an organisation has no credit account.
 */

export type ImportedRefundCreditFacts = HandBackFacts & {
  status: ManualRefundTaskStatus | string;
  paymentId: string | null;
  amountCents: number | null;
  booking: {
    memberId: string | null;
    importRow: { status: BookingImportRowStatus | string } | null;
    payment: { id: string } | null;
  };
};

export const IMPORTED_REFUND_CREDIT_CLOSED = "This refund task has already been closed.";
export const IMPORTED_REFUND_CREDIT_NOT_IMPORTED =
  "Only a cancelled imported booking's refund can be given as account credit. Pay this one back by bank transfer.";
export const IMPORTED_REFUND_CREDIT_ORGANISATION =
  "This booking belongs to an organisation, which has no account to hold credit. Pay it back by bank transfer.";
export const IMPORTED_REFUND_CREDIT_NO_AMOUNT = "This refund has no amount to give as credit.";

/** Why this task cannot be given as account credit, in the officer's words, or null when it can. */
export function importedRefundCreditRefusal(task: ImportedRefundCreditFacts): string | null {
  if (task.status !== "OPEN") return IMPORTED_REFUND_CREDIT_CLOSED;
  if (
    !isCancellationOwnHandBack(task) ||
    task.paymentId === null ||
    task.booking.payment?.id !== task.paymentId ||
    task.booking.importRow?.status !== "IMPORTED"
  ) {
    return IMPORTED_REFUND_CREDIT_NOT_IMPORTED;
  }
  if (task.booking.memberId === null) return IMPORTED_REFUND_CREDIT_ORGANISATION;
  if (task.amountCents === null || task.amountCents <= 0) return IMPORTED_REFUND_CREDIT_NO_AMOUNT;
  return null;
}

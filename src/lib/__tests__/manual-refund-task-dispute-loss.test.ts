/**
 * #4516 (owner decision, 18 Nov 2026, comment 6951152823): lost card dispute cents are applied ONCE across all of a
 * payment's dispute-loss hand-backs (a cancellation's own and a dispute-held edit's), oldest open task first. The pure
 * rule (`disputeLossAvailableToTask`, through `journalHandBackDismissal`) that the dismissal door, the reduction door,
 * the Mark paid refusal and the queue all ask. The doors' locks and writes are proved in `manual-refund-task.test.ts`
 * and on PostgreSQL in `dispute-loss-hand-backs.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  disputeLossAvailableToTask, journalHandBackDismissal, type HandBackDisputeContext, type PaymentHandBackTask,
} from "@/lib/manual-refund-task-hand-back-journal";
import {
  DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, DISPUTED_HAND_BACK_LOST_NOT_PAYABLE, DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING,
  DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE, JOURNAL_HAND_BACK_DISMISS_REFUSAL,
} from "@/lib/manual-refund-task-copy";

const at = (day: number) => new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`);
const task = (id: string, facts: Partial<PaymentHandBackTask>): PaymentHandBackTask => ({
  id, paymentId: "payment-1", status: "OPEN", createdAt: at(1), amountCents: 10_000, raisedAmountCents: 10_000,
  kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null, partPaymentReviewPaymentId: null, reason: "Booking b cancelled", ...facts,
});
const EDIT_KEY = "edit-refund-hand-back:mod-1";
const lost = (cents: number, id = "dp_1", status = "LOST") => ({ stripeDisputeId: id, status: status as never, amountCents: cents, paymentId: "payment-1" });
const context = (tasks: PaymentHandBackTask[], disputes = [lost(10_000)]): HandBackDisputeContext => ({ disputes, paymentTasks: tasks });

describe("lost dispute cents are applied once across a payment's hand-backs (owner decision, 18 Nov 2026)", () => {
  it("$100 lost, a $100 edit hand-back then a $200 cancel hand-back: the edit is dismissible, the cancel stays payable in full", () => {
    const edit = task("edit", { occurrenceKey: EDIT_KEY, createdAt: at(1) });
    const cancel = task("cancel", { createdAt: at(2), amountCents: 20_000, raisedAmountCents: 20_000 });
    const ctx = context([edit, cancel]);

    expect(journalHandBackDismissal(edit, ctx)).toMatchObject({ withdraws: true, disputeLost: true, markPaidRefusal: DISPUTED_HAND_BACK_LOST_NOT_PAYABLE });
    expect(journalHandBackDismissal(cancel, ctx)).toMatchObject({ refusal: DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, reduction: null, markPaidRefusal: null });
    // Written off in total: the edit's $100, never also $100 of the cancel's.
    expect(disputeLossAvailableToTask(edit, ctx) + disputeLossAvailableToTask(cancel, ctx)).toBe(10_000);
  });

  it("the other order: a $200 cancel then a $100 edit: the cancel is reduced by $100, the edit stays payable in full", () => {
    const cancel = task("cancel", { createdAt: at(1), amountCents: 20_000, raisedAmountCents: 20_000 });
    const edit = task("edit", { occurrenceKey: EDIT_KEY, createdAt: at(2) });
    const ctx = context([cancel, edit]);

    expect(journalHandBackDismissal(cancel, ctx)).toMatchObject({ reduction: { cents: 10_000 }, markPaidRefusal: DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING });
    expect(journalHandBackDismissal(edit, ctx)).toMatchObject({ refusal: DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, withdraws: false, markPaidRefusal: null });
  });

  it("once the older task has applied the loss, nothing is left for the younger one", () => {
    const edit = task("edit", { occurrenceKey: EDIT_KEY, createdAt: at(1), status: "DISMISSED" });
    const cancel = task("cancel", { createdAt: at(2), amountCents: 20_000, raisedAmountCents: 20_000 });
    expect(disputeLossAvailableToTask(cancel, context([edit, cancel]))).toBe(0);
    // Reduced instead: the cancel reduced by $100 leaves the edit nothing either.
    const reduced = task("cancel", { createdAt: at(1), amountCents: 10_000, raisedAmountCents: 20_000 });
    const younger = task("edit", { occurrenceKey: EDIT_KEY, createdAt: at(2) });
    expect(disputeLossAvailableToTask(younger, context([reduced, younger]))).toBe(0);
    expect(journalHandBackDismissal(younger, context([reduced, younger])).markPaidRefusal).toBeNull();
  });

  it("a part-lost dispute spread across two tasks: the older takes all it owes, the younger the rest, never more than lost", () => {
    const older = task("older", { occurrenceKey: EDIT_KEY, createdAt: at(1), amountCents: 6_000, raisedAmountCents: 6_000 });
    const younger = task("younger", { createdAt: at(2), amountCents: 10_000, raisedAmountCents: 10_000 });
    const ctx = context([older, younger], [lost(9_000)]);

    expect(journalHandBackDismissal(older, ctx)).toMatchObject({ withdraws: true });
    expect(journalHandBackDismissal(younger, ctx)).toMatchObject({ reduction: { cents: 3_000 } });
    // After the older is dismissed, the younger still gets exactly 3,000.
    const after = context([{ ...older, status: "DISMISSED" }, younger], [lost(9_000)]);
    expect(disputeLossAvailableToTask(younger, after)).toBe(3_000);
    // And after the younger is reduced by it, nothing is left anywhere.
    const done = context([{ ...older, status: "DISMISSED" }, { ...younger, amountCents: 7_000 }], [lost(9_000)]);
    expect(disputeLossAvailableToTask({ ...younger, amountCents: 7_000 }, done)).toBe(0);
  });

  it("a task on another payment, and a hand-back no dispute is set against (an appeal's bank part), take nothing and apply nothing", () => {
    const other = task("other", { paymentId: "payment-2", createdAt: at(1), status: "DISMISSED" });
    const appeal = task("appeal", { occurrenceKey: "refund-request-hand-back:req-1", createdAt: at(1), status: "DISMISSED" });
    const cancel = task("cancel", { createdAt: at(2) });
    expect(disputeLossAvailableToTask(cancel, context([other, appeal, cancel]))).toBe(10_000);
    expect(journalHandBackDismissal(appeal, context([appeal], [lost(10_000)])).refusal).toBe(JOURNAL_HAND_BACK_DISMISS_REFUSAL);
  });

  it("an open dispute refuses Dismiss and Reduce for every task; Mark paid waits only where a loss is already this task's", () => {
    const edit = task("edit", { occurrenceKey: EDIT_KEY, createdAt: at(1) });
    const cancel = task("cancel", { createdAt: at(2) });
    const ctx = context([edit, cancel], [lost(4_000), lost(5_000, "dp_2", "OPEN")]);
    expect(journalHandBackDismissal(edit, ctx)).toMatchObject({ withdraws: false, reduction: null, markPaidRefusal: DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE });
    expect(journalHandBackDismissal(cancel, ctx)).toMatchObject({ withdraws: false, reduction: null, markPaidRefusal: null });
  });

  it("a won dispute leaves an edit's hand-back payable and not dismissible", () => {
    const edit = task("edit", { occurrenceKey: EDIT_KEY });
    expect(journalHandBackDismissal(edit, context([edit], [lost(10_000, "dp_1", "WON")]))).toMatchObject({ withdraws: false, reduction: null, markPaidRefusal: null });
  });
});

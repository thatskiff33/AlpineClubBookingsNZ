import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import type { PaymentHandBackTask } from "@/lib/manual-refund-task-hand-back-journal";
import { REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE } from "@/lib/manual-refund-task-reopen";
import { lateWinOwedAgain } from "@/lib/stripe-dispute-late-win";
import { stripeDisputeWonAfterLossNextStep } from "@/lib/stripe-dispute-note";

/**
 * #5197: which hand-backs a late win owes again. The once-only allocation (#4516, owner decision 18 Nov 2026) applied
 * a payment's lost cents to its dispute-loss hand-backs oldest first, dismissing or reducing them; a dispute that
 * then reads won undoes what is no longer covered, newest task first, a dismissal by reopening the task and a
 * reduction by naming its cents. The walk is proved here; the reopen itself against PostgreSQL in
 * `stripe-dispute-late-win.realdb.test.ts`.
 */

let sequence = 0;
function task(overrides: Partial<PaymentHandBackTask> & { day: number }): PaymentHandBackTask {
  const { day, ...rest } = overrides;
  sequence += 1;
  return {
    id: `task_${sequence}`, paymentId: "pay_1", status: "DISMISSED", amountCents: 10_000, raisedAmountCents: 10_000,
    createdAt: new Date(Date.UTC(2026, 5, day)), kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null,
    partPaymentReviewPaymentId: null, reason: "Booking cancelled while its card payment is disputed", ...rest,
  };
}
const lost = (cents: number, paymentId: string | null = "pay_1") => ({ stripeDisputeId: `dp_${cents}`, status: "LOST" as const, amountCents: cents, paymentId });

describe("lateWinOwedAgain (#5197)", () => {
  it("reopens a dismissed hand-back whole once no lost dispute covers it", () => {
    const dismissed = task({ day: 1 });
    expect(lateWinOwedAgain("pay_1", [dismissed], [])).toEqual({
      reopen: [{ taskId: dismissed.id, cents: 10_000, taskCents: 10_000 }], reduced: [],
    });
  });

  it("names a reduction's cents and reopens nothing for a task still open", () => {
    const reduced = task({ day: 1, status: "OPEN", amountCents: 7_000 });
    expect(lateWinOwedAgain("pay_1", [reduced], [])).toEqual({ reopen: [], reduced: [{ taskId: reduced.id, cents: 3_000 }] });
  });

  it("a reduced hand-back later dismissed: reopened for its rest, and its reduction named", () => {
    const both = task({ day: 1, amountCents: 7_000 });
    expect(lateWinOwedAgain("pay_1", [both], [])).toEqual({
      reopen: [{ taskId: both.id, cents: 7_000, taskCents: 7_000 }], reduced: [{ taskId: both.id, cents: 3_000 }],
    });
  });

  it("a part win: only what the disputes still lost no longer cover, the newest application first", () => {
    // $100 edit then $300 cancel, both dismissed by $400 lost across two disputes; the $100 one is won.
    const edit = task({ day: 1, occurrenceKey: editRefundHandBackOccurrenceKey("mod_1") });
    const cancel = task({ day: 2, amountCents: 30_000, raisedAmountCents: 30_000 });
    expect(lateWinOwedAgain("pay_1", [edit, cancel], [lost(30_000)])).toEqual({
      reopen: [{ taskId: cancel.id, cents: 10_000, taskCents: 30_000 }], reduced: [],
    });
  });

  it("MUTATION: the newest first, so the oldest task keeps the loss still lost", () => {
    const older = task({ day: 1 });
    const newer = task({ day: 2 });
    expect(lateWinOwedAgain("pay_1", [older, newer], [lost(10_000)]).reopen.map((item) => item.taskId)).toEqual([newer.id]);
  });

  it("counts only this payment's tasks and disputes, and only dispute-loss hand-backs", () => {
    const other = task({ day: 1, paymentId: "pay_2" });
    const appeal = task({ day: 2, occurrenceKey: "refund-request-hand-back:req_1" });
    const mine = task({ day: 3 });
    expect(lateWinOwedAgain("pay_1", [other, appeal, mine], [lost(10_000, "pay_2")]).reopen.map((item) => item.taskId)).toEqual([mine.id]);
  });

  it("owes nothing again while lost disputes still cover every application", () => {
    expect(lateWinOwedAgain("pay_1", [task({ day: 1 })], [lost(10_000)])).toEqual({ reopen: [], reduced: [] });
  });
});

describe("the won-after-loss alert's next step (#5197)", () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const read = { kind: "read" as const, reopened: [], alreadyOpen: [], notReopened: [], countedByCancellation: [], reduced: [] };

  it("never reads a failed read as no tasks", () => {
    const step = stripeDisputeWonAfterLossNextStep({ kind: "read-failed" }, money);
    expect(step).toMatch(/could not read this payment's refund tasks/);
    expect(step).not.toMatch(/No refund task/);
  });

  it("says nothing is owed again only when the read found nothing", () => {
    expect(stripeDisputeWonAfterLossNextStep(read, money)).toMatch(/No refund task on this payment was dismissed or reduced/);
  });

  it("a part reopen says how much is owed again and to reduce the rest first", () => {
    const step = stripeDisputeWonAfterLossNextStep({ ...read, reopened: [{ taskId: "t1", cents: 10_000, taskCents: 30_000 }] }, money);
    expect(step).toMatch(/task t1 \(\$300\.00, of which \$100\.00 is owed again; .*reduce it/);
  });

  it("lists an older dismissal with no recorded status as not reopened, to check by hand, never as counted by the cancellation", () => {
    const step = stripeDisputeWonAfterLossNextStep({ ...read, notReopened: [{ taskId: "t3", cents: 10_000, reason: REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE }] }, money);
    expect(step).toContain("the app could not reopen them: task t3 ($100.00): It was dismissed before the app recorded the booking's status");
    expect(step).toContain("Check the booking's payments by hand");
    expect(step).not.toMatch(/counted that money in its own refund/);
    // Reopen is refused for this one, so the list never tells the treasurer simply to reopen it.
    expect(step).toContain("Check each one by hand: reopen it under Finance → Payments where the app allows");
    expect(step).not.toMatch(/Reopen them under/);
  });

  it("names a task already back on the queue", () => {
    expect(stripeDisputeWonAfterLossNextStep({ ...read, alreadyOpen: [{ taskId: "t2" }] }, money)).toMatch(/Already back on the queue: task t2\./);
  });
});

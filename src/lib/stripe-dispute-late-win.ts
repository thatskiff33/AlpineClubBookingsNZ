import "server-only";

import type { StripeDispute } from "@prisma/client";

import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import {
  isDisputeLossHandBack,
  lossAppliedByTask,
  readPaymentHandBackTasks,
  type HandBackDisputes,
  type PaymentHandBackTask,
} from "@/lib/manual-refund-task-hand-back-journal";
import { reopenHandBackAfterLateWin } from "@/lib/manual-refund-task-reopen";
import { prisma } from "@/lib/prisma";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import { stripeDisputeLateWinReopenKey } from "@/lib/stripe-dispute-keys";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";
import { disputeIsLost, type LateWinHandBackReport } from "@/lib/stripe-dispute-note";

/**
 * #5197 (`INV-PAY-154`, owner decision 18 Nov 2026): A LOST DISPUTE STRIPE LATER REPORTS WON (a "late win").
 *
 * While a card dispute read lost, an officer could dismiss the payment's hand-back task (the cardholder had the money
 * back) or reduce it by the lost part (#4516, owner decision 15 Nov 2026), withdrawing that much of its refund debt.
 * Won, the money is the club's again and it owes the member: the app reopens each dismissed task and posts its debt
 * again (`reopenHandBackAfterLateWin`), and the won-after-loss alert names every task, reopened or not, and every
 * reduction now owed again, which the app leaves for an officer. It moves no money.
 *
 * Which tasks: the lost cents every dispute-loss hand-back on the payment applied (`lossAppliedByTask`, the once-only
 * allocation's own count) less the lost cents still on the payment are owed again, walked NEWEST task first (the
 * allocation applied loss oldest first, so the newest application is undone first): a dismissed task is reopened
 * whole and a reduction is reported with its cents, until the owed cents run out.
 */

/** What a late win owes again: tasks to reopen and reductions to report, each with the cents owed again. */
export type LateWinOwedAgain = {
  reopen: { taskId: string; cents: number; taskCents: number }[];
  reduced: { taskId: string; cents: number }[];
};

const newestFirst = (a: PaymentHandBackTask, b: PaymentHandBackTask) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The allocation in reverse, for one payment: pure, so the walk is tested without a database. */
export function lateWinOwedAgain(paymentId: string, tasks: readonly PaymentHandBackTask[], disputes: HandBackDisputes): LateWinOwedAgain {
  const lossTasks = tasks.filter((task) => task.paymentId === paymentId && isDisputeLossHandBack(task));
  const applied = lossTasks.reduce((sum, task) => sum + lossAppliedByTask(task), 0);
  const stillLost = disputes.filter((dispute) => dispute.paymentId === paymentId && disputeIsLost(dispute.status))
    .reduce((sum, dispute) => sum + dispute.amountCents, 0);
  let owed = Math.max(0, applied - stillLost);
  const result: LateWinOwedAgain = { reopen: [], reduced: [] };
  for (const task of [...lossTasks].sort(newestFirst)) {
    if (owed <= 0) break;
    const raised = task.raisedAmountCents ?? task.amountCents ?? 0;
    const rest = task.amountCents ?? raised;
    if (task.status === "DISMISSED" && rest > 0) {
      result.reopen.push({ taskId: task.id, cents: Math.min(owed, rest), taskCents: rest });
      owed -= rest;
    }
    const reduction = Math.min(owed, Math.max(0, raised - rest));
    if (reduction > 0) {
      result.reduced.push({ taskId: task.id, cents: reduction });
      owed -= reduction;
    }
  }
  return result;
}

/** Why a reopen did not happen, in the alert's words. */
function notReopenedReason(err: unknown): string {
  if (err instanceof ManualBookingPaymentError) return err.message;
  if (isPostgresLockNotAvailable(err)) return "The booking was busy with another change, so the app did not wait for it.";
  return "The app hit an unexpected error reopening it.";
}

/**
 * Reopen what a late win owes and report it, after the dispute's move to WON has committed and while its alert is
 * still unsent. Never throws: a failed read is reported as such (never as "no tasks"), and each task's refusal or lock
 * timeout is reported as not reopened. A task this late win reopened, in this delivery or an earlier or concurrent
 * one, is known by its (dispute, task) marker, read after the reopens, since the allocation no longer counts it once
 * it is open. A dispute with no payment (a group organiser's settlement) has no tasks.
 */
export async function settleLateWinHandBacks(row: Pick<StripeDispute, "stripeDisputeId" | "paymentId" | "bookingId">): Promise<LateWinHandBackReport> {
  const { paymentId, bookingId, stripeDisputeId: disputeId } = row;
  if (paymentId === null || bookingId === null) return { kind: "no-payment" };
  let tasks: PaymentHandBackTask[];
  let owedAgain: LateWinOwedAgain;
  try {
    tasks = await readPaymentHandBackTasks(prisma, [paymentId]);
    const disputes = (await readDisputesByBookingId(prisma, [bookingId])).get(bookingId) ?? [];
    owedAgain = lateWinOwedAgain(paymentId, tasks, disputes);
  } catch (err) {
    logger.error({ disputeId, paymentId, err }, "A late-won Stripe dispute's hand-back tasks could not be read; the alert says so (#5197)");
    return { kind: "read-failed" };
  }

  const reopened: { taskId: string; cents: number; taskCents: number }[] = [];
  const open: { taskId: string; cents: number; taskCents: number }[] = [];
  const notReopened: { taskId: string; cents: number; reason: string }[] = [];
  for (const item of owedAgain.reopen) {
    try {
      const outcome = await reopenHandBackAfterLateWin({ taskId: item.taskId, disputeId });
      (outcome === "reopened" ? reopened : open).push(item);
    } catch (err) {
      logger.warn({ disputeId, taskId: item.taskId, err }, "A late-won Stripe dispute's dismissed hand-back was not reopened; the alert names it (#5197)");
      notReopened.push({ taskId: item.taskId, cents: item.cents, reason: notReopenedReason(err) });
    }
  }
  const marked = await reopenedByThisLateWin(disputeId, tasks);
  for (const task of tasks) {
    if (!marked.has(task.id) || reopened.some((item) => item.taskId === task.id)) continue;
    // Reopened by another delivery of this late win: its whole amount (the walk's part is not kept).
    const cents = open.find((item) => item.taskId === task.id)?.cents ?? task.amountCents ?? 0;
    reopened.push({ taskId: task.id, cents, taskCents: task.amountCents ?? 0 });
  }
  const alreadyOpen = open.filter((item) => !marked.has(item.taskId)).map((item) => ({ taskId: item.taskId }));
  return { kind: "read", reopened, alreadyOpen, notReopened, reduced: owedAgain.reduced };
}

/** The tasks whose (dispute, task) marker a reopen of this late win committed; none when the read fails (logged). */
async function reopenedByThisLateWin(disputeId: string, tasks: readonly PaymentHandBackTask[]): Promise<Set<string>> {
  const byKey = new Map(tasks.map((task) => [stripeDisputeLateWinReopenKey(disputeId, task.id), task.id]));
  try {
    const held = await prisma.alertCooldown.findMany({ where: { key: { in: [...byKey.keys()] } }, select: { key: true } });
    return new Set(held.map((cooldown) => byKey.get(cooldown.key)!));
  } catch (err) {
    logger.error({ disputeId, err }, "A late-won Stripe dispute's reopen markers could not be read; the alert names this delivery's reopens only (#5197)");
    return new Set();
  }
}

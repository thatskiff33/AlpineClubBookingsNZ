import "server-only";

import type { StripeDispute } from "@prisma/client";

import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import {
  handBackRaisedCents,
  isDisputeLossHandBack,
  lossAppliedByTask,
  lostCentsOnPayment,
  olderThan,
  readPaymentHandBackTasks,
  type HandBackDisputes,
  type PaymentHandBackTask,
} from "@/lib/manual-refund-task-hand-back-journal";
import { reopenHandBackAfterLateWin, ReopenCountedByCancellationError } from "@/lib/manual-refund-task-reopen";
import { prisma } from "@/lib/prisma";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import { stripeDisputeLateWinReopenKey } from "@/lib/stripe-dispute-keys";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";
import type { LateWinHandBackReport } from "@/lib/stripe-dispute-note";

/**
 * #5197 (`INV-PAY-154`): A LOST DISPUTE STRIPE LATER REPORTS WON (a "late win").
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
 *
 * A stated limit, the allocation's own (`INV-PAY-157`): a dispute-loss task dismissed for another reason by older code
 * counts as applied loss, so a late win may reopen it. Nothing records why a task was dismissed before #4516.
 */

/** What a late win owes again: tasks to reopen and reductions to report, each with the cents owed again. */
export type LateWinOwedAgain = {
  reopen: { taskId: string; cents: number; taskCents: number }[];
  reduced: { taskId: string; cents: number }[];
};

/** The allocation in reverse, for one payment: pure, so the walk is tested without a database. */
export function lateWinOwedAgain(paymentId: string, tasks: readonly PaymentHandBackTask[], disputes: HandBackDisputes): LateWinOwedAgain {
  const lossTasks = tasks.filter((task) => task.paymentId === paymentId && isDisputeLossHandBack(task));
  const applied = lossTasks.reduce((sum, task) => sum + lossAppliedByTask(task), 0);
  let owed = Math.max(0, applied - lostCentsOnPayment(paymentId, disputes));
  const result: LateWinOwedAgain = { reopen: [], reduced: [] };
  for (const task of [...lossTasks].sort((a, b) => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0))) {
    if (owed <= 0) break;
    const raised = handBackRaisedCents(task);
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
 * timeout is reported as not reopened. A task this late win reopened, in an earlier or concurrent delivery, is known by
 * its (dispute, task) marker: the walk reads it as still dismissed, so every delivery plans the same reopens with the
 * same cents, and the markers are read again after the reopens to tell a concurrent delivery's from an officer's. A
 * dispute with no payment (a group organiser's settlement) has no tasks.
 */
export async function settleLateWinHandBacks(row: Pick<StripeDispute, "stripeDisputeId" | "paymentId" | "bookingId">): Promise<LateWinHandBackReport> {
  const { paymentId, bookingId, stripeDisputeId: disputeId } = row;
  if (paymentId === null || bookingId === null) return { kind: "no-payment" };
  let owedAgain: LateWinOwedAgain;
  let tasks: PaymentHandBackTask[];
  try {
    tasks = await readPaymentHandBackTasks(prisma, [paymentId]);
    const disputes = (await readDisputesByBookingId(prisma, [bookingId])).get(bookingId) ?? [];
    const marked = await reopenedByThisLateWin(disputeId, tasks);
    const asPlanned = tasks.map((task) => (marked.has(task.id) ? { ...task, status: "DISMISSED" } : task));
    owedAgain = lateWinOwedAgain(paymentId, asPlanned, disputes);
  } catch (err) {
    logger.error({ disputeId, paymentId, err }, "A late-won Stripe dispute's hand-back tasks could not be read; the alert says so (#5197)");
    return { kind: "read-failed" };
  }

  const reopened: { taskId: string; cents: number; taskCents: number }[] = [];
  const open: { taskId: string; cents: number; taskCents: number }[] = [];
  const notReopened: { taskId: string; cents: number; reason: string }[] = [];
  const countedByCancellation: { taskId: string; cents: number }[] = [];
  for (const item of owedAgain.reopen) {
    try {
      const outcome = await reopenHandBackAfterLateWin({ taskId: item.taskId, disputeId });
      (outcome === "reopened" ? reopened : open).push(item);
    } catch (err) {
      logger.warn({ disputeId, taskId: item.taskId, err }, "A late-won Stripe dispute's dismissed hand-back was not reopened; the alert names it (#5197)");
      if (err instanceof ReopenCountedByCancellationError) countedByCancellation.push(item);
      else notReopened.push({ taskId: item.taskId, cents: item.cents, reason: notReopenedReason(err) });
    }
  }
  // A task already open was reopened by another delivery of this late win (its marker) or by an officer.
  const markedNow = await reopenedByThisLateWin(disputeId, tasks).catch((err: unknown) => {
    logger.error({ disputeId, err }, "A late-won Stripe dispute's reopen markers could not be read; the alert calls those tasks already open (#5197)");
    return new Set<string>();
  });
  const alreadyOpen = open.filter((item) => !markedNow.has(item.taskId)).map((item) => ({ taskId: item.taskId }));
  reopened.push(...open.filter((item) => markedNow.has(item.taskId)));
  return { kind: "read", reopened, alreadyOpen, notReopened, countedByCancellation, reduced: owedAgain.reduced };
}

/** The tasks whose (dispute, task) marker a reopen of this late win committed. */
async function reopenedByThisLateWin(disputeId: string, tasks: readonly PaymentHandBackTask[]): Promise<Set<string>> {
  const byKey = new Map(tasks.map((task) => [stripeDisputeLateWinReopenKey(disputeId, task.id), task.id]));
  const held = await prisma.alertCooldown.findMany({ where: { key: { in: [...byKey.keys()] } }, select: { key: true } });
  return new Set(held.map((cooldown) => byKey.get(cooldown.key)!));
}

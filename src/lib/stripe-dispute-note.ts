/**
 * #4911 (`INV-PAY-154`): what the treasurer does about a Stripe dispute, per
 * stage and outcome - one copy shared by the hand-built HTML
 * (`email-templates/admin-stripe-dispute.ts`), the `{{disputeNextStep}}` token
 * an admin's saved body renders, and the registry's preview sample. A leaf
 * module: the registry imports it without loading the email layout.
 */
import type { StripeDisputeStatus } from "@prisma/client";

/** How a dispute's status reads in the alert and on the admin payments list. */
export const STRIPE_DISPUTE_STATUS_LABEL: Record<StripeDisputeStatus, string> = {
  OPEN: "open",
  WON: "won",
  LOST: "lost",
  CLOSED_OTHER: "closed with no funds taken",
};

/**
 * The disputes a refusal, a recovery row's cause or a treasurer task names, as
 * "dp_1 (open), dp_2 (lost)": one wording, so each surface names a dispute alike.
 */
export function namedDisputes(disputes: ReadonlyArray<{ stripeDisputeId: string; status: StripeDisputeStatus }>): string {
  return disputes.map((dispute) => `${dispute.stripeDisputeId} (${STRIPE_DISPUTE_STATUS_LABEL[dispute.status]})`).join(", ");
}

/**
 * The statuses that hold a capture's refunds and credits: open, or lost to the
 * cardholder. The one rule the hold's query (`stripe-dispute-hold.ts`) and every
 * dispute marker read; kept here, a leaf, so client components can import it.
 */
export const HOLDING_DISPUTE_STATUSES: readonly StripeDisputeStatus[] = ["OPEN", "LOST"];

/** Whether a dispute in this status holds its capture's refunds and credits. */
export function disputeHoldsCapture(status: StripeDisputeStatus): boolean {
  return HOLDING_DISPUTE_STATUSES.includes(status);
}

/**
 * Whether a dispute was decided for the cardholder, who then already has the money back through their bank: the
 * one rule the refund refusal (`DisputedCaptureRefundRefusedError.lost`) and the disputed hand-back's dismissal
 * (#4516, owner decision 15 Nov 2026) read. A closed dispute never reopens to open; Stripe calls lost final but
 * allows a rare "late win" (lost to won), which updates the row like any newer closed outcome.
 */
export function disputeIsLost(status: StripeDisputeStatus): boolean {
  return status === "LOST";
}

/** What the app does while a dispute holds the capture: the one sentence both alerts carry. */
export const STRIPE_DISPUTE_HOLD_NOTE =
  "While the dispute is open or lost, the app issues no card refund and no account credit for this payment: a cancellation, or an edit that lowers the price, is recorded and handed to the treasurer instead. " +
  "The app posts nothing to Xero for the dispute.";

/** The next step, by what the alert reports. */
export const STRIPE_DISPUTE_NEXT_STEP: Record<StripeDisputeStatus, string> = {
  OPEN:
    "The cardholder's bank has disputed this payment. Respond in Stripe with evidence before Stripe's deadline (the Disputes page shows it); if nobody responds, the dispute is lost. " +
    "Stripe has usually taken the amount and a dispute fee from the club's balance already.",
  WON:
    "The dispute was decided for the club and Stripe returned the disputed amount. Refunds and credits for this payment follow the normal rules again. " +
    "If you recorded the withdrawal in Xero by hand, record its reversal the same way.",
  LOST:
    "The dispute was decided for the cardholder: the money is not coming back and the cardholder already has it. Do not refund or credit this payment. " +
    "Record the loss and Stripe's dispute fee in Xero by hand against the Stripe clearing account, as the deployment guide's lost-dispute procedure describes. " +
    "If the booking was cancelled and its refund handed to the treasurer, that task can be dismissed on the payments board once the lost amount covers it: the cardholder already has the money.",
  CLOSED_OTHER:
    "Stripe closed this dispute without taking funds (an inquiry or a prevented dispute). Refunds and credits for this payment follow the normal rules again.",
};

/**
 * Which of a dispute's alerts this is: when it opens, when it closes, and the
 * one more a dispute already closed as lost owes when a newer event reports it
 * won (#5061 follow-up).
 */
export type StripeDisputeAlertStage = "opened" | "closed" | "won-after-loss";

/**
 * #5197: what a late win did about the hand-back tasks on the disputed payment, for the won-after-loss alert. A task
 * dismissed while the dispute read lost is reopened by the app (`reopened`), was already back on the queue
 * (`alreadyOpen`), could not be reopened (`notReopened`, with the reason: among them an older dismissal that recorded no
 * booking status, left to check by hand), or is an edit's refund dismissed before its booking's cancellation, which
 * then counted that money in its own refund (`countedByCancellation`); a reduction made
 * for the loss is owed again but changes nothing in the app (`reduced`). `cents` is what the late win makes owed again.
 */
export type LateWinHandBackReport =
  | { kind: "no-payment" }
  | { kind: "read-failed" }
  | {
      kind: "read";
      reopened: readonly { taskId: string; cents: number; taskCents: number }[];
      alreadyOpen: readonly { taskId: string }[];
      notReopened: readonly { taskId: string; cents: number; reason: string }[];
      countedByCancellation: readonly { taskId: string; cents: number }[];
      reduced: readonly { taskId: string; cents: number }[];
    };

const WON_AFTER_LOSS_XERO =
  "This dispute was reported lost, and Stripe now reports it won: the disputed amount has come back to the club's balance. " +
  "If you recorded the loss and dispute fee in Xero, reverse that entry the same way, as the deployment guide's lost-dispute procedure describes.";

/**
 * The next step of the won-after-loss alert (#5061 follow-up, #5197): the lost alert told the treasurer to record the
 * loss in Xero, so this one says to reverse it, then names every hand-back task the loss dismissed or reduced and what
 * the app did about each. `money` formats cents as the alert's amounts are.
 */
export function stripeDisputeWonAfterLossNextStep(report: LateWinHandBackReport, money: (cents: number) => string): string {
  if (report.kind === "no-payment") {
    return `${WON_AFTER_LOSS_XERO} The app holds no booking payment for this charge, so no refund task was dismissed or reduced for it.`;
  }
  if (report.kind === "read-failed") {
    return `${WON_AFTER_LOSS_XERO} The app could not read this payment's refund tasks. Check the booking on the payments board: ` +
      "a refund task dismissed while the dispute read lost must be reopened and paid, and any reduction made for the loss is owed to the member again.";
  }
  const parts = [WON_AFTER_LOSS_XERO];
  const task = (item: { taskId: string; cents: number }) => `task ${item.taskId} (${money(item.cents)})`;
  if (report.reopened.length > 0) {
    const named = report.reopened.map((item) => item.cents < item.taskCents
      ? `task ${item.taskId} (${money(item.taskCents)}, of which ${money(item.cents)} is owed again; another lost dispute still covers the rest, so reduce it on the payments board before paying)`
      : task(item));
    parts.push(`The app reopened the refund tasks dismissed while the dispute read lost, and the club owes the member again: ${named.join("; ")}. Pay them back as usual.`);
  }
  if (report.alreadyOpen.length > 0) {
    parts.push(`Already back on the queue: ${report.alreadyOpen.map((item) => `task ${item.taskId}`).join("; ")}.`);
  }
  if (report.notReopened.length > 0) {
    const named = report.notReopened.map((item) => `${task(item)}: ${item.reason}`);
    parts.push(`These refund tasks were dismissed while the dispute read lost, and the app could not reopen them: ${named.join(" ")} ` +
      "Check each one by hand: reopen it under Finance → Payments where the app allows, or take it to the treasurer.");
  }
  if (report.countedByCancellation.length > 0) {
    parts.push(`Not reopened, because the booking was cancelled after they were dismissed and its cancellation counted that money in its own refund: ${report.countedByCancellation.map(task).join("; ")}.`);
  }
  if (report.reduced.length > 0) {
    parts.push(`These refund tasks were reduced while the dispute read lost, and the amount taken off is owed to the member again: ${report.reduced.map(task).join("; ")}. ` +
      "The app leaves a reduced task as it is: pay the member that amount by bank transfer, with the rest of the task, and take it to the treasurer to record.");
  }
  if (parts.length === 1) parts.push("No refund task on this payment was dismissed or reduced for the loss, so nothing more is owed to the member because of it.");
  return parts.join(" ");
}

/**
 * The subject phrase (`{{disputeSubjectLabel}}`): which of the dispute's
 * alerts this is, and once closed, how it ended. One template carries them all,
 * so a subject typed in by hand would title a closed dispute as a new one.
 */
export function stripeDisputeSubjectLabel(stage: StripeDisputeAlertStage, outcome: string): string {
  if (stage === "opened") return "Card payment disputed by the cardholder - respond in Stripe";
  if (stage === "won-after-loss") return "Lost card payment dispute now won - reverse the Xero loss entry";
  return `Card payment dispute closed (${outcome})`;
}

import "server-only";

import { PaymentStatus, type Prisma } from "@prisma/client";

import { groupCancelInProgress } from "@/lib/group-cancel-in-progress";

import { groupChildHandBacksFromRows, mirrorPlanShareWritten } from "@/lib/booking-ledger-group-child-plan";
import { GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { assertGroupMirrorHandBackWithinUnpromisedCash } from "@/lib/edit-refund-hand-back";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { mirrorPlanRefundedCents } from "@/lib/group-settlement-refund-plan";
import { isGroupSettlementMirrorHandBackKind } from "@/lib/group-settlement-mirror-kinds";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";

/**
 * #3949 (`INV-PAY-137`; owner decisions on #3949, 15 and 21 Oct 2026): AN
 * EDIT'S OR AN APPROVED APPEAL'S BANK-TRANSFER REFUND ON A JOINER'S BOOKING THE
 * GROUP ORGANISER PAID FOR BY INTERNET BANKING.
 *
 * The organiser's one bank-transfer invoice settles every joiner, and the settle
 * gives each child a `SUCCEEDED`, `INTERNET_BANKING` payment mirror with NO
 * `PaymentTransaction` of its own (`group-settlement.ts`). An edit that lowers
 * such a child's price raises an edit refund hand-back (`INV-PAY-117`), and an
 * approved appeal a refund-request hand-back (`INV-PAY-118`). Both used to
 * complete through `applyLocalRefundAllocation`, which allocates against the
 * payment's captured transactions - none - and refused every amount as "more
 * than was ever captured", so the task could never be paid, and once the
 * child was cancelled it could not be dismissed either.
 *
 * The refund comes out of the organiser's group payment and goes back to the
 * organiser, the same pattern a card-paid group uses (#3653) and the IB group
 * cancel uses (#4042). Completing the task therefore records it the way the
 * group cancel records ITS refunds on a child: on the child's
 * `refundedAmountCents` mirror (`mirrorPlanRefundedCents`, REFUNDED or
 * PARTIALLY_REFUNDED), beside the hand-back's `BANK_REFUND` ledger line. The
 * group's `GroupBookingSettlement` is NOT touched: its status is what the
 * group cancel and its replay read to decide whether the settlement's own
 * refund is still to be made, and a bank transfer for one joiner is not that.
 *
 * Xero: no note is queued - the child has no invoice of its own - and the
 * officers are alerted after the commit to credit the group's combined invoice by
 * hand (`alertGroupMirrorRefundXeroByHand`, review M1). An interim: #4292 makes
 * that note automatic (owner decision, 22 Oct 2026).
 *
 * Locks: none of its own. The completion already holds `lock(1)` for these two
 * keys (`resolveManualRefundTask#1`); the route takes the `Payment` row
 * (`lockPaymentForRefundedTotal`) next, before the cap read, so the cap and the
 * write see one figure (`INV-LOCK-002`: global, then the row).
 */

/**
 * #3949 (`INV-PAY-137`): DID THIS COMPLETION SEND MONEY BACK BY BANK TRANSFER,
 * recorded inside its own transaction? The ordinary hand-back
 * (`local-allocation`, on the payment's transactions) and a group child's
 * (`group-settlement-mirror`, on its mirror) alike: both post the
 * `BANK_REFUND` line and both are the `REFUNDED` event's money. The one test,
 * so neither is left out of one. (Only the ledger route owes a refund request
 * its own Xero note: the mirror route's note is the treasurer's, review M1.)
 */
export function isBankTransferHandBackRoute(
  route: EditReviewSettlementRoute | null,
): route is Extract<EditReviewSettlementRoute, { kind: "local-allocation" | "group-settlement-mirror" }> {
  return route?.kind === "local-allocation" || route?.kind === "group-settlement-mirror";
}

/** The route a completion takes for such a hand-back (`EditReviewSettlementRoute`'s member). */
export type GroupSettlementMirrorRoute = {
  kind: "group-settlement-mirror";
  /** The child's payment mirror, which the refund is recorded on. */
  paymentId: string;
  /** No edit-review anchor: such a child has no invoice of its own for a modification note to correct (review M1). */
  bookingModificationId: null;
  /** What goes back to the organiser by bank transfer. */
  refundCents: number;
  /** Nothing of it is applied credit: the organiser paid in money. */
  creditBackCents: 0;
};

type MirrorHandBackTask = {
  id: string;
  kind: string | null;
  occurrenceKey: string | null;
  paymentId: string | null;
  booking: {
    status: string;
    organiserSettled: boolean;
    parentBookingId: string | null;
    payment: { id: string; source: string } | null;
  };
};

/**
 * Is this an edit's, an approved appeal's or (owner decision, 22 Oct 2026) the
 * joiner's own cancellation's hand-back (`isGroupSettlementMirrorHandBackKind`)
 * on a joiner's booking the organiser paid for by internet banking, raised on
 * that booking's own payment?
 * Pure; `chooseGroupSettlementMirrorRoute` adds the one fact it cannot see
 * (that no transaction backs the payment).
 */
export function isGroupSettlementMirrorHandBack(task: MirrorHandBackTask): boolean {
  return (
    isGroupSettlementMirrorHandBackKind(task) &&
    task.paymentId !== null &&
    task.booking.payment?.id === task.paymentId &&
    paidByOrganiserInternetBanking(task.booking)
  );
}

/**
 * The route, or null when the task is not one of these (the caller then keeps
 * its ordinary route). Before the claim, inside the completion's transaction:
 * a refusal here leaves the task OPEN.
 */
export async function chooseGroupSettlementMirrorRoute({
  task,
  amountCents,
  store,
}: {
  task: MirrorHandBackTask;
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<GroupSettlementMirrorRoute | null> {
  if (!isGroupSettlementMirrorHandBack(task) || task.paymentId === null) return null;
  return mirrorRouteOnUnbackedPayment({ task, paymentId: task.paymentId, amountCents, store });
}

/**
 * #3949 review: an EDIT FINANCIAL REVIEW's refund on such a child, which took
 * the by-hand ledger route and was refused the same way. Its share goes back to
 * the organiser onto the mirror too. `paymentId` is the payment the review's
 * refund comes out of (`editReviewRefundSettlementPayment`); it must be the
 * child's own mirror. A cancelled child never reaches here: its netting refuses
 * an organiser-paid booking first (`capturedShareOwedAfterCancellation`), so no
 * part of the share can become the joiner's account credit.
 */
export async function chooseReviewGroupSettlementMirrorRoute({
  task,
  paymentId,
  amountCents,
  store,
}: {
  task: { id: string; booking: MirrorHandBackTask["booking"] };
  paymentId: string;
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<GroupSettlementMirrorRoute | null> {
  if (!paidByOrganiserInternetBanking(task.booking) || task.booking.payment?.id !== paymentId) return null;
  return mirrorRouteOnUnbackedPayment({ task, paymentId, amountCents, store });
}

/**
 * #3949 review round 3 (item 2): NOT WHILE THE ORGANISER'S GROUP CANCEL IS
 * BETWEEN ITS PLAN AND THIS CHILD'S CLAIM (`groupCancelInProgress`, the one
 * test). The cancel froze this child's refund net of the hand-backs open when
 * it planned, and books that whole share when it claims the child, so a refund
 * recorded on the child in between would be paid to the organiser twice. Read
 * under the completion's `lock(1)` (the fence's own key), a completion is
 * refused, task OPEN, in that window. No hand-back can be RAISED in it either
 * (review round 4: `raiseEditRefundHandBackIfOwed` and
 * `raiseRefundRequestHandBack` ask the same test), so every one open once the
 * claim has cancelled the child was open when the plan froze and was netted
 * there; it is then paid as normal. Refusing beats re-sizing the claim: the
 * frozen plan is what the cancel's ledger line, its replay, the census and the
 * organiser's hand-back all read, and re-sizing one would leave the others
 * disagreeing.
 */
async function assertGroupCancelNotInProgress(
  store: Prisma.TransactionClient,
  booking: { status: string; parentBookingId: string | null },
): Promise<void> {
  if (await groupCancelInProgress(store, booking)) throw new ManualBookingPaymentError(GROUP_CANCEL_IN_PROGRESS_MESSAGE, 409);
}

/** #3949 review round 3: the refusal while the organiser's group cancel is still working through its joiners. */
export const GROUP_CANCEL_IN_PROGRESS_MESSAGE =
  "The group organiser is cancelling this group and has not finished with this booking yet, so this refund cannot be recorded now - the cancellation is working out this booking's own refund to the organiser. Try again once the booking shows as cancelled.";

/**
 * The `Payment` row first (review C1: the transaction count is then read under
 * it too), then: a child payment that DOES carry a `PaymentTransaction` is left
 * on the ledger route - there the transactions are the record, and a mirror
 * written beside them would be undone by the next aggregate reconcile - and
 * otherwise the cap, before the claim.
 */
async function mirrorRouteOnUnbackedPayment({
  task,
  paymentId,
  amountCents,
  store,
}: {
  task: { id: string; booking: Pick<MirrorHandBackTask["booking"], "status" | "parentBookingId"> };
  paymentId: string;
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<GroupSettlementMirrorRoute | null> {
  await assertGroupCancelNotInProgress(store, task.booking);
  await lockPaymentForRefundedTotal(store, paymentId);
  if ((await store.paymentTransaction.count({ where: { paymentId } })) > 0) return null;
  await assertGroupMirrorHandBackWithinUnpromisedCash(store, { paymentId, taskId: task.id, amountCents });
  return { kind: "group-settlement-mirror", paymentId, bookingModificationId: null, refundCents: amountCents, creditBackCents: 0 };
}

/**
 * Record the refund on the child's mirror, after the claim, holding the
 * `Payment` row the route took. Refused, never clamped, past what the payment
 * still holds: the throw rolls the claim back and the task stays OPEN.
 */
export async function applyGroupSettlementMirrorRefund({
  route,
  store,
}: {
  route: GroupSettlementMirrorRoute;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await lockPaymentForRefundedTotal(store, route.paymentId);
  const payment = await store.payment.findUniqueOrThrow({
    where: { id: route.paymentId },
    select: { amountCents: true, refundedAmountCents: true },
  });
  if (route.refundCents <= 0 || payment.refundedAmountCents + route.refundCents > payment.amountCents) {
    throw new ManualBookingPaymentError(GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE, 400);
  }
  const nextRefunded = mirrorPlanRefundedCents(payment, route.refundCents);
  await store.payment.update({
    where: { id: route.paymentId },
    data: {
      refundedAmountCents: nextRefunded,
      status: nextRefunded >= payment.amountCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
    },
  });
}

/**
 * #3949 (`INV-PAY-137`): A GROUP CHILD'S MIRROR, AS THE ORGANISER CANCEL'S
 * RECOVERY REPLAY READS IT. Before #3949 only the cancel moved such a child's
 * `refundedAmountCents`, so the replay read "zero" as "the plan's share is not
 * written yet". A paid-back edit or appeal hand-back now moves it too, so the
 * replay asks `mirrorPlanShareWritten` instead - the figure net of what those
 * hand-backs moved - and asks it holding the `Payment` row, which the
 * hand-back's completion takes before its claim: the two never interleave, so
 * the plan's share is neither skipped nor counted twice.
 */
export async function readGroupChildMirrorForPlanReplay(
  tx: Prisma.TransactionClient,
  child: { bookingId: string; paymentId: string },
): Promise<{ amountCents: number; refundedAmountCents: number; planShareWritten: boolean; claimedByGroupCancel: boolean }> {
  const { bookingId, paymentId } = child;
  await lockPaymentForRefundedTotal(tx, paymentId);
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { amountCents: true, refundedAmountCents: true },
  });
  // Review round 3: EVERY completion that may have written the mirror, sorted by the planner's own rule
  // (`groupChildHandBacksFromRows`): an edit's, an appeal's and a joiner cancel's hand-back, and a review's refund.
  const completed = await tx.manualRefundTask.findMany({
    where: { paymentId, status: "COMPLETED" },
    select: { kind: true, status: true, occurrenceKey: true, paymentId: true, amountCents: true, settlementDirection: true },
  });
  // Review round 3: a child its member cancelled themselves (a paid cancel's snapshot) was never the plan's to refund.
  const cancelled = await tx.bookingEvent.findFirst({
    where: { bookingId, type: "CANCELLED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { snapshot: true },
  });
  return {
    ...payment,
    planShareWritten: mirrorPlanShareWritten(payment.refundedAmountCents, groupChildHandBacksFromRows(paymentId, completed)),
    claimedByGroupCancel: (cancelled?.snapshot ?? null) === null,
  };
}

/**
 * #3949 review M1 (`INV-PAY-137`): THE APP RAISES NO XERO NOTE FOR SUCH A
 * REFUND, SO IT TELLS THE TREASURER TO. A joiner's booking the organiser paid
 * for by Internet Banking has no invoice of its own: the money was taken on the
 * group's ONE combined invoice, addressed to the organiser. The refund note
 * machinery credits the payment's own invoice under the booking's own contact
 * (`createXeroCreditNote`), and keeps one note per non-card payment, so it can
 * place neither this refund nor a later group cancel's beside it correctly. So
 * no note is queued (an edit's never was; an appeal's needs an invoice the child
 * lacks), and after the commit the officers get the existing Xero alert naming
 * the refund, the organiser and the combined invoice, to credit by hand and
 * record the bank refund against. Best-effort, after the commit; never throws -
 * the completed task and its audit row are the durable record.
 */
export async function alertGroupMirrorRefundXeroByHand({
  bookingId,
  taskId,
  refundCents,
  format,
}: {
  bookingId: string;
  taskId: string;
  refundCents: number;
  format: ClubFormat;
}): Promise<void> {
  try {
    const child = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { parentBookingId: true, member: { select: { firstName: true, lastName: true } }, organisation: { select: { name: true, email: true } } },
    });
    const group = child?.parentBookingId
      ? await prisma.groupBooking.findUnique({
          where: { organiserBookingId: child.parentBookingId },
          select: { organiserMember: { select: { firstName: true, lastName: true } }, settlement: { select: { xeroInvoiceNumber: true } } },
        })
      : null;
    const name = (person: { firstName: string; lastName: string } | null | undefined, fallback: string) =>
      person ? `${person.firstName} ${person.lastName}` : fallback;
    const invoice = group?.settlement?.xeroInvoiceNumber ? `invoice ${group.settlement.xeroInvoiceNumber}` : "its combined invoice";
    await sendAdminXeroSyncErrorAlert({
      errorType: "GROUP_ORGANISER_REFUND_NOTE_BY_HAND",
      operation: `Refund credit note for booking ${bookingId} (paid back to the group organiser)`,
      errorMessage: `${formatCents(refundCents, format)} was paid back by bank transfer to the group organiser (${name(group?.organiserMember, "the organiser")}) for ${name(child ? bookingOwner(child).member : null, "a joiner")}'s place in a group the organiser paid for by internet banking (refund task ${taskId}). Until automatic Xero notes are added, the app does not raise this refund's Xero credit note: that booking has no invoice of its own, and the money was taken on the group's ${invoice}. In Xero, raise a credit note for ${formatCents(refundCents, format)} to the organiser against that invoice and record the bank refund against it.`,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err, bookingId, taskId }, "Failed to send the group organiser refund's Xero-by-hand alert (#3949)");
  }
}

import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import {
  CANCEL_CARD_SHORTFALL_KEY_PREFIX,
  cancelCardShortfallPart,
  closeKeysOf,
  paidAnotherWayUnpaidCents,
  type CardRefundState,
  type CardShortfallTaskStatuses,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  buildBookingCancellationRefundIdempotencyKey,
  buildOrganiserChildCancellationRefundKey,
  bookingCancelCardRefundRecoveryWhere,
  buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking,
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
  isBookingCancelCardRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import type { FailedLaterCardRefund, PaidAnotherWayClose } from "@/lib/booking-narrative-cancelled-post-payment";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { cardRefundMadeForOperation, cardRefundPaymentBeforeFailure, cardRefundSliceFilledBy, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";

type CardRefundRow = { id: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };
/**
 * #4285 review: where these reads run - the app's client (the booking and
 * payment-link pages), or a caller's transaction, so the kept-capture alert's
 * drain reads the cancel's refund inside its one snapshot (`INV-SSOT`: one
 * reading, never a copy of it).
 */
type CardRefundStore = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "manualRefundTask" | "payment">;
/** A cancel's card refund row, as these reads select it. */
const CANCEL_CARD_REFUND_ROW_SELECT = {
  id: true, idempotencyKey: true, paymentId: true, amountCents: true, allocationPlan: true, status: true, attempts: true, nextRetryAt: true, succeededAt: true,
} as const satisfies Prisma.PaymentRecoveryOperationSelect;
type CancelCardRefundRow = Prisma.PaymentRecoveryOperationGetPayload<{ select: typeof CANCEL_CARD_REFUND_ROW_SELECT }>;
/** A "Paid another way" close's record: what it paid back, and what the row still owed. */
type CloseRecord = { amountCents: number | null; raisedAmountCents: number | null };

/**
 * #4125: where a card cancel's refund stands on its recovery row, for the
 * narrative (`cardRefundState`); #4145: closed "Paid another way", what that
 * close's record says (`cardRefundClose`) - paid back, left unpaid, and made.
 */
export interface CancelledCardRefund {
  cardRefundState?: CardRefundState;
  cardRefundClose?: PaidAnotherWayClose;
  /**
   * #4145: what a capacity race's rows planned to refund, together - the most its
   * card refund can be, where its CANCELLED snapshot froze the full charge
   * (before #4125). Absent on a member's cancel.
   */
  cardRefundPlanCents?: number;
  /** #4166: its refunds an event recorded that Stripe failed later, each by the row that owes it again. Absent when none. */
  cardRefundFailedLater?: FailedLaterCardRefund[];
}

/**
 * #4125: where one card refund recovery row stands. Closed `SUCCEEDED` is made,
 * unless its close is a "Paid another way" record (`closeKeysOf`); a row the
 * runner will still send is on its way (`isPaymentRecoveryOperationInFlight`);
 * any other is dead - stalled until the club acts.
 */
async function cardRefundRowState(
  row: CardRefundRow,
  store: Pick<Prisma.TransactionClient, "manualRefundTask">,
): Promise<{ state: CardRefundState; record?: CloseRecord }> {
  if (row.status === PaymentRecoveryOperationStatus.SUCCEEDED) {
    const record = await store.manualRefundTask.findFirst({
      where: { occurrenceKey: { in: closeKeysOf(row.id) } },
      select: { amountCents: true, raisedAmountCents: true },
    });
    return record ? { state: "paid-another-way", record } : { state: "settled" };
  }
  return { state: isPaymentRecoveryOperationInFlight(row) ? "on-its-way" : "stalled" };
}

/**
 * #4097 (`INV-PAY-129`): WHERE A CARD REFUND SHORTFALL'S CANCEL STANDS, for the
 * booking page and the public payment-link page, which hand it to the pure
 * narrative. Each part's task status, and - only on a cancel that has such
 * tasks - the card part's own refund: settled, still on its way, or closed as
 * "Paid another way" (its record under `closeKeysOf`).
 *
 * No `server-only` and no heavier import than Prisma: the payment-link page's
 * context module must stay importable outside a React server
 * (`cli-server-only-reach-census.test.ts`). #4285 review: the kept-capture
 * alert's drain reads it inside its snapshot (`store`), so a part paid since is
 * never said to be owed.
 */
export async function readCardShortfallTaskStatuses(bookingId: string, store: CardRefundStore = prisma): Promise<CardShortfallTaskStatuses> {
  const tasks = await store.manualRefundTask.findMany({
    where: { bookingId, occurrenceKey: { startsWith: CANCEL_CARD_SHORTFALL_KEY_PREFIX } },
    select: { kind: true, occurrenceKey: true, status: true },
  });
  const statuses: CardShortfallTaskStatuses = {};
  for (const task of tasks ?? []) {
    const part = cancelCardShortfallPart(task);
    if (part) statuses[part] = task.status;
  }
  if (Object.keys(statuses).length === 0) return statuses;
  const cardRefund = await store.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
    select: { id: true, status: true, attempts: true, nextRetryAt: true },
  });
  if (cardRefund) statuses.card = (await cardRefundRowState(cardRefund, store)).state;
  return statuses;
}

/**
 * #4125: WHERE A CARD CANCEL'S REFUND STANDS when no REFUNDED event says it was
 * made, for the same two pages. One read, of the cancel's card refund row - the
 * member's cancel (`booking_cancel_refund_recovery_<booking>`) or the capacity
 * race's (`capacity_claim_failed_refund_recovery_<booking>_<intent>`) - plus a
 * second only for a closed row, to tell a "Paid another way" close from a
 * refund made, and read what its record says (#4145; summed over a capacity
 * race's rows) - with, from the row's payment, what its slices took from the
 * refunds recorded on it, by the rule the close used (`cardRefundMadeForOperation`). No row reads as absent (`undefined`), which the narrative
 * takes as on its way. Several rows (a second intent's capacity race) read as
 * the one furthest from done: a dead one first, then one still being sent.
 * #4285 review: read through `store`, a caller's transaction where it passes one.
 */
export async function readCancelledCardRefund(bookingId: string, store: CardRefundStore = prisma): Promise<CancelledCardRefund> {
  const rows = await store.paymentRecoveryOperation.findMany({
    // On `@@index([bookingId])`, so the prefix match never scans the table.
    where: bookingCancelCardRefundRecoveryWhere(bookingId),
    select: CANCEL_CARD_REFUND_ROW_SELECT,
  });
  // `startsWith` is SQL LIKE, where `_` matches any one character, so the query alone
  // would let booking `ab`'s read take booking `abc`'s rows: the exact rule decides (#4147).
  const own = rows.filter((row) => isBookingCancelCardRefundRecoveryKey(bookingId, row.idempotencyKey));
  return cancelledCardRefundOf(bookingId, own, store);
}

/**
 * #4285 review: WHERE AN ORGANISER-CARD CHILD'S CANCEL REFUND STANDS - its debt
 * to the ORGANISER's card out of the combined payment (#3653,
 * `buildOrganiserChildCancellationRefundKey`), which the joiner's cancel and the
 * group's share. Read as `readCancelledCardRefund` reads a member's row; a
 * refund Stripe failed later reopens that debt itself, so its row says so. For
 * the kept-capture alert's drain, which names whose card it went to.
 */
export async function readOrganiserChildCancelledCardRefund(
  childBookingId: string,
  settlementId: string,
  store: CardRefundStore = prisma,
): Promise<CancelledCardRefund & { amountCents?: number }> {
  const debt = await store.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildOrganiserChildCancellationRefundKey(settlementId, childBookingId) },
    select: CANCEL_CARD_REFUND_ROW_SELECT,
  });
  if (!debt) return {};
  return { ...(await cancelledCardRefundOf(childBookingId, [debt], store)), amountCents: debt.amountCents };
}

/** The cancel's card refund rows, read as one: where they stand, and what Stripe failed later. */
async function cancelledCardRefundOf(bookingId: string, own: CancelCardRefundRow[], store: CardRefundStore): Promise<CancelledCardRefund> {
  const standings = await Promise.all(own.map(async (row) => ({ row, ...(await cardRefundRowState(row, store)) })));
  const cardRefundState = FURTHEST_FROM_DONE_FIRST.find((state) => standings.some((each) => each.state === state));
  const failedLater = await readFailedLaterCardRefunds(bookingId, standings, store);
  const planned = { ...capacityRacePlanCents(bookingId, own), ...(failedLater.parts.length > 0 ? { cardRefundFailedLater: failedLater.parts } : {}) };
  if (cardRefundState !== "paid-another-way") return { cardRefundState, ...planned };
  const closed = standings.flatMap(({ row, record }) => (record ? [{ row, record }] : []));
  const payments = await store.payment.findMany({
    where: { id: { in: [...new Set(closed.map(({ row }) => row.paymentId))] } },
    select: { id: true, status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
  });
  const made = (row: { id: string; paymentId: string }) => {
    const payment = payments.find((each) => each.id === row.paymentId);
    return payment ? cardRefundMadeForOperation(payment, row.id).madeCents : 0;
  };
  return {
    cardRefundState,
    ...planned,
    cardRefundClose: {
      paidBackCents: closed.reduce((sum, { record }) => sum + (record.amountCents ?? 0), 0),
      unpaidCents: closed.reduce((sum, { record }) => sum + paidAnotherWayUnpaidCents(record), 0),
      // #4166: a part that failed later counts as the close found it; the narrative says it by its own row.
      madeCents: closed.reduce((sum, { row }) => sum + made(row) + (failedLater.madeByRow.get(row.id) ?? 0), 0),
    },
  };
}

/**
 * #4166 (`INV-PAY-134`): THE CANCEL'S CARD REFUNDS THAT FAILED AFTER A CLOSE
 * RECORDED THEM. A refund Stripe failed later on a row already closed is owed
 * by a row of its own (`card_refund_failed_later_<refund>`, #4104); it is this
 * cancel's when one of the cancel's own rows made it, or a failed-later row of
 * this cancel did (its retry failed too). Which row made it is what the writer
 * recorded on the row (`madeByOperationId`: by metadata, and among several
 * failed-later rows, which all send the same, by the slice it fills);
 * a row raised before #4166 is read by the slice the refund fills as the
 * payment stood before it failed (`cardRefundPaymentBeforeFailure`). Each is
 * told by the last row of its chain, and only where the cancel's row is closed:
 * made (its event covers its whole plan), or paid another way, where only a
 * refund that close counted is told - made by Stripe by the close - and dated
 * only if recorded by it, as its event was (`dated`). Read only where one of
 * the cancel's rows closed. `madeByRow`: what each cancel row's counted failed
 * refunds were, for its close's made figure, which no longer counts them.
 */
async function readFailedLaterCardRefunds(
  bookingId: string,
  standings: ReadonlyArray<{ row: { id: string; succeededAt: Date | null }; state: CardRefundState }>,
  store: CardRefundStore,
): Promise<{ parts: FailedLaterCardRefund[]; madeByRow: Map<string, number> }> {
  const none = { parts: [], madeByRow: new Map<string, number>() };
  const closed = standings.filter(({ state }) => state === "settled" || state === "paid-another-way");
  if (closed.length === 0) return none;
  const rows = await store.paymentRecoveryOperation.findMany({
    // On `@@index([bookingId])`; exact, and the key's own rule decides (#4146).
    where: { bookingId, idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX) },
    select: CANCEL_CARD_REFUND_ROW_SELECT,
  });
  const failed = (rows ?? []).flatMap((row) => {
    const refundId = cardRefundFailedLaterRefundId(row.idempotencyKey);
    return refundId ? [{ row, refundId }] : [];
  });
  if (failed.length === 0) return none;
  const payments = await store.payment.findMany({
    where: { id: { in: [...new Set(failed.map(({ row }) => row.paymentId))] } },
    select: { id: true, status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
  });
  const paymentOf = (paymentId: string) => payments.find((each) => each.id === paymentId);
  const madeBy = new Map(
    failed.map(({ row, refundId }) => {
      const recorded = parseRefundAllocationPlan(row.allocationPlan)?.[0]?.madeByOperationId;
      if (recorded !== undefined) return [row.id, recorded] as const;
      const payment = paymentOf(row.paymentId);
      return [row.id, payment ? (cardRefundSliceFilledBy(cardRefundPaymentBeforeFailure(payment, refundId), refundId)?.operation.id ?? null) : null] as const;
    }),
  );
  // Each failed-later row of this cancel, with the failed refund its cancel row made (the head of its chain).
  const roots = new Set(closed.map(({ row }) => row.id));
  const headOf = new Map<string, { root: string; head: (typeof failed)[number] }>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const each of failed) {
      const maker = madeBy.get(each.row.id) ?? null;
      if (maker === null || headOf.has(each.row.id)) continue;
      const found = roots.has(maker) ? { root: maker, head: each } : headOf.get(maker);
      if (!found) continue;
      headOf.set(each.row.id, found);
      grew = true;
    }
  }
  // A row whose own retry failed later too is told by the row that owes that retry.
  const last = failed.filter(({ row }) => headOf.has(row.id) && !failed.some((each) => headOf.has(each.row.id) && madeBy.get(each.row.id) === row.id));
  const parts: FailedLaterCardRefund[] = [];
  const madeByRow = new Map<string, number>();
  for (const { row } of last) {
    const { root, head } = headOf.get(row.id) as { root: string; head: (typeof failed)[number] };
    const close = closed.find((each) => each.row.id === root);
    if (!close) continue;
    let dated = true;
    if (close.state === "paid-another-way") {
      // F2: only what that close counted - its made figure and its event - is told, and added back.
      const refund = paymentOf(head.row.paymentId)?.refunds.find((each) => each.stripeRefundId === head.refundId);
      const closedAt = close.row.succeededAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (!refund || (refund.stripeCreatedAt ?? refund.createdAt).getTime() > closedAt) continue;
      dated = refund.createdAt.getTime() <= closedAt;
      madeByRow.set(root, (madeByRow.get(root) ?? 0) + head.row.amountCents);
    }
    const { state, record } = await cardRefundRowState(row, store);
    parts.push({
      amountCents: row.amountCents,
      state,
      ...(dated ? {} : { dated }),
      ...(state === "settled" ? { madeAt: row.succeededAt } : {}),
      ...(record ? { paidBackCents: record.amountCents ?? row.amountCents, unpaidCents: paidAnotherWayUnpaidCents(record) } : {}),
    });
  }
  return { parts, madeByRow };
}

const FURTHEST_FROM_DONE_FIRST: readonly CardRefundState[] = ["stalled", "on-its-way", "paid-another-way", "settled"];

/** #4145: a capacity race's rows' frozen plans together (each row's amount where it has none), or nothing for a member's cancel. */
function capacityRacePlanCents(
  bookingId: string,
  rows: ReadonlyArray<{ idempotencyKey: string; amountCents: number; allocationPlan: unknown }>,
): { cardRefundPlanCents?: number } {
  const planned = rows
    .filter((row) => row.idempotencyKey.startsWith(buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId)))
    .map((row) => parseRefundAllocationPlan(row.allocationPlan)?.reduce((sum, slice) => sum + slice.amountCents, 0) ?? row.amountCents);
  return planned.length > 0 && planned.every((cents) => typeof cents === "number") ? { cardRefundPlanCents: planned.reduce((sum, cents) => sum + cents, 0) } : {};
}

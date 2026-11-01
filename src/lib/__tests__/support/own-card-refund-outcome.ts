/**
 * #4070: the answers an own-card edit refund can get from
 * `refundPaymentTransactions` after the edit commits, and what the "Booking
 * Modified" email must then say. Shared by the four edit doors' tests so each
 * door is driven through the same states, and (#4084) by the cancel's, whose
 * "Booking Cancelled" email says `card` for `own` and `card_pending` for
 * `own_card_pending`. `queued` is what still owed goes to the recovery runner
 * (`enqueueBookingModificationRefundRecovery`): a call that throws queues the
 * unpaid remainder; #3984 keeps the whole read plan, marking made slices
 * and moving refused ones to their next key (`INV-PAY-128`). The cancel queues
 * nothing new for either: its pre-persisted debt is left open.
 *
 * `primeOwnCardRefund` answers a `refundPaymentTransactions` double with the
 * state's refunds, or rejects with its error; `expectQueuedOnce` asserts what
 * the door queued.
 */
import { expect, type Mock } from "vitest";

import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

type Refund = {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
  status: string | null;
  slice: RefundAllocationSlice;
};
type Answer = { refunds: Refund[] } | Error;

/** Nothing queued, the whole unpaid remainder, or answers containing refused slices. */
type Queued = null | "remainder" | { refused: RefundAllocationSlice[] };

const NEWER_SLICE: RefundAllocationSlice = { paymentTransactionId: "txn_additional", amountCents: 600 };
const OLDER_SLICE: RefundAllocationSlice = { paymentTransactionId: "txn_primary", amountCents: 400 };

const refundOf = (slice: RefundAllocationSlice, status: string | null, refundId = "re_own_1"): Refund => ({
  refundId,
  paymentIntentId: "pi_original",
  amountCents: slice.amountCents,
  status,
  slice,
});

const made = (status: string | null): Answer => ({ refunds: [refundOf(NEWER_SLICE, status)] });

export const OWN_CARD_REFUND_STATES: ReadonlyArray<{
  label: string;
  answer: Answer;
  queued: Queued;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "Stripe answered succeeded", answer: made("succeeded"), queued: null, destination: "own" },
  { label: "Stripe answered pending", answer: made("pending"), queued: null, destination: "own" },
  // A refund with no status counts as made, as the organiser executor counts it (`status ?? "unknown"`).
  { label: "Stripe answered no status", answer: made(null), queued: null, destination: "own" },
  { label: "the Stripe call throws", answer: new Error("stripe down"), queued: "remainder", destination: "own_card_pending" },
  { label: "Stripe answered failed", answer: made("failed"), queued: { refused: [NEWER_SLICE] }, destination: "own_card_pending" },
  { label: "Stripe answered canceled", answer: made("canceled"), queued: { refused: [NEWER_SLICE] }, destination: "own_card_pending" },
  {
    label: "one slice made, one refused",
    answer: { refunds: [refundOf(NEWER_SLICE, "succeeded"), refundOf(OLDER_SLICE, "failed", "re_own_2")] },
    queued: { refused: [OLDER_SLICE] },
    destination: "own_card_pending",
  },
  { label: "no refund came back", answer: { refunds: [] }, queued: null, destination: "own_card_pending" },
];

/** A single captured charge carrying this edit's refund, before any attempt. */
export function ownCardRefundPlan({ amountCents }: { amountCents: number }) {
  return {
    slices: [{ paymentTransactionId: "txn_refund", amountCents }],
    plannedAmountCents: amountCents,
    totalRefundableCents: amountCents,
  };
}

/** Scale the fixture's charge split to the actual edit, keeping integer cents. */
function plannedSlices(answer: Answer, amountCents: number): RefundAllocationSlice[] {
  if (answer instanceof Error || answer.refunds.length === 0) return ownCardRefundPlan({ amountCents }).slices;
  const total = answer.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  let remaining = amountCents;
  return answer.refunds.map((refund, index) => {
    const cents = index === answer.refunds.length - 1 ? remaining : Math.floor(amountCents * refund.amountCents / total);
    remaining -= cents;
    return { ...refund.slice, amountCents: cents };
  });
}

export function primeOwnCardRefund(refundPaymentTransactions: Mock, answer: Answer, planner?: Mock): void {
  // Edit doors send a complete plan even when Stripe returns no answers.
  planner?.mockImplementation(async ({ amountCents }: { amountCents: number }) => ({
    ...ownCardRefundPlan({ amountCents }), slices: plannedSlices(answer, amountCents),
  }));
  if (answer instanceof Error) refundPaymentTransactions.mockRejectedValue(answer);
  else if (planner) refundPaymentTransactions.mockImplementation(async ({ amountCents }: { amountCents: number }) => {
    const slices = plannedSlices(answer, amountCents);
    return { refunds: answer.refunds.map((refund, index) => ({ ...refund, slice: slices[index], amountCents: slices[index]!.amountCents })) };
  });
  else refundPaymentTransactions.mockResolvedValue(answer);
}

/**
 * The door queued what the state owes, once, in integer cents: the remainder
 * of `pendingCents`, or the whole answered plan with made slices marked.
 */
export function expectQueuedOnce(enqueue: Mock, queued: Queued, pendingCents: number, answer: Answer): void {
  // An unanswered edit retains its whole plan; cancellation already holds its debt.
  if (!(answer instanceof Error) && answer.refunds.length === 0) queued = "remainder";
  if (queued === null) {
    expect(enqueue).not.toHaveBeenCalled();
    return;
  }
  expect(enqueue).toHaveBeenCalledTimes(1);
  if (queued === "remainder") {
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ amountCents: pendingCents }));
    expect(enqueue.mock.calls[0]?.[0]).toHaveProperty("allocationPlan", [{ paymentTransactionId: "txn_refund", amountCents: pendingCents }]);
    return;
  }
  // #4083 review: each was read refused at the door, so it is queued already on
  // its next key (`refused1`) - the runner's first attempt asks Stripe afresh.
  if (answer instanceof Error) throw new Error("A refused answer must contain refunds");
  const slices = plannedSlices(answer, pendingCents);
  const plan = answer.refunds.map((refund, index) => queued.refused.includes(refund.slice)
    ? { ...slices[index], stripeKeySuffix: "refused1" }
    : { ...slices[index], madeRefundId: refund.refundId });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      amountCents: pendingCents,
      allocationPlan: plan,
    }),
  );
}

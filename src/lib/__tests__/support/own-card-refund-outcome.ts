/**
 * #4070: the answers an own-card edit refund can get from
 * `refundPaymentTransactions` after the edit commits, and what the "Booking
 * Modified" email must then say. Shared by the four edit doors' tests so each
 * door is driven through the same states, and (#4084) by the cancel's, whose
 * "Booking Cancelled" email says `card` for `own` and `card_pending` for
 * `own_card_pending`.
 *
 * Both doors write their debt's recovery row before the attempt (#1349; #4992,
 * `INV-PAY-146`), so nothing is queued after commit. `rowOpen` says whether the
 * cancel leaves that row open for the runner (a thrown call, or a refusal,
 * `INV-PAY-128`); the edit closes it only when the email says `own`.
 *
 * `primeOwnCardRefund` answers a `refundPaymentTransactions` double with the
 * state's refunds, or rejects with its error; `frozenOwnCardRefund` is the plan
 * an edit's transaction froze for that state; `expectPrePersistedEditRefund`
 * asserts what the edit door did with it.
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
  rowOpen: boolean;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "Stripe answered succeeded", answer: made("succeeded"), rowOpen: false, destination: "own" },
  { label: "Stripe answered pending", answer: made("pending"), rowOpen: false, destination: "own" },
  // A refund with no status counts as made, as the organiser executor counts it (`status ?? "unknown"`).
  { label: "Stripe answered no status", answer: made(null), rowOpen: false, destination: "own" },
  { label: "the Stripe call throws", answer: new Error("stripe down"), rowOpen: true, destination: "own_card_pending" },
  { label: "Stripe answered failed", answer: made("failed"), rowOpen: true, destination: "own_card_pending" },
  { label: "Stripe answered canceled", answer: made("canceled"), rowOpen: true, destination: "own_card_pending" },
  {
    label: "one slice made, one refused",
    answer: { refunds: [refundOf(NEWER_SLICE, "succeeded"), refundOf(OLDER_SLICE, "failed", "re_own_2")] },
    rowOpen: true,
    destination: "own_card_pending",
  },
  { label: "no refund came back", answer: { refunds: [] }, rowOpen: false, destination: "own_card_pending" },
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

/** The plan the edit's transaction froze for this state's answer (`ownCardRefund`). */
export function frozenOwnCardRefund(answer: Answer, amountCents: number): { plan: RefundAllocationSlice[] } {
  return { plan: plannedSlices(answer, amountCents) };
}

/**
 * #4992: the edit sent the plan its transaction froze, queued nothing after
 * commit, and closed its pre-persisted row only when the refund was made.
 * `enqueue` is the recovery writer: when the door's real transaction ran here
 * (`reservedInTransaction`), it wrote the row once, on the transaction, before
 * the attempt; otherwise (the service is mocked) it was never called.
 */
export function expectPrePersistedEditRefund(
  mocks: { refund: Mock; enqueue: Mock; close: Mock },
  { answer, destination, pendingCents, bookingModificationId, reservedInTransaction }: {
    answer: Answer;
    destination: BookingModifiedRefundDestination;
    pendingCents: number;
    bookingModificationId: string;
    reservedInTransaction: boolean;
  },
): void {
  const { plan } = frozenOwnCardRefund(answer, pendingCents);
  expect(mocks.refund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amountCents: pendingCents, allocation: plan }));
  if (reservedInTransaction) {
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bookingModificationId, amountCents: pendingCents, allocationPlan: plan, store: expect.anything() }),
    );
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.refund.mock.invocationCallOrder[0]!);
  } else {
    expect(mocks.enqueue).not.toHaveBeenCalled();
  }
  if (destination === "own") {
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: `payment_recovery_modification_refund_${bookingModificationId}`,
      sentPlan: plan,
    });
  } else {
    expect(mocks.close).not.toHaveBeenCalled();
  }
}

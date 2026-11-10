/**
 * #4516 review L1: a superseded intent's refund row whose first request (its own key, no slice evidence) was made
 * and never answered. When the row next finds nothing outstanding, the one refund that is that request's answers
 * the key's open reservation through the cash writer; anything ambiguous leaves it for the census and the OPERATOR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  journal: { zone: "Pacific/Auckland" } as Record<string, unknown>,
  open: vi.fn(async () => true),
  list: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  cash: vi.fn(async () => 1),
  warn: vi.fn(),
  tx: { marker: "tx" },
}));

vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/member-money", () => ({ isRefundReservationOpen: mocks.open }));
vi.mock("@/lib/member-money/doors", () => ({
  isBookingJournalInactive: (context: Record<string, unknown>) => "inactive" in context,
  postCardRefundCash: mocks.cash,
  resolveBookingMoneyPostingContext: async () => mocks.journal,
}));
// #4368 review S2: the "own refund with no slice key" predicate (`isOwnUnstampedCardRefund`) is NOT mocked - both its
// halves run for real, over the metadata the row's own request carries (`cardRefundOperationRefundMetadata`). A mock
// of its inner `carriesCardRefundOperationMetadata` would not reach the predicate's own call to it.
vi.mock("@/lib/payment-transactions", () => ({ PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS: { maxWait: 1, timeout: 1 } }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: async (run: (tx: unknown) => unknown) => run(mocks.tx) } }));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: mocks.list }));

import { answerSupersededFirstRequest, supersededFirstRequestUnsent } from "@/lib/superseded-first-request-answer";
import { cardRefundOperationRefundMetadata } from "@/lib/payment-recovery-keys";

const operation = { id: "op-1", type: "REFUND_SUPERSEDED_PAYMENT", idempotencyKey: "payment_recovery_refund_txn_pi", stripeKeyPrefix: null,
  bookingId: "b-1", paymentId: "p-1", paymentIntentId: "pi_1" } as never;
const refund = (id: string, metadata: Record<string, string>, status = "succeeded") => ({ id, status, payment_intent: "pi_1", metadata });
/** The metadata this row's own request carries, and another booking's of the same kind. */
const OWN = cardRefundOperationRefundMetadata(operation as unknown as Parameters<typeof cardRefundOperationRefundMetadata>[0]);
const ANOTHER = { ...OWN, bookingId: "b-another" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.journal = { zone: "Pacific/Auckland" };
  mocks.open.mockResolvedValue(true);
});

describe("a superseded intent's first request, made and never answered (#4516 review L1)", () => {
  it("MUTATION: answers the one refund carrying the row's metadata and no slice key to the row's own key", async () => {
    mocks.list.mockResolvedValue([
      refund("re_first", OWN),
      refund("re_slice", { ...OWN, refundSliceKey: "payment_recovery_refund_txn_pi_txn_6000" }),
      refund("re_other", ANOTHER),
      refund("re_failed", OWN, "failed"),
    ]);
    await answerSupersededFirstRequest(operation);
    expect(mocks.cash).toHaveBeenCalledWith(mocks.tx, mocks.journal, { paymentId: "p-1", attemptKeys: new Map([["re_first", "payment_recovery_refund_txn_pi"]]) });
  });

  it("asks Stripe nothing while the journal is inactive or the key holds no open reservation", async () => {
    mocks.journal = { inactive: "unusable-currency" };
    await answerSupersededFirstRequest(operation);
    mocks.journal = { zone: "Pacific/Auckland" };
    mocks.open.mockResolvedValue(false);
    await answerSupersededFirstRequest(operation);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.cash).not.toHaveBeenCalled();
  });

  it("MUTATION (round-2 review C): the key is unused only while it holds an open reservation and Stripe lists no refund its request made, in any state", async () => {
    mocks.list.mockResolvedValue([refund("re_slice", { ...OWN, refundSliceKey: "k_txn_100" }), refund("re_other", ANOTHER)]);
    expect(await supersededFirstRequestUnsent(operation)).toBe(true);
    mocks.list.mockResolvedValue([refund("re_failed", OWN, "failed")]);
    expect(await supersededFirstRequestUnsent(operation)).toBe(false);
    mocks.list.mockRejectedValue(new Error("stripe down"));
    expect(await supersededFirstRequestUnsent(operation)).toBe(false);
    mocks.list.mockClear();
    mocks.open.mockResolvedValue(false);
    expect(await supersededFirstRequestUnsent(operation)).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("leaves the reservation for the census when no single refund is the request's, or Stripe cannot be read", async () => {
    mocks.list.mockResolvedValue([refund("re_a", OWN), refund("re_b", OWN)]);
    await answerSupersededFirstRequest(operation);
    mocks.list.mockResolvedValue([]);
    await answerSupersededFirstRequest(operation);
    mocks.list.mockRejectedValue(new Error("stripe down"));
    await answerSupersededFirstRequest(operation);
    expect(mocks.cash).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(3);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4119 (`INV-PAY-131`): the route answers with the card's part of the card
 * refund as the cancel will plan it - $140.00 by card of a $200.00 payment
 * whose other $60.00 came by bank transfer - and the rest by part, from the
 * preview's own card-tier refund. Where the card carries it all, or the cancel
 * would not refund to the member's card at all, it says nothing more. The
 * payment and its ledger are read in one read-only `RepeatableRead` snapshot.
 * `cancel-card-refund-shortfall.realdb.test.ts` runs the same sizing beside the
 * real cancel.
 */

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  executeRaw: vi.fn(async () => 0),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "member-1" } }) }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: async () => null }));
// #4866: no live superseded capture on these payments (`superseded-capture-hold-back.test.ts`, its realdb proof).
vi.mock("@/lib/superseded-capture-hold-back", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/superseded-capture-hold-back")),
  readSupersededCaptureHeldBack: vi.fn(async () => ({ byTransaction: new Map(), totalCents: 0 })),
  readSupersededHoldBackOperations: vi.fn(async () => []),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    clubTimeSettings: {
      findUnique: async () => ({ timeZone: "Pacific/Auckland", updatedByMemberId: null, updatedAt: new Date("2026-01-01T00:00:00.000Z") }),
    },
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    bookingModification: { findMany: async () => [], findFirst: async () => null },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  // All back, whenever: the card tier's refund is the whole $200.00.
  loadCancellationPolicy: async () => [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0, creditRefundPercentage: 100, creditFixedFeeCents: 0 }],
}));
vi.mock("@/lib/booking-cancel", () => ({
  paymentEligibleForPaidCancelPath: async () => true,
  paymentHasCaptureEvidence: async () => true,
}));
vi.mock("@/lib/internet-banking-part-payment-at-cancel", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/internet-banking-part-payment-at-cancel")),
  readPartPaymentAtCancel: async () => null,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  checkRateLimit: async () => ({ success: true, limit: 60, remaining: 59, resetAt: 0 }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: vi.fn() }));

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";

const CARD = { id: "txn-card", source: "STRIPE", stripePaymentIntentId: "pi_1", status: "SUCCEEDED", amountCents: 14_000, refundedAmountCents: 0, createdAt: new Date("2026-05-01T00:00:00.000Z") };
const BANK = { id: "txn-bank", source: "INTERNET_BANKING", stripePaymentIntentId: null, status: "SUCCEEDED", amountCents: 6_000, refundedAmountCents: 0, createdAt: new Date("2026-06-01T00:00:00.000Z") };

function seed(payment: Record<string, unknown>, transactions: Array<typeof CARD | typeof BANK>) {
  const row = {
    id: "payment-1",
    bookingId: "booking-1",
    source: "STRIPE",
    status: "SUCCEEDED",
    amountCents: 20_000,
    refundedAmountCents: 0,
    changeFeeCents: 0,
    creditAppliedCents: 0,
    manuallyMarkedPaidAt: null,
    stripePaymentIntentId: null,
    additionalPaymentIntentId: null,
    ...payment,
  };
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAID",
    finalPriceCents: 20_000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: { ...row, manualRefundTasks: [] },
  });
  mocks.paymentFindUnique.mockResolvedValue({ ...row, transactions });
  mocks.paymentTransactionFindMany.mockResolvedValue(transactions);
}

async function preview() {
  const response = await GET(new Request("http://localhost/api/bookings/booking-1/cancel-preview") as never, {
    params: Promise.resolve({ id: "booking-1" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { refundAmountCents: number; cardShortfall?: unknown };
}

beforeEach(() => {
  mocks.paymentFindUnique.mockReset();
  mocks.executeRaw.mockClear();
  mocks.transaction.mockReset().mockImplementation(async (run: (tx: unknown) => unknown) =>
    run({
      $executeRaw: mocks.executeRaw,
      payment: { findUnique: mocks.paymentFindUnique },
      paymentTransaction: { findMany: mocks.paymentTransactionFindMany },
    }),
  );
});

describe("the cancel preview's card line (#4119)", () => {
  it("names the card's part and the bank-transfer rest when the card plan is short", async () => {
    seed({}, [CARD, BANK]);
    expect(await preview()).toMatchObject({ refundAmountCents: 20_000, cardShortfall: { cardCents: 14_000, bankCents: 6_000, checkCents: 0 } });
  });

  it("reads the payment and its ledger in one read-only RepeatableRead snapshot", async () => {
    seed({}, [CARD, BANK]);
    await preview();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(String((mocks.executeRaw.mock.calls[0] as unknown[])[0])).toContain("SET TRANSACTION READ ONLY");
    expect(mocks.paymentFindUnique).toHaveBeenCalledTimes(1);
  });

  it("says nothing more when the card carries the whole refund", async () => {
    seed({}, [{ ...CARD, amountCents: 20_000 }]);
    const body = await preview();
    expect(body.refundAmountCents).toBe(20_000);
    expect(body).not.toHaveProperty("cardShortfall");
  });

  it.each([
    { why: "an internet banking payment, refunded as account credit", payment: { source: "INTERNET_BANKING" } },
    { why: "a payment marked paid by hand, handed back by hand", payment: { manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z") } },
  ])("does not plan a card refund for $why", async ({ payment }) => {
    seed(payment, [CARD, BANK]);
    expect(await preview()).not.toHaveProperty("cardShortfall");
    expect(mocks.paymentFindUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3836 with #3827 (`INV-PAY-117`): a $50 card + $150 credit booking whose
 * mirror the old inbound sync clipped to the $50 card amount, and $20 an
 * earlier edit promised back by hand. The preview tiers the ledger's $150 (as
 * `cancelTieredAppliedCreditCents` makes the cancel) AND nets the $20 out of
 * the refundable cash (as the cancel's `openNonCancellationHandBackCents`), so
 * it quotes exactly what `paidCancellationMoney` - the cancel's one call - pays.
 * The real-PostgreSQL proof runs the real cancel beside the real route
 * (`credit-only-card-allocation.realdb.test.ts`).
 */

const LEDGER_APPLIED_CENTS = 15_000;
const OPEN_HAND_BACK_CENTS = 2_000;

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  policy: [] as unknown[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "member-1" } }) }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: async () => null }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    clubTimeSettings: {
      findUnique: async () => ({ timeZone: "Pacific/Auckland", updatedByMemberId: null, updatedAt: new Date("2026-01-01T00:00:00.000Z") }),
    },
    // The applied rows hold $150; no edit ran through #3809's give-back, so no cap.
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: -LEDGER_APPLIED_CENTS } }) },
    bookingModification: { findMany: async () => [], findFirst: async () => null },
  },
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: async () => mocks.policy,
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

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";
import { cancelTieredAppliedCreditCents } from "@/lib/booking-payment-state";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";

// Half back, less a $10 fee, at least 14 days out; the frozen clock is 1 July, check-in 1 August.
const HALF_LESS_TEN = [{ daysBeforeStay: 14, refundPercentage: 50, fixedFeeCents: 1_000, creditRefundPercentage: 50, creditFixedFeeCents: 1_000 }];
// The shape `credit-only-card-allocation.realdb.test.ts` cancels for real: all back.
const FULL_REFUND = [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0, creditRefundPercentage: 100, creditFixedFeeCents: 0 }];

const PAYMENT = { amountCents: 5_000, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 5_000 };

beforeEach(() => {
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAID",
    finalPriceCents: 20_000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: {
      id: "payment-1",
      bookingId: "booking-1",
      source: "STRIPE",
      status: "SUCCEEDED",
      manuallyMarkedPaidAt: null,
      ...PAYMENT,
      manualRefundTasks: [{ amountCents: OPEN_HAND_BACK_CENTS }],
    },
  });
});

async function preview() {
  const response = await GET(new Request("http://localhost/api/bookings/booking-1/cancel-preview") as never, {
    params: Promise.resolve({ id: "booking-1" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { refundAmountCents: number; creditRefundAmountCents: number; creditRestoredCents: number; totalPaidCents: number };
}

describe("the cancel preview of a clipped mirror with an open edit hand-back (#3836, #3827)", () => {
  it.each([
    // $30 refundable at 50% less the $10 fee card-first: $5 back; the $150 credit at 50%: $75.
    { shape: "half less $10, to the card", policy: HALF_LESS_TEN, refundMethod: "card" as const, refundCents: 500, creditRestoredCents: 7_500 },
    // The real-PostgreSQL cancel of this shape refunds $30 to account credit and restores $150.
    { shape: "all back, to account credit", policy: FULL_REFUND, refundMethod: "credit" as const, refundCents: 3_000, creditRestoredCents: 15_000 },
  ])("quotes what the cancel's own money call pays ($shape): the ledger's credit tiered, the promised $20 netted out", async ({ policy, refundMethod, refundCents, creditRestoredCents }) => {
    mocks.policy = policy;
    const quoted = await preview();
    const cancel = paidCancellationMoney({
      payment: { ...PAYMENT, creditAppliedCents: cancelTieredAppliedCreditCents(PAYMENT, LEDGER_APPLIED_CENTS) },
      openNonCancellationHandBackCents: OPEN_HAND_BACK_CENTS,
      finalPriceCents: 20_000,
      appliedCreditCents: LEDGER_APPLIED_CENTS,
      restoresToMemberLedger: true,
      days: 31,
      policy,
      refundMethod,
      capAppliedCredit: false,
    });
    const quotedRefund = refundMethod === "credit" ? quoted.creditRefundAmountCents : quoted.refundAmountCents;
    expect(quotedRefund).toBe(cancel.refundAmountCents);
    expect(quoted.creditRestoredCents).toBe(cancel.creditRestoredCents);
    expect(quoted.totalPaidCents).toBe(cancel.paidAmountCents);
    expect({ quotedRefund, creditRestoredCents: quoted.creditRestoredCents, totalPaidCents: quoted.totalPaidCents }).toEqual({
      quotedRefund: refundCents,
      creditRestoredCents,
      totalPaidCents: 3_000,
    });
  });
});

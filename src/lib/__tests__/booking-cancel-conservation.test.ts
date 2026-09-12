/**
 * Conservation / path-independence matrix for cancel-after-reduction (#1031).
 *
 * For each cancellation-policy tier (100% / 50% / 0%) and each reduction
 * settlement path — card refund, account credit, and Internet Banking paid
 * after a reduction — the total member payout across the sequence
 * (modification settlement + cancellation settlement) must equal the policy
 * expectation for the final state, which is the same total a direct cancel of
 * the original booking pays. No ordering of edit/cancel operations may pay
 * out more than another ordering reaching the same final state.
 *
 * The modification-leg amounts are computed with the real policy math
 * (calculateDualRefundAmounts), mirroring what the settlement engine pays and
 * how it allocates refundedAmountCents (card refunds via the refund ledger,
 * credit settlements via applyLocalRefundAllocation — see member-credit.ts).
 * The cancel leg drives the real cancelBooking with the real
 * calculateRefundAmount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateDualRefundAmounts,
  calculateRefundAmount as realCalculateRefundAmount,
  type CancellationRule,
} from "@/lib/policies/cancellation";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  createCancellationCredit: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  processWaitlistForDates: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  processRefund: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: {
      update: mocks.paymentUpdate,
    },
    // #1547: the outer capture-evidence lookup on the never-captured branch.
    paymentTransaction: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    promoRedemption: {
      findUnique: mocks.promoRedemptionFindUnique,
    },
    promoCode: {
      update: vi.fn(),
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/cancellation", async () => {
  const policies = (await vi.importActual("@/lib/policies/cancellation")) as typeof import("@/lib/policies/cancellation");
  return {
    calculateRefundAmount: policies.calculateRefundAmount,
    daysUntilDate: mocks.daysUntilDate,
    loadCancellationPolicy: mocks.loadCancellationPolicy,
  };
});

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: mocks.createCancellationCredit,
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));

vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  findUnconvergedAppliedCreditDeallocation: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: mocks.enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation:
    mocks.enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  applyLocalRefundAllocation: mocks.applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed: mocks.markPaymentIntentTransactionFailed,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  planStripeRefundAllocation: mocks.planStripeRefundAllocation,
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueBookingCancellationRefundRecovery: vi.fn(async () => ({
    id: "recovery_op_1",
  })),
  markBookingCancellationRefundRecoverySucceeded: vi.fn(async () => ({
    count: 1,
  })),
  recordBookingCancellationRefundRecoveryInlineError: vi.fn(async () => ({
    count: 1,
  })),
}));

import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import { cancelBooking } from "@/lib/booking-cancel";

const POLICY: CancellationRule[] = [
  {
    daysBeforeStay: 14,
    refundPercentage: 100,
    creditRefundPercentage: 100,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
  {
    daysBeforeStay: 7,
    refundPercentage: 50,
    creditRefundPercentage: 50,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
  {
    daysBeforeStay: 0,
    refundPercentage: 0,
    creditRefundPercentage: 0,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
];

const ORIGINAL_CENTS = 30000;
const REDUCTION_CENTS = 10000;
const FINAL_CENTS = ORIGINAL_CENTS - REDUCTION_CENTS;

const TIERS = [
  { label: "100% tier", days: 30 },
  { label: "50% tier", days: 10 },
  { label: "0% tier", days: 3 },
] as const;

type PaymentFixture = {
  amountCents: number;
  refundedAmountCents: number;
  source?: string;
  xeroInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
};

async function runCancel({
  days,
  method,
  payment,
}: {
  days: number;
  method: "card" | "credit";
  payment: PaymentFixture;
}) {
  mocks.daysUntilDate.mockReturnValue(days);
  // Persistent (not ...Once): both the outer read and the tx1 single-flight
  // re-read under the advisory lock (#1160) must see this PAID booking.
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking_m",
    memberId: "member_1",
    lodgeId: "lodge_1",
    status: "PAID",
    finalPriceCents: FINAL_CENTS,
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-12"),
    member: {
      id: "member_1",
      email: "member@example.com",
      firstName: "Alice",
    },
    payment: {
      id: "payment_m",
      bookingId: "booking_m",
      status: "SUCCEEDED",
      changeFeeCents: 0,
      creditAppliedCents: 0,
      stripePaymentIntentId: "pi_m",
      ...payment,
    },
  });

  const result = await cancelBooking(
    "booking_m",
    "member_1",
    "MEMBER",
    "127.0.0.1",
    method
  );

  expect(result.status).toBe(200);
  if (!("data" in result)) {
    throw new Error("expected a success response");
  }
  return result.data.refundAmountCents;
}

describe("cancel-after-reduction conservation matrix (#1031)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The cancel service uses two $transaction shapes: the callback form for
    // the paid single-flight critical section (#1160) and the array form for
    // the pre-payment branches. Support both.
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          // #2619: model the participant fence's under-lock re-reads.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.bookingFindUnique(args),
          );
          const mockTx = {
            $executeRaw: vi.fn().mockResolvedValue(undefined),
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            payment: {
              update: mocks.paymentUpdate,
            },
            // #1547: the never-captured claim reads capture evidence and any
            // Xero-linked applied credit under the lock.
            paymentTransaction: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            memberCredit: {
              aggregate: vi
                .fn()
                .mockResolvedValue({ _sum: { amountCents: null } }),
            },
            memberCreditNoteAllocation: {
              aggregate: vi
                .fn()
                .mockResolvedValue({ _sum: { amountCents: null } }),
            },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.loadCancellationPolicy.mockResolvedValue(POLICY);
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.createCancellationCredit.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.isXeroConnected.mockResolvedValue(false);
    mocks.enqueueXeroAccountCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_1",
      message: "queued",
    });
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_2",
      message: "queued",
    });
    mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(null);
    mocks.applyLocalRefundAllocation.mockResolvedValue(undefined);
    mocks.markPaymentIntentTransactionFailed.mockResolvedValue(undefined);
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1", paymentIntentId: "pi_m", amountCents: 0 }],
    });
    // #1349: the claim tx freezes the refund plan before any Stripe call; the
    // conservation matrix only asserts money sums, so echo the requested
    // amount as a single fully-refundable slice.
    mocks.planStripeRefundAllocation.mockImplementation(
      async ({ amountCents }: { amountCents: number }) => ({
        slices: [{ paymentTransactionId: "ptx_m", amountCents }],
        plannedAmountCents: amountCents,
        totalRefundableCents: amountCents,
      }),
    );
  });

  for (const tier of TIERS) {
    const directCancelTotal = realCalculateRefundAmount(
      ORIGINAL_CENTS,
      tier.days,
      POLICY,
      "card"
    ).refundAmountCents;

    it(`reduce(card) then cancel pays the direct-cancel total at the ${tier.label}`, async () => {
      // Reduction leg: the settlement engine pays the policy-limited card
      // refund on the reduction and allocates it into refundedAmountCents.
      const modPayout = calculateDualRefundAmounts(
        REDUCTION_CENTS,
        tier.days,
        POLICY
      ).cardRefundAmountCents;

      const cancelPayout = await runCancel({
        days: tier.days,
        method: "card",
        payment: {
          amountCents: ORIGINAL_CENTS,
          refundedAmountCents: modPayout,
        },
      });

      expect(modPayout + cancelPayout).toBe(directCancelTotal);
    });

    it(`reduce(credit) then cancel pays the direct-cancel total at the ${tier.label}`, async () => {
      // Reduction leg: credit settlement now allocates locally (#1031), so
      // refundedAmountCents reflects the credit exactly like a card refund.
      const modPayout = calculateDualRefundAmounts(
        REDUCTION_CENTS,
        tier.days,
        POLICY
      ).creditRefundAmountCents;

      const cancelPayout = await runCancel({
        days: tier.days,
        method: "card",
        payment: {
          amountCents: ORIGINAL_CENTS,
          refundedAmountCents: modPayout,
        },
      });

      expect(modPayout + cancelPayout).toBe(directCancelTotal);
    });

    it(`IB paid-after-reduce then cancel pays the policy share of what was actually paid at the ${tier.label}`, async () => {
      // Internet Banking: the reduction issued a modification credit note
      // before payment; the member then paid the reduced invoice (FINAL).
      // Reconciliation never rewrites payment.amountCents, so the mirror
      // stays at the stale original. The cancel payout must be the policy
      // share of what was actually paid — never more.
      const expected = realCalculateRefundAmount(
        FINAL_CENTS,
        tier.days,
        POLICY,
        "credit"
      ).refundAmountCents;

      const cancelPayout = await runCancel({
        days: tier.days,
        method: "credit",
        payment: {
          amountCents: ORIGINAL_CENTS,
          refundedAmountCents: 0,
          source: "INTERNET_BANKING",
          xeroInvoiceId: "inv_1",
          stripePaymentIntentId: null,
        },
      });

      expect(cancelPayout).toBe(expected);
    });
  }

  it("conserves money even when a legacy credit-settled reduction never allocated (repro 1)", async () => {
    // Pre-fix data: a 10000 credit-settled reduction wrote the MemberCredit
    // but left refundedAmountCents at 0. The cap alone must keep the cancel
    // payout at the booking's current value, so credit + refund never exceeds
    // what the member paid.
    const cancelPayout = await runCancel({
      days: 30,
      method: "card",
      payment: {
        amountCents: ORIGINAL_CENTS,
        refundedAmountCents: 0,
      },
    });

    expect(cancelPayout).toBe(FINAL_CENTS);
    expect(REDUCTION_CENTS + cancelPayout).toBe(ORIGINAL_CENTS);
  });

  it("does not double-pay the forfeited share of a penalty-window reduction (repro 3)", async () => {
    // 50% tier: the reduction refunded 5000 and retained 5000. The retained
    // share must not earn a second 50% payout on cancel.
    const modPayout = calculateDualRefundAmounts(
      REDUCTION_CENTS,
      10,
      POLICY
    ).cardRefundAmountCents;
    expect(modPayout).toBe(5000);

    const cancelPayout = await runCancel({
      days: 10,
      method: "card",
      payment: {
        amountCents: ORIGINAL_CENTS,
        refundedAmountCents: modPayout,
      },
    });

    expect(cancelPayout).toBe(10000);
    expect(modPayout + cancelPayout).toBe(15000);
  });

  it("restores applied credit at 100% (no override) on a never-captured cancel, conserving the ledger (#1547)", async () => {
    // Apply X of credit, abandon payment, then cancel while never-captured: the
    // member's ledger delta must be 0. This file mocks restoreCreditFromBooking,
    // so we assert it runs exactly once with NO override arg and that the
    // returned amount surfaces on the response (the real-math ledger
    // conservation is pinned in member-credit.test.ts).
    const APPLIED_CENTS = 12000;
    mocks.daysUntilDate.mockReturnValue(30);
    mocks.restoreCreditFromBooking.mockResolvedValue(APPLIED_CENTS);
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking_nc",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 20000,
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_nc",
        bookingId: "booking_nc",
        amountCents: 20000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        source: "STRIPE",
        changeFeeCents: 0,
        creditAppliedCents: APPLIED_CENTS,
        stripePaymentIntentId: "pi_nc",
        xeroInvoiceId: null,
      },
    });

    const result = await cancelBooking(
      "booking_nc",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    if (!("data" in result)) {
      throw new Error("expected a success response");
    }
    // Exactly one restore, with the tx client and NO 4th (override) arg — the
    // never-captured path never tiers the restore.
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    expect(mocks.restoreCreditFromBooking.mock.calls[0]).toHaveLength(3);
    expect(mocks.restoreCreditFromBooking.mock.calls[0][0]).toBe("member_1");
    expect(mocks.restoreCreditFromBooking.mock.calls[0][1]).toBe("booking_nc");
    // The full applied amount is returned to the member (ledger delta 0).
    expect(result.data.creditRestoredCents).toBe(APPLIED_CENTS);
    expect(result.data.refundAmountCents).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  createCancellationCredit: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  processWaitlistForDates: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
    },
    payment: {
      update: mocks.paymentUpdate,
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

vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: mocks.calculateRefundAmount,
  daysUntilDate: mocks.daysUntilDate,
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: mocks.createCancellationCredit,
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: mocks.enqueueXeroAccountCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { cancelBooking } from "@/lib/booking-cancel";

describe("cancelBooking credit refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "member_1",
      status: "PAID",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_1",
      },
    });
    mocks.prismaTransaction.mockImplementation(async (actions: Array<Promise<unknown>>) =>
      Promise.all(actions)
    );
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.daysUntilDate.mockReturnValue(30);
    mocks.loadCancellationPolicy.mockResolvedValue({
      fullRefundDays: 60,
      partialRefundDays: 14,
      partialRefundPercentage: 50,
      creditRefundPercentage: 100,
    });
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 5000,
      refundPercentage: 50,
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.createCancellationCredit.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.enqueueXeroAccountCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_account_credit_1",
      message: "queued",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("creates the local credit first, then queues the Xero account-credit note", async () => {
    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 5000,
        refundMethod: "credit",
        creditAmountCents: 5000,
      }),
    });

    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      5000,
      "booking_1"
    );
    expect(mocks.enqueueXeroAccountCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      5000,
      {
        createdByMemberId: "member_1",
      }
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
    expect(
      mocks.createCancellationCredit.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.enqueueXeroAccountCreditNoteOperation.mock.invocationCallOrder[0]
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPlanStripeRefundAllocation = vi.hoisted(() => vi.fn());

import { NO_ADDITIONAL_ASK } from "@/lib/additional-payment-ask";
import { NextRequest } from "next/server";

// Issue #818 (wave 2): a Stripe refund failure after guest removal must enqueue a
// durable, admin-visible REFUND_BOOKING_MODIFICATION recovery operation instead of
// only logging "manual reconciliation required". These tests pin that behaviour to
// the DELETE handler so it stays consistent with the booking-modification path.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  transaction: vi.fn(),
  memberFindUnique: vi.fn(),
  removeBookingGuestInTransaction: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueBookingModificationRefundRecovery: vi.fn(),
  logAudit: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  recoveryFindUnique: vi.fn(),
  runPaymentRecoveryOperationNow: vi.fn(),
  alertPaymentRecoveryOfficers: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    member: { findUnique: mocks.memberFindUnique },
    // #4057: the organiser child refund's debt, looked up and re-read after commit.
    paymentRecoveryOperation: { findUnique: mocks.recoveryFindUnique },
  },
}));
vi.mock("@/lib/booking-guest-removal-service", () => ({
  removeBookingGuestInTransaction: mocks.removeBookingGuestInTransaction,
  BookingGuestRemovalError: class BookingGuestRemovalError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  planStripeRefundAllocation: mockPlanStripeRefundAllocation,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  enqueueBookingModificationRefundRecovery:
    mocks.enqueueBookingModificationRefundRecovery,
  runPaymentRecoveryOperationNow: mocks.runPaymentRecoveryOperationNow,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: mocks.alertPaymentRecoveryOfficers }));
vi.mock("@/lib/email", () => ({ sendBookingModifiedEmail: mocks.sendBookingModifiedEmail }));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: mocks.queueXeroBookingEditSettlement,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { DELETE } from "@/app/api/bookings/[id]/guests/[guestId]/route";
import { ORGANISER_REFUND_DEBT_STATES, primeOrganiserRefundDebt } from "./support/organiser-refund-debt-reread";
import { expectQueuedOnce, ownCardRefundPlan, OWN_CARD_REFUND_STATES, primeOwnCardRefund } from "./support/own-card-refund-outcome";

const params = Promise.resolve({ id: "b1", guestId: "g1" });

function makeRequest() {
  return new NextRequest("https://example.test/api/bookings/b1/guests/g1", {
    method: "DELETE",
  });
}

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    booking: {
      id: "b1",
      memberId: "m1",
      checkIn: new Date("2026-07-15"),
      checkOut: new Date("2026-07-17"),
      finalPriceCents: 8000,
      guests: [{ id: "g2" }],
    },
    removedGuest: { id: "g1", firstName: "Sam", lastName: "Lee" },
    priceDiffCents: -2000,
    refundAmountCents: 2000,
    accountCreditAmountCents: 0,
    // Only the Stripe-refundable slice drives the refund + recovery path.
    pendingRefundAmountCents: 2000,
    additionalAmountCents: 0,
    // #3371: the minter's own parameter. A removal asks for nothing, and a zero
    // ask never mints - so it can retire nothing and carries nothing.
    additionalAsk: NO_ADDITIONAL_ASK,
    // #3954: this booking carries no unpaid ask, so the reduction retired none.
    unpaidAskOffsetCents: 0,
    retiredAdditionalAsks: [],
    settlementMethod: "card",
    policyRetainedAmountCents: 0,
    xeroRefundAmountCents: 0,
    hasSucceededPayment: true,
    hasIssuedXeroInvoice: false,
    paymentStatus: "PAID",
    paymentId: "pay_1",
    paymentCustomerId: null,
    memberEmail: "m@example.com",
    memberName: "Sam Lee",
    promoRemoved: false,
    choreWarnings: [],
    oldGuestCount: 2,
    bookingModificationId: "mod_1",
    zeroDollarAutoPaid: false,
    supersededPrimaryPaymentIntents: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPlanStripeRefundAllocation.mockImplementation(ownCardRefundPlan);
  mocks.auth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
  mocks.memberFindUnique.mockResolvedValue({
    id: "m1",
    email: "m@example.com",
    firstName: "Pat",
  });
  mocks.queueXeroBookingEditSettlement.mockResolvedValue(undefined);
  mocks.sendBookingModifiedEmail.mockResolvedValue(undefined);
  mocks.enqueueBookingModificationRefundRecovery.mockResolvedValue(undefined);
});

describe("DELETE /api/bookings/[id]/guests/[guestId] refund recovery", () => {
  it("enqueues durable refund recovery when the Stripe refund fails", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));

    const res = await DELETE(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stripeRefundId).toBeNull();
    expect(mocks.enqueueBookingModificationRefundRecovery).toHaveBeenCalledWith({
      bookingId: "b1",
      paymentId: "pay_1",
      bookingModificationId: "mod_1",
      amountCents: 2000,
      // The route's exact Stripe key prefix rides on the recovery row (#1152).
      stripeKeyPrefix: "guest_remove_refund_b1_mod_1",
      allocationPlan: [{ paymentTransactionId: "txn_refund", amountCents: 2000 }],
    });
  });

  it("does not enqueue recovery when the Stripe refund succeeds", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1" }],
    });

    const res = await DELETE(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stripeRefundId).toBe("re_1");
    expect(mocks.enqueueBookingModificationRefundRecovery).not.toHaveBeenCalled();
  });

  it("still returns success when recovery enqueue also fails", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
    mocks.enqueueBookingModificationRefundRecovery.mockRejectedValue(
      new Error("db down"),
    );

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(200);
    expect(mocks.enqueueBookingModificationRefundRecovery).toHaveBeenCalled();
  });

  it("does not refund or enqueue recovery when there is nothing to refund", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(
      makeResult({
        refundAmountCents: 0,
        pendingRefundAmountCents: 0,
        priceDiffCents: 0,
      }),
    );

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(200);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.enqueueBookingModificationRefundRecovery).not.toHaveBeenCalled();
  });
});

/*
  #4057: a joiner's booking the group organiser paid for by card refunds the
  removal to the ORGANISER's card through its debt. The email says the refund was
  made only when the debt, re-read after the run, says so; otherwise it is on its
  way. The real `executeBookingModificationRefund` runs here.
*/
describe("DELETE guest removal on an organiser-paid child: the email's refund destination (#4057)", () => {
  const organiserChild = () => makeResult({ organiserChildRefund: { amountCents: 2000 } });

  it.each(ORGANISER_REFUND_DEBT_STATES)("debt $label -> $destination", async ({ lookupThrows, reread, runs, destination }) => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(organiserChild());
    mocks.runPaymentRecoveryOperationNow.mockResolvedValue("succeeded");
    primeOrganiserRefundDebt(mocks.recoveryFindUnique, { bookingModificationId: "mod_1", debtId: "op_child", lookupThrows, reread });

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(200);
    // A lookup that throws leaves nothing to run; the debt stays owed.
    if (runs) expect(mocks.runPaymentRecoveryOperationNow).toHaveBeenCalledWith("op_child", expect.anything());
    else expect(mocks.runPaymentRecoveryOperationNow).not.toHaveBeenCalledWith("op_child", expect.anything());
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2000, refundDestination: destination }),
      expect.anything(),
    );
  });

  it("a debt missing after commit is still owed, so on its way - never made", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(organiserChild());
    mocks.recoveryFindUnique.mockResolvedValue(null);

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(200);
    expect(mocks.runPaymentRecoveryOperationNow).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundDestination: "organiser_card_pending" }),
      expect.anything(),
    );
  });

  it("a refund the helper could not run here (no payment to refund from) is still owed, so on its way", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(
      makeResult({ organiserChildRefund: { amountCents: 2000 }, paymentId: null }),
    );

    await DELETE(makeRequest(), { params });

    expect(mocks.runPaymentRecoveryOperationNow).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundDestination: "organiser_card_pending" }),
      expect.anything(),
    );
  });

  it("the member's own card refund stays the member's own", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    mocks.refundPaymentTransactions.mockResolvedValue({ refunds: [{ refundId: "re_1" }] });

    await DELETE(makeRequest(), { params });

    expect(mocks.recoveryFindUnique).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundDestination: "own" }),
      expect.anything(),
    );
  });
});

/*
  #4070: the member's own card. The email says the refund was made only when
  Stripe made it; a refund the Stripe call could not make is queued for the
  recovery runner and on its way. The real `executeBookingModificationRefund`
  runs here.
*/
describe("DELETE guest removal on the member's own card: the email's refund destination (#4070)", () => {
  it.each(OWN_CARD_REFUND_STATES)("$label -> $destination", async ({ answer, queued, destination }) => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    primeOwnCardRefund(mocks.refundPaymentTransactions, answer, mockPlanStripeRefundAllocation);

    const res = await DELETE(makeRequest(), { params });

    expect(res.status).toBe(200);
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay_1", amountCents: 2000 }));
    expectQueuedOnce(mocks.enqueueBookingModificationRefundRecovery, queued, 2000, answer);
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2000, refundDestination: destination, refundByBankTransfer: null }),
      expect.anything(),
    );
  });

  // #4083 review: the officers hear of a refusal once, when the edit's row is
  // first written - not when a repeat enqueue finds it already there.
  it.each([
    [true, 1],
    [false, 0],
  ])("a refused refund alerts the officers when its row is created (%s -> %i alert)", async (created, alerts) => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    const slice = { paymentTransactionId: "txn_primary", amountCents: 2000 };
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_refused", paymentIntentId: "pi_original", amountCents: 2000, status: "failed", slice }],
    });
    mocks.enqueueBookingModificationRefundRecovery.mockResolvedValue({ created, paymentIntentId: "pi_original" });

    await DELETE(makeRequest(), { params });

    expect(mocks.alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(alerts);
    if (alerts) {
      expect(mocks.alertPaymentRecoveryOfficers).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 2000,
          paymentIntentId: "pi_original",
          errorMessage: "Stripe refused $20.00 of this card refund (failed or cancelled), so that $20.00 did not go back and is still owed; it will be retried automatically.",
        }),
        expect.anything(),
      );
    }
  });

  it("a refused refund whose row could not be written still alerts the officers: the alert is then its only record (#4083)", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(makeResult());
    const slice = { paymentTransactionId: "txn_primary", amountCents: 2000 };
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_refused", paymentIntentId: "pi_original", amountCents: 2000, status: "failed", slice }],
    });
    mocks.enqueueBookingModificationRefundRecovery.mockRejectedValue(new Error("database down"));

    await DELETE(makeRequest(), { params });

    expect(mocks.alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(mocks.alertPaymentRecoveryOfficers).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2000, paymentIntentId: "pi_original" }),
      expect.anything(),
    );
  });

  it("a bank-transfer refund runs no Stripe refund and keeps the member's own wording", async () => {
    mocks.removeBookingGuestInTransaction.mockResolvedValue(
      makeResult({ pendingRefundAmountCents: 0, hasSucceededPayment: false }),
    );

    await DELETE(makeRequest(), { params });

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2000, refundDestination: "own", refundByBankTransfer: "member" }),
      expect.anything(),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentSource, PaymentStatus } from "@prisma/client";

/**
 * B5 (#2262) — the RECIPROCAL fence.
 *
 * The outbound refusal stops an admin recording cash while a Xero invoice is
 * outstanding. This is its counterpart: an inbound Xero PAID landing on a
 * booking already recorded as settled in cash must NOT return `alreadyPaid`
 * quietly (the pre-#2262 behaviour), because that leaves the club holding an
 * unreconciled overpayment with nobody told. It must raise an admin alert —
 * asserted here, not merely "no second write".
 *
 * Keyed on `manuallyMarkedPaidAt` ALONE:
 *  * PAID      — the plain double settlement;
 *  * CANCELLED — must conflict, or the inbound path mints member credit for the
 *    same cash an OPEN hand-back task already owes the member: a double refund;
 *  * COMPLETED — must conflict, because the post-stay cron flips PAID ->
 *    COMPLETED, so a late bank transfer lands on a completed cash booking.
 * …and with NO "carries no Xero id" conjunct, because two stampers outside the
 * settle loop can legitimately stamp an id onto a manual row.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  bookingEventFindFirst: vi.fn(),
  recordBookingEvent: vi.fn(),
  claimAlertCooldown: vi.fn(),
  sendAdminManualSettlementConflictAlert: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => mocks.transaction(...a),
    payment: {
      findMany: (...a: unknown[]) => mocks.paymentFindMany(...a),
      findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a),
    },
    bookingEvent: {
      findFirst: (...a: unknown[]) => mocks.bookingEventFindFirst(...a),
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminManualSettlementConflictAlert: (...a: unknown[]) =>
    mocks.sendAdminManualSettlementConflictAlert(...a),
  sendAdminPaymentFailureAlert: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
}));

vi.mock("@/lib/alert-cooldown", () => ({
  claimAlertCooldown: (...a: unknown[]) => mocks.claimAlertCooldown(...a),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...a: unknown[]) => mocks.recordBookingEvent(...a),
}));

vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceededFromInvoice: vi.fn(),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
}));
vi.mock("@/lib/waitlist", () => ({ processWaitlistForDates: vi.fn() }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    error: (...a: unknown[]) => mocks.error(...a),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { syncInternetBankingPaymentsForPaidInvoice } from "@/lib/xero-inbound/invoice-paid-effects";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const INVOICE_ID = "inv-xero-1";

const tx = {
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
  paymentTransaction: {
    updateMany: (...a: unknown[]) => mocks.paymentTransactionUpdateMany(...a),
  },
};

function invoice() {
  return {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-001",
    status: "PAID",
    amountPaid: 100,
  } as never;
}

function manualPayment(bookingStatus: BookingStatus, overrides = {}) {
  return {
    id: "payment-1",
    bookingId: "booking-1",
    amountCents: 10000,
    status: PaymentStatus.SUCCEEDED,
    source: PaymentSource.INTERNET_BANKING,
    reference: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroRefundCreditNoteId: null,
    manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
    booking: {
      id: "booking-1",
      status: bookingStatus,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { firstName: "Ada", lastName: "Lovelace", email: "ada@x.org" },
      guests: [],
      promoRedemption: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.bookingEventFindFirst.mockResolvedValue(null);
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.sendAdminManualSettlementConflictAlert.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
});

function primePayment(payment: ReturnType<typeof manualPayment>) {
  // First call: syncLinkedPaymentInvoiceMetadata-shaped list. Second: the loop.
  mocks.paymentFindMany.mockResolvedValue([payment]);
  mocks.paymentFindUnique.mockResolvedValue(payment);
}

describe("the inbound reciprocal fence", () => {
  for (const status of [
    BookingStatus.PAID,
    BookingStatus.CANCELLED,
    BookingStatus.COMPLETED,
  ]) {
    it(`conflicts (never settles or credits) when the booking is ${status}`, async () => {
      primePayment(manualPayment(status));

      const result = await syncInternetBankingPaymentsForPaidInvoice(
        invoice(),
        ["payment-1"],
        CLUB_FORMAT_TEST
      );

      expect(result.manualSettlementConflicts).toBe(1);
      expect(result.paidInternetBankingPayments).toBe(0);
      expect(result.creditedInternetBankingBookings).toBe(0);
      expect(result.skippedAlreadyPaidBookings).toBe(0);
      // Crucially: the settle loop never stamps the Xero invoice id onto the
      // manual settlement's transaction rows.
      expect(mocks.paymentTransactionUpdateMany).not.toHaveBeenCalled();
      // The alert IS raised — the acceptance criterion is an alert, not
      // merely the absence of a second write.
      expect(mocks.sendAdminManualSettlementConflictAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-1",
          bookingStatus: status,
          xeroInvoiceNumber: "INV-001",
          // Cross-lane #2283: a BUILT Xero deep link, never hand-rolled.
          xeroInvoiceUrl: expect.stringContaining(INVOICE_ID),
        }),
        CLUB_FORMAT_TEST
      );
      expect(mocks.error).toHaveBeenCalled();
    });
  }

  it("still fires when an out-of-loop stamper has already put a Xero id on the manual row", async () => {
    primePayment(
      manualPayment(BookingStatus.PAID, {
        xeroInvoiceId: INVOICE_ID,
        xeroInvoiceNumber: "INV-001",
      })
    );

    const result = await syncInternetBankingPaymentsForPaidInvoice(invoice(), [
      "payment-1",
    ], CLUB_FORMAT_TEST);

    expect(result.manualSettlementConflicts).toBe(1);
  });

  it("records the durable admin-only event ONCE per payment+invoice, but re-counts every replay", async () => {
    primePayment(manualPayment(BookingStatus.PAID));
    mocks.bookingEventFindFirst.mockResolvedValue({ id: "event-1" });

    const result = await syncInternetBankingPaymentsForPaidInvoice(invoice(), [
      "payment-1",
    ], CLUB_FORMAT_TEST);

    expect(result.manualSettlementConflicts).toBe(1);
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("does not re-mail the admins inside the cooldown window, but still counts the conflict", async () => {
    primePayment(manualPayment(BookingStatus.PAID));
    mocks.claimAlertCooldown.mockResolvedValue(false);

    const result = await syncInternetBankingPaymentsForPaidInvoice(invoice(), [
      "payment-1",
    ], CLUB_FORMAT_TEST);

    expect(result.manualSettlementConflicts).toBe(1);
    expect(mocks.sendAdminManualSettlementConflictAlert).not.toHaveBeenCalled();
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `manual-settlement-conflict:payment-1:${INVOICE_ID}`,
      })
    );
  });
});

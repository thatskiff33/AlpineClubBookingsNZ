import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";

/**
 * #3638 — card first, then bank.
 *
 * A member switched a card booking to Internet Banking while the card payment
 * was already going through. The card payment settled the booking; the member
 * then paid the emailed Xero invoice by bank transfer too. Before #3638 the
 * inbound sync marked the bank payment received, saw a PAID booking and moved
 * on with a counter bump: the club held twice the price and nobody was told.
 *
 * It must now raise a durable admin-only conflict event (once per invoice) and
 * an admin alert, move no money, and never re-claim the booking. An ordinary
 * Internet Banking replay, a card row refunded in full, and a booking change
 * paid by card (an ADDITIONAL row) are not a second instrument.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  memberCreditFindFirst: vi.fn(),
  memberCreditAggregate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  memberCreditCreate: vi.fn(),
  bookingEventFindFirst: vi.fn(),
  recordBookingEvent: vi.fn(),
  claimAlertCooldown: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  sendAdminManualSettlementConflictAlert: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  syncBookingLedgerSettlements: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
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
  sendAdminPaymentFailureAlert: (...a: unknown[]) =>
    mocks.sendAdminPaymentFailureAlert(...a),
  sendBookingCancelledEmail: vi.fn(),
  sendBookingConfirmedEmail: (...a: unknown[]) =>
    mocks.sendBookingConfirmedEmail(...a),
}));

vi.mock("@/lib/alert-cooldown", () => ({
  claimAlertCooldown: (...a: unknown[]) => mocks.claimAlertCooldown(...a),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...a: unknown[]) => mocks.recordBookingEvent(...a),
}));

vi.mock("@/lib/booking-ledger-settlement-sync", () => ({
  syncBookingLedgerSettlements: (...a: unknown[]) =>
    mocks.syncBookingLedgerSettlements(...a),
}));
vi.mock("@/lib/booking-ledger-credit-sync", () => ({
  syncBookingLedgerCredits: vi.fn(),
}));
vi.mock("@/lib/booking-credit-election", () => ({
  clearStaleCreditElection: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/booking-credit-election-report", () => ({
  reportUnappliedCreditElection: vi.fn(),
}));
vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceededFromInvoice: vi.fn(),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn(),
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(),
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...a: unknown[]) =>
    mocks.acquireLodgeCapacityLock(...a),
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
import {
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
  isManualSettlementMarkerEvent,
} from "@/lib/manual-settlement-reversal-event";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const INVOICE_ID = "inv-xero-3638";

const tx = {
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  payment: {
    findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a),
    update: (...a: unknown[]) => mocks.paymentUpdate(...a),
  },
  paymentTransaction: {
    updateMany: (...a: unknown[]) => mocks.paymentTransactionUpdateMany(...a),
    findMany: (...a: unknown[]) => mocks.paymentTransactionFindMany(...a),
    findFirst: (...a: unknown[]) => mocks.paymentTransactionFindFirst(...a),
    create: (...a: unknown[]) => mocks.paymentTransactionCreate(...a),
  },
  booking: {
    updateMany: (...a: unknown[]) => mocks.bookingUpdateMany(...a),
  },
  memberCredit: {
    create: (...a: unknown[]) => mocks.memberCreditCreate(...a),
    findFirst: (...a: unknown[]) => mocks.memberCreditFindFirst(...a),
    aggregate: (...a: unknown[]) => mocks.memberCreditAggregate(...a),
  },
  paymentRecoveryOperation: {
    findMany: (...a: unknown[]) => mocks.paymentRecoveryOperationFindMany(...a),
  },
};

function invoice() {
  return {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-3638",
    status: "PAID",
    amountPaid: 270,
  } as never;
}

/**
 * The switched payment: Internet Banking source, its intent reference dropped
 * by the switch, and already SUCCEEDED because the card settlement landed.
 */
function switchedPayment(bookingStatus: BookingStatus, overrides = {}) {
  return {
    id: "payment-1",
    bookingId: "booking-1",
    amountCents: 27000,
    status: PaymentStatus.SUCCEEDED,
    source: PaymentSource.INTERNET_BANKING,
    reference: "BOOKING-BOOKING1",
    stripePaymentIntentId: null,
    xeroInvoiceId: INVOICE_ID,
    xeroInvoiceNumber: "INV-3638",
    xeroRefundCreditNoteId: null,
    manuallyMarkedPaidAt: null,
    internetBankingHoldSlots: false,
    booking: {
      id: "booking-1",
      lodgeId: "lodge-1",
      status: bookingStatus,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { firstName: "Ada", lastName: "Lovelace", email: "ada@x.org" },
      organisation: null,
      guests: [],
      promoRedemption: null,
    },
    ...overrides,
  };
}

const CARD_PRIMARY = {
  source: PaymentSource.STRIPE,
  stripePaymentIntentId: "pi_card_3638",
  amountCents: 27000,
  refundedAmountCents: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentTransactionFindMany.mockResolvedValue([CARD_PRIMARY]);
  // No captured Internet Banking row yet: this bank cash is new.
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.memberCreditFindFirst.mockResolvedValue(null);
  mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  mocks.paymentUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingEventFindFirst.mockResolvedValue(null);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
  mocks.syncBookingLedgerSettlements.mockResolvedValue(undefined);
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
});

function primePayment(payment: ReturnType<typeof switchedPayment>) {
  mocks.paymentFindMany.mockResolvedValue([payment]);
  mocks.paymentFindUnique.mockResolvedValue(payment);
}

async function sync() {
  return syncInternetBankingPaymentsForPaidInvoice(
    invoice(),
    ["payment-1"],
    CLUB_FORMAT_TEST
  );
}

describe("card first, then bank (#3638)", () => {
  for (const status of [BookingStatus.PAID, BookingStatus.COMPLETED]) {
    it(`raises one conflict event and an alert when the ${status} booking was settled by card`, async () => {
      primePayment(switchedPayment(status));

      const result = await sync();

      expect(result.secondInstrumentSettlementConflicts).toBe(1);
      // No longer the quiet arm.
      expect(result.skippedAlreadyPaidBookings).toBe(0);

      // The bank receipt is RECORDED — the money did arrive.
      expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.SUCCEEDED }),
        })
      );
      // Nothing is re-claimed (a COMPLETED booking is never flipped back to
      // PAID), credited or refunded.
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
      expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
      expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();

      // The durable admin-only record.
      expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
      expect(mocks.recordBookingEvent).toHaveBeenCalledWith({
        bookingId: "booking-1",
        type: BookingEventType.CANCELLED,
        actorMemberId: null,
        amountCents: 27000,
        reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
        snapshot: {
          kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
          invoiceId: INVOICE_ID,
          invoiceNumber: "INV-3638",
          bookingStatus: status,
          settledBySource: PaymentSource.STRIPE,
          settledByPaymentIntentId: "pi_card_3638",
        },
      });

      // The alert names the card payment and the invoice.
      expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mocks.sendAdminPaymentFailureAlert.mock.calls[0];
      expect(alert).toMatchObject({
        paymentIntentId: "pi_card_3638",
        amountCents: 27000,
      });
      expect(alert.errorMessage).toContain("paid TWICE");
      expect(alert.errorMessage).toContain("INV-3638");
      expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `second-instrument-settlement-conflict:payment-1:${INVOICE_ID}`,
        })
      );
      // No member was emailed a confirmation for money they paid twice.
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalled();
    });
  }

  it("asks only for net-captured PRIMARY rows of another source", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));

    await sync();

    // ADDITIONAL (a booking change paid by card) and fully REFUNDED rows are
    // excluded at the query; the Internet Banking row itself never counts.
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentId: "payment-1",
          kind: PaymentTransactionKind.PRIMARY,
          source: { not: PaymentSource.INTERNET_BANKING },
          status: {
            in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
        },
      })
    );
  });

  it("records the event ONCE per invoice, but re-counts every replay", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.bookingEventFindFirst.mockResolvedValue({ id: "event-1" });

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.bookingEventFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "booking-1",
          snapshot: {
            path: ["kind"],
            equals: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
          },
        }),
      })
    );
  });

  it("does not re-mail the admins inside the cooldown window", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.claimAlertCooldown.mockResolvedValue(false);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("catches a booking that became PAID while it waited for the lodge lock", async () => {
    const pending = switchedPayment(BookingStatus.CONFIRMED);
    const paid = switchedPayment(BookingStatus.PAID);
    mocks.paymentFindMany.mockResolvedValue([pending]);
    mocks.paymentFindUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(paid);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
  });
});

describe("not a second instrument (#3638)", () => {
  it("an ordinary Internet Banking replay stays the quiet already-paid arm", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("a card capture refunded in full holds nothing twice", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([
      {
        ...CARD_PRIMARY,
        refundedAmountCents: 27000,
      },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("a booking still awaiting payment never runs the test", async () => {
    primePayment(switchedPayment(BookingStatus.CONFIRMED));
    mocks.paymentFindUnique.mockResolvedValue(
      switchedPayment(BookingStatus.CONFIRMED)
    );

    await sync();

    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });
});

describe("card first, then cancelled, then bank (#3638)", () => {
  it("raises the conflict for new bank cash on a card-settled booking that was cancelled", async () => {
    // The cancellation refunded the card in full under the club's policy.
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { ...CARD_PRIMARY, refundedAmountCents: 27000 },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    // Before #3638 this was the credit-mint arm, which mints only for a
    // payment that never settled — silently nothing.
    expect(result.creditedInternetBankingBookings).toBe(0);
    expect(mocks.memberCreditCreate).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
          bookingStatus: BookingStatus.CANCELLED,
        }),
      })
    );
    const [alert] = mocks.sendAdminPaymentFailureAlert.mock.calls[0];
    expect(alert.errorMessage).toContain("later cancelled");
    // Refunded card rows count on a cancelled booking.
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              PaymentStatus.SUCCEEDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.REFUNDED,
            ],
          },
        }),
      })
    );
  });

  it("stays out of the way when the bank cash was already recorded (a replay, or bank first)", async () => {
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ib-primary" });

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });
});

describe("the opposite order belongs to #1992 (#3638)", () => {
  it("a card capture the duplicate-capture refund owns is not a second instrument", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      { idempotencyKey: "duplicate_capture_booking-1_pi_card_3638" },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: { in: ["duplicate_capture_booking-1_pi_card_3638"] },
      },
      select: { idempotencyKey: true },
    });
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });
});

describe("a replay on a completed booking (#3638)", () => {
  it("never flips it back to PAID or re-sends the confirmation", async () => {
    // An ordinary Internet Banking booking, paid by bank and completed after
    // the stay; Xero redelivers the invoice event.
    primePayment(switchedPayment(BookingStatus.COMPLETED));
    mocks.paymentTransactionFindMany.mockResolvedValue([]);

    const result = await sync();

    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
    expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("does not re-claim a booking that COMPLETED while it waited for the lodge lock", async () => {
    const pending = switchedPayment(BookingStatus.CONFIRMED);
    mocks.paymentFindMany.mockResolvedValue([pending]);
    mocks.paymentFindUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(switchedPayment(BookingStatus.COMPLETED));
    mocks.paymentTransactionFindMany.mockResolvedValue([]);

    const result = await sync();

    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });
});

describe("the marker is admin-only (#3638)", () => {
  it("is excluded wherever CANCELLED events are read as a cancellation", () => {
    expect(
      isManualSettlementMarkerEvent({
        type: BookingEventType.CANCELLED,
        snapshot: { kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND },
      })
    ).toBe(true);
    expect(
      isManualSettlementMarkerEvent({
        type: BookingEventType.CANCELLED,
        snapshot: { policySummary: "Full refund" },
      })
    ).toBe(false);
  });
});

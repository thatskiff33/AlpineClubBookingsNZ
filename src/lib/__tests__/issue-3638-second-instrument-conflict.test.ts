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
  paymentRefundFindMany: vi.fn(),
  txBookingEventFindFirst: vi.fn(),
  txBookingEventCreate: vi.fn(),
  bookingEventUpdate: vi.fn(),
  memberCreditFindFirst: vi.fn(),
  memberCreditAggregate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  memberCreditCreate: vi.fn(),
  bookingEventFindFirst: vi.fn(),
  recordBookingEvent: vi.fn(),
  claimAlertCooldown: vi.fn(),
  sendAdminSecondInstrumentSettlementConflictAlert: vi.fn(),
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
      // #3638: the alert is recorded on the marker once it is sent.
      update: (...a: unknown[]) => mocks.bookingEventUpdate(...a),
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminManualSettlementConflictAlert: (...a: unknown[]) =>
    mocks.sendAdminManualSettlementConflictAlert(...a),
  sendAdminSecondInstrumentSettlementConflictAlert: (...a: unknown[]) =>
    mocks.sendAdminSecondInstrumentSettlementConflictAlert(...a),
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
import * as settlementMarkerModule from "@/lib/manual-settlement-reversal-event";
import {
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
  SETTLEMENT_MARKERS,
  SETTLEMENT_MARKER_EVENT_REASONS,
  isManualSettlementMarkerEvent,
  settlementMarkerTimelineEntries,
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
  paymentRefund: {
    findMany: (...a: unknown[]) => mocks.paymentRefundFindMany(...a),
  },
  // The cancelled case's idempotency read: this invoice's marker, in the
  // settle loop's transaction.
  bookingEvent: {
    findFirst: (...a: unknown[]) => mocks.txBookingEventFindFirst(...a),
    // #3638 delta D1: the marker is written INSIDE the settle transaction.
    create: (...a: unknown[]) => mocks.txBookingEventCreate(...a),
  },
};

/**
 * The BookingEvent table as the settle transaction and the post-commit alert
 * see it — stateful across deliveries, so a retry reads what the first
 * delivery committed.
 */
type MarkerRow = { id: string; snapshot: Record<string, unknown> };
let markerRows: MarkerRow[] = [];

function seedMarker(snapshot: Record<string, unknown>): MarkerRow {
  const row = {
    id: `marker-${markerRows.length + 1}`,
    snapshot: {
      kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-3638",
      bookingStatus: BookingStatus.CANCELLED,
      conflictKind: "cancelledAfterCard",
      settledBySource: PaymentSource.STRIPE,
      settledByPaymentIntentId: "pi_card_3638",
      cardAmountCents: 27000,
      cardRefundedAmountCents: 27000,
      alertSentAt: null,
      ...snapshot,
    },
  };
  markerRows.push(row);
  return row;
}

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
  id: "card-row",
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
  mocks.paymentRefundFindMany.mockResolvedValue([]);
  markerRows = [];
  mocks.txBookingEventFindFirst.mockImplementation(
    async ({
      where,
    }: {
      where: {
        snapshot: { equals: string };
        AND: [{ snapshot: { equals: string } }];
      };
    }) =>
      markerRows.find(
        (row) =>
          row.snapshot.kind === where.snapshot.equals &&
          row.snapshot.invoiceId === where.AND[0].snapshot.equals,
      ) ?? null,
  );
  mocks.txBookingEventCreate.mockImplementation(
    async ({ data }: { data: { snapshot: Record<string, unknown> } }) => {
      const row = { id: `marker-${markerRows.length + 1}`, snapshot: data.snapshot };
      markerRows.push(row);
      return { id: row.id };
    },
  );
  mocks.bookingEventUpdate.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { snapshot: Record<string, unknown> };
    }) => {
      const row = markerRows.find((candidate) => candidate.id === where.id);
      if (row) row.snapshot = data.snapshot;
      return row;
    },
  );
  mocks.memberCreditFindFirst.mockResolvedValue(null);
  mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  mocks.paymentUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingEventFindFirst.mockResolvedValue(null);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.sendAdminSecondInstrumentSettlementConflictAlert.mockResolvedValue(undefined);
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

      // The durable admin-only record, written in the settle transaction
      // (delta D1) so it commits with the receipt.
      expect(mocks.txBookingEventCreate).toHaveBeenCalledTimes(1);
      expect(mocks.txBookingEventCreate).toHaveBeenCalledWith({
        data: {
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
            conflictKind: "settled",
            settledBySource: PaymentSource.STRIPE,
            settledByPaymentIntentId: "pi_card_3638",
            cardAmountCents: 27000,
            cardRefundedAmountCents: 0,
            alertSentAt: null,
          },
        },
        select: { id: true },
      });
      // Not the post-commit helper, which swallows its own failure.
      expect(mocks.recordBookingEvent).not.toHaveBeenCalled();

      // Its own alert (#3638 review): it names the booking, the card payment
      // and the Xero invoice with a link to it — never the generic "Payment
      // Failed" mail the payment-failure preference can mute.
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).toHaveBeenCalledTimes(1);
      const [alert] = mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0];
      expect(alert).toEqual({
        memberName: "Ada Lovelace",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        bookingId: "booking-1",
        bookingStatus: status,
        conflictKind: "settled",
        invoiceAmountCents: 27000,
        cardHeldCents: 27000,
        cardPaymentIntentId: "pi_card_3638",
        xeroInvoiceNumber: "INV-3638",
        xeroInvoiceUrl: expect.stringContaining(INVOICE_ID),
      });
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
        expect.objectContaining({ key: "second-instrument-alert:marker-1" })
      );
      // Recorded as sent on the marker only after the send.
      expect(markerRows[0].snapshot.alertSentAt).toEqual(expect.any(String));
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

  it("records the marker ONCE per invoice and mails ONCE, but re-counts every replay", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    seedMarker({
      bookingStatus: BookingStatus.PAID,
      conflictKind: "settled",
      alertSentAt: "2026-08-04T00:00:00.000Z",
    });

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.txBookingEventCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });

  it("does not send while another sender holds the alert, and leaves it owed", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.claimAlertCooldown.mockResolvedValue(false);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
    expect(markerRows[0].snapshot.alertSentAt).toBeNull();
  });

  it("leaves the alert owed when the send fails, so the next delivery re-sends it", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.sendAdminSecondInstrumentSettlementConflictAlert.mockRejectedValueOnce(
      new Error("SES down"),
    );

    await sync();
    expect(markerRows[0].snapshot.alertSentAt).toBeNull();

    await sync();
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).toHaveBeenCalledTimes(2);
    expect(markerRows).toHaveLength(1);
    expect(markerRows[0].snapshot.alertSentAt).toEqual(expect.any(String));
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
    expect(mocks.txBookingEventCreate).toHaveBeenCalledTimes(1);
  });
});

describe("not a second instrument (#3638)", () => {
  it("an ordinary Internet Banking replay stays the quiet already-paid arm", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.txBookingEventCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
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
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
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
    expect(markerRows).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
          bookingStatus: BookingStatus.CANCELLED,
          conflictKind: "cancelledAfterCard",
        }),
      }),
    ]);
    const [alert] = mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0];
    expect(alert).toMatchObject({
      conflictKind: "cancelledAfterCard",
      bookingStatus: BookingStatus.CANCELLED,
    });
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

  it("stays out of the way on a replay once this invoice's conflict was raised and mailed", async () => {
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ib-primary" });
    seedMarker({ alertSentAt: "2026-08-04T00:00:00.000Z" });

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    // The marker is looked up for THIS invoice, inside the settle transaction.
    expect(mocks.txBookingEventFindFirst).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        type: BookingEventType.CANCELLED,
        snapshot: { path: ["kind"], equals: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND },
        AND: [{ snapshot: { path: ["invoiceId"], equals: INVOICE_ID } }],
      },
      select: { id: true, snapshot: true },
    });
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
    expect(mocks.txBookingEventCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });

  // #3638 delta D2: with the marker atomic with the receipt, "receipt recorded
  // and no marker" means no conflict was ever raised — a bank-first booking.
  // A card capture that landed after it (a stale intent the late-capture
  // handler refunded) must not be reported as having settled the booking.
  it("stays quiet on a bank-first replay with a card capture refunded after the switch", async () => {
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ib-primary" });
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { ...CARD_PRIMARY, refundedAmountCents: 27000 },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
    expect(markerRows).toEqual([]);
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });

  it("stays quiet on a bank-first replay whose card row is #1765 refund history", async () => {
    // Card paid and refunded, switched to Internet Banking, repaid by bank
    // (PAID), then cancelled. No conflict was ever raised, so no marker.
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ib-primary" });
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { ...CARD_PRIMARY, refundedAmountCents: 27000 },
    ]);
    mocks.paymentRefundFindMany.mockResolvedValue([{ paymentTransactionId: "card-row" }]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(markerRows).toEqual([]);
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });

  // Round-1 concurrency F2 and delta D1: the receipt commits, then the
  // process dies before the alert. The marker committed WITH the receipt, so
  // the retry finds it owed and re-sends once; a later replay stays quiet.
  for (const [label, card, history, kind] of [
    ["a card-settled booking", { ...CARD_PRIMARY, refundedAmountCents: 27000 }, [], "cancelledAfterCard"],
    [
      "a #1765 booking whose card was refunded before the switch",
      { ...CARD_PRIMARY, refundedAmountCents: 27000 },
      [{ paymentTransactionId: "card-row" }],
      "cancelledAfterRefund",
    ],
  ] as const) {
    it(`re-sends the alert once on the retry after a crash between commit and alert, for ${label}`, async () => {
      const switchedAt = new Date("2026-07-10T00:00:00.000Z");
      primePayment(
        switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
      );
      mocks.paymentTransactionFindMany.mockResolvedValue([card]);
      mocks.paymentRefundFindMany.mockResolvedValue([...history]);
      // Delivery 1: the bank cash is new.
      mocks.paymentTransactionFindFirst.mockImplementation(
        async ({ orderBy }: { orderBy?: unknown }) =>
          orderBy ? { createdAt: switchedAt } : null
      );
      // The process dies after the commit, before the alert (the throwing
      // error log stands in for the kill; it runs right after the commit).
      mocks.error.mockImplementationOnce(() => {
        throw new Error("process killed");
      });
      await expect(sync()).rejects.toThrow("process killed");
      expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalled();
      expect(markerRows).toHaveLength(1);
      expect(markerRows[0].snapshot).toMatchObject({
        conflictKind: kind,
        alertSentAt: null,
      });
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();

      // Delivery 2, the retry: the receipt is on file, the marker is owed.
      mocks.paymentTransactionFindFirst.mockImplementation(
        async ({ orderBy }: { orderBy?: unknown }) =>
          orderBy ? { createdAt: switchedAt } : { id: "ib-primary" }
      );
      const retry = await sync();

      expect(retry.secondInstrumentSettlementConflicts).toBe(1);
      expect(markerRows).toHaveLength(1);
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).toHaveBeenCalledTimes(1);
      expect(
        mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
      ).toMatchObject({ conflictKind: kind, cardPaymentIntentId: "pi_card_3638" });
      expect(markerRows[0].snapshot.alertSentAt).toEqual(expect.any(String));

      // Delivery 3: sent and recorded, so nothing more.
      const replay = await sync();
      expect(replay.secondInstrumentSettlementConflicts).toBe(0);
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).toHaveBeenCalledTimes(1);
    });
  }

  it("raises NEW bank cash on a cancelled #1765 booking, with the refund-history wording", async () => {
    // Repay-after-refund booking switched to Internet Banking and cancelled
    // BEFORE it was repaid; the member then pays the stale invoice. The card
    // was refunded before the switch, but this bank cash is new and has
    // nowhere to go (the credit-mint arm mints only for a payment that never
    // settled), so it is raised — and says the card was refunded, not that
    // the cancellation settled it (delta D3).
    const switchedAt = new Date("2026-07-10T00:00:00.000Z");
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockImplementation(
      async ({ orderBy }: { orderBy?: unknown }) =>
        orderBy ? { createdAt: switchedAt } : null
    );
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { ...CARD_PRIMARY, refundedAmountCents: 27000 },
    ]);
    mocks.paymentRefundFindMany.mockResolvedValue([{ paymentTransactionId: "card-row" }]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.paymentRefundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentTransactionId: { in: ["card-row"] },
          createdAt: { lt: switchedAt },
        }),
      })
    );
    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({ conflictKind: "cancelledAfterRefund", cardHeldCents: 0 });
  });

  it("prefers a real card settlement over #1765 history when a cancelled booking has both", async () => {
    const switchedAt = new Date("2026-07-10T00:00:00.000Z");
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED })
    );
    mocks.paymentTransactionFindFirst.mockImplementation(
      async ({ orderBy }: { orderBy?: unknown }) =>
        orderBy ? { createdAt: switchedAt } : null
    );
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { ...CARD_PRIMARY, id: "old-row", stripePaymentIntentId: "pi_old", refundedAmountCents: 27000 },
      { ...CARD_PRIMARY, id: "card-row", refundedAmountCents: 27000 },
    ]);
    mocks.paymentRefundFindMany.mockResolvedValue([{ paymentTransactionId: "old-row" }]);

    await sync();

    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({ conflictKind: "cancelledAfterCard", cardPaymentIntentId: "pi_card_3638" });
  });
});

/**
 * #3638 review (correctness F3): #1765's repay-after-refund booking is paid by
 * card, refunded in part, repriced back to PAYMENT_PENDING and — now that the
 * switch lets a refunded intent through — repaid by Internet Banking. The old
 * card row still holds net cash, but it is settled history, not a second
 * instrument: its refund was recorded before the booking moved to Internet
 * Banking. A refund recorded after the switch is somebody acting on a live
 * card payment, and is still raised.
 */
describe("#1765 refund history is not a second instrument (#3638)", () => {
  const switchedAt = new Date("2026-07-10T00:00:00.000Z");
  const partlyRefundedCard = {
    ...CARD_PRIMARY,
    amountCents: 27000,
    refundedAmountCents: 9000,
  };

  beforeEach(() => {
    mocks.paymentTransactionFindMany.mockResolvedValue([partlyRefundedCard]);
    mocks.paymentTransactionFindFirst.mockImplementation(
      async ({ orderBy }: { orderBy?: unknown }) =>
        orderBy ? { createdAt: switchedAt } : null
    );
  });

  it("settles a repay-after-partial-refund booking quietly when the refund predates the switch", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentRefundFindMany.mockResolvedValue([{ paymentTransactionId: "card-row" }]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(result.skippedAlreadyPaidBookings).toBe(1);
    expect(mocks.paymentRefundFindMany).toHaveBeenCalledWith({
      where: {
        paymentTransactionId: { in: ["card-row"] },
        createdAt: { lt: switchedAt },
        status: { notIn: ["failed", "canceled"] },
      },
      select: { paymentTransactionId: true },
    });
    expect(mocks.txBookingEventCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });

  it("still raises a card payment refunded in part after the switch", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentRefundFindMany.mockResolvedValue([]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
  });

  it("never asks about refunds for a card row that has none", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([CARD_PRIMARY]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.paymentRefundFindMany).not.toHaveBeenCalled();
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
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
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
    expect(mocks.txBookingEventCreate).not.toHaveBeenCalled();
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

  // #3638 review (SSOT F3): the kind predicate and the DB reason filter were
  // two hand-kept lists. Both now derive from SETTLEMENT_MARKERS; this walks
  // the module's exports so a fourth marker kind declared without a registry
  // entry fails here rather than leaking into the narrative as a cancellation.
  it("derives the kind test and the reason filter from one registry that names every marker kind", () => {
    const declaredKinds = Object.entries(settlementMarkerModule)
      .filter(([name]) => name.endsWith("_EVENT_KIND"))
      .map(([, value]) => value);
    expect(declaredKinds.length).toBeGreaterThanOrEqual(3);
    expect(SETTLEMENT_MARKERS.map((marker) => marker.kind).sort()).toEqual(
      [...declaredKinds].sort(),
    );
    for (const marker of SETTLEMENT_MARKERS) {
      expect(
        isManualSettlementMarkerEvent({
          type: BookingEventType.CANCELLED,
          snapshot: { kind: marker.kind },
        }),
      ).toBe(true);
      expect(SETTLEMENT_MARKER_EVENT_REASONS).toContain(marker.reason);
    }
    expect(SETTLEMENT_MARKER_EVENT_REASONS).toHaveLength(SETTLEMENT_MARKERS.length);
    // Membership is a CANCELLED event's snapshot kind, never the kind alone.
    expect(
      isManualSettlementMarkerEvent({
        type: BookingEventType.REFUNDED,
        snapshot: { kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND },
      }),
    ).toBe(false);
  });

  // #3638 review (SSOT F9): the staff timeline's entries come from the same
  // registry, titled for staff, with the reason the event row stores.
  it("maps every marker, and only markers, to a staff timeline entry", () => {
    const occurredAt = new Date("2026-08-04T00:00:00.000Z");
    const entries = settlementMarkerTimelineEntries([
      {
        id: "ev-second",
        type: BookingEventType.CANCELLED,
        occurredAt,
        amountCents: 27000,
        reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
        snapshot: {
          kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
          invoiceNumber: "INV-3638",
        },
      },
      {
        id: "ev-reversal",
        type: BookingEventType.CANCELLED,
        occurredAt,
        amountCents: null,
        reason: null,
        snapshot: { kind: MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND },
      },
      {
        id: "ev-genuine-cancel",
        type: BookingEventType.CANCELLED,
        occurredAt,
        amountCents: 0,
        reason: "Cancelled by member",
        snapshot: { policySummary: "Full refund" },
      },
    ]);

    expect(entries).toEqual([
      {
        id: "ev-second",
        occurredAt,
        amountCents: 27000,
        title: "May have been paid twice (card and Xero)",
        detail: `${SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON} Xero invoice INV-3638.`,
        tone: "danger",
      },
      {
        id: "ev-reversal",
        occurredAt,
        amountCents: null,
        title: "Manual payment reversed",
        // No stored reason: the registry's own.
        detail: SETTLEMENT_MARKERS[0].reason,
        tone: "warning",
      },
    ]);
  });
});

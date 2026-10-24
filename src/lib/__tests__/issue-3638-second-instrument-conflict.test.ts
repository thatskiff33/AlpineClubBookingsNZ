import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventType,
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
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
  // #3979: the settle's read of the payment's own rows, kept apart from the
  // second-instrument question above so each test's answer to that question
  // stays its own.
  settleRowsFindMany: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  // #4177: the superseded-intent machinery's live operations on the payment.
  supersededOperationFindMany: vi.fn(),
  ownershipPaymentFindUnique: vi.fn(),
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
import { duplicateCaptureRefundOperationWhere } from "@/lib/duplicate-capture-ownership";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { IB_RECEIPT_FROM_CASH_REASON } from "@/lib/xero-inbound/settle-from-cash";
import {
  isPaymentRecoveryOperationInFlight,
  PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
} from "@/lib/payment-recovery-constants";
import {
  buildBookingModificationRefundRecoveryIdempotencyKey,
  nextRefusedRefundKeySuffix,
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";

const INVOICE_ID = "inv-xero-3638";

const tx = {
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  payment: {
    // #4221: the superseded-intent ownership read asks for the payment as the
    // owed figure reads it (its card refund rows and recorded refunds).
    findUnique: (...a: unknown[]) =>
      (a[0] as { select?: { recoveryOperations?: unknown } } | undefined)?.select?.recoveryOperations === undefined
        ? mocks.paymentFindUnique(...a)
        : mocks.ownershipPaymentFindUnique(...a),
    update: (...a: unknown[]) => mocks.paymentUpdate(...a),
  },
  // #3979: the receipt figure's cross-check reads the booking's supplementary
  // invoices; none here.
  bookingModification: { findMany: async () => [] },
  paymentTransaction: {
    updateMany: (...a: unknown[]) => mocks.paymentTransactionUpdateMany(...a),
    findMany: (...a: unknown[]) =>
      (a[0] as { where?: { kind?: unknown } } | undefined)?.where?.kind === undefined
        ? mocks.settleRowsFindMany(...a)
        : mocks.paymentTransactionFindMany(...a),
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
    // The duplicate-capture refund lookup asks by idempotency key; the
    // superseded-intent ownership read (#4177) asks by payment, type and status.
    findMany: (...a: unknown[]) =>
      (a[0] as { where?: { idempotencyKey?: unknown } } | undefined)?.where?.idempotencyKey === undefined
        ? mocks.supersededOperationFindMany(...a)
        : mocks.paymentRecoveryOperationFindMany(...a),
  },
  paymentRefund: {
    findMany: (...a: unknown[]) => mocks.paymentRefundFindMany(...a),
  },
  // #3535's clearing-note evidence, read by the already-cancelled credit arm
  // these bookings fall through to: no clearing note on file.
  xeroObjectLink: { findFirst: vi.fn().mockResolvedValue(null), findMany: async () => [] },
  xeroSyncOperation: {
    findFirst: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
  // The bank receipt this suite's switched payment already carries (#3979):
  // a replay, so the settle decides no figure again.
  mocks.settleRowsFindMany.mockResolvedValue([
    {
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.INTERNET_BANKING,
      status: PaymentStatus.SUCCEEDED,
      amountCents: 27000,
      refundedAmountCents: 0,
    },
  ]);
  // No captured Internet Banking row yet: this bank cash is new.
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.supersededOperationFindMany.mockResolvedValue([]);
  mocks.ownershipPaymentFindUnique.mockResolvedValue(null);
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
      // #3792: the lodge key is taken once, at the top of the reconcile, before
      // the member key and the receipt's Payment write (INV-LOCK-002); this arm
      // still claims nothing (no booking update above).
      expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledTimes(1);

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

  it("#4211: the bank receipt that settles the booking is recorded as its settler", async () => {
    primePayment(switchedPayment(BookingStatus.CONFIRMED));
    mocks.paymentTransactionFindMany.mockImplementation(async (args: { where?: { source?: unknown } }) =>
      args.where?.source === PaymentSource.INTERNET_BANKING ? [{ id: "bank-row" }] : [],
    );

    await sync();

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { settledByTransactionId: "bank-row" },
    });
  });

  it("a booking still awaiting payment never runs the test", async () => {
    primePayment(switchedPayment(BookingStatus.CONFIRMED));
    mocks.paymentFindUnique.mockResolvedValue(
      switchedPayment(BookingStatus.CONFIRMED)
    );

    await sync();

    // #4211: the settle reads its own bank receipt's row to record it as the
    // settler; the second-instrument read (any non-bank row) never runs.
    expect(
      mocks.paymentTransactionFindMany.mock.calls.filter(
        ([args]) => (args as { where?: { source?: unknown } }).where?.source !== PaymentSource.INTERNET_BANKING,
      ),
    ).toEqual([]);
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

  it("#4211: a recorded settler with #1765 history still ranks after a real card settlement on a cancelled booking", async () => {
    const switchedAt = new Date("2026-07-10T00:00:00.000Z");
    primePayment(
      switchedPayment(BookingStatus.CANCELLED, { status: PaymentStatus.REFUNDED, settledByTransactionId: "old-row" })
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
    // #4211: the one reading guard (c) of the duplicate-capture refund uses.
    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith({
      where: duplicateCaptureRefundOperationWhere("booking-1"),
      select: { idempotencyKey: true },
    });
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
  });
});

/**
 * #4163 (`INV-PAY-133`): two card captures both qualify, and the one the
 * conflict names is the settling capture - the OLDEST-INSERTED one no
 * duplicate-capture refund owns (#1765 refund history aside: skipped on a
 * paid booking, ranked last on a cancelled one). The mock answers like the database: it
 * honours the read's `orderBy`, so a read without the shared ledger order
 * hands back the rows as seeded (newest first) and names the later capture.
 */
describe("the settling capture follows the shared ledger order (#4163)", () => {
  const FIRST_CAPTURE = {
    ...CARD_PRIMARY,
    id: "first-capture",
    stripePaymentIntentId: "pi_first_4163",
    amountCents: 27000,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    insertionSeq: 1,
  };
  // Same createdAt (one transaction): only insertionSeq tells them apart.
  const SECOND_CAPTURE = {
    ...CARD_PRIMARY,
    id: "second-capture",
    stripePaymentIntentId: "pi_second_4163",
    amountCents: 31000,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    insertionSeq: 2,
  };

  function answerLikeTheDatabase(rows: (typeof FIRST_CAPTURE)[]) {
    mocks.paymentTransactionFindMany.mockImplementation(
      async ({ orderBy }: { orderBy?: Record<string, "asc" | "desc">[] }) => {
        const sorted = [...rows];
        for (const key of [...(orderBy ?? [])].reverse()) {
          const [[field, direction]] = Object.entries(key) as [
            ["createdAt" | "insertionSeq", "asc" | "desc"],
          ];
          const sign = direction === "asc" ? 1 : -1;
          sorted.sort(
            (a, b) =>
              sign *
              (field === "createdAt"
                ? a.createdAt.getTime() - b.createdAt.getTime()
                : a.insertionSeq - b.insertionSeq),
          );
        }
        return sorted;
      },
    );
  }

  it("names the oldest-inserted capture when two qualify, whatever order the rows come back in", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    // Seeded newest first: the "wrong" order for the `.find()`.
    answerLikeTheDatabase([SECOND_CAPTURE, FIRST_CAPTURE]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { insertionSeq: "asc" }],
      }),
    );
    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({
      cardPaymentIntentId: "pi_first_4163",
      cardHeldCents: 27000,
    });
  });

  it("#4211: names the settler the card's PAID claim recorded, over an older capture", async () => {
    primePayment(switchedPayment(BookingStatus.PAID, { settledByTransactionId: "second-capture" }));
    answerLikeTheDatabase([SECOND_CAPTURE, FIRST_CAPTURE]);

    await sync();

    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({
      cardPaymentIntentId: "pi_second_4163",
      cardHeldCents: 31000,
    });
  });

  it("skips an older capture the duplicate-capture refund owns and names the next oldest", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    answerLikeTheDatabase([SECOND_CAPTURE, FIRST_CAPTURE]);
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      { idempotencyKey: "duplicate_capture_booking-1_pi_first_4163" },
    ]);

    await sync();

    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({
      cardPaymentIntentId: "pi_second_4163",
      cardHeldCents: 31000,
    });
  });
});

/**
 * #4177: on a PAID booking, an older capture X whose captured money the
 * superseded-intent machinery holds for the member (a REFUND_SUPERSEDED_PAYMENT
 * not yet SUCCEEDED, or a CANCEL_PAYMENT_INTENT still in flight) is not the
 * settling capture: the duplicate-capture refund skips it too, so the conflict
 * names S, never X. A dead cancel holds nothing, so X still counts; and on a
 * CANCELLED booking every capture counts, because the new bank cash has nowhere
 * to go. The fake answers the read with the predicate's own semantics.
 */
describe("the settling capture skips one the superseded-intent machinery holds, on a paid booking (#4177)", () => {
  const X = {
    ...CARD_PRIMARY,
    id: "superseded-capture",
    stripePaymentIntentId: "pi_superseded_4177",
    amountCents: 27000,
  };
  const S = {
    ...CARD_PRIMARY,
    id: "settling-capture",
    stripePaymentIntentId: "pi_settling_4177",
    amountCents: 31000,
  };

  type Operation = {
    id: string;
    paymentId: string;
    paymentIntentId: string;
    paymentTransactionId: string | null;
    idempotencyKey: string;
    amountCents: number;
    allocationPlan: unknown;
    type: PaymentRecoveryOperationType;
    status: PaymentRecoveryOperationStatus;
    attempts: number;
    nextRetryAt: Date | null;
    createdAt: Date;
    succeededAt: Date | null;
  };

  /** When the ops are raised, a minute apart; refunds Stripe makes later come after every one. */
  const RAISED_FROM = new Date("2026-06-01T00:00:00.000Z").getTime();
  const LATER = new Date("2026-06-02T00:00:00.000Z");
  const RETRY_AT = new Date("2026-07-02T00:00:00.000Z");
  let opSeq = 0;
  const op = (type: PaymentRecoveryOperationType, overrides: Partial<Operation> = {}): Operation => {
    opSeq += 1;
    return {
      id: `op-${opSeq}`,
      paymentId: "payment-1",
      paymentIntentId: X.stripePaymentIntentId,
      paymentTransactionId: X.id,
      idempotencyKey: `recovery-key-${opSeq}`,
      amountCents: X.amountCents,
      allocationPlan: null,
      type,
      status: PaymentRecoveryOperationStatus.PENDING,
      attempts: 0,
      nextRetryAt: RETRY_AT,
      createdAt: new Date(RAISED_FROM + opSeq * 60_000),
      succeededAt: null,
      ...overrides,
    };
  };

  /** The read `listSupersededIntentIdsOwningCaptures` sends, pinned whole. */
  const EXPECTED_READ = {
    where: {
      paymentId: "payment-1",
      OR: [
        { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
        {
          idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX),
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        {
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
          type: {
            in: [
              PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
              PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
            ],
          },
        },
        {
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE],
        },
      ],
    },
    select: {
      id: true,
      type: true,
      status: true,
      paymentIntentId: true,
      paymentTransactionId: true,
      idempotencyKey: true,
    },
  };

  /** The payment as the owed figure reads it (#4221), pinned whole. */
  const EXPECTED_PAYMENT_READ = {
    where: { id: "payment-1" },
    select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
  };

  type RecordedRefund = { stripeRefundId: string; paymentTransactionId: string; amountCents: number; status: string; createdAt: Date };

  /**
   * Answers like the database: every superseded refund op, an open row under
   * the failed-later key prefix, an open card refund row, and a cancel op in
   * flight.
   */
  function ownedBy(operations: Operation[], refunds: RecordedRefund[] = []) {
    mocks.ownershipPaymentFindUnique.mockImplementation(async (args: unknown) => {
      expect(args).toEqual(EXPECTED_PAYMENT_READ);
      return {
        status: "PAID",
        amountCents: 0,
        refundedAmountCents: 0,
        recoveryOperations: operations
          .filter((operation) =>
            [PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT].includes(
              operation.type as never,
            ),
          )
          .map(({ id, type, status, idempotencyKey, amountCents, allocationPlan, paymentTransactionId, createdAt, succeededAt }) => ({
            id,
            type,
            status,
            idempotencyKey,
            amountCents,
            allocationPlan,
            paymentTransactionId,
            createdAt,
            succeededAt: succeededAt ?? (status === PaymentRecoveryOperationStatus.SUCCEEDED ? new Date(createdAt.getTime() + 30_000) : null),
          })),
        refunds: refunds.map((refund) => ({ ...refund, stripeCreatedAt: null })),
      };
    });
    mocks.supersededOperationFindMany.mockImplementation(async (args: unknown) => {
      expect(args).toEqual(EXPECTED_READ);
      return operations
        .filter(
          (operation) =>
            operation.paymentId === "payment-1" &&
            (operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT ||
              (operation.idempotencyKey.startsWith(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX) &&
                operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED) ||
              (operation.type === PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION &&
                operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED) ||
              (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT &&
                isPaymentRecoveryOperationInFlight(operation))),
        )
        .map(({ id, type, status, paymentIntentId, paymentTransactionId, idempotencyKey }) => ({
          id,
          type,
          status,
          paymentIntentId,
          paymentTransactionId,
          idempotencyKey,
        }));
    });
  }

  function alertedIntent() {
    return mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0].cardPaymentIntentId;
  }

  it.each([
    ["a REFUND_SUPERSEDED_PAYMENT still retrying", op(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, { status: PaymentRecoveryOperationStatus.FAILED })],
    ["a REFUND_SUPERSEDED_PAYMENT whose retries are spent", op(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, { status: PaymentRecoveryOperationStatus.FAILED, attempts: 5, nextRetryAt: null })],
    ["a CANCEL_PAYMENT_INTENT waiting to run", op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT)],
    ["a CANCEL_PAYMENT_INTENT being run", op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, { status: PaymentRecoveryOperationStatus.PROCESSING })],
    ["a CANCEL_PAYMENT_INTENT that failed and will retry", op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, { status: PaymentRecoveryOperationStatus.FAILED, attempts: 2 })],
  ])("paid: names S, not the older X %s holds", async (_label, operation) => {
    primePayment(switchedPayment(BookingStatus.PAID));
    // Oldest first, as the ordered read returns them: X, then S.
    mocks.paymentTransactionFindMany.mockResolvedValue([X, S]);
    ownedBy([operation]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.supersededOperationFindMany).toHaveBeenCalledTimes(1);
    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({ cardPaymentIntentId: S.stripePaymentIntentId, cardHeldCents: 31000 });
  });

  it.each([
    ["its superseded refund SUCCEEDED", op(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, { status: PaymentRecoveryOperationStatus.SUCCEEDED })],
    ["its cancel died with no refund behind it (retries spent)", op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, { status: PaymentRecoveryOperationStatus.FAILED, attempts: 5, nextRetryAt: null })],
    ["its cancel was raised dead (PENDING, retries spent)", op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, { attempts: 5 })],
  ])("paid: still names X once %s: nothing holds its money for the member", async (_label, operation) => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([X, S]);
    ownedBy([operation]);

    await sync();

    expect(alertedIntent()).toBe(X.stripePaymentIntentId);
  });

  it("paid: raises nothing when the only card capture is one the machinery holds for the member, and records the receipt at the cash", async () => {
    primePayment(switchedPayment(BookingStatus.PAID));
    mocks.paymentTransactionFindMany.mockResolvedValue([X]);
    ownedBy([op(PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT)]);
    // The transition: the bank receipt is not captured yet, and its stored
    // figure (300.00) differs from the invoice's cash (270.00).
    mocks.settleRowsFindMany.mockResolvedValue([
      {
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: PaymentStatus.PENDING,
        amountCents: 30000,
        refundedAmountCents: 0,
      },
      {
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.STRIPE,
        status: PaymentStatus.SUCCEEDED,
        amountCents: X.amountCents,
        refundedAmountCents: 0,
      },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(0);
    expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
    // No second instrument, so the settle records the receipt at the cash
    // (INV-PAY-125), and the payment's figure is the cash plus X until X's
    // refund is recorded.
    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: PaymentSource.INTERNET_BANKING, kind: PaymentTransactionKind.PRIMARY }),
        data: expect.objectContaining({
          status: PaymentStatus.SUCCEEDED,
          amountCents: 27000,
          reason: IB_RECEIPT_FROM_CASH_REASON,
        }),
      }),
    );
    expect(mocks.paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 27000 + X.amountCents, refundedAmountCents: 0 }),
      }),
    );
  });

  /**
   * #4221: X's superseded refund SUCCEEDED (Stripe accepted it), so any cash X
   * holds again came back from a refund Stripe failed later, and the
   * failed-later row (#4104) raised for that failure, on X's own intent, owes
   * it back. While that row is open - re-sent automatically, or dead for the
   * treasurer - X's money is on its way back to the member, whichever door
   * sent the refund that failed.
   */
  describe("a capture owed back again after its superseded refund (#4221)", () => {
    const supersededRefund = () =>
      op(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        attempts: 1,
        nextRetryAt: null,
      });
    /**
     * A failed-later row as `keepFailedLaterCardRefundOwed` raises it: on the
     * failed refund's own intent (X unless overridden), no transaction column,
     * one slice recording who made the refund.
     */
    const failedLater = (
      refundId: string,
      slice: { paymentTransactionId?: string; madeByOperationId?: string | null },
      overrides: Partial<Operation> = {},
    ) => {
      const amountCents = overrides.amountCents ?? X.amountCents;
      return op(PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, {
        idempotencyKey: `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}${refundId}`,
        paymentTransactionId: null,
        allocationPlan: [{ paymentTransactionId: slice.paymentTransactionId ?? X.id, amountCents, ...slice }],
        ...overrides,
      });
    };
    /** Another door's refund on X (an edit's or a cancel's recovery row), not a superseded one. */
    const otherDoorRefund = () =>
      op(PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        attempts: 1,
        nextRetryAt: null,
      });

    it.each([
      ["recorded as made by X's superseded refund", (refund: Operation) => [failedLater("re_4221_a", { madeByOperationId: refund.id })]],
      ["raised before #4166 (no maker recorded)", () => [failedLater("re_4221_b", {})]],
      ["whose maker could not be told apart (null)", () => [failedLater("re_4221_c", { madeByOperationId: null })]],
      [
        "dead for the treasurer (retries spent)",
        (refund: Operation) => [failedLater("re_4221_d", { madeByOperationId: refund.id }, { attempts: 5 })],
      ],
      [
        "whose re-sends failed and are spent",
        (refund: Operation) => [
          failedLater("re_4221_g", { madeByOperationId: refund.id }, {
            status: PaymentRecoveryOperationStatus.FAILED,
            attempts: 5,
            nextRetryAt: null,
          }),
        ],
      ],
      [
        "dead after a retry that failed later too, made by an earlier failed-later row now closed",
        (refund: Operation) => {
          const first = failedLater("re_4221_e1", { madeByOperationId: refund.id }, {
            status: PaymentRecoveryOperationStatus.SUCCEEDED,
          });
          return [first, failedLater("re_4221_e2", { madeByOperationId: first.id }, { attempts: 5 })];
        },
      ],
      ["recorded as made by another door's refund", () => [failedLater("re_4221_other_door", { madeByOperationId: "an-edit-refund-row" })]],
      [
        // The money lens's F2: the superseded refund succeeded for good, and
        // another door's refund on X failed later. X holds that cash again.
        "for another door's refund on X that failed later, after the superseded refund succeeded",
        () => {
          const edit = otherDoorRefund();
          return [edit, failedLater("re_4221_f2", { madeByOperationId: edit.id })];
        },
      ],
    ])("paid: names S, not X, while an open failed-later row on X %s asks again", async (_label, rows) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X, S]);
      const refund = supersededRefund();
      ownedBy([refund, ...rows(refund)]);

      await sync();

      expect(mocks.supersededOperationFindMany).toHaveBeenCalledTimes(1);
      expect(alertedIntent()).toBe(S.stripePaymentIntentId);
    });

    it("paid: raises nothing when X is the only card capture and its failed-later row is open", async () => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X]);
      const refund = supersededRefund();
      ownedBy([refund, failedLater("re_4221_only", { madeByOperationId: refund.id })]);

      const result = await sync();

      expect(result.secondInstrumentSettlementConflicts).toBe(0);
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
    });

    it.each([
      [
        "its failed-later row is closed (made again, or paid another way)",
        () => [
          supersededRefund(),
          failedLater("re_4221_closed", {}, { status: PaymentRecoveryOperationStatus.SUCCEEDED }),
        ],
      ],
      [
        // Keyed on the row's own intent: one on S says nothing about X.
        "the open failed-later row is on S's intent, not X's",
        () => [
          supersededRefund(),
          failedLater("re_4221_on_s", { paymentTransactionId: S.id }, { paymentIntentId: S.stripePaymentIntentId }),
        ],
      ],
      [
        // No superseded refund on X: an ordinary failed-later refund, not this machinery's.
        "no superseded refund exists on X",
        () => [otherDoorRefund(), failedLater("re_4221_no_superseded", {})],
      ],
    ])("paid: still names X when %s", async (_label, rows) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X, S]);
      ownedBy(rows());

      await sync();

      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });

    it("paid: still names S, the only capture, when its open failed-later row has no superseded refund behind it on S", async () => {
      // X, refunded in full, is no candidate; its superseded refund says
      // nothing about S, whose open failed-later row is an ordinary one.
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([S]);
      ownedBy([
        supersededRefund(),
        failedLater("re_4221_only_s", { paymentTransactionId: S.id }, { paymentIntentId: S.stripePaymentIntentId, amountCents: S.amountCents }),
      ]);

      await sync();

      expect(alertedIntent()).toBe(S.stripePaymentIntentId);
    });

    /**
     * The other door's path: an open edit or cancel refund row whose slice on
     * X made refund R before X's superseded refund took the rest. Stripe fails
     * R later, and `keepFailedLaterCardRefundOwed` re-plans that slice
     * (`failedRefundIds`, its next key) rather than raising a failed-later
     * row. X holds R's amount again, which the open row sends again.
     */
    const R_CENTS = 5000;
    const openDoorRow = (
      slices: Array<{ paymentTransactionId: string; failedRefundIds?: string[]; madeRefundId?: string }>,
      overrides: Partial<Operation> = {},
    ) =>
      op(PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, {
        idempotencyKey: buildBookingModificationRefundRecoveryIdempotencyKey("modification-4221"),
        paymentIntentId: S.stripePaymentIntentId,
        paymentTransactionId: null,
        allocationPlan: slices.map((slice) => ({ amountCents: R_CENTS, ...slice })),
        ...overrides,
      });
    const replannedOnX = { paymentTransactionId: X.id, stripeKeySuffix: nextRefusedRefundKeySuffix(undefined), failedRefundIds: ["re_4221_r"] };
    /** X after its superseded refund took the rest: it holds R's amount again, and no more. */
    const X_HOLDING_R = { ...X, refundedAmountCents: X.amountCents - R_CENTS };

    it.each([
      ["waiting to send it again", () => openDoorRow([replannedOnX])],
      ["beside a slice on S it already made", () => openDoorRow([{ paymentTransactionId: S.id, madeRefundId: "re_4221_s" }, replannedOnX])],
      ["failed and retrying", () => openDoorRow([replannedOnX], { status: PaymentRecoveryOperationStatus.FAILED, attempts: 2 })],
      ["dead for the treasurer (retries spent)", () => openDoorRow([replannedOnX], { attempts: 5 })],
    ])("paid: names S, not X, while an open refund row's slice on X that failed later is %s", async (_label, row) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_R, S]);
      ownedBy([supersededRefund(), row()]);

      await sync();

      expect(mocks.supersededOperationFindMany).toHaveBeenCalledTimes(1);
      expect(alertedIntent()).toBe(S.stripePaymentIntentId);
    });

    it("paid: raises nothing when X is the only card capture and an open row re-plans its slice on X", async () => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_R]);
      ownedBy([supersededRefund(), openDoorRow([replannedOnX])]);

      const result = await sync();

      expect(result.secondInstrumentSettlementConflicts).toBe(0);
      expect(mocks.sendAdminSecondInstrumentSettlementConflictAlert).not.toHaveBeenCalled();
    });

    it.each([
      ["the row is closed (made again, or paid another way)", () => [supersededRefund(), openDoorRow([replannedOnX], { status: PaymentRecoveryOperationStatus.SUCCEEDED })]],
      ["the re-planned slice was made again", () => [supersededRefund(), openDoorRow([{ ...replannedOnX, madeRefundId: "re_4221_r2" }])]],
      ["its slice on X never failed", () => [supersededRefund(), openDoorRow([{ paymentTransactionId: X.id }])]],
      ["the re-planned slice is on S, not X", () => [supersededRefund(), openDoorRow([{ ...replannedOnX, paymentTransactionId: S.id }])]],
      ["no superseded refund exists on X", () => [otherDoorRefund(), openDoorRow([replannedOnX])]],
      [
        "the superseded refund on X names no transaction",
        () => [{ ...supersededRefund(), paymentTransactionId: null }, openDoorRow([replannedOnX])],
      ],
    ])("paid: still names X when %s", async (_label, rows) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_R, S]);
      ownedBy(rows());

      await sync();

      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });
    /**
     * #4221 round 5: a re-send already recorded owes nothing, whether its row
     * has closed yet or not. X holds 3000 again only because a refund made by
     * hand in Stripe (`re_a`, not re-sent) failed later too: owed by nothing.
     */
    const HELD_UNOWED = 3000;
    const X_HOLDING_UNOWED = { ...X, refundedAmountCents: X.amountCents - HELD_UNOWED };
    const RESENT = X.amountCents - HELD_UNOWED;
    const failedRefunds: RecordedRefund[] = [
      { stripeRefundId: "re_4221_a", paymentTransactionId: X.id, amountCents: HELD_UNOWED, status: "failed", createdAt: LATER },
      { stripeRefundId: "re_4221_s", paymentTransactionId: X.id, amountCents: RESENT, status: "failed", createdAt: LATER },
    ];
    const resend = (stripeRefundId: string, amountCents = RESENT): RecordedRefund => ({
      stripeRefundId,
      paymentTransactionId: X.id,
      amountCents,
      status: "succeeded",
      createdAt: new Date(LATER.getTime() + 60_000),
    });

    it.each([
      [
        "its failed-later row's re-send is recorded but the row has not closed (a worker that crashed before its close)",
        () => failedLater("re_4221_s", {}, { amountCents: RESENT, status: PaymentRecoveryOperationStatus.PROCESSING }),
        "re_4221_resent",
      ],
      [
        "its dead failed-later row was paid by a refund in the Stripe dashboard, which never closes it",
        () => failedLater("re_4221_s", {}, { amountCents: RESENT, attempts: 5 }),
        "re_4221_dashboard",
      ],
    ])("paid: names X, holding cash nothing owes back, when %s", async (_label, row, resentId) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_UNOWED, S]);
      ownedBy([{ ...supersededRefund(), amountCents: RESENT }, row()], [...failedRefunds, resend(resentId)]);

      await sync();

      expect(mocks.ownershipPaymentFindUnique).toHaveBeenCalledTimes(1);
      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });

    it("paid: names X when an open row's re-planned slice on X is re-sent and recorded, and X holds cash nothing owes back", async () => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_UNOWED, S]);
      ownedBy([supersededRefund(), openDoorRow([replannedOnX])], [resend("re_4221_slice_again", R_CENTS)]);

      await sync();

      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });

    it("paid: still names X when its superseded refund closed after re-sending a re-planned slice of its own plan", async () => {
      // #4103 gives a refused superseded refund a one-slice plan, and #4104
      // re-plans it when Stripe fails it later; a clean re-send then closes
      // the row SUCCEEDED with that slice still in its plan. Closed, it owes
      // nothing, so whatever X holds now is held by nothing.
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_R, S]);
      ownedBy([{ ...supersededRefund(), amountCents: R_CENTS, allocationPlan: [{ ...replannedOnX, amountCents: R_CENTS }] }]);

      await sync();

      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });

    /** X holding more than open rows owe back: a refund no row re-sends (made by hand in Stripe) failed later too. */
    const X_HOLDING_MORE = { ...X, refundedAmountCents: X.amountCents - 3 * R_CENTS };

    it.each([
      ["a re-planned slice owes back only part of it", () => [supersededRefund(), openDoorRow([replannedOnX])]],
      ["a failed-later row owes back only part of it", () => [supersededRefund(), failedLater("re_4221_part", {}, { amountCents: 2 * R_CENTS })]],
      [
        "a slice made again leaves the rest owed by nothing",
        () => [supersededRefund(), openDoorRow([replannedOnX, replannedOnX, { ...replannedOnX, madeRefundId: "re_4221_again" }])],
      ],
    ])("paid: still names X when %s", async (_label, rows) => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_MORE, S]);
      ownedBy(rows());

      await sync();

      expect(alertedIntent()).toBe(X.stripePaymentIntentId);
    });

    it("paid: names S when open rows together owe back all X holds: re-planned slices and a failed-later row", async () => {
      primePayment(switchedPayment(BookingStatus.PAID));
      mocks.paymentTransactionFindMany.mockResolvedValue([X_HOLDING_MORE, S]);
      ownedBy([supersededRefund(), openDoorRow([replannedOnX]), failedLater("re_4221_rest", {}, { amountCents: 2 * R_CENTS })]);

      await sync();

      expect(alertedIntent()).toBe(S.stripePaymentIntentId);
    });
  });

  it.each([
    PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
    PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
  ])(
    "cancelled: the bank cash has nowhere to go, so X, held by a live %s, is still the cancelledAfterCard conflict",
    async (type) => {
      primePayment(switchedPayment(BookingStatus.CANCELLED));
      mocks.paymentTransactionFindMany.mockResolvedValue([X]);
      ownedBy([op(type)]);

      const result = await sync();

      expect(result.secondInstrumentSettlementConflicts).toBe(1);
      expect(mocks.supersededOperationFindMany).not.toHaveBeenCalled();
      expect(markerRows).toEqual([
        expect.objectContaining({
          snapshot: expect.objectContaining({ conflictKind: "cancelledAfterCard" }),
        }),
      ]);
      expect(
        mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
      ).toMatchObject({ conflictKind: "cancelledAfterCard", cardPaymentIntentId: X.stripePaymentIntentId });
    },
  );

  // #4211: the duplicate-capture refund's ownership counts on a cancelled
  // booking too, unlike the superseded machinery's: that capture is going back
  // to the member under its own refund, so it is never the card side.
  it("cancelled: skips an older capture a duplicate-capture refund owns and names the next oldest", async () => {
    primePayment(switchedPayment(BookingStatus.CANCELLED));
    mocks.paymentTransactionFindMany.mockResolvedValue([X, S]);
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      { idempotencyKey: `duplicate_capture_booking-1_${X.stripePaymentIntentId}` },
    ]);

    const result = await sync();

    expect(result.secondInstrumentSettlementConflicts).toBe(1);
    expect(mocks.supersededOperationFindMany).not.toHaveBeenCalled();
    expect(
      mocks.sendAdminSecondInstrumentSettlementConflictAlert.mock.calls[0][0],
    ).toMatchObject({ conflictKind: "cancelledAfterCard", cardPaymentIntentId: S.stripePaymentIntentId });
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
    // #3792: the lodge key once, at the reconcile's top; nothing is claimed.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledTimes(1);
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

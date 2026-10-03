import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  transaction: vi.fn(),
  txExecuteRaw: vi.fn(),
  txPaymentFindUnique: vi.fn(),
  txPaymentUpdate: vi.fn(),
  txBookingUpdate: vi.fn(),
  txMemberCreditAggregate: vi.fn(),
  txPaymentTransactionFindMany: vi.fn(),
  createAuditLog: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  revokePaymentLinksForBooking: vi.fn(),
  processWaitlistForDates: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  // #3535: still mocked so a regression back onto the cash-refund path is
  // visible (it is asserted never called), not a TypeError on an absent export.
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  findUnconvergedAppliedCreditDeallocation: vi.fn(),
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
  reconcileHostingReviewForSystemCancellation: vi.fn(),
  settleHostingCoverageAfterCommit: vi.fn(),
  // #3643: the payment-evidence seam. Default = nobody paid, so every
  // pre-#3643 test below still exercises the release it always did.
  readHoldPaymentEvidence: vi.fn(),
  hasRecordedInvoicePayment: vi.fn(),
  claimAlertCooldown: vi.fn(),
  releaseAlertCooldown: vi.fn(),
  deferAlertCooldown: vi.fn(),
  markAlertOwed: vi.fn(),
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  checkRateLimit: vi.fn(),
  paymentFindUnique: vi.fn(),
  sendAdminInternetBankingHoldKeptAlert: vi.fn(),
  sendAdminInternetBankingHoldStartedStayAlert: vi.fn(),
}));

// #3611: the cancellation's ledger lines are proved in booking-ledger-cancellation.test.ts and against PostgreSQL; here only the call is observed.
const cancellationLedger = vi.hoisted(() => ({ postCancellationLedgerLines: vi.fn<(input: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/booking-ledger-cancellation-sync", () => cancellationLedger);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mocks.paymentFindMany,
      findUnique: mocks.paymentFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/adult-member-hosting-system-cancellation", () => ({
  reconcileHostingReviewForSystemCancellation:
    mocks.reconcileHostingReviewForSystemCancellation,
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverageAfterCommit,
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocationsForBooking,
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
  sendAdminInternetBankingHoldKeptAlert:
    mocks.sendAdminInternetBankingHoldKeptAlert,
  sendAdminInternetBankingHoldStartedStayAlert: mocks.sendAdminInternetBankingHoldStartedStayAlert,
}));

vi.mock("@/lib/internet-banking-hold-payment-evidence", () => ({
  readHoldPaymentEvidence: mocks.readHoldPaymentEvidence,
  hasRecordedInvoicePayment: mocks.hasRecordedInvoicePayment,
}));

// The claim store is mocked; the claim RULE (`sendAdminAlertOnceEver`, shared
// with #3672's mid-stay group alert) runs for real over it.
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 36_500 * 86_400_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 86_400_000,
  claimAlertCooldown: mocks.claimAlertCooldown,
  releaseAlertCooldown: mocks.releaseAlertCooldown,
  deferAlertCooldown: mocks.deferAlertCooldown,
  markAlertOwed: mocks.markAlertOwed,
  listOwedAlertKeys: mocks.listOwedAlertKeys,
  noteOwedAlertAttempt: mocks.noteOwedAlertAttempt,
  settleOwedAlert: mocks.settleOwedAlert,
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

// #3663: the started-stay rule reads the club's day in the club's zone.
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/member-credit", () => ({
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinksForBooking,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroModificationCreditNoteOperation:
    mocks.enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  findUnconvergedAppliedCreditDeallocation:
    mocks.findUnconvergedAppliedCreditDeallocation,
}));

vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking:
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
}));

import { releaseExpiredInternetBankingHolds } from "@/lib/internet-banking-payment-cron";
import { decideExpiredHold } from "@/lib/internet-banking-hold-kept";

const NOW = new Date("2026-07-06T08:00:00Z");

// #3643: runs before every describe's own beforeEach (whose clearAllMocks
// keeps implementations), so the whole file defaults to "nobody paid".
beforeEach(() => {
  mocks.readHoldPaymentEvidence.mockResolvedValue({
    kind: "unpaid",
    readStartedAt: new Date("2026-07-06T07:59:00Z"),
    invoices: [],
  });
  mocks.hasRecordedInvoicePayment.mockResolvedValue(false);
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValue("sent");
  mocks.releaseAlertCooldown.mockResolvedValue(undefined);
  mocks.markAlertOwed.mockResolvedValue(undefined);
  mocks.listOwedAlertKeys.mockResolvedValue([]);
  mocks.settleOwedAlert.mockResolvedValue(undefined);
  mocks.noteOwedAlertAttempt.mockResolvedValue(undefined);
  mocks.deferAlertCooldown.mockResolvedValue(undefined);
  mocks.checkRateLimit.mockResolvedValue({ success: true });
});

/**
 * #3535: the note a released hold enqueues — the never-captured cancel path's
 * invoice-applied clearing note, anchored on the booking, told to say the
 * invoice was cleared because nobody paid it.
 */
function clearingNote(refundAmountCents: number) {
  return {
    bookingId: "booking_ib_1",
    refundAmountCents,
    clearsUnpaidInvoice: true,
  };
}

function makeExpiredPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_ib_1",
    bookingId: "booking_ib_1",
    // effectivePriceCents: finalPrice (15000) minus 2655 applied credit. The
    // clearing note is now sized off the invoice's FULL finalPrice, not this
    // credit-reduced figure (#1597).
    amountCents: 12345,
    changeFeeCents: 0,
    // The default fixture carries an issued invoice (the invoice-bearing shape),
    // so the durability tests exercise the enqueue path.
    xeroInvoiceId: "inv_ib_1",
    xeroInvoiceNumber: "INV-IB-001",
    status: "PENDING",
    source: "INTERNET_BANKING",
    internetBankingHoldSlots: true,
    internetBankingHoldUntil: new Date("2026-07-05T08:00:00Z"),
    internetBankingHoldReleasedAt: null,
    booking: {
      id: "booking_ib_1",
      memberId: "mem_1",
      status: "CONFIRMED",
      finalPriceCents: 15000,
      checkIn: new Date("2026-07-20"),
      checkOut: new Date("2026-07-22"),
      member: {
        email: "member@example.com",
        firstName: "Alice",
      },
      guests: [{ id: "guest_1", nights: [] }],
    },
    ...overrides,
  };
}

// #1357 (F17): the invoice-clearing credit note must be enqueued INSIDE the
// release transaction so the outbox row commits atomically with
// internetBankingHoldReleasedAt — a crash after the commit can no longer
// strand the open Xero invoice with no self-heal (re-runs skip released
// holds).
describe("releaseExpiredInternetBankingHolds credit-note durability (#1357)", () => {
  const txRef: { current: unknown } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    txRef.current = null;
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: {
            update: mocks.txBookingUpdate,
          },
          memberCreditNoteAllocation: {
            aggregate: mocks.txMemberCreditAggregate,
          },
          paymentTransaction: {
            findMany: mocks.txPaymentTransactionFindMany,
          },
        };
        txRef.current = tx;
        return callback(tx);
      },
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.revokePaymentLinksForBooking.mockResolvedValue(undefined);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    // #1547: default = no applied credit on the released booking.
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
    // #1597: default = no credit allocated to the invoice AS A XERO CREDIT NOTE,
    // so the clearing note is the full finalPrice.
    mocks.txMemberCreditAggregate.mockResolvedValue({
      _sum: { amountCents: 0 },
    });
    // #1597: default = no captured ledger row (never-captured hold).
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_note_1",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(
      undefined,
    );
    mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
    mocks.claimAlertCooldown.mockResolvedValue(true);
    mocks.releaseAlertCooldown.mockResolvedValue(undefined);
    mocks.deferAlertCooldown.mockResolvedValue(undefined);
    mocks.sendAdminInternetBankingHoldStartedStayAlert.mockResolvedValue(SENT_TO_ONE);
  });

  // `sendToAdmins`' result for one opted-in admin who was sent the alert.
  const SENT_TO_ONE = {
    deliveryAllowed: true,
    recipients: 1,
    sent: 1,
    queuedForRetry: 0,
    notDelivered: 0,
  };

  // #3663 (INV-PAY-016): NOW is 2026-07-06 20:00 in Pacific/Auckland, so the
  // club's today is 2026-07-06. A stay that has started is never cancelled.
  function withCheckIn(checkIn: string) {
    const payment = makeExpiredPayment({
      booking: { ...makeExpiredPayment().booking, checkIn: new Date(checkIn) },
    });
    mocks.paymentFindMany.mockResolvedValue([payment]);
    mocks.txPaymentFindUnique.mockResolvedValue(payment);
  }

  it.each([
    ["past", "2026-07-05"],
    ["today", "2026-07-06"],
  ])(
    "leaves an expired hold alone and alerts the treasurer once when check-in is %s",
    async (_label, checkIn) => {
      withCheckIn(checkIn);

      const result = await releaseExpiredInternetBankingHolds(NOW);

      expect(result).toMatchObject({ released: 0, skippedStarted: 1, skipped: 0 });
      expect(mocks.txBookingUpdate).not.toHaveBeenCalled();
      expect(mocks.txPaymentUpdate).not.toHaveBeenCalled();
      expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
      expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
        expect.objectContaining({ key: "internet-banking-hold-started-stay:pay_ib_1" }),
      );
      expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).toHaveBeenCalledTimes(1);
      expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).toHaveBeenCalledWith(
        {
          memberName: expect.stringContaining("Alice"),
          bookingId: "booking_ib_1",
          checkIn: new Date(checkIn),
          holdUntil: new Date("2026-07-05T08:00:00Z"),
          amountOwingCents: 12345,
        },
        expect.anything(),
      );
      // Delivered: the claim is kept for good.
      expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
      expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
    },
  );

  it("does not repeat the started-stay alert once another run holds the claim", async () => {
    withCheckIn("2026-07-05");
    mocks.claimAlertCooldown.mockResolvedValue(false);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.skippedStarted).toBe(1);
    expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).not.toHaveBeenCalled();
    // Another run's claim is never given back or moved.
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  // The claim follows what the send did, the same rule as #3672's alert.
  it("keeps the claim when the alert is queued for the email retry cron", async () => {
    withCheckIn("2026-07-05");
    mocks.sendAdminInternetBankingHoldStartedStayAlert.mockResolvedValue({
      ...SENT_TO_ONE,
      sent: 0,
      queuedForRetry: 1,
    });

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  it("holds the claim for a day when no admin can receive the alert", async () => {
    withCheckIn("2026-07-05");
    mocks.sendAdminInternetBankingHoldStartedStayAlert.mockResolvedValue({
      deliveryAllowed: true,
      recipients: 0,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 0,
    });

    await releaseExpiredInternetBankingHolds(NOW);

    const claim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith({
      key: "internet-banking-hold-started-stay:pay_ib_1",
      claimedAt: claim.now,
      windowMs: 36_500 * 86_400_000,
      retryAfterMs: 86_400_000,
    });
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("gives the claim back when the send throws, and the run carries on", async () => {
    withCheckIn("2026-07-05");
    mocks.sendAdminInternetBankingHoldStartedStayAlert.mockRejectedValue(
      new Error("mailer down"),
    );

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.skippedStarted).toBe(1);
    const claim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({
      key: "internet-banking-hold-started-stay:pay_ib_1",
      claimedAt: claim.now,
    });
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  it("still releases an expired hold whose check-in is tomorrow", async () => {
    withCheckIn("2026-07-07");

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ released: 1, skippedStarted: 0 });
    expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).not.toHaveBeenCalled();
  });

  it("judges 'started' by the club's day, not the UTC day", async () => {
    // 13:00 UTC on 6 July is 01:00 on 7 July in Auckland: check-in on the 7th
    // has started for the club although the UTC date is still the 6th.
    withCheckIn("2026-07-07");

    const result = await releaseExpiredInternetBankingHolds(
      new Date("2026-07-06T13:00:00Z"),
    );

    expect(result).toMatchObject({ released: 0, skippedStarted: 1 });
  });

  it("enqueues the invoice-clearing credit note through the release transaction client", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    // The enqueue received the SAME transaction client the release ran in —
    // the outbox row commits atomically with the hold release, not
    // post-commit fire-and-forget.
    expect(txRef.current).not.toBeNull();
    // #1597: sized off the invoice's FULL finalPrice (15000), NOT the
    // credit-reduced payment amount (12345) that under-cleared the invoice.
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(15000),
      { store: txRef.current },
    );
    // The Xero-connected kick stays OUTSIDE the transaction (provider calls
    // never run in-tx) and fires because an operation was queued.
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  it("rolls back a failed release and continues with the remaining holds", async () => {
    const poisoned = makeExpiredPayment();
    const healthy = makeExpiredPayment({
      id: "pay_ib_2",
      bookingId: "booking_ib_2",
      booking: {
        ...makeExpiredPayment().booking,
        id: "booking_ib_2",
      },
    });
    mocks.paymentFindMany.mockResolvedValue([poisoned, healthy]);
    mocks.txPaymentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "pay_ib_2" ? healthy : poisoned,
    );
    // The poisoned candidate's enqueue rejects INSIDE its transaction: that
    // release rolls back whole (hold not marked released, so the next run
    // retries it) while the loop continues to the next hold.
    mocks.enqueueXeroModificationCreditNoteOperation
      .mockRejectedValueOnce(new Error("enqueue exploded"))
      .mockResolvedValueOnce({ queueOperationId: "op_refund_note_2" });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.failed).toBe(1);
    expect(result.released).toBe(1);
    expect(result.paymentIds).toEqual(["pay_ib_2"]);
    // Only the healthy candidate's post-commit effects ran.
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue anything for skipped holds", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue(
      makeExpiredPayment({ internetBankingHoldReleasedAt: new Date() }),
    );

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
    // #1547: a skipped hold never touches the credit ledger.
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
  });

  it("defers hold expiry before any write while clamp deallocation is unresolved", async () => {
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValueOnce({
      id: "op_dealloc",
      status: "RUNNING",
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.txBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.txPaymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("restores applied credit inside the release transaction and threads it through the narrative (#1547)", async () => {
    mocks.restoreCreditFromBooking.mockResolvedValue(2000);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    // Exactly one restore, on the SAME transaction client as the claim, with
    // NO override arg (100% — nothing was captured).
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "mem_1",
      "booking_ib_1",
      txRef.current,
    );
    expect(mocks.restoreCreditFromBooking.mock.calls[0]).toHaveLength(3);
    // The CANCELLED narrative, audit metadata, and email all carry the amount.
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CANCELLED",
        reason: expect.stringContaining(
          "$20.00 of applied account credit was returned.",
        ),
        snapshot: expect.objectContaining({ creditRestoredCents: 2000 }),
      }),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.internet_banking_hold_expired",
        metadata: expect.objectContaining({ creditRestoredCents: 2000 }),
      }),
    );
    const emailCall = mocks.sendBookingCancelledEmail.mock.calls[0];
    expect(emailCall[8]).toBe(2000);
    // #3792: an expired hold is not the member's cancel, so no policy wording.
    expect(emailCall[10]).toBe("in-full");
  });

  it("#3611: posts the released booking's reversals, nothing kept, on the release transaction", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(cancellationLedger.postCancellationLedgerLines).toHaveBeenCalledTimes(1);
    expect(cancellationLedger.postCancellationLedgerLines).toHaveBeenCalledWith(
      expect.objectContaining({
        store: txRef.current,
        bookingId: "booking_ib_1",
        keptCents: 0,
        site: "internet-banking-hold-release",
      }),
    );
  });

  it("skips the kick when the enqueue deduped to no new operation", async () => {
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });

  // #3535 (`INV-PAY-017`): an invoice nobody paid is CLEARED by the allocated
  // note the never-captured cancel path raises — never the cash-refund note,
  // which is not allocated and names a refund for money that never moved.
  it("clears the unpaid invoice with the allocated clearing note, never the cash-refund note (#3535)", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledTimes(1);
    const [params, options] =
      mocks.enqueueXeroModificationCreditNoteOperation.mock.calls[0]!;
    // Anchored on the BOOKING with no edit behind it (the cancel path's
    // anchor), told it clears an unpaid invoice, and naming no refund method.
    expect(params).toEqual(clearingNote(15000));
    expect(params).not.toHaveProperty("bookingModificationId");
    expect(params).not.toHaveProperty("refundMethod");
    expect(options).toEqual({ store: txRef.current });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("enqueues before the release transaction returns, so the note commits with the release (#3535)", async () => {
    // The enqueue runs INSIDE the callback handed to $transaction: it has been
    // called by the time the callback resolves, and never after.
    let enqueuedInsideCallback = false;
    mocks.transaction.mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: { update: mocks.txBookingUpdate },
          memberCreditNoteAllocation: {
            aggregate: mocks.txMemberCreditAggregate,
          },
          paymentTransaction: { findMany: mocks.txPaymentTransactionFindMany },
        };
        txRef.current = tx;
        const out = await callback(tx);
        enqueuedInsideCallback =
          mocks.enqueueXeroModificationCreditNoteOperation.mock.calls.length === 1;
        return out;
      },
    );

    await releaseExpiredInternetBankingHolds(NOW);

    expect(enqueuedInsideCallback).toBe(true);
    // And the hold is marked released in that same transaction, so the two
    // commit or roll back together.
    expect(mocks.txPaymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay_ib_1" },
      data: { status: "FAILED", internetBankingHoldReleasedAt: NOW },
    });
  });

  it("enqueues nothing new on a re-run once the hold is released (#3535)", async () => {
    // Run 1 releases the hold and enqueues the clearing note.
    await releaseExpiredInternetBankingHolds(NOW);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledTimes(1);

    // Run 2 re-reads the same payment under the lock: released, FAILED — the
    // guard set skips it before any write, so no second note is enqueued.
    const released = makeExpiredPayment({
      status: "FAILED",
      internetBankingHoldReleasedAt: NOW,
      booking: { ...makeExpiredPayment().booking, status: "CANCELLED" },
    });
    mocks.txPaymentFindUnique.mockResolvedValue(released);

    const rerun = await releaseExpiredInternetBankingHolds(NOW);

    expect(rerun.released).toBe(0);
    expect(rerun.skipped).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("asks only for pending holds with no release stamp, which every released hold lacks (#3535)", async () => {
    // A query-shape pin, and all it can be: a hold released before #3535 got
    // its refund note in the SAME transaction that set
    // internetBankingHoldReleasedAt and flipped the payment FAILED, so this
    // filter keeps the CRON from raising a clearing note beside it. The repair
    // tool is another matter (#3639).
    mocks.paymentFindMany.mockResolvedValue([]);

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "INTERNET_BANKING",
          status: "PENDING",
          internetBankingHoldReleasedAt: null,
        }),
      }),
    );
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });
});

// #1597: the clearing credit note is sized like the never-captured cancel path
// (booking-cancel.ts) — the invoice's FULL finalPrice minus only the credit
// already allocated to it as a Xero credit note — and is gated on an issued
// invoice, NOT the credit-reduced payment amount that under-cleared the invoice.
describe("releaseExpiredInternetBankingHolds invoice-clearing sizing (#1597)", () => {
  const txRef: { current: unknown } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    txRef.current = null;
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: {
            update: mocks.txBookingUpdate,
          },
          memberCreditNoteAllocation: {
            aggregate: mocks.txMemberCreditAggregate,
          },
          paymentTransaction: {
            findMany: mocks.txPaymentTransactionFindMany,
          },
        };
        txRef.current = tx;
        return callback(tx);
      },
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.revokePaymentLinksForBooking.mockResolvedValue(undefined);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.txMemberCreditAggregate.mockResolvedValue({
      _sum: { amountCents: 0 },
    });
    // #1597: default = no captured ledger row (never-captured hold).
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_note_1",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(
      undefined,
    );
    mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
  });

  it("clears the full finalPrice even when the booking carried applied credit (no double-count)", async () => {
    // The member had NZ$26.55 of credit applied locally (amountCents 12345 =
    // 15000 − 2655), restored 100% at release. That credit never reduced the
    // Xero invoice (raised at full finalPrice), so the aggregate of
    // Xero-allocated credit notes is 0 and the clearing note is the full 15000.
    mocks.restoreCreditFromBooking.mockResolvedValue(2655);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(15000),
      { store: txRef.current },
    );
  });

  it("subtracts only credit already allocated to the invoice as a Xero credit note", async () => {
    // A NZ$50.00 credit note was allocated to the invoice in Xero (a
    // precise MemberCreditNoteAllocation ledger stores positive cents, so the
    // invoice's Xero outstanding is 15000 − 5000; the clearing note must be
    // exactly that remainder to avoid over-allocating.
    mocks.txMemberCreditAggregate.mockResolvedValue({
      _sum: { amountCents: 5000 },
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(10000),
      { store: txRef.current },
    );
    expect(
      mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
    ).toHaveBeenCalledWith("booking_ib_1", "inv_ib_1", txRef.current, CLUB_FORMAT_TEST);
    expect(mocks.lockMemberCreditLedger).toHaveBeenCalledWith(
      "mem_1",
      txRef.current,
    );
    expect(mocks.lockMemberCreditLedger.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mock
        .invocationCallOrder[0],
    );
  });

  it("conserves on hold-expiry with #1620-allocated applied credit (reduced clearing + 100% restore)", async () => {
    // #1620 allocate-existing makes xeroAllocatedAppliedCredit non-zero: the
    // applied credit was allocated to the invoice as a Xero note (stamped
    // MemberCreditNoteAllocation, +5000) AND is restored 100% at release. Clearing =
    // finalPrice − allocated = 10000, and the member's credit is made whole.
    // Together these conserve: the invoice nets to zero (5000 allocated note +
    // 10000 clearing, no cash) and the credit balance is restored — the exact
    // interaction the owner asked to pin now that the term can be non-zero.
    mocks.txMemberCreditAggregate.mockResolvedValue({
      _sum: { amountCents: 5000 },
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(5000);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(10000),
      { store: txRef.current },
    );
  });

  it("enqueues no clearing note when the released hold has no issued invoice", async () => {
    // The create-time hold-slots shape is CONFIRMED and booking-create only
    // enqueues the invoice for a PAYMENT_PENDING booking, so this shape reaches
    // release with no invoice. Enqueuing a refund note here previously minted a
    // permanently-failing outbox op (worker throws "No Xero invoice linked").
    const noInvoice = makeExpiredPayment({
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
    });
    mocks.paymentFindMany.mockResolvedValue([noInvoice]);
    mocks.txPaymentFindUnique.mockResolvedValue(noInvoice);
    // Applied credit is still restored locally even with no invoice.
    mocks.restoreCreditFromBooking.mockResolvedValue(2655);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    // The hold still releases and the member's credit is still restored...
    expect(result.released).toBe(1);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    // ...but no clearing credit note is enqueued and no allocation is even read.
    expect(mocks.txMemberCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });

  it("enqueues no clearing note when Xero credit notes already fully cover the invoice", async () => {
    // The invoice's entire finalPrice is already covered by allocated Xero
    // credit notes: nothing left to clear, so no note is enqueued.
    mocks.txMemberCreditAggregate.mockResolvedValue({
      _sum: { amountCents: 15000 },
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });

  it("enqueues no clearing note when the payment carries capture evidence", async () => {
    // Inert for reachable candidates (the guards require a PENDING payment), but
    // this mirrors booking-cancel's second gate clause: a captured ledger row
    // means the invoice is settled Xero-side, so a clearing note would poison
    // the op-retry stack. A captured PaymentTransaction row is present, so the
    // note (and the allocation read) are skipped entirely.
    mocks.txPaymentTransactionFindMany.mockResolvedValue([
      { status: "SUCCEEDED" },
    ]);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.txMemberCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });
});

// #3209: the release frees the beds and, until now, never re-checked adult
// supervision. The guard set above requires `booking.status === CONFIRMED`, and
// CONFIRMED is one of the two statuses that qualify a booking as a
// `SAME_BOOKING_OWNER` coverage source — so an expired hold could take the
// qualifying adult off ANOTHER booking of the same member with no incident, no
// owner email and nothing in the officer queue.
describe("releaseExpiredInternetBankingHolds adult-member hosting (#3209)", () => {
  const txRef: { current: unknown } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    txRef.current = null;
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: { update: mocks.txBookingUpdate },
          memberCreditNoteAllocation: {
            aggregate: mocks.txMemberCreditAggregate,
          },
          paymentTransaction: { findMany: mocks.txPaymentTransactionFindMany },
        };
        txRef.current = tx;
        return callback(tx);
      },
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.revokePaymentLinksForBooking.mockResolvedValue(undefined);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
    mocks.txMemberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_note_1",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(undefined);
    mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
  });

  it("reconciles hosting inside the release transaction and drains after it commits", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    // The release transaction's own client, so the obligation the reconcile
    // records commits atomically with the cancellation.
    expect(txRef.current).not.toBeNull();
    expect(
      mocks.reconcileHostingReviewForSystemCancellation,
    ).toHaveBeenCalledWith("booking_ib_1", txRef.current);
    // And the drain runs AFTER, on the module client: inside the transaction it
    // would read the uncommitted rows it exists to re-read, and send email from a
    // transaction that can still roll back.
    expect(mocks.settleHostingCoverageAfterCommit).toHaveBeenCalledWith({
      bookingId: "booking_ib_1",
    });
  });

  it("takes the coverage-owner key last, after the lodge and credit-ledger keys", async () => {
    // `INV-HOST-031` / `INV-LOCK-002`: the per-owner coverage key is always
    // acquired last. Placing the reconcile at the end of the transaction is what
    // makes that true here, and a future edit that hoists it above the credit
    // ledger lock inverts the order without any other test noticing.
    const order: string[] = [];
    mocks.lockMemberCreditLedger.mockImplementation(async () => {
      order.push("credit-ledger");
    });
    mocks.reconcileBedAllocationsForBooking.mockImplementation(async () => {
      order.push("beds");
    });
    mocks.reconcileHostingReviewForSystemCancellation.mockImplementation(
      async () => {
        order.push("hosting");
      },
    );

    await releaseExpiredInternetBankingHolds(NOW);

    expect(order).toEqual(["credit-ledger", "beds", "hosting"]);
  });

  it("does not reconcile or drain for a candidate the guard set skips", async () => {
    // Not CONFIRMED, so nothing was cancelled and no cover was removed.
    mocks.txPaymentFindUnique.mockResolvedValue(
      makeExpiredPayment({
        booking: {
          ...makeExpiredPayment().booking,
          status: "CANCELLED",
        },
      }),
    );

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.skipped).toBe(1);
    expect(
      mocks.reconcileHostingReviewForSystemCancellation,
    ).not.toHaveBeenCalled();
    expect(mocks.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });

  it("leaves the hold unreleased for the next run when the reconcile fails outright", async () => {
    // The seam asks for `REVIEW_ONLY`, so the hosting rule cannot refuse this at
    // all; what reaches here is a database failure or a participant retry. That
    // rolls the release
    // back whole — the hold is NOT marked released, so the next run retries it —
    // and the loop moves on rather than starving the remaining candidates. What
    // must never happen is a released hold with the coverage question lost, and
    // the drain not running proves nothing was reported as done.
    mocks.reconcileHostingReviewForSystemCancellation.mockRejectedValue(
      new Error("participants contended"),
    );

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.failed).toBe(1);
    expect(result.released).toBe(0);
    expect(mocks.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });
});

// #3643 (`INV-PAY-107`, owner decision option A; orchestrator decision on the
// thread for the unreadable bound): a hold whose invoice has any money against
// it is not released; the treasurer is told once per hold per reason; an
// unreadable invoice is kept until check-in or seven days past the deadline,
// then released with a second alert; a payment recorded between the live read
// and the lock still keeps the hold.
describe("releaseExpiredInternetBankingHolds keeps a hold with money against it (#3643)", () => {
  const READ_AT = new Date("2026-07-06T07:59:00Z");
  const PART_PAID = {
    kind: "paid",
    readStartedAt: READ_AT,
    invoices: [],
    fromRecordedLinkOnly: false,
    paidCents: 15000,
    cashComplete: true,
    amountDueCents: 15000,
    paidInFull: false,
  };
  const UNREADABLE = {
    kind: "unreadable",
    readStartedAt: READ_AT,
    reason: "Xero is not connected. Please connect via admin panel.",
    notFound: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: { update: mocks.txBookingUpdate },
          memberCreditNoteAllocation: {
            aggregate: mocks.txMemberCreditAggregate,
          },
          paymentTransaction: { findMany: mocks.txPaymentTransactionFindMany },
        }),
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.txMemberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_note_1",
    });
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(undefined);
    mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
  });

  function expectNothingReleased() {
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.txPaymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  }

  it("keeps a part-paid hold, opens no transaction, and alerts the treasurer with the money", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      paidCents: 5000,
      amountDueCents: 10000,
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 1, released: 0, skipped: 0, failed: 0 });
    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pay_ib_1", xeroInvoiceId: "inv_ib_1" }),
    );
    expectNothingReleased();
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "internet-banking-hold-kept:part-paid:pay_ib_1:2026-07-05T08:00:00.000Z",
      }),
    );
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "part-paid",
        bookingId: "booking_ib_1",
        paidCents: 5000,
        amountOwingCents: 10000,
        xeroInvoiceNumber: "INV-IB-001",
        xeroInvoiceUrl: expect.stringContaining("inv_ib_1"),
      }),
      expect.anything(),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.internet_banking_hold_kept",
        outcome: "blocked",
      }),
    );
  });

  it("says 'paid in full, sync behind' rather than 'wait for the rest' when nothing is owed", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      amountDueCents: 0,
      paidInFull: true,
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.kept).toBe(1);
    expectNothingReleased();
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "paid-in-full", amountOwingCents: 0 }),
      expect.anything(),
    );
  });

  it("alerts once per hold: a later run that loses the claim sends nothing and still keeps the hold", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    mocks.claimAlertCooldown.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await releaseExpiredInternetBankingHolds(NOW);
    const second = await releaseExpiredInternetBankingHolds(NOW);

    expect(first.kept).toBe(1);
    expect(second.kept).toBe(1);
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    expectNothingReleased();
  });

  // #3635 (F1): every recipient suppressed, or a non-production withhold,
  // reads as `undelivered`. Giving the claim back would re-send (and write a
  // critical delivery-escalation audit row) every 15 minutes; it is held for
  // a day instead, as `sendAdminAlertOnceEver` holds it.
  it("holds the claim for a day when the send reached nobody (every recipient suppressed)", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValueOnce("undelivered");

    await releaseExpiredInternetBankingHolds(NOW);

    const key = "internet-banking-hold-kept:part-paid:pay_ib_1:2026-07-05T08:00:00.000Z";
    const claim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith({
      key,
      claimedAt: claim.now,
      windowMs: 36_500 * 86_400_000,
      retryAfterMs: 86_400_000,
    });
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    // Not settled yet, so not audited yet.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();

    // The next 15-minute run finds the claim held and sends nothing.
    mocks.claimAlertCooldown.mockResolvedValueOnce(false);
    await releaseExpiredInternetBankingHolds(new Date(NOW.getTime() + 15 * 60 * 1000));
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledTimes(1);
  });

  it("gives the claim back when the send throws, so the next run sends it", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    mocks.sendAdminInternetBankingHoldKeptAlert.mockRejectedValueOnce(new Error("SES down"));

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({
      key: "internet-banking-hold-kept:part-paid:pay_ib_1:2026-07-05T08:00:00.000Z",
      claimedAt: expect.any(Date),
    });
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledTimes(2);
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim when the club's delivery rules muted the alert (nothing to retry)", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValueOnce("skipped-by-policy");

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("shows the paid figure as unknown when only the recorded link says money arrived", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      fromRecordedLinkOnly: true,
      paidCents: 0,
      cashComplete: false,
      amountDueCents: null,
    });

    await releaseExpiredInternetBankingHolds(NOW);

    // D5: the app's cancel cannot credit a payment it cannot size, so the
    // email says the officer's cancel is an unpaid one settled by hand.
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "part-paid-manual",
        paidCents: null,
        amountOwingCents: null,
      }),
      expect.anything(),
    );
  });

  it("releases a fully unpaid hold exactly as before", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 0, released: 1 });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(15000),
      expect.anything(),
    );
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).not.toHaveBeenCalled();
    expect(mocks.claimAlertCooldown).not.toHaveBeenCalled();
  });

  it("re-checks only links recorded since the live read started", async () => {
    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.hasRecordedInvoicePayment).toHaveBeenCalledWith(
      { paymentId: "pay_ib_1", bookingId: "booking_ib_1", since: READ_AT },
      expect.anything(),
    );
  });

  it("does not ask Xero or alert about a booking the release would skip anyway", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    const notConfirmed = makeExpiredPayment({
      booking: { ...makeExpiredPayment().booking, status: "CANCELLED" },
    });
    mocks.paymentFindMany.mockResolvedValue([notConfirmed]);
    mocks.txPaymentFindUnique.mockResolvedValue(notConfirmed);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 0, skipped: 1, released: 0 });
    expect(mocks.readHoldPaymentEvidence).not.toHaveBeenCalled();
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).not.toHaveBeenCalled();
  });

  it("releases a hold with no issued invoice (nothing to pay against) as before", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({ kind: "no-invoice", readStartedAt: READ_AT });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 0, released: 1 });
  });

  it("keeps a hold whose invoice cannot be read and alerts once, inside the bound", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.kept).toBe(1);
    expectNothingReleased();
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "internet-banking-hold-kept:unreadable:pay_ib_1:2026-07-05T08:00:00.000Z",
      }),
    );
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "unreadable",
        paidCents: null,
        amountOwingCents: null,
      }),
      expect.anything(),
    );
  });

  it("releases an unreadable hold seven days past its deadline, with the second alert", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);
    // Deadline 5 July 08:00Z; seven days on is 12 July 08:00Z. Check-in stays
    // later (20 July), so only the seven-day arm can fire.
    const later = new Date("2026-07-12T08:00:00Z");

    const result = await releaseExpiredInternetBankingHolds(later);

    expect(result).toMatchObject({ kept: 0, released: 1 });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      clearingNote(15000),
      expect.anything(),
    );
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "released-unreadable" }),
      expect.anything(),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.internet_banking_hold_released_unreadable" }),
    );
  });

  it("still keeps an unreadable hold one minute inside the seven days", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);

    const result = await releaseExpiredInternetBankingHolds(new Date("2026-07-12T07:59:00Z"));

    expect(result).toMatchObject({ kept: 1, released: 0 });
    expectNothingReleased();
  });

  // Composed with #3663 (INV-PAY-016): the unreadable-invoice bound's
  // check-in arm hands the hold to the started-stay rule rather than
  // releasing it. A stay that has started is never cancelled; it is left for
  // reconciliation by hand, with #3663's one alert.
  it("leaves an unreadable hold alone once the club's check-in day arrives, for the started-stay rule", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);
    // 08:00Z on 6 July is 20:00 on 6 July in Auckland: check-in day has arrived.
    const atCheckIn = makeExpiredPayment({
      booking: { ...makeExpiredPayment().booking, checkIn: new Date("2026-07-06") },
    });
    mocks.paymentFindMany.mockResolvedValue([atCheckIn]);
    mocks.txPaymentFindUnique.mockResolvedValue(atCheckIn);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 0, released: 0, skippedStarted: 1 });
    // #3635 (C1): answered before any read, so no Xero read and no transaction.
    expect(mocks.readHoldPaymentEvidence).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.txPaymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "released-unreadable" }),
      expect.anything(),
    );
    expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).toHaveBeenCalledTimes(1);
  });

  // #3635 (C1): a started stay is answered BEFORE the Xero read, whatever the
  // invoice would say. The release never cancels one (INV-PAY-016), so the
  // read could change nothing; it would only spend the read budget every run.
  it("leaves a part-paid hold whose stay has started for the started-stay rule, without reading Xero", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
    const started = makeExpiredPayment({
      booking: { ...makeExpiredPayment().booking, checkIn: new Date("2026-07-06") },
    });
    mocks.paymentFindMany.mockResolvedValue([started]);
    mocks.txPaymentFindUnique.mockResolvedValue(started);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 0, released: 0, skippedStarted: 1 });
    expectNothingReleased();
    expect(mocks.readHoldPaymentEvidence).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).not.toHaveBeenCalled();
    expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).toHaveBeenCalledTimes(1);
  });

  it("C1: five started-stay holds spend no read budget, so another expired hold is still read and released", async () => {
    const started = Array.from({ length: 5 }, (_, i) =>
      makeExpiredPayment({
        id: `pay_started_${i}`,
        bookingId: `booking_started_${i}`,
        booking: {
          ...makeExpiredPayment().booking,
          id: `booking_started_${i}`,
          checkIn: new Date("2026-07-05"),
        },
      }),
    );
    const releasable = makeExpiredPayment();
    // Started holds sort first (older deadlines), as they do in production.
    mocks.paymentFindMany.mockResolvedValue([...started, releasable]);
    mocks.txPaymentFindUnique.mockResolvedValue(releasable);
    // The day's budget has exactly one read left.
    mocks.checkRateLimit
      .mockReset()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue({ success: false });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ skippedStarted: 5, released: 1, deferred: 0 });
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pay_ib_1" }),
    );
    expect(mocks.sendAdminInternetBankingHoldStartedStayAlert).toHaveBeenCalledTimes(5);
  });

  it("never releases a part-paid hold at the bound", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);

    // Ten days past the deadline, still before the 20 July check-in (a
    // started stay is answered before any read, #3635 C1).
    const result = await releaseExpiredInternetBankingHolds(new Date("2026-07-15T08:00:00Z"));

    expect(result).toMatchObject({ kept: 1, released: 0 });
    expectNothingReleased();
  });

  it("still keeps the hold when a payment is recorded between the read and the lock", async () => {
    mocks.hasRecordedInvoicePayment.mockResolvedValue(true);
    mocks.readHoldPaymentEvidence
      .mockResolvedValueOnce({ kind: "unpaid", readStartedAt: READ_AT, invoices: [] })
      .mockResolvedValueOnce(PART_PAID);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ kept: 1, released: 0, skipped: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.txPaymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "part-paid" }),
      expect.anything(),
    );
  });

  it("reads at most the per-run cap of holds and leaves the rest for a later run", async () => {
    const holds = Array.from({ length: 25 }, (_, i) =>
      makeExpiredPayment({
        id: `pay_${i}`,
        bookingId: `booking_${i}`,
        booking: { ...makeExpiredPayment().booking, id: `booking_${i}` },
      }),
    );
    mocks.paymentFindMany.mockResolvedValue(holds);
    mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({ scanned: 25, kept: 20, deferred: 5 });

    // The next 15-minute run reads a different window of them.
    mocks.readHoldPaymentEvidence.mockClear();
    await releaseExpiredInternetBankingHolds(new Date(NOW.getTime() + 15 * 60 * 1000));
    const secondRunIds = mocks.readHoldPaymentEvidence.mock.calls.map(
      ([hold]) => (hold as { id: string }).id,
    );
    expect(secondRunIds).toContain("pay_24");
  });
});

describe("releaseExpiredInternetBankingHolds delta round (#3643 D4, D5, D9)", () => {
  const READ_AT = new Date("2026-07-06T07:59:00Z");
  const UNREADABLE = {
    kind: "unreadable",
    readStartedAt: READ_AT,
    reason: "Xero is not connected.",
    notFound: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: mocks.txExecuteRaw,
          payment: { findUnique: mocks.txPaymentFindUnique, update: mocks.txPaymentUpdate },
          booking: { update: mocks.txBookingUpdate },
          memberCreditNoteAllocation: { aggregate: mocks.txMemberCreditAggregate },
          paymentTransaction: { findMany: mocks.txPaymentTransactionFindMany },
        }),
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.txMemberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({ queueOperationId: "op_1" });
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
    mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(undefined);
    mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
  });

  it("D4: a released-unreadable alert that reached nobody is audited anyway and marked owed, never given back", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);
    mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValue("undelivered");

    const result = await releaseExpiredInternetBankingHolds(new Date("2026-07-12T08:00:00Z"));

    expect(result.released).toBe(1);
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.markAlertOwed).toHaveBeenCalledWith({
      key: "internet-banking-hold-alert-owed:released-unreadable:pay_ib_1",
      due: "after-retry",
      retryAfterMs: 86_400_000,
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.internet_banking_hold_released_unreadable",
        details: expect.stringContaining('"alertDelivery":"undelivered"'),
      }),
    );
  });

  it("D4: a released-unreadable alert whose send THREW is marked owed and due on the next run (#3635 N1)", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue(UNREADABLE);
    mocks.sendAdminInternetBankingHoldKeptAlert.mockRejectedValue(new Error("recipient read failed"));

    const result = await releaseExpiredInternetBankingHolds(new Date("2026-07-12T08:00:00Z"));

    expect(result.released).toBe(1);
    expect(mocks.markAlertOwed).toHaveBeenCalledWith({
      key: "internet-banking-hold-alert-owed:released-unreadable:pay_ib_1",
      due: "next-run",
      retryAfterMs: 86_400_000,
    });
  });

  it("D4: an owed alert whose drain send THREW is left due, not pushed a day out (#3635 N1)", async () => {
    mocks.paymentFindMany.mockResolvedValue([]);
    const key = "internet-banking-hold-alert-owed:released-unreadable:pay_ib_1";
    mocks.listOwedAlertKeys.mockResolvedValue([key]);
    mocks.paymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.sendAdminInternetBankingHoldKeptAlert.mockRejectedValue(new Error("recipient read failed"));

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it("D4: the next run delivers the owed alert and settles it", async () => {
    mocks.paymentFindMany.mockResolvedValue([]);
    const key = "internet-banking-hold-alert-owed:released-unreadable:pay_ib_1";
    mocks.listOwedAlertKeys.mockResolvedValue([key]);
    mocks.paymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValue("sent");

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "released-unreadable", bookingId: "booking_ib_1" }),
      expect.anything(),
    );
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key });
  });

  it("D4: an owed alert still undelivered stays owed, and waits a day for its next try (#3635 F1)", async () => {
    mocks.paymentFindMany.mockResolvedValue([]);
    const key = "internet-banking-hold-alert-owed:released-unreadable:pay_ib_1";
    mocks.listOwedAlertKeys.mockResolvedValue([key]);
    mocks.paymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.sendAdminInternetBankingHoldKeptAlert.mockResolvedValue("undelivered");

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    // Only due markers are offered, and this attempt restarts the day.
    expect(mocks.listOwedAlertKeys).toHaveBeenCalledWith({
      prefix: "internet-banking-hold-alert-owed:",
      retryAfterMs: 86_400_000,
    });
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key });
  });

  it("D5: an organisation's part-paid hold is worded as settled by hand", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      kind: "paid",
      readStartedAt: READ_AT,
      invoices: [],
      fromRecordedLinkOnly: false,
      paidCents: 5000,
      cashComplete: true,
      amountDueCents: 10000,
      paidInFull: false,
    });
    const org = makeExpiredPayment({
      booking: {
        ...makeExpiredPayment().booking,
        memberId: null,
        member: null,
        organisationId: "org_1",
        organisation: { name: "School", email: "school@example.com" },
      },
    });
    mocks.paymentFindMany.mockResolvedValue([org]);

    await releaseExpiredInternetBankingHolds(NOW);

    expect(mocks.sendAdminInternetBankingHoldKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "part-paid-manual", memberName: "School" }),
      expect.anything(),
    );
  });

  it("D9: with the day's read budget spent, a hold is left for later, neither read nor released", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result).toMatchObject({ deferred: 1, released: 0, kept: 0 });
    expect(mocks.readHoldPaymentEvidence).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ib-hold-xero-reads" }),
      "club",
    );
  });
});

// #3635 (F5): the unreadable bound asks the one started-stay derivation
// (`bookingStayHasStarted`, a calendar-day compare), never a raw Date compare,
// so it and the release transaction always agree on "started".
describe("decideExpiredHold started-stay derivation (#3635 F5)", () => {
  it("reads a check-in carrying a time of day as its calendar day", () => {
    const hold = makeExpiredPayment({
      booking: {
        ...makeExpiredPayment().booking,
        checkIn: new Date("2026-07-06T15:00:00.000Z"),
      },
    }) as unknown as Parameters<typeof decideExpiredHold>[0];

    const decision = decideExpiredHold(
      hold,
      {
        kind: "unreadable",
        readStartedAt: NOW,
        reason: "Xero is not connected.",
        notFound: false,
      },
      { now: NOW, clubToday: new Date("2026-07-06T00:00:00.000Z") },
    );

    expect(decision).toEqual({ action: "release-at-bound" });
  });
});

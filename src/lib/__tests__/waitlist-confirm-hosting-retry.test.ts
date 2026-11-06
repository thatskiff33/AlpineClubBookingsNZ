import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  confirmWaitlistOffer: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentCreate: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  reconcileBeds: vi.fn(),
  enqueueHosting: vi.fn(),
  settleHosting: vi.fn(),
  sendConfirmed: vi.fn(),
  sendPending: vi.fn(),
  enqueueXero: vi.fn(),
  kickXero: vi.fn(),
  createAuditLog: vi.fn().mockResolvedValue(undefined),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/waitlist", () => ({
  confirmWaitlistOffer: mocks.confirmWaitlistOffer,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacity,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: mocks.reconcileBeds,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueHosting,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHosting,
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendConfirmed,
  sendBookingPendingEmail: mocks.sendPending,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXero,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST } from "@/app/api/bookings/[id]/waitlist-confirm/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY,
  WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
  WAITLIST_CONFIRM_STATUS_MOVED_BODY,
  WAITLIST_OFFER_RELEASED_CAPACITY_BODY,
} from "@/lib/waitlist-confirm-recovery-contract";

/** A Prisma transaction-contention rejection, exactly as the client throws it. */
function contentionError(code: "P2028" | "P2034") {
  return Object.assign(
    new Error(
      code === "P2028"
        ? "Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting."
        : "Write conflict or deadlock detected. Please retry your transaction.",
    ),
    { code },
  );
}

function post() {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/waitlist-confirm", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

function booking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: 0,
    discountCents: 0,
    promoAdjustmentCents: 0,
    checkIn: new Date("2026-08-20T00:00:00.000Z"),
    checkOut: new Date("2026-08-22T00:00:00.000Z"),
    nonMemberHoldUntil: null,
    member: { email: "member@example.test", firstName: "Member" },
    guests: [{ id: "guest-1", nights: [] }],
    promoRedemption: null,
  };
}

function txDouble() {
  return {
    $executeRaw: mocks.executeRaw,
    booking: {
      findUnique: mocks.bookingFindUnique,
      updateMany: mocks.bookingUpdateMany,
    },
    payment: { create: mocks.paymentCreate },
  };
}

// #4738: a $0 confirmation's lines and R01 are proved against PostgreSQL
// (zero-price-confirmation.realdb.test.ts); here only the call is observed.
const confirmationLedger = vi.hoisted(() => ({
  postStoredBookingConfirmationLedgerLines: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/booking-ledger-confirmation-sync", () => confirmationLedger);
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  resolveBookingMoneyPostingContext: vi.fn(async () => ({ journal: "context" })),
}));

describe("zero-dollar waitlist participant contention (#2597)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.confirmWaitlistOffer.mockResolvedValue({
      success: true,
      newStatus: "PAYMENT_PENDING",
    });
    mocks.bookingFindUnique.mockResolvedValue(booking());
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentCreate.mockResolvedValue({ id: "payment-1" });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    mocks.checkCapacity.mockResolvedValue({ available: true });
    mocks.reconcileBeds.mockResolvedValue(undefined);
    mocks.enqueueHosting.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );
    mocks.transaction.mockImplementation(
      async (callback: (client: ReturnType<typeof txDouble>) => Promise<unknown>) =>
        callback(txDouble()),
    );
  });

  it("restores WAITLISTED after phase two rolls back and returns the fixed 409", async () => {
    const response = await post();

    expect(response.status).toBe(409);
    // The frozen retry sentence and code are unchanged, and now carry the honest
    // end state: the offer this card was showing is gone, and the waitlist place
    // is back (#2623 T8).
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      offerRevoked: true,
      waitlistPlaceRestored: true,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "booking-1", status: "PAYMENT_PENDING" },
      data: {
        status: "WAITLISTED",
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
    // The compensation runs on explicit budgets rather than Prisma's 2s/5s
    // defaults, because it runs under exactly the contention that triggered it —
    // but tighter than the admin precedents, because two attempts must not keep a
    // member waiting much past 30s (#2623).
    expect(mocks.transaction.mock.calls[1]?.[1]).toEqual({
      maxWait: 5_000,
      timeout: 10_000,
    });
    expect(mocks.reconcileBeds).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1" }),
    );
    expect(mocks.settleHosting).not.toHaveBeenCalled();
    expect(mocks.sendConfirmed).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("retries a contended compensation once and still answers the fixed 409 (#2623 T4)", async () => {
    let transactionCall = 0;
    mocks.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) => {
        transactionCall += 1;
        // 1 = phase two (throws the participant retry via enqueueHosting).
        // 2 = the first compensation attempt, contended.
        // 3 = the retry, which succeeds.
        if (transactionCall === 2) throw contentionError("P2034");
        return callback(txDouble());
      },
    );

    const response = await post();

    expect(transactionCall).toBe(3);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      offerRevoked: true,
      waitlistPlaceRestored: true,
    });
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("never lets a failed compensation become a 500, and raises it for operator recovery (#2623 T4)", async () => {
    let transactionCall = 0;
    mocks.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) => {
        transactionCall += 1;
        // Phase two throws the participant retry; both compensation attempts
        // then lose their own lock waits — the exact case that used to escape as
        // an unhandled 500 with a $0 booking parked in PAYMENT_PENDING.
        if (transactionCall >= 2) throw contentionError("P2028");
        return callback(txDouble());
      },
    );

    const response = await post();

    expect(transactionCall).toBe(3);
    expect(response.status).toBe(503);
    // Not retry-shaped: there is nothing to retry, and the copy says so.
    await expect(response.json()).resolves.toEqual({
      ...WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY,
    });
    expect(WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY.error).not.toBe(
      HOSTING_COVERAGE_RETRY_MESSAGE,
    );

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        severity: "critical",
        outcome: "failure",
        subjectMemberId: "member-1",
        // Both causes are recorded so an operator can tell a participant-fence
        // strand from a plain lock-wait strand without reading logs.
        metadata: expect.objectContaining({
          lodgeId: "lodge-1",
          finalPriceCents: 0,
          claimErrorCode: HOSTING_COVERAGE_RETRY_CODE,
          releaseErrorCode: "P2028",
        }),
      }),
    );
    expect(mocks.settleHosting).not.toHaveBeenCalled();
    expect(mocks.sendConfirmed).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
  });

  it("waits for the strand report to commit, and still answers if that write fails (#2649 review)", async () => {
    // The report is no longer only a notification: `return-to-waitlist` refuses
    // any booking without an unresolved one, because the
    // free/PAYMENT_PENDING/no-payment shape is reached by producers that were
    // never on a waitlist. So the write is AWAITED rather than fire-and-forget —
    // a report lost to process teardown leaves a genuinely stranded member
    // repairable only from a database session. Its failure semantics are
    // unchanged: logged, and the operator-door body still returned.
    // Resolve on a MACROtask, not a microtask: `void createAuditLog(...)` would
    // let the response leave with the insert still in flight, and only a timer
    // separates the two. This is the difference the change is about.
    let auditSettled = false;
    mocks.createAuditLog.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            auditSettled = true;
            resolve();
          }, 5),
        ),
    );
    let transactionCall = 0;
    mocks.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) => {
        transactionCall += 1;
        if (transactionCall >= 2) throw contentionError("P2028");
        return callback(txDouble());
      },
    );

    const response = await post();

    expect(auditSettled).toBe(true);
    expect(response.status).toBe(503);
  });

  it("still answers the operator door when the strand report itself cannot be written (#2649 review)", async () => {
    // Failure semantics are deliberately unchanged from the fire-and-forget
    // form: the write is logged and the member still gets the operator-door
    // answer, never a 500.
    mocks.createAuditLog.mockReset();
    mocks.createAuditLog.mockRejectedValue(new Error("audit insert failed"));
    let transactionCall = 0;
    mocks.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) => {
        transactionCall += 1;
        if (transactionCall >= 2) throw contentionError("P2028");
        return callback(txDouble());
      },
    );

    const response = await post();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ...WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY,
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it("maps a non-participant phase-two failure instead of throwing it (#2623 T4)", async () => {
    mocks.enqueueHosting.mockReset();
    mocks.enqueueHosting.mockRejectedValueOnce(contentionError("P2028"));

    const response = await post();

    // Nothing about this failure is the member's to act on, and phase one had
    // already consumed the offer: it is released rather than rethrown as a 500
    // that strands the booking.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "WAITLIST_CONFIRM_RELEASED_UNAVAILABLE",
      error: expect.stringContaining("your place on the waitlist was restored"),
      offerRevoked: true,
      waitlistPlaceRestored: true,
    });
    expect(mocks.bookingUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "WAITLISTED" }),
      }),
    );
  });

  it("tells the member the offer is gone when capacity was lost (#2623 T8)", async () => {
    mocks.enqueueHosting.mockReset();
    mocks.enqueueHosting.mockResolvedValue(undefined);
    mocks.checkCapacity.mockResolvedValue({ available: false });

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ...WAITLIST_OFFER_RELEASED_CAPACITY_BODY,
    });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    // One transaction only: the flip restored WAITLISTED under its own locks.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not report lost capacity when the booking simply moved on (#2623 T8)", async () => {
    mocks.enqueueHosting.mockReset();
    mocks.enqueueHosting.mockResolvedValue(undefined);
    mocks.bookingFindUnique.mockResolvedValueOnce(booking()).mockResolvedValue({
      ...booking(),
      status: "PAID",
    });

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ...WAITLIST_CONFIRM_STATUS_MOVED_BODY,
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("writes no $0 payment row when the PAID claim is lost under the locks (#2623)", async () => {
    mocks.enqueueHosting.mockReset();
    mocks.enqueueHosting.mockResolvedValue(undefined);
    mocks.bookingUpdateMany.mockResolvedValue({ count: 0 });

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ...WAITLIST_CONFIRM_STATUS_MOVED_BODY,
    });
    // A lost claim RETURNS, which commits the transaction. `Payment.bookingId`
    // is unique, so a SUCCEEDED $0 row written before the claim would have
    // survived that commit and blocked the booking's real payment row forever.
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    // #4738: and a lost claim posts no confirmation.
    expect(confirmationLedger.postStoredBookingConfirmationLedgerLines).not.toHaveBeenCalled();
  });

  it("posts the $0 offer's confirmation once, in the transaction that wins the PAID claim (#4738)", async () => {
    mocks.enqueueHosting.mockReset();
    mocks.enqueueHosting.mockResolvedValue(undefined);
    mocks.sendConfirmed.mockResolvedValue(undefined);
    mocks.enqueueXero.mockResolvedValue({ queueOperationId: null });

    const response = await post();

    expect(response.status).toBe(200);
    expect(confirmationLedger.postStoredBookingConfirmationLedgerLines).toHaveBeenCalledTimes(1);
    expect(confirmationLedger.postStoredBookingConfirmationLedgerLines.mock.calls[0]!.slice(1)).toEqual([
      "booking-1",
      { journal: "context" },
    ]);
    expect(mocks.bookingUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      confirmationLedger.postStoredBookingConfirmationLedgerLines.mock.invocationCallOrder[0]!,
    );
  });
});

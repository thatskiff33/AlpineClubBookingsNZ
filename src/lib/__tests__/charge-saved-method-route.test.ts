import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { stripeSdkError } from "./support/stripe-sdk-error";

const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockChargePaymentMethod,
  mockGetPaymentIntent,
  mockCancelPaymentIntentIfCancellableWithResult,
  mockEnqueueXeroBookingInvoiceOperation,
  mockKickQueuedXeroOutboxOperationsIfConnected,
  mockSendAdminPaymentFailureAlert,
  mockLogAudit,
  mockBookingFindUnique,
  mockBookingUpdateMany,
  mockBookingUpdate,
  mockPaymentUpdate,
  mockPrismaTransaction,
  mockExecuteRaw,
  mockAcquireLodgeCapacityLock,
  mockMarkBookingPaymentSucceeded,
  mockCheckCapacityForGuestRanges,
  mockUpsertPaymentIntentTransaction,
  mockReconcilePaymentAggregates,
  mockPaymentTransactionFindMany,
  mockPaymentTransactionCreate,
  mockPaymentTransactionUpdate,
  mockPaymentTransactionUpdateMany,
  mockPaymentTransactionFindUnique,
  mockPaymentTransactionDeleteMany,
  mockReconcileBeds,
  mockEnqueueHosting,
  mockSettleHosting,
  mockIsValidCronSecret,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn().mockResolvedValue(null),
  mockChargePaymentMethod: vi.fn(),
  mockGetPaymentIntent: vi.fn(),
  mockCancelPaymentIntentIfCancellableWithResult: vi.fn(),
  mockEnqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_1",
    message: "queued",
  }),
  mockKickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({
    found: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  }),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockBookingUpdateMany: vi.fn(),
  mockBookingUpdate: vi.fn(),
  mockPaymentUpdate: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockAcquireLodgeCapacityLock: vi.fn(),
  mockMarkBookingPaymentSucceeded: vi.fn(),
  mockCheckCapacityForGuestRanges: vi.fn(),
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
  mockReconcilePaymentAggregates: vi.fn(),
  mockPaymentTransactionFindMany: vi.fn(),
  mockPaymentTransactionCreate: vi.fn(),
  mockPaymentTransactionUpdate: vi.fn(),
  mockPaymentTransactionUpdateMany: vi.fn(),
  mockPaymentTransactionFindUnique: vi.fn(),
  mockPaymentTransactionDeleteMany: vi.fn(),
  mockReconcileBeds: vi.fn(),
  mockEnqueueHosting: vi.fn(),
  mockSettleHosting: vi.fn(),
  mockIsValidCronSecret: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

// #3267: a replayed attempt that already names its intent is RETRIEVED, and a
// superseded attempt's intent is cancelled through the with-result variant.
vi.mock("@/lib/stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
  getPaymentIntent: (...args: unknown[]) => mockGetPaymentIntent(...args),
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellableWithResult(...args),
}));

vi.mock("@/lib/cron-auth", () => ({
  isValidCronSecret: (...args: unknown[]) => mockIsValidCronSecret(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
}));

// #3267: the route records its charge through the attempt module, exercised for
// real here; that module reads `isCapturedTransactionStatus` from this module
// and re-derives the aggregate through `reconcilePaymentAggregates`, the one
// export replaced (the real one needs a Payment row to read).
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...args: unknown[]) => mockAcquireLodgeCapacityLock(...args),
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mockCheckCapacityForGuestRanges(...args),
}));

// #3267: the claim reconciles beds under the lodge lock and records the #2576
// hosting seam, exactly as the cron and the admin confirm-pending-guests route do.
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: (...args: unknown[]) =>
    mockReconcileBeds(...args),
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mockReconcileBeds(...args),
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: (...args: unknown[]) => mockEnqueueHosting(...args),
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...args: unknown[]) => mockSettleHosting(...args),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-1"),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The transaction client the route receives inside prisma.$transaction, reusing
// the same underlying mocks so assertions on booking.updateMany and the ledger
// see the calls made inside the advisory-locked transactions too. Built by a
// function (not a top-level const) because the hoisted prisma factory below
// needs the same ledger surface on the base client.
function paymentTransactionMocks() {
  return {
    findMany: (...args: unknown[]) => mockPaymentTransactionFindMany(...args),
    create: (...args: unknown[]) => mockPaymentTransactionCreate(...args),
    update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
    updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
    findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
    deleteMany: (...args: unknown[]) => mockPaymentTransactionDeleteMany(...args),
  };
}
const txClient = {
  $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
  booking: {
    findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
    updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    update: (...args: unknown[]) => mockBookingUpdate(...args),
  },
  paymentTransaction: paymentTransactionMocks(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
    },
    payment: {
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
    paymentTransaction: {
      findMany: (...args: unknown[]) => mockPaymentTransactionFindMany(...args),
      create: (...args: unknown[]) => mockPaymentTransactionCreate(...args),
      update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
      updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
      deleteMany: (...args: unknown[]) => mockPaymentTransactionDeleteMany(...args),
    },
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
  },
}));

import { POST } from "@/app/api/payments/charge-saved-method/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import { PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY } from "@/lib/payment-recovery-contract";

/** #3267: the id the attempt row is minted with; the Stripe key is built from it. */
const ATTEMPT_ROW_ID = "txn_attempt_1";
const ATTEMPT_KEY = `pending_charge_booking-1_${ATTEMPT_ROW_ID}`;
const HOLD_UNTIL = new Date("2026-07-08T00:00:00.000Z");

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/payments/charge-saved-method", {
    method: "POST",
    body: JSON.stringify({ bookingId: "booking-1" }),
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: null,
    status: "PENDING",
    finalPriceCents: 12500,
    nonMemberHoldUntil: HOLD_UNTIL,
    capacityOverriddenAt: null,
    checkIn: new Date("2026-07-10"),
    checkOut: new Date("2026-07-12"),
    guests: [
      {
        id: "guest-1",
        stayStart: new Date("2026-07-10"),
        stayEnd: new Date("2026-07-11"),
      },
      {
        id: "guest-2",
        stayStart: new Date("2026-07-11"),
        stayEnd: new Date("2026-07-12"),
      },
    ],
    payment: {
      id: "payment-1",
      stripePaymentMethodId: "pm_123",
      stripeCustomerId: "cus_123",
      // #3269: saved through a SetupIntent, so reusable off-session.
      stripeSetupIntentId: "seti_123",
    },
    member: {
      firstName: "Alice",
      lastName: "Example",
    },
    ...overrides,
  };
}

/** The CONFIRMED -> PENDING revert, if the route made one. */
function releaseCall() {
  return mockBookingUpdateMany.mock.calls.find(
    ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING",
  );
}
/** The PENDING -> CONFIRMED claim, if the route made one. */
function claimCall() {
  return mockBookingUpdateMany.mock.calls.find(
    ([call]) => call?.where?.status === "PENDING" && call?.data?.status === "CONFIRMED",
  );
}
/**
 * The pre-lock and locked reads answer with `booking`; the release's
 * status-only re-read (#3267: the release re-reads the claim under its locks
 * and hands back only a booking still CONFIRMED) answers CONFIRMED once a claim
 * has been made, because the mock store is not stateful. Pass `releaseStatus`
 * to model a webhook that settled the booking in between.
 */
function primeBooking(
  booking: ReturnType<typeof makeBooking>,
  releaseStatus: string = "CONFIRMED",
) {
  mockBookingFindUnique.mockImplementation(
    async ({ select }: { select?: { status?: boolean } }) =>
      select?.status && Object.keys(select).length === 1 && claimCall()
        ? { status: releaseStatus }
        : booking,
  );
}
/** The settle write for `paymentIntentId`, if the route made one (#3267: a status-guarded updateMany). */
function settleCall(paymentIntentId: string) {
  return mockPaymentTransactionUpdateMany.mock.calls.find(
    ([call]) => call?.data?.stripePaymentIntentId === paymentIntentId,
  );
}
function orderOf(mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, call: unknown[]) {
  return mock.mock.invocationCallOrder[mock.mock.calls.indexOf(call)]!;
}

describe("POST /api/payments/charge-saved-method", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockIsValidCronSecret.mockReturnValue(false);
    primeBooking(makeBooking());
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentUpdate.mockResolvedValue({});
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});
    mockExecuteRaw.mockResolvedValue(1);
    mockAcquireLodgeCapacityLock.mockResolvedValue(undefined);
    mockReconcileBeds.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
    mockEnqueueHosting.mockResolvedValue(null);
    mockSettleHosting.mockResolvedValue(undefined);
    mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg(txClient);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
    // #3267: no earlier attempt on the ledger; a fresh row is minted and
    // settled in place.
    mockPaymentTransactionFindMany.mockResolvedValue([]);
    mockPaymentTransactionCreate.mockResolvedValue({ id: ATTEMPT_ROW_ID });
    mockPaymentTransactionUpdate.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id, paymentId: "payment-1" }),
    );
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentTransactionFindUnique.mockResolvedValue(null);
    mockPaymentTransactionDeleteMany.mockResolvedValue({ count: 0 });
    mockReconcilePaymentAggregates.mockResolvedValue(null);
    mockGetPaymentIntent.mockResolvedValue(null);
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { status: "canceled" },
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
  });

  it("marks the booking PAID immediately when the off-session charge succeeds", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_1",
      status: "succeeded",
      amount: 12500,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      paymentIntentId: "pi_success_1",
      status: "succeeded",
    });

    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_success_1",
      amountCents: 12500,
      paymentMethodId: null,
    });
    // The capacity re-check consumes the post-lock snapshot on the tx client.
    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      "lodge-1",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      expect.arrayContaining([
        expect.objectContaining({
          stayStart: new Date("2026-07-10"),
          stayEnd: new Date("2026-07-11"),
        }),
        expect.objectContaining({
          stayStart: new Date("2026-07-11"),
          stayEnd: new Date("2026-07-12"),
        }),
      ]),
      "booking-1",
      txClient,
    );
    // A captured charge never releases the claim.
    expect(releaseCall()).toBeUndefined();
  });

  describe("the claim (#3267, the shape the cron and confirm-pending-guests already take)", () => {
    it("claims PENDING -> CONFIRMED under lock(1) then the lodge lock, re-checks capacity and mints the attempt row inside that transaction, all BEFORE Stripe is asked anything", async () => {
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_1",
        status: "succeeded",
        amount: 12500,
        payment_method: "pm_123",
      });

      const response = await POST(makeRequest());
      expect(response.status).toBe(200);

      // Order inside the claim: global lock(1) -> lodge lock -> capacity
      // re-check -> status-guarded claim -> attempt row -> only then Stripe.
      expect(mockExecuteRaw).toHaveBeenCalled();
      expect(mockAcquireLodgeCapacityLock).toHaveBeenCalledWith(txClient, "lodge-1");
      const claim = claimCall();
      expect(claim?.[0]).toEqual({
        where: { id: "booking-1", status: "PENDING" },
        data: { status: "CONFIRMED", nonMemberHoldUntil: null },
      });
      const order = [
        mockExecuteRaw.mock.invocationCallOrder[0]!,
        mockAcquireLodgeCapacityLock.mock.invocationCallOrder[0]!,
        mockCheckCapacityForGuestRanges.mock.invocationCallOrder[0]!,
        mockBookingUpdateMany.mock.invocationCallOrder[mockBookingUpdateMany.mock.calls.indexOf(claim!)]!,
        mockReconcileBeds.mock.invocationCallOrder[0]!,
        mockEnqueueHosting.mock.invocationCallOrder[0]!,
        mockPaymentTransactionCreate.mock.invocationCallOrder[0]!,
        mockChargePaymentMethod.mock.invocationCallOrder[0]!,
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The attempt row: PENDING, this card, this path's reason, on the row the
      // route read; its key is built from its own id.
      expect(mockPaymentTransactionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentId: "payment-1",
          kind: "PRIMARY",
          source: "STRIPE",
          amountCents: 12500,
          status: "PENDING",
          paymentMethodId: "pm_123",
          reason: "pending_saved_method_charge",
        }),
        select: { id: true },
      });
      expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
        where: { id: ATTEMPT_ROW_ID },
        data: { reference: ATTEMPT_KEY },
      });
      // #2576 §9: the seam is recorded with the claim and drained after commit.
      expect(mockEnqueueHosting).toHaveBeenCalledWith(
        "booking-1",
        txClient,
        expect.objectContaining({ cause: "SYSTEM_CHANGE", actorMemberId: "admin-1" }),
      );
      expect(mockSettleHosting).toHaveBeenCalledWith({ bookingId: "booking-1" });
      expect(mockSettleHosting.mock.invocationCallOrder[0]!).toBeLessThan(
        mockChargePaymentMethod.mock.invocationCallOrder[0]!,
      );
    });

    it("charges under the attempt row's own key with the shared { bookingId, memberId } metadata, and records the capture on that row before reconciling", async () => {
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_1",
        status: "succeeded",
        amount: 12500,
        payment_method: "pm_123",
      });

      await POST(makeRequest());

      expect(mockChargePaymentMethod).toHaveBeenCalledWith({
        amountCents: 12500,
        customerId: "cus_123",
        paymentMethodId: "pm_123",
        metadata: { bookingId: "booking-1", memberId: "member-1" },
        idempotencyKey: ATTEMPT_KEY,
      });
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      // Forward only: a capture is written over anything but refund history.
      const settle = settleCall("pi_1");
      expect(settle?.[0]).toEqual({
        where: { id: ATTEMPT_ROW_ID, status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] } },
        data: {
          stripePaymentIntentId: "pi_1",
          status: "SUCCEEDED",
          amountCents: 12500,
          paymentMethodId: "pm_123",
        },
      });
      expect(orderOf(mockPaymentTransactionUpdateMany, settle!)).toBeLessThan(
        mockMarkBookingPaymentSucceeded.mock.invocationCallOrder[0]!,
      );
      expect(mockReconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: "payment-1", store: expect.anything() });
    });

    it("charges the card on the row UNDER THE LOCKS, not the pre-lock snapshot: a card replaced between the two reads is the one charged and the one the attempt row records", async () => {
      const preLock = makeBooking();
      const locked = makeBooking({
        payment: { id: "payment-1", stripePaymentMethodId: "pm_replaced", stripeCustomerId: "cus_123", stripeSetupIntentId: "seti_replaced" },
      });
      mockBookingFindUnique.mockImplementation(async ({ select, include }: { select?: { status?: boolean }; include?: Record<string, unknown> }) => {
        if (select?.status && Object.keys(select).length === 1) return { status: "CONFIRMED" };
        // The locked read is the one that asks for the payment row; the pre-lock
        // read asks for member + payment + guests.
        return include && !("member" in include) ? locked : preLock;
      });
      mockChargePaymentMethod.mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 12500, payment_method: "pm_replaced" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The locked read carries the card columns.
      expect(mockBookingFindUnique).toHaveBeenCalledWith({
        where: { id: "booking-1" },
        include: { guests: { include: { nights: true } }, payment: true },
      });
      expect(mockPaymentTransactionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ paymentMethodId: "pm_replaced" }),
        select: { id: true },
      });
      expect(mockChargePaymentMethod).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodId: "pm_replaced" }),
      );
    });

    it("answers 409 and charges nothing when the card is gone by the time the locks are held (retired or mid-replacement)", async () => {
      const preLock = makeBooking();
      const locked = makeBooking({
        payment: { id: "payment-1", stripePaymentMethodId: null, stripeCustomerId: "cus_123", stripeSetupIntentId: "seti_replacing" },
      });
      mockBookingFindUnique.mockImplementation(async ({ include }: { include?: Record<string, unknown> }) =>
        include && !("member" in include) ? locked : preLock,
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "No saved payment method found for this booking" });
      expect(claimCall()).toBeUndefined();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    });

    it("returns 409 without claiming or charging when the post-lock capacity re-check fails", async () => {
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: false,
        minAvailable: -1,
        nightDetails: [],
      });

      const response = await POST(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("capacity");
      expect(claimCall()).toBeUndefined();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("returns 409 when the booking is no longer PENDING under the lock, or when the status-guarded claim loses", async () => {
      mockBookingFindUnique
        .mockResolvedValueOnce(makeBooking())
        .mockResolvedValueOnce(makeBooking({ status: "CANCELLED" }));
      let response = await POST(makeRequest());
      expect(response.status).toBe(409);
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mockBookingFindUnique.mockResolvedValue(makeBooking());
      mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txClient));
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });
      response = await POST(makeRequest());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Booking is no longer pending" });
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    });

    it("releases the claim (CONFIRMED -> PENDING, hold restored, beds reconciled) and alerts admins in Stripe's words when the charge THROWS; a definite refusal has ended the attempt row", async () => {
      mockChargePaymentMethod.mockRejectedValue(
        stripeSdkError({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." }),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to charge saved payment method" });
      expect(releaseCall()?.[0]).toEqual({
        where: { id: "booking-1", status: "CONFIRMED" },
        data: { status: "PENDING", nonMemberHoldUntil: HOLD_UNTIL },
      });
      // Both transactions on this path — the claim and the release — take both
      // locks; the release re-locks rather than running unserialised.
      expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
      expect(mockAcquireLodgeCapacityLock).toHaveBeenCalledTimes(2);
      expect(mockReconcileBeds).toHaveBeenCalledTimes(2);
      // The attempt row is FAILED (status-guarded) BEFORE the claim is handed back.
      const failedMark = mockPaymentTransactionUpdateMany.mock.calls.find(
        ([call]) => call?.data?.status === "FAILED",
      );
      expect(failedMark?.[0]).toEqual({
        where: { id: ATTEMPT_ROW_ID, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED" },
      });
      expect(
        mockPaymentTransactionUpdateMany.mock.invocationCallOrder[
          mockPaymentTransactionUpdateMany.mock.calls.indexOf(failedMark!)
        ]!,
      ).toBeLessThan(
        mockBookingUpdateMany.mock.invocationCallOrder[mockBookingUpdateMany.mock.calls.indexOf(releaseCall()!)]!,
      );
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 12500,
          errorMessage: "Your card has insufficient funds.",
        }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.failed" }),
      );
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("an ambiguous failure (api_error) leaves the attempt row PENDING for the next attempt to ask about, and still releases the claim", async () => {
      mockChargePaymentMethod.mockRejectedValue(stripeSdkError({ type: "api_error", message: "Stripe is having a moment" }));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(releaseCall()).toBeDefined();
      expect(
        mockPaymentTransactionUpdateMany.mock.calls.find(([call]) => call?.data?.status === "FAILED"),
      ).toBeUndefined();
    });

    it("a non-captured answer (3DS outstanding) records the intent on the attempt row inside the locked release, hands the claim back, alerts, and answers 409 saying what happened — not success", async () => {
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_3ds",
        status: "requires_action",
        amount: 12500,
        payment_method: "pm_123",
      });

      const response = await POST(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ success: false, paymentIntentId: "pi_3ds", status: "requires_action" });
      expect(body.error).toContain("3D Secure");
      expect(releaseCall()?.[0]).toEqual({
        where: { id: "booking-1", status: "CONFIRMED" },
        data: { status: "PENDING", nonMemberHoldUntil: HOLD_UNTIL },
      });
      const settle = settleCall("pi_3ds");
      // Forward only: a non-capture is written only over an unresolved row.
      expect(settle?.[0]).toEqual({
        where: { id: ATTEMPT_ROW_ID, status: { in: ["PENDING", "PROCESSING"] } },
        data: { stripePaymentIntentId: "pi_3ds", status: "PROCESSING", amountCents: 12500, paymentMethodId: "pm_123" },
      });
      // Recorded inside the release transaction: after its locks, before the
      // status re-read that fences the release, before the revert.
      const settleOrder = orderOf(mockPaymentTransactionUpdateMany, settle!);
      expect(settleOrder).toBeGreaterThan(mockAcquireLodgeCapacityLock.mock.invocationCallOrder[1]!);
      const statusReRead = mockBookingFindUnique.mock.calls.findIndex(
        ([call]) => call?.select?.status && Object.keys(call.select).length === 1,
      );
      expect(statusReRead).toBeGreaterThanOrEqual(0);
      expect(settleOrder).toBeLessThan(mockBookingFindUnique.mock.invocationCallOrder[statusReRead]!);
      expect(settleOrder).toBeLessThan(
        mockBookingUpdateMany.mock.invocationCallOrder[mockBookingUpdateMany.mock.calls.indexOf(releaseCall()!)]!,
      );
      expect(mockReconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: "payment-1", store: txClient });
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_3ds", errorMessage: expect.stringContaining("3D Secure") }),
      );
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.failed" }),
      );
    });

    it("does NOT release a claim the webhook has already settled: the retrieve said processing, the succeeded webhook moved the booking to PAID before the release took its locks — the answer is recorded forward-only and the booking is left alone", async () => {
      // The booking reads PAID at the release's status re-read.
      primeBooking(makeBooking(), "PAID");
      mockChargePaymentMethod.mockResolvedValue({ id: "pi_race", status: "processing", amount: 12500, payment_method: "pm_123" });
      // The webhook adopted the row and settled it: the forward-only guard
      // refuses our stale PROCESSING write (count 0), and the row reads
      // SUCCEEDED when re-read.
      mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
      mockPaymentTransactionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
        where.id ? { status: "SUCCEEDED" } : null,
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(409);
      // The settle was attempted under the release's locks, with the unresolved guard...
      expect(settleCall("pi_race")?.[0].where).toEqual({ id: ATTEMPT_ROW_ID, status: { in: ["PENDING", "PROCESSING"] } });
      // ...and refused, so no reconcile ran and the claim was NOT handed back
      // (a CONFIRMED -> PENDING write here would have matched nothing anyway,
      // but the point is that the route knows it and says so instead of
      // pretending to release).
      expect(mockReconcilePaymentAggregates).not.toHaveBeenCalled();
      expect(releaseCall()).toBeUndefined();
      expect(mockReconcileBeds).toHaveBeenCalledTimes(1);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("a claim lost to an actor other than the settling webhook is an ANOMALY: a booking reading CANCELLED at the release is logged at error level, not warned about (#3267 fix round 2)", async () => {
      // The fence is right either way — a status-guarded release would match
      // nothing — but before this round every non-CONFIRMED status was warned
      // about identically, so a booking cancelled mid-charge passed silently.
      const logger = (await import("@/lib/logger")).default;
      primeBooking(makeBooking(), "CANCELLED");
      mockChargePaymentMethod.mockResolvedValue({ id: "pi_race", status: "processing", amount: 12500, payment_method: "pm_123" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(409);
      expect(releaseCall()).toBeUndefined();
      const said = (calls: unknown[][], needle: string) =>
        calls.some((call) => typeof call[1] === "string" && call[1].includes(needle));
      expect(said(vi.mocked(logger.error).mock.calls, "lost its CONFIRMED claim to another actor")).toBe(true);
      expect(said(vi.mocked(logger.warn).mock.calls, "already PAID at release")).toBe(false);
    });

    it("alerts with the amount that was CHARGED, not the pre-lock snapshot's: a price that moved between the two reads (#3267 fix round 2)", async () => {
      // The charge already used the post-lock `finalPriceCents`; the operator
      // alert used the pre-lock one, so an alert could name a figure nobody was
      // ever asked for.
      const preLock = makeBooking();
      const locked = makeBooking({ finalPriceCents: 19900 });
      mockBookingFindUnique.mockImplementation(async ({ select, include }: { select?: { status?: boolean }; include?: Record<string, unknown> }) => {
        if (select?.status && Object.keys(select).length === 1) return { status: "CONFIRMED" };
        return include && !("member" in include) ? locked : preLock;
      });
      mockChargePaymentMethod.mockResolvedValue({ id: "pi_3ds", status: "requires_action", amount: 19900, payment_method: "pm_123" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(409);
      expect(mockChargePaymentMethod).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 19900 }));
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_3ds", amountCents: 19900 }),
      );
    });

    it("the thrown-charge alert also names the CHARGED amount, not the pre-lock snapshot's (#3267 fix round 2)", async () => {
      // The outer catch's alert reads its own context, captured next to the
      // claim; it has to carry the same post-lock figure as the branch above.
      const preLock = makeBooking();
      const locked = makeBooking({ finalPriceCents: 19900 });
      mockBookingFindUnique.mockImplementation(async ({ select, include }: { select?: { status?: boolean }; include?: Record<string, unknown> }) => {
        if (select?.status && Object.keys(select).length === 1) return { status: "CONFIRMED" };
        return include && !("member" in include) ? locked : preLock;
      });
      mockChargePaymentMethod.mockRejectedValue(stripeSdkError({ type: "api_error", message: "Stripe is having a moment" }));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 19900, errorMessage: "Stripe is having a moment" }),
      );
    });

    it("REPLAYS the cron's unresolved attempt on the same card: Stripe is asked about that intent, no second charge is made, and its outcome settles the same row", async () => {
      mockPaymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn_cron",
          status: "PROCESSING",
          amountCents: 12500,
          refundedAmountCents: 0,
          paymentMethodId: "pm_123",
          stripePaymentIntentId: "pi_cron",
          reference: "pending_charge_booking-1_txn_cron",
          reason: "pending_hold_auto_charge",
        },
      ]);
      mockGetPaymentIntent.mockResolvedValue({
        id: "pi_cron",
        status: "succeeded",
        amount: 12500,
        payment_method: "pm_123",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, paymentIntentId: "pi_cron" });
      expect(mockGetPaymentIntent).toHaveBeenCalledWith("pi_cron");
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "txn_cron" }),
          data: expect.objectContaining({ status: "SUCCEEDED" }),
        }),
      );
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_cron" }),
      );
    });

    it("refuses (409) and alerts when a captured charge is already recorded on the still-pending booking, charging nothing", async () => {
      mockPaymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn_paid",
          status: "SUCCEEDED",
          amountCents: 12500,
          refundedAmountCents: 0,
          paymentMethodId: "pm_123",
          stripePaymentIntentId: "pi_paid",
          reference: null,
          reason: null,
        },
      ]);

      const response = await POST(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ paymentIntentId: "pi_paid" });
      expect(body.error).toContain("already recorded");
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_paid" }),
      );
      // The transaction threw, so nothing it wrote is committed; no release runs.
      expect(releaseCall()).toBeUndefined();
    });
  });

  it("refuses (400) a card written by a one-off checkout — no SetupIntent — and never calls Stripe (#3269)", async () => {
    mockBookingFindUnique.mockResolvedValue(
      makeBooking({
        guests: [],
        // Customer + pm alone used to pass this route's guard. Stripe refuses to
        // charge a payment method it captured without customer attachment, so
        // the route must refuse first.
        payment: {
          id: "payment-1",
          stripePaymentMethodId: "pm_oneoff",
          stripeCustomerId: "cus_123",
          stripeSetupIntentId: null,
        },
      }),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "No saved payment method found for this booking",
    });
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("charges the row's own SetupIntent-saved card (#3269)", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_own",
      status: "succeeded",
      amount: 12500,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_123", paymentMethodId: "pm_123" })
    );
  });

  // #1771 — a booking deliberately admitted over the ceiling by an admin carries
  // a persisted capacityOverriddenAt marker. The saved-card preflight must NOT
  // 409 it: the charge proceeds (and markBookingPaymentSucceeded, which honours
  // the same override, settles it).
  it("charges an over-capacity booking with a persisted capacity override instead of 409ing (#1771)", async () => {
    mockBookingFindUnique.mockResolvedValue(
      makeBooking({
        capacityOverriddenAt: new Date("2026-06-01"),
        capacityOverriddenByMemberId: "admin-1",
        guests: [{ id: "guest-1", stayStart: new Date("2026-07-10"), stayEnd: new Date("2026-07-12") }],
      }),
    );
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_override",
      status: "succeeded",
      amount: 12500,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockChargePaymentMethod).toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
  });

  it("returns privacy-safe status recovery without reverting after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_2",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new Error('Payment update failed: constraint "Payment_secret_fkey"'),
    );

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY);
    expect(body).not.toHaveProperty("finalisationPending");
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(JSON.stringify(body)).not.toContain("Payment_secret_fkey");
    // Money is captured: the CONFIRMED claim keeps the beds; it is never reverted.
    expect(releaseCall()).toBeUndefined();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_success_2" }),
    );
  });

  it("returns the fixed recovery 409 to an admin after a captured charge hits participant contention", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_hosting_retry",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
      finalisationPending: true,
    });
    // The capture was recorded on the attempt row before reconciliation, so the
    // webhook can finish the promotion.
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ATTEMPT_ROW_ID }),
        data: expect.objectContaining({ stripePaymentIntentId: "pi_hosting_retry", status: "SUCCEEDED" }),
      }),
    );
    expect(releaseCall()).toBeUndefined();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_hosting_retry" }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.payment.failed" }),
    );
  });

  it("rethrows participant contention for the cron caller after preserving the captured charge", async () => {
    mockIsValidCronSecret.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_cron_hosting_retry",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    await expect(
      POST(makeRequest({ "x-cron-secret": "test" })),
    ).rejects.toMatchObject({ code: HOSTING_COVERAGE_RETRY_CODE });
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stripePaymentIntentId: "pi_cron_hosting_retry", status: "SUCCEEDED" }),
      }),
    );
    expect(releaseCall()).toBeUndefined();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalled();
  });

  it("returns status-unconfirmed recovery for an ordinary cron failure after capture", async () => {
    mockIsValidCronSecret.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_cron_status_unknown",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new Error("local persistence unavailable"),
    );

    const response = await POST(makeRequest({ "x-cron-secret": "test" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
    );
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalled();
  });

  it("still succeeds when Xero invoice queueing fails after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_3",
      status: "succeeded",
      amount: 12500,
    });
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero down"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("booking-1", {
      createdByMemberId: "admin-1",
    });
  });
});

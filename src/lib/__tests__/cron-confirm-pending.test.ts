import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Stripe
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

const mockChargePaymentMethod = vi.fn();
const mockMarkBookingPaymentSucceeded = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({
  queueOperationId: "op_1",
  message: "queued",
});
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue({
  found: 1,
  processed: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
});
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
}));
vi.mock("../xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("../payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
}));

vi.mock("../payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));

vi.mock("../waitlist", () => ({
  processWaitlistForDates: vi.fn().mockResolvedValue(undefined),
}));

// Mock email
const mockSendConfirmedEmail = vi.fn();
const mockSendBumpedEmail = vi.fn();
const mockSendGuestsRemovedEmail = vi.fn();
const mockSendGuestsCancelledEmail = vi.fn();
const mockSendAdminPaymentFailureAlert = vi.fn().mockResolvedValue(undefined);
const mockSendAdminHoldExpiredAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("../email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendConfirmedEmail(...args),
  sendBookingBumpedEmail: (...args: unknown[]) => mockSendBumpedEmail(...args),
  sendBookingGuestsRemovedEmail: (...args: unknown[]) => mockSendGuestsRemovedEmail(...args),
  sendBookingGuestsCancelledEmail: (...args: unknown[]) => mockSendGuestsCancelledEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendAdminBookingRequestHoldExpiredEmail: (...args: unknown[]) =>
    mockSendAdminHoldExpiredAlert(...args),
}));

// The confirm-pending cron revokes payment links for bumped bookings
// (issue #707); the behaviour itself is covered in payment-link.test.ts.
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: vi.fn().mockResolvedValue(0),
}));

// Mock the partial-bump helper (its internals are unit-tested separately).
const mockApplyPartialBump = vi.fn();
vi.mock("../partial-bump", () => ({
  applyPartialBumpInTransaction: (...args: unknown[]) => mockApplyPartialBump(...args),
}));

// Mock promo cleanup used by the whole-bump path.
const mockDeletePromoRedemption = vi.fn().mockResolvedValue(undefined);
vi.mock("../promo", () => ({
  deletePromoRedemptionAndAdjustCount: (...args: unknown[]) =>
    mockDeletePromoRedemption(...args),
}));

// Mock capacity
const mockCheckCapacityForGuestRanges = vi.fn();
vi.mock("../capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mockCheckCapacityForGuestRanges(...args),
  LODGE_CAPACITY: 29,
}));

// Mock Prisma
const mockBookingFindMany = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockPromoRedemptionFindUnique = vi.fn();
const mockPrismaTransaction = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    payment: {
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
    promoRedemption: {
      findUnique: (...args: unknown[]) => mockPromoRedemptionFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
  },
}));

const { confirmPendingBookings } = await import("../cron-confirm-pending");

function makePendingBooking(
  id: string,
  opts: {
    checkIn?: string;
    checkOut?: string;
    guestCount?: number;
    holdUntil?: string;
    hasPaymentMethod?: boolean;
    finalPriceCents?: number;
  } = {}
) {
  const {
    checkIn = "2026-07-15",
    checkOut = "2026-07-17",
    guestCount = 2,
    holdUntil = "2026-07-08",
    hasPaymentMethod = true,
    finalPriceCents = 10000,
  } = opts;
  const stayStart = new Date(checkIn);
  const stayEnd = new Date(checkOut);

  return {
    id,
    memberId: `member_${id}`,
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    status: "PENDING",
    finalPriceCents,
    discountCents: 0,
    nonMemberHoldUntil: new Date(holdUntil),
    hasNonMembers: true,
    promoRedemption: null,
    createdAt: new Date("2026-03-01"),
    member: {
      id: `member_${id}`,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
    },
    guests: Array.from({ length: guestCount }, (_, i) => ({
      id: `guest_${id}_${i}`,
      bookingId: id,
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT",
      isMember: false,
      stayStart,
      stayEnd,
      priceCents: 5000,
    })),
    payment: hasPaymentMethod
      ? {
          id: `pay_${id}`,
          bookingId: id,
          stripePaymentMethodId: `pm_${id}`,
          stripeCustomerId: `cus_${id}`,
          stripeSetupIntentId: `seti_${id}`,
          amountCents: finalPriceCents,
          status: "PENDING",
        }
      : null,
  };
}

describe("Cron: Confirm Pending Bookings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueXeroBookingInvoiceOperation.mockResolvedValue({
      queueOperationId: "op_1",
      message: "queued",
    });
    mockKickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPromoRedemptionFindUnique.mockResolvedValue(null);
    mockDeletePromoRedemption.mockResolvedValue(undefined);
    mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          booking: {
            update: (...args: unknown[]) => mockBookingUpdate(...args),
          },
        });
      }

      return Promise.all(arg as Promise<unknown>[]);
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "b1",
      bumpedBookingIds: [],
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
  });

  it("confirms a booking when capacity is available and payment succeeds", async () => {
    const booking = makePendingBooking("b1");
    const expectedIdempotencyKey = ["pending", "charge", "b1"].join("_");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    expect(mockChargePaymentMethod).toHaveBeenCalledWith({
      amountCents: 10000,
      customerId: "cus_b1",
      paymentMethodId: "pm_b1",
      metadata: { bookingId: "b1", memberId: "member_b1" },
      idempotencyKey: expectedIdempotencyKey,
    });

    expect(mockSendConfirmedEmail).toHaveBeenCalledWith(
      "b1@example.com",
      "Test",
      booking.checkIn,
      booking.checkOut,
      2,
      10000,
      undefined
    );
  });

  it("bumps a booking when capacity is not available", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);

    // Whole bump now uses the status-claim pattern for idempotency.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "BUMPED" },
    });

    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockSendBumpedEmail).toHaveBeenCalled();
  });

  it("fails gracefully when no payment method is saved", async () => {
    const booking = makePendingBooking("b1", { hasPaymentMethod: false });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("processes multiple bookings independently", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockBookingFindMany.mockResolvedValue([booking1, booking2]);

    // b1: available, payment succeeds
    // b2: not available, bump
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] })
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] });

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toEqual(["b2"]);
  });

  it("handles Stripe charge failure gracefully", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockRejectedValue(new Error("Card declined"));

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
  });

  it("handles payment in processing state (requires_action)", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "requires_action",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    // Not confirmed yet (waiting for webhook), not failed
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_b1",
        paymentIntentId: "pi_auto_1",
        amountCents: 10000,
        status: "PROCESSING",
      })
    );
    expect(mockBookingUpdate).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { status: "PENDING" },
    });
  });

  it("does nothing when no pending bookings are past hold deadline", async () => {
    mockBookingFindMany.mockResolvedValue([]);

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);
    expect(mockCheckCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("continues processing remaining bookings when one fails", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockBookingFindMany.mockResolvedValue([booking1, booking2]);

    mockCheckCapacityForGuestRanges
      .mockRejectedValueOnce(new Error("DB error")) // b1 fails
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] }); // b2 succeeds

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_2",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toEqual(["b2"]);
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("passes guest stay ranges and booking ID to range capacity as excludeBookingId", async () => {
    const booking = makePendingBooking("b1", { guestCount: 3 });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    await confirmPendingBookings();

    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      "b1"
    );
  });

  it("continues when Xero invoice queueing fails during pending confirmation", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero unavailable"));

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("b1");
  });

  it("does not revert or alert when local persistence fails after Stripe already succeeded", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValueOnce(
      new Error("Payment update failed")
    );

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  // --- issue #708: flag, partial bump, fallback, request-origin, idempotency ---

  function makeMixedPendingBooking(
    opts: {
      id?: string;
      cancelIfGuestsBumped?: boolean;
      hasPaymentMethod?: boolean;
      finalPriceCents?: number;
    } = {}
  ) {
    const {
      id = "b1",
      cancelIfGuestsBumped = false,
      hasPaymentMethod = true,
      finalPriceCents = 18000,
    } = opts;
    const base = makePendingBooking(id, { hasPaymentMethod, finalPriceCents });
    base.guests = [
      {
        id: `${id}_m0`,
        bookingId: id,
        firstName: "Member",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: true,
        memberId: `mem_${id}`,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 8000,
      },
      {
        id: `${id}_n0`,
        bookingId: id,
        firstName: "NonMember",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 10000,
      },
    ];
    return { ...base, cancelIfGuestsBumped };
  }

  function partialResultFor(booking: ReturnType<typeof makeMixedPendingBooking>, finalCents: number) {
    return {
      kind: "partial" as const,
      removedGuests: [booking.guests[1]],
      remainingGuests: [booking.guests[0]],
      newTotalPriceCents: finalCents,
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      newFinalPriceCents: finalCents,
      promoRemoved: false,
    };
  }

  it("cancels the whole booking when the cancel-if-guests-bumped flag is set", async () => {
    const booking = makeMixedPendingBooking({ cancelIfGuestsBumped: true });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "BUMPED" },
    });
    expect(mockSendGuestsCancelledEmail).toHaveBeenCalled();
    expect(mockSendBumpedEmail).not.toHaveBeenCalled();
    expect(mockApplyPartialBump).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("partial-bumps and charges the reduced amount by default", async () => {
    const booking = makeMixedPendingBooking({ finalPriceCents: 18000 });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] })
      .mockResolvedValueOnce({ available: true, minAvailable: 5, nightDetails: [] });
    mockApplyPartialBump.mockResolvedValue(partialResultFor(booking, 8000));
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_partial",
      status: "succeeded",
      amount: 8000,
    });
    mockPaymentUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(mockApplyPartialBump).toHaveBeenCalled();
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 8000, idempotencyKey: "pending_charge_b1" })
    );
    expect(result.partialBumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(mockSendGuestsRemovedEmail).toHaveBeenCalledWith(
      "b1@example.com",
      "Test",
      booking.checkIn,
      booking.checkOut,
      1,
      8000
    );
    expect(mockSendConfirmedEmail).not.toHaveBeenCalled();
  });

  it("falls back to a whole bump when members alone still don't fit", async () => {
    const booking = makeMixedPendingBooking();
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] })
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] });
    mockApplyPartialBump.mockResolvedValue(partialResultFor(booking, 8000));

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "BUMPED" },
    });
    expect(mockSendBumpedEmail).toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("moves a no-card booking to payment-owed without charging after partial bump", async () => {
    const booking = makeMixedPendingBooking({ hasPaymentMethod: false, finalPriceCents: 8000 });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] })
      .mockResolvedValueOnce({ available: true, minAvailable: 5, nightDetails: [] });
    mockApplyPartialBump.mockResolvedValue(partialResultFor(booking, 8000));

    const result = await confirmPendingBookings();

    expect(result.partialBumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Routed to payment-owed (not left stranded in PENDING with a cleared hold).
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING" },
    });
    expect(mockSendGuestsRemovedEmail).toHaveBeenCalled();
  });

  it("skips when the partial-bump claim was already processed (idempotent)", async () => {
    const booking = makeMixedPendingBooking();
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValueOnce({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockApplyPartialBump.mockResolvedValue({ kind: "already-processed" });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.bumpedBookingIds).toEqual([]);
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockSendGuestsRemovedEmail).not.toHaveBeenCalled();
  });

  it("extends the hold and alerts admins for a request-origin booking, never charging it (#707)", async () => {
    const booking = {
      ...makePendingBooking("b1", { hasPaymentMethod: false }),
      originBookingRequest: { id: "req_1" },
    };
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // Request-origin bookings pay via a tokenised link, never a saved card.
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Hold extended via the status-claim; booking stays PENDING (not failed).
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "b1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(result.failedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(mockSendAdminHoldExpiredAlert).toHaveBeenCalled();
  });
});

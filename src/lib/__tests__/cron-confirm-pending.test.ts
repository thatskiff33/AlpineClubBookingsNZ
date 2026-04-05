import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Stripe
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

const mockChargePaymentMethod = vi.fn();
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
}));

// Mock email
const mockSendConfirmedEmail = vi.fn();
const mockSendBumpedEmail = vi.fn();
const mockSendAdminPaymentFailureAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("../email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendConfirmedEmail(...args),
  sendBookingBumpedEmail: (...args: unknown[]) => mockSendBumpedEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
}));

// Mock capacity
const mockCheckCapacity = vi.fn();
vi.mock("../capacity", () => ({
  checkCapacity: (...args: unknown[]) => mockCheckCapacity(...args),
  LODGE_CAPACITY: 29,
}));

// Mock Prisma
const mockBookingFindMany = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockPaymentUpdate = vi.fn();
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
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPrismaTransaction.mockImplementation(async (actions: unknown[]) => {
      // Execute all Prisma actions in the transaction array
      return Promise.all(actions as Promise<unknown>[]);
    });
  });

  it("confirms a booking when capacity is available and payment succeeds", async () => {
    const booking = makePendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({
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
    mockCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);

    expect(mockBookingUpdate).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { status: "BUMPED" },
    });

    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockSendBumpedEmail).toHaveBeenCalled();
  });

  it("fails gracefully when no payment method is saved", async () => {
    const booking = makePendingBooking("b1", { hasPaymentMethod: false });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({
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
    mockCheckCapacity
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
    mockCheckCapacity.mockResolvedValue({
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
    mockCheckCapacity.mockResolvedValue({
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

    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { bookingId: "b1" },
      data: {
        stripePaymentIntentId: "pi_auto_1",
        status: "PROCESSING",
      },
    });
  });

  it("does nothing when no pending bookings are past hold deadline", async () => {
    mockBookingFindMany.mockResolvedValue([]);

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);
    expect(mockCheckCapacity).not.toHaveBeenCalled();
  });

  it("continues processing remaining bookings when one fails", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockBookingFindMany.mockResolvedValue([booking1, booking2]);

    mockCheckCapacity
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
  });

  it("passes booking ID to checkCapacity as excludeBookingId", async () => {
    const booking = makePendingBooking("b1", { guestCount: 3 });
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({
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

    expect(mockCheckCapacity).toHaveBeenCalledWith(
      booking.checkIn,
      booking.checkOut,
      3,
      "b1"
    );
  });
});

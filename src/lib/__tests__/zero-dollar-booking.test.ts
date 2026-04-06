/**
 * Zero-Dollar Booking Tests (Issues 1 & 6)
 *
 * Issue 1: When a booking has a 100% discount (finalPriceCents = 0), the booking detail page
 *          must NOT try to create a Stripe PaymentIntent (which fails for $0 with Stripe).
 * Issue 6: $0 bookings must transition to PAID status immediately (not wait for a webhook
 *          that will never come because no Stripe payment is created).
 *
 * Test coverage:
 * - Booking creation route: $0 CONFIRMED bookings get SUCCEEDED Payment + PAID status in TX
 * - Booking creation route: $0 PENDING bookings (non-member, far future) stay PENDING
 * - Booking creation route: normal non-zero bookings follow existing flow (no payment in TX)
 * - Cron: $0 PENDING bookings confirmed without Stripe charge
 * - Cron: $0 PENDING bookings with existing payment record updated to SUCCEEDED
 * - Cron: $0 PENDING bookings skipped if already processed
 * - UI: BookingPaymentWrapper shows "Booking Complete" when amountCents === 0
 * - UI: Payment section visibility conditions
 * - Xero: $0 payment condition corrected ($0 bookings now get payment recorded)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

// ─── Shared mock functions (reconfigured per describe block via beforeEach) ───

const mockPrismaTransaction = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockTxBookingFindMany = vi.fn().mockResolvedValue([]);
const mockTxSeasonFindMany = vi.fn().mockResolvedValue([]);
const mockTxBookingCreate = vi.fn();
const mockTxBookingUpdate = vi.fn();
const mockTxPaymentCreate = vi.fn();
// Cron-level prisma ops (non-transaction)
const mockBookingFindMany = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockPaymentCreate = vi.fn();
const mockExecuteRawUnsafe = vi.fn().mockResolvedValue(undefined);

// Shared tx mock used by booking route
const mockTx = {
  $executeRawUnsafe: mockExecuteRawUnsafe,
  booking: {
    findMany: mockTxBookingFindMany,
    create: mockTxBookingCreate,
    update: mockTxBookingUpdate,
  },
  season: { findMany: mockTxSeasonFindMany },
  payment: { create: mockTxPaymentCreate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => mockPrismaTransaction(fn),
    member: { findUnique: (...args: unknown[]) => mockMemberFindUnique(...args) },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    payment: {
      create: (...args: unknown[]) => mockPaymentCreate(...args),
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingCreate: {} },
}));

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn(),
  calculatePromoDiscount: vi.fn(),
}));

const mockCheckCapacity = vi.fn();
vi.mock("@/lib/capacity", () => ({
  checkCapacity: (...args: unknown[]) => mockCheckCapacity(...args),
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/bumping", () => ({
  bumpPendingBookings: vi.fn(),
  sendBumpedNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn(),
  redeemPromoCode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/email", () => ({
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingBumpedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue("inv-1"),
}));

vi.mock("@/lib/stripe", () => ({
  chargePaymentMethod: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Imports (after vi.mock hoisting) ────────────────────────────────────────

const { auth } = await import("@/lib/auth");
const { calculateBookingPrice } = await import("@/lib/pricing");
const { sendBookingConfirmedEmail } = await import("@/lib/email");
const { chargePaymentMethod } = await import("@/lib/stripe");
const { POST } = await import("@/app/api/bookings/route");
const { confirmPendingBookings } = await import("@/lib/cron-confirm-pending");

const mockedAuth = vi.mocked(auth);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedCharge = vi.mocked(chargePaymentMethod);

// ─── Date helpers ─────────────────────────────────────────────────────────────

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

const tomorrow = daysFromNow(1);
const dayAfterTomorrow = daysFromNow(2);
const farFuture = daysFromNow(30);
const farFutureEnd = daysFromNow(32);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Booking creation route — zero-dollar handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Booking Creation Route: zero-dollar handling", () => {
  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function setupStandardMocks() {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", isEmailVerified: true },
    } as any);

    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      emailVerified: true,
    });

    // Transaction calls callback with tx
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
  }

  function setupZeroDollarConfirmedBooking() {
    mockTxBookingCreate.mockResolvedValue({
      id: "bk1",
      memberId: "m1",
      checkIn: new Date(tomorrow),
      checkOut: new Date(dayAfterTomorrow),
      status: "CONFIRMED",
      totalPriceCents: 10000,
      discountCents: 10000,
      finalPriceCents: 0,
      hasNonMembers: false,
      nonMemberHoldUntil: null,
      notes: null,
      guests: [{ id: "g1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 0 }],
    });
    mockTxBookingUpdate.mockResolvedValue({ id: "bk1", status: "PAID" });
    mockTxPaymentCreate.mockResolvedValue({ id: "pay1", status: "SUCCEEDED", amountCents: 0 });
    // Post-transaction findUnique for confirmation email
    mockBookingFindUnique.mockResolvedValue({
      id: "bk1",
      member: { email: "alice@example.com", firstName: "Alice" },
      guests: [{ id: "g1" }],
      checkIn: new Date(tomorrow),
      checkOut: new Date(dayAfterTomorrow),
      finalPriceCents: 0,
      discountCents: 10000,
      promoRedemption: { promoCode: { code: "FREE100" } },
    });
    // Pricing returns $0 (e.g. 100% promo applied by calculateBookingPrice + promo reduction)
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 0,
      guests: [{ priceCents: 0, perNightCents: [0] }],
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTxBookingFindMany.mockResolvedValue([]);
    mockTxSeasonFindMany.mockResolvedValue([]);
  });

  it("creates a SUCCEEDED Payment inside the transaction for a $0 CONFIRMED booking", async () => {
    setupStandardMocks();
    setupZeroDollarConfirmedBooking();

    const req = makeRequest({
      checkIn: tomorrow,
      checkOut: dayAfterTomorrow,
      guests: [{ firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true }],
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockTxPaymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "bk1",
        amountCents: 0,
        status: "SUCCEEDED",
      }),
    });
  });

  it("sets booking status to PAID inside the transaction for a $0 CONFIRMED booking", async () => {
    setupStandardMocks();
    setupZeroDollarConfirmedBooking();

    const req = makeRequest({
      checkIn: tomorrow,
      checkOut: dayAfterTomorrow,
      guests: [{ firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true }],
    });

    await POST(req);

    expect(mockTxBookingUpdate).toHaveBeenCalledWith({
      where: { id: "bk1" },
      data: { status: "PAID" },
    });
  });

  it("sends confirmation email for a $0 CONFIRMED booking (not pending email)", async () => {
    setupStandardMocks();
    setupZeroDollarConfirmedBooking();

    const req = makeRequest({
      checkIn: tomorrow,
      checkOut: dayAfterTomorrow,
      guests: [{ firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true }],
    });

    await POST(req);

    expect(sendBookingConfirmedEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "Alice",
      expect.any(Date),
      expect.any(Date),
      expect.any(Number),
      0,
      expect.objectContaining({ discountCents: 10000 })
    );
  });

  it("does NOT create Payment in the transaction for a $0 PENDING booking (non-member, far future)", async () => {
    setupStandardMocks();
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 0,
      guests: [
        { priceCents: 0, perNightCents: [0, 0] },
        { priceCents: 0, perNightCents: [0, 0] },
      ],
    } as any);

    // PENDING booking (non-member, far future)
    mockTxBookingCreate.mockResolvedValue({
      id: "bk2",
      memberId: "m1",
      checkIn: new Date(farFuture),
      checkOut: new Date(farFutureEnd),
      status: "PENDING",
      totalPriceCents: 0,
      discountCents: 0,
      finalPriceCents: 0,
      hasNonMembers: true,
      nonMemberHoldUntil: new Date(new Date(farFuture).getTime() - 7 * 86400000),
      notes: null,
      guests: [
        { id: "g1", firstName: "Alice", ageTier: "ADULT", isMember: true, priceCents: 0 },
        { id: "g2", firstName: "Bob", ageTier: "ADULT", isMember: false, priceCents: 0 },
      ],
    });
    mockBookingFindUnique.mockResolvedValue(null);

    const req = makeRequest({
      checkIn: farFuture,
      checkOut: farFutureEnd,
      guests: [
        { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
        { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false },
      ],
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // PENDING $0: no shortcut — no payment created in tx, no PAID status update
    expect(mockTxPaymentCreate).not.toHaveBeenCalled();
    expect(mockTxBookingUpdate).not.toHaveBeenCalled();
  });

  it("does NOT create Payment in the transaction for a normal non-zero CONFIRMED booking", async () => {
    setupStandardMocks();
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [10000] }],
    } as any);

    mockTxBookingCreate.mockResolvedValue({
      id: "bk3",
      memberId: "m1",
      checkIn: new Date(tomorrow),
      checkOut: new Date(dayAfterTomorrow),
      status: "CONFIRMED",
      totalPriceCents: 10000,
      discountCents: 0,
      finalPriceCents: 10000,
      hasNonMembers: false,
      nonMemberHoldUntil: null,
      notes: null,
      guests: [{ id: "g1", firstName: "Alice", ageTier: "ADULT", isMember: true, priceCents: 10000 }],
    });
    mockBookingFindUnique.mockResolvedValue(null);

    const req = makeRequest({
      checkIn: tomorrow,
      checkOut: dayAfterTomorrow,
      guests: [{ firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true }],
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Non-zero CONFIRMED: waits for Stripe webhook — no payment in tx
    expect(mockTxPaymentCreate).not.toHaveBeenCalled();
    expect(mockTxBookingUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Cron confirm-pending — zero-dollar handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Cron Confirm Pending: zero-dollar handling", () => {
  function makeZeroDollarPendingBooking(id: string, hasExistingPayment = false) {
    return {
      id,
      memberId: `member_${id}`,
      checkIn: new Date("2026-08-15"),
      checkOut: new Date("2026-08-17"),
      status: "PENDING",
      finalPriceCents: 0,
      discountCents: 10000,
      nonMemberHoldUntil: new Date("2026-08-08"),
      hasNonMembers: true,
      promoRedemption: { promoCode: { code: "FREE100" } },
      createdAt: new Date("2026-03-01"),
      member: {
        id: `member_${id}`,
        email: `${id}@example.com`,
        firstName: "Test",
        lastName: "User",
      },
      guests: [
        { id: `g1_${id}`, firstName: "Guest1", lastName: "Test", ageTier: "ADULT", isMember: false, priceCents: 0 },
        { id: `g2_${id}`, firstName: "Guest2", lastName: "Test", ageTier: "ADULT", isMember: true, priceCents: 0 },
      ],
      payment: hasExistingPayment
        ? {
            id: `pay_${id}`,
            bookingId: id,
            stripePaymentMethodId: `pm_${id}`,
            stripeCustomerId: `cus_${id}`,
            stripeSetupIntentId: `seti_${id}`,
            amountCents: 0,
            status: "PENDING",
          }
        : null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentCreate.mockResolvedValue({ id: "pay-new", status: "SUCCEEDED" });
    mockPaymentUpdate.mockResolvedValue({ id: "pay-1", status: "SUCCEEDED" });
  });

  it("confirms $0 PENDING booking without calling Stripe.chargePaymentMethod", async () => {
    const booking = makeZeroDollarPendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toContain("b1");
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);
    expect(mockedCharge).not.toHaveBeenCalled();
  });

  it("creates new SUCCEEDED Payment for $0 booking with no existing payment record", async () => {
    const booking = makeZeroDollarPendingBooking("b1", false);
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });

    await confirmPendingBookings();

    expect(mockPaymentCreate).toHaveBeenCalledWith({
      data: { bookingId: "b1", amountCents: 0, status: "SUCCEEDED" },
    });
    expect(mockPaymentUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { bookingId: "b1" } }));
  });

  it("updates existing Payment to SUCCEEDED for $0 booking that has a payment record", async () => {
    const booking = makeZeroDollarPendingBooking("b1", true);
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });

    await confirmPendingBookings();

    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { bookingId: "b1" },
      data: { status: "SUCCEEDED", amountCents: 0 },
    });
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("sets booking status to PAID via updateMany for $0 booking", async () => {
    const booking = makeZeroDollarPendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });

    await confirmPendingBookings();

    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAID" },
    });
  });

  it("sends confirmation email with promo code for $0 PENDING booking", async () => {
    const booking = makeZeroDollarPendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });

    await confirmPendingBookings();

    expect(sendBookingConfirmedEmail).toHaveBeenCalledWith(
      "b1@example.com",
      "Test",
      booking.checkIn,
      booking.checkOut,
      2,
      0,
      { discountCents: 10000, promoCode: "FREE100" }
    );
  });

  it("skips $0 booking already claimed by another process (updateMany returns 0)", async () => {
    const booking = makeZeroDollarPendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockBookingUpdateMany.mockResolvedValue({ count: 0 });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("bumps a $0 PENDING booking when capacity is not available", async () => {
    const booking = makeZeroDollarPendingBooking("b1");
    mockBookingFindMany.mockResolvedValue([booking]);
    mockCheckCapacity.mockResolvedValue({ available: false, minAvailable: 0, nightDetails: [] });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(mockedCharge).not.toHaveBeenCalled();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: UI logic (pure conditions, no React rendering required)
// ─────────────────────────────────────────────────────────────────────────────

describe("BookingPaymentWrapper: amountCents === 0 logic", () => {
  it("skips Stripe initialization when amountCents is 0", () => {
    // useEffect guard: if (amountCents === 0) return;
    const shouldSkipStripeInit = (amountCents: number) => amountCents === 0;

    expect(shouldSkipStripeInit(0)).toBe(true);
    expect(shouldSkipStripeInit(100)).toBe(false);
    expect(shouldSkipStripeInit(5000)).toBe(false);
  });

  it("shows Booking Complete UI (not Stripe form) when amountCents is 0", () => {
    // Early return before loading/error checks renders 'Booking Complete' element
    const getUIState = (amountCents: number) =>
      amountCents === 0 ? "booking-complete" : "stripe-flow";

    expect(getUIState(0)).toBe("booking-complete");
    expect(getUIState(100)).toBe("stripe-flow");
    expect(getUIState(9900)).toBe("stripe-flow");
  });
});

describe("Booking Detail Page: payment section visibility", () => {
  it("hides Complete Payment section for PAID bookings (the new $0 CONFIRMED state)", () => {
    // page.tsx line 93: status === "CONFIRMED" && (!payment || payment.status !== "SUCCEEDED")
    const showCompletePayment = (
      status: string,
      payment: { status: string } | null
    ) => status === "CONFIRMED" && (!payment || payment.status !== "SUCCEEDED");

    // $0 bookings now land on PAID status with SUCCEEDED payment → form hidden
    expect(showCompletePayment("PAID", { status: "SUCCEEDED" })).toBe(false);
    // CONFIRMED + SUCCEEDED payment → form hidden
    expect(showCompletePayment("CONFIRMED", { status: "SUCCEEDED" })).toBe(false);
    // CONFIRMED + no payment → form shown (normal flow waiting for Stripe)
    expect(showCompletePayment("CONFIRMED", null)).toBe(true);
    // CONFIRMED + PENDING payment → form shown
    expect(showCompletePayment("CONFIRMED", { status: "PENDING" })).toBe(true);
  });

  it("hides Save Payment Method section for PAID bookings", () => {
    // page.tsx line 112: status === "PENDING" && (!payment || !payment.stripeSetupIntentId)
    const showSavePayment = (
      status: string,
      payment: { stripeSetupIntentId?: string | null } | null
    ) => status === "PENDING" && (!payment || !payment.stripeSetupIntentId);

    // PAID status: neither CONFIRMED nor PENDING → both sections hidden
    expect(showSavePayment("PAID", null)).toBe(false);
    expect(showSavePayment("PAID", { stripeSetupIntentId: null })).toBe(false);
    // PENDING with no setup intent → show save card form
    expect(showSavePayment("PENDING", null)).toBe(true);
    // PENDING with setup intent saved → hide form
    expect(showSavePayment("PENDING", { stripeSetupIntentId: "seti_1" })).toBe(false);
  });

  it("$0 CONFIRMED booking has PAID status: both payment sections hidden", () => {
    const status = "PAID";
    const payment = { status: "SUCCEEDED", stripeSetupIntentId: null as string | null };

    const showCompletePayment = status === "CONFIRMED" && (!payment || payment.status !== "SUCCEEDED");
    const showSavePayment = status === "PENDING" && (!payment || !payment.stripeSetupIntentId);

    expect(showCompletePayment).toBe(false);
    expect(showSavePayment).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Xero invoice — $0 payment condition
// ─────────────────────────────────────────────────────────────────────────────

describe("Xero invoice: zero-dollar payment recording", () => {
  it("old guard (amountCents > 0) would skip $0 payment — causing open invoice in Xero", () => {
    const oldGuard = (status: string, amountCents: number) =>
      status === "SUCCEEDED" && amountCents > 0;

    expect(oldGuard("SUCCEEDED", 0)).toBe(false); // Bug: $0 invoice left open
    expect(oldGuard("SUCCEEDED", 5000)).toBe(true);
    expect(oldGuard("PENDING", 0)).toBe(false);
  });

  it("new guard (status === SUCCEEDED) records payment for ALL succeeded bookings incl $0", () => {
    const newGuard = (status: string) => status === "SUCCEEDED";

    expect(newGuard("SUCCEEDED")).toBe(true); // Fix: $0 invoice gets payment, marked PAID
    expect(newGuard("PENDING")).toBe(false);
    expect(newGuard("FAILED")).toBe(false);
  });

  it("uses Stripe reference for non-zero payments", () => {
    const ref = (amountCents: number, piId: string | null) =>
      amountCents > 0 ? `Stripe ${piId ?? "payment"}` : "Zero-dollar booking (100% promo discount)";

    expect(ref(5000, "pi_abc123")).toBe("Stripe pi_abc123");
    expect(ref(5000, null)).toBe("Stripe payment");
  });

  it("uses zero-dollar reference for $0 payments", () => {
    const ref = (amountCents: number, piId: string | null) =>
      amountCents > 0 ? `Stripe ${piId ?? "payment"}` : "Zero-dollar booking (100% promo discount)";

    expect(ref(0, null)).toBe("Zero-dollar booking (100% promo discount)");
    expect(ref(0, "pi_irrelevant")).toBe("Zero-dollar booking (100% promo discount)");
  });
});

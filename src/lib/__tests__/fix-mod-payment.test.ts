/**
 * Tests for Issue 2 fix: modification payment collection for price increases.
 *
 * Covers:
 * - modify-dates: price increase creates additional PaymentIntent, returns clientSecret
 * - modify-dates: price decrease still processes refund (no regression)
 * - add-guests: price increase creates additional PaymentIntent, returns clientSecret
 * - stripe webhook: payment_intent.succeeded for additional PI updates payment record
 * - confirm-modification-payment endpoint: verifies PI and updates DB
 * - additional-payment-secret endpoint: returns clientSecret for pending additional PI
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockTransaction = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingGuestCreate = vi.fn();
const mockBookingGuestUpdate = vi.fn();
const mockBookingModCreate = vi.fn();
const mockSeasonFindMany = vi.fn();
const mockChoreAssignFindMany = vi.fn();
const mockChoreAssignDeleteMany = vi.fn();
const mockProcessedWebhookCreate = vi.fn();
const mockProcessedWebhookDeleteMany = vi.fn();
const mockProcessedWebhookFindUnique = vi.fn();
const mockMemberCount = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockAuditCreate = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockRefundPaymentTransactions = vi.fn();
const mockFindPaymentTransactionByIntentId = vi.fn();
const mockMarkPaymentIntentTransactionSucceeded = vi.fn();
const mockMarkPaymentIntentTransactionFailed = vi.fn();
const mockCompleteCanceledSupersededPaymentIntentRecovery = vi.fn();
const mockQueueSupersededPaymentIntentRefundRecovery = vi.fn();
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking", message: "queued" });
const mockEnqueueXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking_update", message: "queued" });
const mockEnqueueXeroRefundCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_refund", message: "queued" });
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);
const mockRecordSkippedXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_skip", message: "skipped" });
const mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent = vi.fn().mockResolvedValue({ released: 1, queueOperationIds: ["op_supplementary"] });

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as any)(fn);
      return Promise.resolve();
    },
    payment: {
      findUnique: mockPaymentFindUnique,
      update: mockPaymentUpdate,
    },
    booking: {
      findUnique: mockBookingFindUnique,
      update: mockBookingUpdate,
    },
    bookingGuest: { create: mockBookingGuestCreate, update: mockBookingGuestUpdate },
    bookingModification: { create: mockBookingModCreate },
    season: { findMany: mockSeasonFindMany },
    choreAssignment: { findMany: mockChoreAssignFindMany, deleteMany: mockChoreAssignDeleteMany },
    processedWebhookEvent: {
      findUnique: mockProcessedWebhookFindUnique,
      create: mockProcessedWebhookCreate,
      deleteMany: mockProcessedWebhookDeleteMany,
    },
    member: { count: mockMemberCount, findUnique: mockMemberFindUnique },
    auditLog: { create: mockAuditCreate },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn(),
  calculatePromoDiscount: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: vi.fn() }));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
  redeemPromoCode: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mockEnqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation: mockEnqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroRefundCreditNoteOperation: mockEnqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation: mockRecordSkippedXeroBookingInvoiceUpdateOperation,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
}));
vi.mock("@/lib/webhook-log", () => ({ recordWebhookLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mockFindPaymentTransactionByIntentId(...args),
  markPaymentIntentTransactionSucceeded: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionSucceeded(...args),
  markPaymentIntentTransactionFailed: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionFailed(...args),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  completeCanceledSupersededPaymentIntentRecovery: (...args: unknown[]) =>
    mockCompleteCanceledSupersededPaymentIntentRecovery(...args),
  queueSupersededPaymentIntentRefundRecovery: (...args: unknown[]) =>
    mockQueueSupersededPaymentIntentRefundRecovery(...args),
  getStripePaymentMethodId: (paymentIntent: {
    payment_method?: string | { id?: string | null } | null;
  }) =>
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null,
}));

// Chore cleanup mock
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({ choreWarnings: [] }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({ choreWarnings: [] }),
}));

import { auth } from "@/lib/auth";
import { checkCapacity } from "@/lib/capacity";
import { calculateBookingPrice } from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import { processRefund, createPaymentIntent, findOrCreateCustomer, getPaymentIntent, constructWebhookEvent } from "@/lib/stripe";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedCalcChangeFee = vi.mocked(calculateChangeFee);
const mockedProcessRefund = vi.mocked(processRefund);
const mockedCreatePaymentIntent = vi.mocked(createPaymentIntent);
const mockedFindOrCreateCustomer = vi.mocked(findOrCreateCustomer);
const mockedGetPaymentIntent = vi.mocked(getPaymentIntent);
const mockedConstructWebhookEvent = vi.mocked(constructWebhookEvent);

function makeSession() {
  return { user: { id: "m1", role: "MEMBER", email: "alice@test.com" } };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    status: "CONFIRMED",
    totalPriceCents: 10000,
    discountCents: 0,
    finalPriceCents: 10000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 10000,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
}

function makeTx(booking: ReturnType<typeof makeBooking>) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      update: vi.fn().mockImplementation(({ data }) => {
        return Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment });
      }),
    },
    bookingGuest: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: {
      findMany: vi.fn().mockResolvedValue([{
        id: "s1",
        startDate: new Date("2026-04-01"),
        endDate: new Date("2026-10-31"),
        rates: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 5000 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 7000 },
        ],
      }]),
    },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  mockUpsertPaymentIntentTransaction.mockResolvedValue({});
  mockRefundPaymentTransactions.mockResolvedValue({
    refunds: [{ refundId: "re_test_1", paymentIntentId: "pi_original", amountCents: 1000 }],
  });
  mockFindPaymentTransactionByIntentId.mockResolvedValue({
    id: "ptx_1",
    paymentId: "p1",
    kind: "ADDITIONAL",
    amountCents: 3000,
    status: "PENDING",
    createdAt: new Date(),
  });
  mockMarkPaymentIntentTransactionSucceeded.mockResolvedValue({});
  mockMarkPaymentIntentTransactionFailed.mockResolvedValue({});
});

// ============================================================================
// modify-dates: price increase creates additional PaymentIntent
// ============================================================================

describe("PUT /api/bookings/[id]/modify-dates — price increase", () => {
  let PUT: typeof import("@/app/api/bookings/[id]/modify-dates/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/modify-dates/route");
    PUT = mod.PUT;
  });

  it("creates additional PaymentIntent and returns clientSecret when price increases", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000, // price increased from 10000
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_additional",
      client_secret: "pi_additional_secret_xxx",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(5000);
    expect(data.additionalPaymentClientSecret).toBe("pi_additional_secret_xxx");

    // Verify PaymentIntent was created with correct amount
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 5000,
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        paymentIntentId: "pi_additional",
        amountCents: 5000,
        status: "PENDING",
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_additional",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("uses existing stripeCustomerId if present (no findOrCreateCustomer call)", async () => {
    const booking = makeBooking(); // has stripeCustomerId: "cus_123"
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 12000,
      guests: [{ priceCents: 12000, perNightCents: [6000, 6000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_add2",
      client_secret: "secret_2",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-05" }),
    });
    await PUT(req, { params: Promise.resolve({ id: "bk1" }) });

    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_123" })
    );
  });

  it("includes change fee in additionalAmountCents", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000, // same price, but change fee applies
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 2000, fromTierRefundPct: 50, toTierRefundPct: 100 }); // $20 change fee
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_fee",
      client_secret: "fee_secret",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    // Changing check-in from Aug 1 to Aug 2 (still before checkOut Aug 3) — triggers late-notice fee
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    // priceDiff = 0, changeFee = 2000, total additional = 2000
    expect(data.additionalAmountCents).toBe(2000);
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2000 })
    );
  });

  it("processes refund for price decrease (no additional PI created)", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000, // price decreased from 10000
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.refundAmountCents).toBe(3000);
    expect(data.additionalAmountCents).toBe(0);
    expect(data.additionalPaymentClientSecret).toBeNull();

    // Refund was processed
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        amountCents: 3000,
      })
    );

    // No additional PI created
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("does not create PI for PENDING bookings (payment not yet taken)", async () => {
    // For PENDING bookings, no payment has been collected yet.
    // The booking price update is recorded, but additionalAmountCents stays 0
    // (the new price will be charged when the booking auto-confirms).
    const booking = makeBooking({
      status: "PENDING",
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 0,
        status: "PENDING",
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000,
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    // No additional payment for PENDING bookings - original payment not taken yet
    expect(data.additionalAmountCents).toBe(0);
    expect(data.additionalPaymentClientSecret).toBeNull();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("queues a supplementary Xero invoice for invoice-backed unpaid bookings without creating a new PI", async () => {
    const booking = makeBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_original",
        stripeCustomerId: "cus_123",
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_primary",
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 15000,
      guests: [{ priceCents: 15000, perNightCents: [7500, 7500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(5000);
    expect(data.additionalPaymentClientSecret).toBeNull();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: null,
        waitForConfirmedAdditionalPayment: false,
        recordPayment: false,
      }
    );
  });

  it("queues a Xero credit note for invoice-backed unpaid decreases without refunding Stripe", async () => {
    const booking = makeBooking({
      payment: {
        id: "p1",
        bookingId: "bk1",
        amountCents: 10000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_original",
        stripeCustomerId: "cus_123",
        refundedAmountCents: 0,
        changeFeeCents: 0,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_primary",
      },
    });
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 7000,
      guests: [{ priceCents: 7000, perNightCents: [3500] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-08-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.refundAmountCents).toBe(0);
    expect(mockedProcessRefund).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 3000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("queues a primary Xero invoice update for zero-net date changes", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    mockedCalcPrice.mockReturnValue({
      totalPriceCents: 10000,
      guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
    } as any);
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 0, toTierRefundPct: 0 });
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-08-05", checkOut: "2026-08-07" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(0);
    expect(data.refundAmountCents).toBe(0);

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
  });
});

// ============================================================================
// POST /api/bookings/[id]/guests — price increase creates additional PI
// ============================================================================

describe("POST /api/bookings/[id]/guests — price increase", () => {
  let POST: typeof import("@/app/api/bookings/[id]/guests/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/guests/route");
    POST = mod.POST;
  });

  it("creates additional PaymentIntent when adding guest to CONFIRMED booking", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
    // New guest price: 5000 per guest for 2 nights = 10000 extra
    mockedCalcPrice.mockImplementation((_ci, _co, guests) => ({
      totalPriceCents: guests.length === 1 ? 10000 : 20000,
      guests: guests.map(() => ({ priceCents: 10000, perNightCents: [5000, 5000] })),
    } as any));
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_guest_extra",
      client_secret: "guest_extra_secret",
    } as any);
    mockPaymentUpdate.mockResolvedValue({});
    mockMemberFindUnique.mockResolvedValue({ active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({
        guests: [{ firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true }],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.additionalAmountCents).toBe(10000);
    expect(data.additionalPaymentClientSecret).toBe("guest_extra_secret");

    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
          reason: "guest_add_price_increase",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "p1",
        paymentIntentId: "pi_guest_extra",
        amountCents: 10000,
        status: "PENDING",
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 10000,
        changeFeeCents: 0,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_guest_extra",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
  });
});

// ============================================================================
// Stripe webhook — additional PaymentIntent succeeded
// ============================================================================

describe("Stripe webhook — additional modification payment succeeded", () => {
  let POST: typeof import("@/app/api/webhooks/stripe/route").POST;

  const makeWebhookRequest = () =>
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "test-sig" },
      body: JSON.stringify({}),
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(false);
    mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValue(false);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("updates additionalPaymentStatus and amountCents when additional PI succeeds", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookFindUnique.mockResolvedValue(null);
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });

    const req = makeWebhookRequest();
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.received).toBe(true);

    expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_additional",
        amountCents: 3000,
      })
    );
    expect(
      mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).toHaveBeenCalledWith("pi_additional");
  });

  it("is idempotent: skips already-SUCCEEDED additional payment", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_test2",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookFindUnique.mockResolvedValue(null);
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "SUCCEEDED",
      createdAt: new Date(),
    });

    const req = makeWebhookRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });

  it("does not update payment when additional PI amount mismatches", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_mismatch",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 2500,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 1 });
    mockFindPaymentTransactionByIntentId.mockResolvedValueOnce({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "bk1",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { firstName: "Alice", lastName: "Smith" },
    });

    const req = makeWebhookRequest();
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: { eventId: "evt_mismatch", source: "stripe" },
    });
  });

  it("returns success for duplicate Stripe webhook deliveries", async () => {
    mockedConstructWebhookEvent.mockReturnValue({
      id: "evt_duplicate",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_additional",
          amount: 3000,
          metadata: { bookingId: "bk1", type: "modification_additional" },
          payment_method: "pm_test",
        },
      },
    } as any);

    mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });

    const req = makeWebhookRequest();
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.received).toBe(true);
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
  });
});

// ============================================================================
// POST /api/bookings/[id]/confirm-modification-payment
// ============================================================================

describe("POST /api/bookings/[id]/confirm-modification-payment", () => {
  let POST: typeof import("@/app/api/bookings/[id]/confirm-modification-payment/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import(
      "@/app/api/bookings/[id]/confirm-modification-payment/route"
    );
    POST = mod.POST;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 if paymentIntentId does not match booking", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_different",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_wrong" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("verifies PI with Stripe and updates payment when succeeded", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_additional",
      status: "succeeded",
      amount: 3000,
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_additional",
        amountCents: 3000,
      })
    );
    expect(
      mockReleaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).toHaveBeenCalledWith("pi_additional");
  });

  it("returns 400 if Stripe PI has not succeeded yet", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({ status: "requires_action" } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if Stripe PI amount does not match the modification amount", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      amountCents: 10000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "PENDING",
      createdAt: new Date(),
    });
    mockedGetPaymentIntent.mockResolvedValue({ status: "succeeded", amount: 2500 } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });

  it("returns 403 for deactivated members", async () => {
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockedAuth.mockResolvedValue(makeSession() as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
    expect(mockPaymentFindUnique).not.toHaveBeenCalled();
  });

  it("is idempotent for already-SUCCEEDED payments", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "SUCCEEDED",
      additionalAmountCents: 3000,
      amountCents: 13000,
      booking: { memberId: "m1" },
    });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_1",
      paymentId: "p1",
      kind: "ADDITIONAL",
      amountCents: 3000,
      status: "SUCCEEDED",
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/confirm-modification-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_additional" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // Should not call Stripe or update DB again
    expect(mockedGetPaymentIntent).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });
});

// ============================================================================
// GET /api/bookings/[id]/additional-payment-secret
// ============================================================================

describe("GET /api/bookings/[id]/additional-payment-secret", () => {
  let GET: typeof import("@/app/api/bookings/[id]/additional-payment-secret/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    const mod = await import(
      "@/app/api/bookings/[id]/additional-payment-secret/route"
    );
    GET = mod.GET;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 if no pending additional payment", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: null,
      additionalPaymentStatus: null,
      additionalAmountCents: 0,
      booking: { memberId: "m1" },
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 if additional payment already SUCCEEDED", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "SUCCEEDED",
      additionalAmountCents: 3000,
      booking: { memberId: "m1" },
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns clientSecret and amountCents for pending additional payment", async () => {
    mockedAuth.mockResolvedValue(makeSession() as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      booking: { memberId: "m1" },
    });
    mockedGetPaymentIntent.mockResolvedValue({
      client_secret: "pi_additional_secret_xyz",
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("pi_additional_secret_xyz");
    expect(data.amountCents).toBe(3000);
  });

  it("returns 403 for a different member trying to access", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other-member", role: "MEMBER" } } as any);
    mockPaymentFindUnique.mockResolvedValue({
      id: "p1",
      additionalPaymentIntentId: "pi_additional",
      additionalPaymentStatus: "PENDING",
      additionalAmountCents: 3000,
      booking: { memberId: "m1" }, // belongs to m1, not other-member
    });

    const req = new NextRequest("http://localhost/api/bookings/bk1/additional-payment-secret");
    const res = await GET(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });
});

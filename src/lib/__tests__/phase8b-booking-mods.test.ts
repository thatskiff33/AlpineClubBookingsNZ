import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockTransaction = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockDeleteMany = vi.fn();
const mockFindMany = vi.fn();
const mockMemberCount = vi.fn();
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") {
        return (mockTransaction as any)(fn);
      }
      return Promise.resolve();
    },
    booking: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      update: mockUpdate,
    },
    bookingGuest: {
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    },
    bookingModification: { create: mockCreate },
    promoRedemption: { delete: mockDelete },
    promoCode: { update: mockUpdate },
    choreAssignment: { findMany: mockFindMany, delete: mockDelete, deleteMany: mockDeleteMany },
    season: { findMany: mockFindMany },
    payment: { update: mockUpdate },
    member: { count: mockMemberCount, findUnique: mockFindUnique, findMany: mockFindMany },
    familyGroupMember: { findMany: mockFindMany },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
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
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  getNonMemberHoldDays: vi.fn(),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn(),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
  redeemPromoCode: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({ processRefund: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { checkCapacity } from "@/lib/capacity";
import { calculateBookingPrice } from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import { daysUntilDate, loadCancellationPolicy, getNonMemberHoldDays } from "@/lib/cancellation";
import { validatePromoCodeRules } from "@/lib/promo";
import { processRefund } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedCalcChangeFee = vi.mocked(calculateChangeFee);
const mockedDaysUntilDate = vi.mocked(daysUntilDate);
const mockedLoadPolicy = vi.mocked(loadCancellationPolicy);
const mockedProcessRefund = vi.mocked(processRefund);
const mockedGetHoldDays = vi.mocked(getNonMemberHoldDays);
const mockedValidatePromo = vi.mocked(validatePromoCodeRules);

// Helper to make a booking object
function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: new Date("2026-06-01"),
    checkOut: new Date("2026-06-03"),
    status: "CONFIRMED",
    totalPriceCents: 10000,
    discountCents: 0,
    finalPriceCents: 10000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
      { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: null, priceCents: 5000 },
    ],
    payment: { id: "p1", bookingId: "bk1", amountCents: 10000, status: "SUCCEEDED", stripePaymentIntentId: "pi_123", xeroInvoiceId: "inv_primary", refundedAmountCents: 0, changeFeeCents: 0 },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
}

// Create a mock tx that behaves like prisma inside a transaction
function makeTx(booking: ReturnType<typeof makeBooking>) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      update: vi.fn().mockImplementation(({ data }) => {
        const updated = { ...booking, ...data, guests: booking.guests };
        return Promise.resolve(updated);
      }),
    },
    bookingGuest: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod1" }),
    },
    payment: {
      update: vi.fn().mockResolvedValue({}),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    familyGroupMember: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([{
        id: "s1",
        startDate: new Date("2026-04-01"),
        endDate: new Date("2026-10-31"),
        rates: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 5000 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 7000 },
          { ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
          { ageTier: "CHILD", isMember: true, pricePerNightCents: 2000 },
        ],
      }]),
    },
    promoRedemption: {
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    promoCode: {
      update: vi.fn().mockResolvedValue({}),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
  };
}

// --- Tests ---

describe("PUT /api/bookings/[id]/modify-dates", () => {
  let PUT: typeof import("@/app/api/bookings/[id]/modify-dates/route").PUT;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      forcePasswordChange: false,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/modify-dates/route");
    PUT = mod.PUT;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 if neither checkIn nor checkOut provided", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 if booking not found", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 for deactivated members before modifying dates", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    mockFindUnique.mockResolvedValueOnce({
      id: "m1",
      active: false,
      forcePasswordChange: false,
    } as any);

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 403 if not booking owner or admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 for CANCELLED booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking({ status: "CANCELLED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if checkOut <= checkIn", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-03" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if capacity not available", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: 0, nightDetails: [] });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-07" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Not enough beds");
  });

  it("successfully modifies dates with price recalculation", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 3, priceCents: 15000, perNightCents: [5000, 5000, 5000] },
      ],
      totalPriceCents: 30000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }]);
    mockedGetHoldDays.mockResolvedValue(7);

    // Mock member lookup for email
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "alice@test.com", firstName: "Alice" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-05", checkOut: "2026-06-08" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(20000); // 30000 - 10000
    expect(body.changeFeeCents).toBe(0);
  });

  it("processes Stripe refund on price decrease for confirmed+paid booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    // Shorter stay = cheaper
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 1, priceCents: 2500, perNightCents: [2500] },
        { ageTier: "ADULT" as const, isMember: true, nights: 1, priceCents: 2500, perNightCents: [2500] },
      ],
      totalPriceCents: 5000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockedProcessRefund.mockResolvedValue({ id: "re_123" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-02" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refundAmountCents).toBe(5000);
    expect(body.stripeRefundId).toBe("re_123");
    expect(mockedProcessRefund).toHaveBeenCalledOnce();
  });

  it("calculates change fee when check-in moves to lenient tier", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 5000, fromTierRefundPct: 0, toTierRefundPct: 50 });
    mockedDaysUntilDate.mockReturnValue(5);
    mockedLoadPolicy.mockResolvedValue([{ daysBeforeStay: 14, refundPercentage: 100 }, { daysBeforeStay: 7, refundPercentage: 50 }, { daysBeforeStay: 0, refundPercentage: 0 }]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-20", checkOut: "2026-06-22" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changeFeeCents).toBe(5000);
  });

  it("admin can modify other members booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
  });

  it("removes invalid promo and sets promoRemoved flag", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking({
      discountCents: 1000,
      finalPriceCents: 9000,
      promoRedemption: {
        id: "pr1",
        promoCodeId: "pc1",
        promoCode: { id: "pc1", active: false, validFrom: null, validUntil: null, maxRedemptions: null, currentRedemptions: 1, membersOnly: false, singleUse: false, type: "PERCENTAGE", percentOff: 10, assignments: [] },
      },
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockedValidatePromo.mockReturnValue("This promo code is no longer active");
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promoRemoved).toBe(true);
  });

  it("cleans up out-of-range SUGGESTED chore assignments", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.choreAssignment.findMany.mockResolvedValue([
      { id: "ca1", status: "SUGGESTED", choreTemplate: { name: "Dishes" }, date: new Date("2026-06-01") },
      { id: "ca2", status: "CONFIRMED", choreTemplate: { name: "Sweep" }, date: new Date("2026-06-01") },
    ]);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: "2026-06-02", checkOut: "2026-06-04" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // SUGGESTED deleted, CONFIRMED kept with warning
    expect(tx.choreAssignment.delete).toHaveBeenCalledWith({ where: { id: "ca1" } });
    expect(body.choreWarnings).toHaveLength(1);
    expect(body.choreWarnings[0]).toContain("CONFIRMED");
  });

  it("sends audit log and email after successful modification", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
      ],
      totalPriceCents: 10000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(30);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkOut: "2026-06-05" }),
    });
    await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.dates" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });

  it("returns 400 for PENDING with non-members modified to check-in within 7 days auto-confirms", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking({
      status: "PENDING",
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-05-25"),
      payment: null,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
    mockedCalcPrice.mockReturnValue({
      guests: [
        { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
        { ageTier: "ADULT" as const, isMember: false, nights: 2, priceCents: 7000, perNightCents: [7000, 7000] },
      ],
      totalPriceCents: 12000,
    });
    mockedCalcChangeFee.mockReturnValue({ feeCents: 0, fromTierRefundPct: 100, toTierRefundPct: 100 });
    mockedDaysUntilDate.mockReturnValue(3);
    mockedLoadPolicy.mockResolvedValue([]);
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    // Check-in 3 days from now (within 7 day hold)
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const soonStr = soon.toISOString().split("T")[0];
    const soonEnd = new Date(soon);
    soonEnd.setDate(soonEnd.getDate() + 2);
    const soonEndStr = soonEnd.toISOString().split("T")[0];

    const req = new NextRequest("http://localhost/api/bookings/bk1/modify-dates", {
      method: "PUT",
      body: JSON.stringify({ checkIn: soonStr, checkOut: soonEndStr }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    // tx.booking.update should have been called with status CONFIRMED
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CONFIRMED" }),
      })
    );
  });
});

describe("POST /api/bookings/[id]/guests", () => {
  let POST: typeof import("@/app/api/bookings/[id]/guests/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/guests/route");
    POST = mod.POST;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty guests array", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the add-guests request exceeds lodge capacity in one payload", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const guests = Array.from({ length: 30 }, (_, index) => ({
      firstName: `Guest${index}`,
      lastName: "Overflow",
      ageTier: "ADULT",
      isMember: false,
    }));
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(body.details.fieldErrors.guests?.[0]).toBeDefined();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 404 for nonexistent booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 for CANCELLED booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking({ status: "BUMPED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 if capacity not available", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: 0, nightDetails: [] });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Not enough beds");
  });

  it("successfully adds guests and recalculates price", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice
      .mockReturnValueOnce({ // new guest price
        guests: [{ ageTier: "ADULT" as const, isMember: false, nights: 2, priceCents: 14000, perNightCents: [7000, 7000] }],
        totalPriceCents: 14000,
      })
      .mockReturnValueOnce({ // full recalc
        guests: [
          { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
          { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
          { ageTier: "ADULT" as const, isMember: false, nights: 2, priceCents: 14000, perNightCents: [7000, 7000] },
        ],
        totalPriceCents: 24000,
      });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: false }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(14000);
    expect(body.additionalAmountCents).toBe(14000);
    expect(tx.bookingGuest.create).toHaveBeenCalledOnce();
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modificationType: "GUEST_ADD" }),
      })
    );
  });

  it("forces typed guest additions to non-member pricing", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice
      .mockReturnValueOnce({
        guests: [{ ageTier: "ADULT" as const, isMember: false, nights: 2, priceCents: 14000, perNightCents: [7000, 7000] }],
        totalPriceCents: 14000,
      })
      .mockReturnValueOnce({
        guests: [
          { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
          { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] },
          { ageTier: "ADULT" as const, isMember: false, nights: 2, priceCents: 14000, perNightCents: [7000, 7000] },
        ],
        totalPriceCents: 24000,
      });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "Manual", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);

    expect(mockedCalcPrice).toHaveBeenNthCalledWith(
      1,
      booking.checkIn,
      booking.checkOut,
      [expect.objectContaining({ isMember: false, ageTier: "ADULT", memberId: null })],
      expect.any(Array)
    );
    expect(tx.bookingGuest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: "Manual",
          lastName: "Guest",
          isMember: false,
          memberId: null,
        }),
      })
    );
  });

  it("no change fee when adding guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice
      .mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }], totalPriceCents: 5000 })
      .mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }, { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }, { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }], totalPriceCents: 15000 });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(res.status).toBe(200);
    // Verify no change fee is calculated (calcChangeFee not called)
    expect(mockedCalcChangeFee).not.toHaveBeenCalled();
  });

  it("sends audit log and email after adding guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    mockedCalcPrice
      .mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }], totalPriceCents: 5000 })
      .mockReturnValueOnce({ guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }, { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }, { ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }], totalPriceCents: 15000 });
    mockedGetHoldDays.mockResolvedValue(7);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests", {
      method: "POST",
      body: JSON.stringify({ guests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true }] }),
    });
    await POST(req, { params: Promise.resolve({ id: "bk1" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.guests.add" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });
});

describe("DELETE /api/bookings/[id]/guests/[guestId]", () => {
  let DELETE: typeof import("@/app/api/bookings/[id]/guests/[guestId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMemberCount.mockResolvedValue(1);
    mockFindUnique.mockResolvedValue({
      id: "m1",
      active: true,
      email: "alice@test.com",
      firstName: "Alice",
    } as any);
    const mod = await import("@/app/api/bookings/[id]/guests/[guestId]/route");
    DELETE = mod.DELETE;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    tx.booking.findUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "other", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 for non-modifiable booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking({ status: "COMPLETED" }));
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 if guest not found on booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const tx = makeTx(makeBooking());
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/nonexistent", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "nonexistent" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Guest not found");
  });

  it("returns 400 when trying to remove last guest", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking({
      guests: [{ id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 10000 }],
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Cannot remove the last guest");
  });

  it("successfully removes guest and recalculates price", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_456" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(-5000);
    expect(body.refundAmountCents).toBe(5000);
    expect(body.stripeRefundId).toBe("re_456");
    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: "g2" } });
    expect(tx.bookingModification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modificationType: "GUEST_REMOVE" }),
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        refundAmountCents: 5000,
        bookingModificationId: "mod1",
      },
      {
        createdByMemberId: "m1",
      }
    );
  });

  it("warns about CONFIRMED/COMPLETED chore assignments", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.choreAssignment.findMany.mockResolvedValue([
      { id: "ca1", status: "CONFIRMED", choreTemplate: { name: "Dishes" }, date: new Date("2026-06-01") },
    ]);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_789" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choreWarnings).toHaveLength(1);
    expect(body.choreWarnings[0]).toContain("Dishes");
    expect(body.choreWarnings[0]).toContain("CONFIRMED");
  });

  it("no change fee when removing guests", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_000" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(mockedCalcChangeFee).not.toHaveBeenCalled();
  });

  it("updates hasNonMembers when removing only non-member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking({
      hasNonMembers: true,
      guests: [
        { id: "g1", bookingId: "bk1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, memberId: "m1", priceCents: 5000 },
        { id: "g2", bookingId: "bk1", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false, memberId: null, priceCents: 7000 },
      ],
      totalPriceCents: 12000,
      finalPriceCents: 12000,
    });
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_nm" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(res.status).toBe(200);
    // Should update hasNonMembers to false
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hasNonMembers: false }),
      })
    );
  });

  it("sends audit log and email after removing guest", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    mockedCalcPrice.mockReturnValue({
      guests: [{ ageTier: "ADULT" as const, isMember: true, nights: 2, priceCents: 5000, perNightCents: [5000, 5000] }],
      totalPriceCents: 5000,
    });
    mockedProcessRefund.mockResolvedValue({ id: "re_audit" } as any);
    mockFindUnique.mockResolvedValue({ id: "m1", active: true, email: "a@t.com", firstName: "A" });

    const req = new NextRequest("http://localhost/api/bookings/bk1/guests/g2", { method: "DELETE" });
    await DELETE(req, { params: Promise.resolve({ id: "bk1", guestId: "g2" }) });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.modify.guests.remove" })
    );
    expect(sendBookingModifiedEmail).toHaveBeenCalled();
  });
});

// --- Email template tests ---

describe("bookingModifiedTemplate", () => {
  it("renders date change template", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates");
    const html = bookingModifiedTemplate({
      firstName: "Alice",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-05"),
      newCheckOut: new Date("2026-06-07"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
    });
    expect(html).toContain("Booking Modified");
    expect(html).toContain("Alice");
    expect(html).toContain("Dates Changed");
    expect(html).toContain("Previous Dates");
    expect(html).toContain("New Dates");
  });

  it("renders guest add template", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates");
    const html = bookingModifiedTemplate({
      firstName: "Bob",
      modificationType: "GUEST_ADD",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-03"),
      oldGuestCount: 2,
      newGuestCount: 3,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 15000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 5000,
    });
    expect(html).toContain("Guests Added");
    expect(html).toContain("Previous Guests");
    expect(html).toContain("New Guests");
    expect(html).toContain("$50.00");
  });

  it("renders guest remove with refund", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates");
    const html = bookingModifiedTemplate({
      firstName: "Carol",
      modificationType: "GUEST_REMOVE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-03"),
      oldGuestCount: 3,
      newGuestCount: 2,
      oldFinalPriceCents: 15000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 5000,
      additionalAmountCents: 0,
    });
    expect(html).toContain("Guest Removed");
    expect(html).toContain("refund");
    expect(html).toContain("$50.00");
  });

  it("shows change fee when present", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates");
    const html = bookingModifiedTemplate({
      firstName: "Dave",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-20"),
      newCheckOut: new Date("2026-06-22"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 5000,
      refundAmountCents: 0,
      additionalAmountCents: 5000,
    });
    expect(html).toContain("Change Fee");
    expect(html).toContain("$50.00");
    expect(html).toContain("additional payment");
  });

  it("escapes HTML in firstName", async () => {
    const { bookingModifiedTemplate } = await import("@/lib/email-templates");
    const html = bookingModifiedTemplate({
      firstName: "<script>alert('xss')</script>",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-05"),
      newCheckOut: new Date("2026-06-07"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

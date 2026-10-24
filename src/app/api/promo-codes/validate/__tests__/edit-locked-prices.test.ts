/**
 * #4202: on a booking edit the promo box prices the party the way the quote and
 * the save do. A night a guest already bought keeps the price it was sold at
 * (#1036, `INV-MOD-005`); only a night the edit buys prices at current rates. So
 * when the club's rates have changed since the booking was made, the box's
 * discount is worked out on the sold prices, as the quote's is, not on today's
 * rate for every night.
 *
 * Real pricing and the real promotion engine; only the database is mocked.
 * Frozen clock discipline: every night is a fixed August 2026 lodge night,
 * after the 2026-07-01 freeze.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  prisma: {
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    promoCode: { findUnique: vi.fn(), findMany: vi.fn() },
    workPartyEvent: { findUnique: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    promoRedemptionAllocation: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    member: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    membershipType: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } })),
}));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/club-time/server", () => ({ clubTime: vi.fn(async () => ({ today: () => "2026-07-01" })) }));
vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-add-policy")),
  loadMemberGuestAddPolicy: vi.fn(async () => ({
    wideningEnabled: false,
    approvalRequired: true,
    pendingHoldExpiryDays: 0,
  })),
}));

import { POST } from "@/app/api/promo-codes/validate/route";

/** Today's rate for a night. */
const NOW_RATE = 5000;
/** What each night already on the booking was sold at, before the rates went up. */
const SOLD = 4000;
const HELD = ["2026-08-10", "2026-08-11", "2026-08-12"];

function promo(overrides: Record<string, unknown>) {
  return {
    id: "promo-1",
    code: "SAVE",
    description: null,
    type: "PERCENTAGE",
    active: true,
    archivedAt: null,
    internal: false,
    percentOff: null,
    valueCents: null,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    membersOnly: false,
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    assignedMembersOnlyOwnNights: true,
    assignments: [],
    lodges: [],
    ...overrides,
  };
}


/** The booking's one guest: an adult member who holds 10-13 August, sold at the old rate. */
const heldGuest = { ageTier: "ADULT", isMember: true, memberId: "member-1", bookingGuestId: "bg-1" };
/** The edit: the guest stays one night longer, to the 14th. */
const extended = { ...heldGuest, stayStart: "2026-08-10", stayEnd: "2026-08-14" };

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "SAVE",
        checkIn: "2026-08-10",
        checkOut: "2026-08-14",
        forBookingEdit: true,
        bookingId: "booking-1",
        ...body,
      }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
  mocks.prisma.season.findMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      type: "WINTER",
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
      ],
    },
  ]);
  mocks.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
  mocks.prisma.promoRedemptionAllocation.aggregate.mockResolvedValue({ _sum: { freeNightsUsed: 0 } });
  mocks.prisma.promoRedemptionAllocation.count.mockResolvedValue(0);
  mocks.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  mocks.prisma.member.findMany.mockResolvedValue([]);
  mocks.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
  mocks.prisma.membershipType.findMany.mockResolvedValue([
    { id: "type-nonmember", key: "NON_MEMBER" },
    { id: "type-full", key: "FULL" },
  ]);
  mocks.prisma.booking.findUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-13"),
  });
  mocks.prisma.bookingGuest.findMany.mockResolvedValue([
    {
      id: "bg-1",
      memberId: "member-1",
      consentStatus: null,
      stayStart: new Date("2026-08-10"),
      stayEnd: new Date("2026-08-13"),
      // #4317: the guest's stored total; three nights at $40 add up to it (R1).
      priceCents: HELD.length * SOLD,
      nights: HELD.map((night) => ({ stayDate: new Date(night), priceCents: SOLD, priceSource: "SOLD" })),
    },
  ]);
});

/** Three nights at their sold price and the new night at today's rate. */
const EDIT_TOTAL = 3 * SOLD + NOW_RATE;

describe("an edit after the rates went up prices the held nights at their sold prices (#4202)", () => {
  it("asks for each stored night's sold price", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    await post({ guests: [extended] });
    expect(mocks.prisma.bookingGuest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
        }),
      }),
    );
  });

  it("a percentage code discounts the sold prices, not today's rate on every night", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({ guests: [extended] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(EDIT_TOTAL);
    expect(body.discountCents).toBe(EDIT_TOTAL / 2);
    expect(body.finalPriceCents).toBe(EDIT_TOTAL / 2);
  });

  it("a free-nights code frees nights at the price each one costs on this booking", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(
      promo({ type: "FREE_NIGHTS", freeNightsPerIndividual: 4 }),
    );
    const res = await post({ guests: [extended] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.freeNightsUsed).toBe(4);
    expect(body.discountCents).toBe(EDIT_TOTAL);
    expect(body.finalPriceCents).toBe(0);
  });

  it("a working bee discounts the held nights in its window at their sold prices", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      id: "event-1",
      name: "Hut bee",
      active: true,
      startDate: new Date("2026-08-10"),
      endDate: new Date("2026-08-11"),
      discountPercent: 100,
      promoCode: promo({ id: "promo-wp", code: "WORKPARTY-X", internal: true, percentOff: 100, membersOnly: true }),
    });
    const res = await post({ code: undefined, workPartyEventId: "event-1", lodgeId: "lodge-1", guests: [extended] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(EDIT_TOTAL);
    expect(body.discountCents).toBe(2 * SOLD);
  });

  it("a guest the edit adds is priced at today's rate on every night", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const friend = { ageTier: "ADULT", isMember: false, stayStart: "2026-08-10", stayEnd: "2026-08-14" };
    const res = await post({ guests: [extended, friend] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(EDIT_TOTAL + 4 * NOW_RATE);
    expect(body.discountCents).toBe((EDIT_TOTAL + 4 * NOW_RATE) / 2);
  });

  it("several codes are priced on the same sold prices", async () => {
    mocks.prisma.promoCode.findMany.mockResolvedValue([promo({ percentOff: 50 })]);
    const res = await post({ code: undefined, codes: [{ code: "SAVE" }], guests: [extended] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(EDIT_TOTAL);
    expect(body.discountCents).toBe(EDIT_TOTAL / 2);
  });

  it("a new booking is unchanged: every night at today's rate", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({
      forBookingEdit: undefined,
      bookingId: undefined,
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "member-1", stayStart: "2026-08-10", stayEnd: "2026-08-14" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(4 * NOW_RATE);
    expect(body.discountCents).toBe(2 * NOW_RATE);
    expect(mocks.prisma.bookingGuest.findMany).not.toHaveBeenCalled();
  });
});

describe("a booking id makes the preview an edit's, whatever forBookingEdit says (#4202)", () => {
  // A club whose group discount prices a non-member at the member rate, but not
  // on later edits (`applyToEdits` off, INV-MOD-026): the quote prices an edit's
  // added non-member at the full non-member rate.
  const NON_MEMBER_RATE = 2 * NOW_RATE;
  beforeEach(() => {
    mocks.prisma.season.findMany.mockResolvedValue([
      {
        id: "season-1",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        type: "WINTER",
        membershipTypeRates: [
          { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: NON_MEMBER_RATE },
        ],
      },
    ]);
    mocks.prisma.groupDiscountSetting.findUnique.mockResolvedValue({
      id: "default",
      enabled: true,
      applyToEdits: false,
      minGroupSize: 2,
      summerOnly: false,
      rateMembershipTypeId: "type-full",
    });
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
  });
  const friend = { ageTier: "ADULT", isMember: false, stayStart: "2026-08-10", stayEnd: "2026-08-14" };

  it("an edit preview that omits forBookingEdit still prices with the edit-time switch", async () => {
    const res = await post({ forBookingEdit: undefined, guests: [extended, friend] });
    expect(res.status).toBe(200);
    expect((await res.json()).totalPriceCents).toBe(EDIT_TOTAL + 4 * NON_MEMBER_RATE);
  });

  it("a new booking's preview keeps the group discount (the comparison has teeth)", async () => {
    const res = await post({
      forBookingEdit: undefined,
      bookingId: undefined,
      guests: [{ ...extended, bookingGuestId: undefined }, friend],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).totalPriceCents).toBe(8 * NOW_RATE);
  });
});

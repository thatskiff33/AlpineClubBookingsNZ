/**
 * #4199: the promo preview prices a guest's chosen nights, not the range around
 * them. A grid guest holding the 10th and 12th of August is discounted on two
 * nights — as the quote and the save price them — where the preview used to
 * strip the night set and discount the 10th to the 12th as three. Range mode is
 * unchanged: continuous dates are priced continuously (#4189, owner decision).
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
    promoCode: { findUnique: vi.fn() },
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

const NIGHTLY = 5000;

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

const GAP_NIGHTS = ["2026-08-10", "2026-08-12"];
/** One adult member holding the 10th and 12th of August, not the 11th. */
const gridGuest = { ageTier: "ADULT", isMember: true, memberId: "member-1", nights: GAP_NIGHTS };

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "SAVE",
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
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
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NIGHTLY },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: NIGHTLY },
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
      // #4317: the stored total and each night's price and provenance; the two
      // held nights at the nightly rate add up to the total (R1).
      priceCents: GAP_NIGHTS.length * NIGHTLY,
      nights: GAP_NIGHTS.map((night) => ({
        stayDate: new Date(night),
        priceCents: NIGHTLY,
        priceSource: "SOLD",
      })),
    },
  ]);
});

describe("a grid guest with a gap (#4199)", () => {
  it("a percentage code discounts the held nights only, on a create preview", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({ guests: [gridGuest] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(2 * NIGHTLY);
    expect(body.discountCents).toBe(NIGHTLY);
  });

  it("a percentage code discounts the held nights only, on the booking editor's preview", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({
      forBookingEdit: true,
      bookingId: "booking-1",
      guests: [{ ...gridGuest, bookingGuestId: "bg-1" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(2 * NIGHTLY);
    expect(body.discountCents).toBe(NIGHTLY);
  });

  it("a free-nights code gives as many free nights as the guest holds, not the range's count", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(
      promo({ type: "FREE_NIGHTS", freeNightsPerIndividual: 3 }),
    );
    const res = await post({ guests: [gridGuest] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.freeNightsUsed).toBe(2);
    expect(body.discountCents).toBe(2 * NIGHTLY);
    expect(body.finalPriceCents).toBe(0);
  });

  it("a working bee whose window is only the gap night gives nothing, rather than a discount on a night not held", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      id: "event-1",
      name: "Gap night bee",
      active: true,
      startDate: new Date("2026-08-11"),
      endDate: new Date("2026-08-11"),
      discountPercent: 100,
      promoCode: promo({ id: "promo-wp", code: "WORKPARTY-X", internal: true, percentOff: 100, membersOnly: true }),
    });
    const held = await post({ code: undefined, workPartyEventId: "event-1", lodgeId: "lodge-1", guests: [gridGuest] });
    expect(held.status).toBe(200);
    const heldBody = await held.json();
    expect(heldBody.totalPriceCents).toBe(2 * NIGHTLY);
    expect(heldBody.discountCents).toBe(0);
    // The same guest as a range stays the 11th, so the bee's night is discounted.
    const range = await post({
      code: undefined,
      workPartyEventId: "event-1",
      lodgeId: "lodge-1",
      guests: [{ ...gridGuest, nights: undefined, stayStart: "2026-08-10", stayEnd: "2026-08-13" }],
    });
    expect(range.status).toBe(200);
    expect((await range.json()).discountCents).toBe(NIGHTLY);
  });

  it("refuses a night that is not a date", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({ guests: [{ ...gridGuest, nights: ["2026-08-10", "not-a-night"] }] });
    expect(res.status).toBe(400);
  });

  it("refuses a night set longer than a year, as every other door does", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const nights = Array.from({ length: 371 }, (_, index) => {
      const night = new Date(Date.UTC(2026, 7, 1 + index));
      return night.toISOString().slice(0, 10);
    });
    const res = await post({ guests: [{ ...gridGuest, nights }] });
    expect(res.status).toBe(400);
  });
});

describe("range mode is unchanged (#4189)", () => {
  it("a gapped guest the editor sends continuous dates for is priced and discounted on all three nights", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({
      forBookingEdit: true,
      bookingId: "booking-1",
      guests: [
        {
          ageTier: "ADULT",
          isMember: true,
          memberId: "member-1",
          bookingGuestId: "bg-1",
          stayStart: "2026-08-10",
          stayEnd: "2026-08-13",
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPriceCents).toBe(3 * NIGHTLY);
    expect(body.discountCents).toBe(1.5 * NIGHTLY);
  });

  it("a guest sent no dates on an unmoved edit keeps their stored nights, as the save does", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const res = await post({
      forBookingEdit: true,
      bookingId: "booking-1",
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "member-1", bookingGuestId: "bg-1" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).totalPriceCents).toBe(2 * NIGHTLY);
  });
});

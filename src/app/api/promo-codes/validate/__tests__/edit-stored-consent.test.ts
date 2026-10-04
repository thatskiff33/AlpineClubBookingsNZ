/**
 * #3492 (C4 review, correctness finding 1; D-3492-4): the edit panel's promo
 * preview judges a guest ALREADY ON the booking by the consent stored on their
 * row, the way `modify-quote` and the save do — so a confirmed cross-family
 * guest's own-night code covers their nights in the preview instead of being
 * re-decided as a fresh add that would land PENDING. Every confirmed state
 * counts: accepted, auto-confirmed where the club only notifies, added by an
 * officer (all stored `CONFIRMED`), and a booking from before guest consent
 * existed (stored null). The booking id is owner-checked and answers an unowned
 * booking exactly as a missing one.
 *
 * Frozen clock discipline: every date is anchored to the 2026-07-01 freeze.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "booker", role: "MEMBER", accessRoles: [{ role: "USER" }] } as Record<string, unknown>,
  },
  prisma: {
    lodge: { findFirst: vi.fn(), findUnique: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
  },
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
  validateSeveralPromoCodes: vi.fn(),
  planMemberGuestConsentWrites: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/club-time/server", () => ({ clubTime: vi.fn(async () => ({ today: () => "2026-07-01" })) }));
vi.mock("@/lib/membership-type-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/membership-type-policy")),
  priceBookingGuestsWithMembershipTypePolicy: mocks.priceBookingGuestsWithMembershipTypePolicy,
}));
vi.mock("@/lib/promo-codes-preview", () => ({
  validateSeveralPromoCodes: mocks.validateSeveralPromoCodes,
}));
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guests")),
  computeMemberGuestBoundary: vi.fn(async () => ({})),
}));
// A club that asks cross-family guests to accept: re-decided as a fresh member
// add, every member guest here would land PENDING.
vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-add-policy")),
  loadMemberGuestAddPolicy: vi.fn(async () => ({
    wideningEnabled: true,
    approvalRequired: true,
    pendingHoldExpiryDays: 7,
  })),
  planMemberGuestConsentWrites: mocks.planMemberGuestConsentWrites,
}));

import { POST } from "@/app/api/promo-codes/validate/route";

const BOOKER = { ageTier: "ADULT", isMember: true, memberId: "booker", bookingGuestId: "bg-booker" };
const FRIEND = { ageTier: "ADULT", isMember: true, memberId: "friend", bookingGuestId: "bg-friend" };

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codes: [{ code: "FRIENDFREE" }],
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        forBookingEdit: true,
        ...body,
      }),
    }),
  );
}

/** The consent each guest reached the promo engine with, in party order. */
function consentSeenByEngine(): Array<string | null> {
  const call = mocks.validateSeveralPromoCodes.mock.calls.at(-1)!;
  return call[0].guests.map((guest: { consentStatus: string | null }) => guest.consentStatus);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.user = { id: "booker", role: "MEMBER", accessRoles: [{ role: "USER" }] };
  mocks.prisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
  mocks.prisma.season.findMany.mockResolvedValue([]);
  mocks.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
  mocks.prisma.booking.findUnique.mockResolvedValue({ id: "booking-1", memberId: "booker", lodgeId: "lodge-1" });
  mocks.priceBookingGuestsWithMembershipTypePolicy.mockImplementation(
    async (_db: unknown, input: { guests: unknown[] }) => ({
      totalPriceCents: input.guests.length * 10000,
      guests: input.guests.map(() => ({
        isMember: true,
        priceCents: 10000,
        perNightCents: [5000, 5000],
        nightDates: ["2026-08-01", "2026-08-02"],
      })),
    }),
  );
  mocks.planMemberGuestConsentWrites.mockImplementation(({ guests }: { guests: Array<{ memberId?: string }> }) => ({
    guests: guests.map((guest) =>
      guest.memberId === "booker" ? guest : { ...guest, consentStatus: "PENDING" },
    ),
  }));
  mocks.validateSeveralPromoCodes.mockResolvedValue({ valid: true, codes: [] });
});

describe("the edit preview reads the booking's stored consent (D-3492-4)", () => {
  it.each([
    ["accepted, auto-confirmed (notify-only) or officer-added", "CONFIRMED", "CONFIRMED"],
    ["on a booking from before guest consent existed", null, null],
  ])("a cross-family guest %s keeps their stored state", async (_label, stored, expected) => {
    mocks.prisma.bookingGuest.findMany.mockResolvedValue([
      { id: "bg-booker", consentStatus: null },
      { id: "bg-friend", consentStatus: stored },
    ]);
    const res = await post({ bookingId: "booking-1", guests: [BOOKER, FRIEND] });
    expect(res.status).toBe(200);
    expect(consentSeenByEngine()).toEqual([null, expected]);
    expect(mocks.prisma.bookingGuest.findMany.mock.calls[0]![0].where).toEqual({
      bookingId: "booking-1",
      id: { in: ["bg-booker", "bg-friend"] },
    });
  });

  it("a guest still pending on the booking stays pending", async () => {
    mocks.prisma.bookingGuest.findMany.mockResolvedValue([{ id: "bg-friend", consentStatus: "PENDING" }]);
    await post({ bookingId: "booking-1", guests: [BOOKER, FRIEND] });
    expect(consentSeenByEngine()).toEqual([null, "PENDING"]);
  });

  it("a guest being added in this edit (no row yet) is judged as the save will add them", async () => {
    mocks.prisma.bookingGuest.findMany.mockResolvedValue([{ id: "bg-booker", consentStatus: null }]);
    const added = { ageTier: "ADULT", isMember: true, memberId: "friend" };
    await post({ bookingId: "booking-1", guests: [BOOKER, added] });
    expect(consentSeenByEngine()).toEqual([null, "PENDING"]);
  });

  it("a row id that is not on this booking falls back to the fresh-add answer", async () => {
    mocks.prisma.bookingGuest.findMany.mockResolvedValue([]);
    await post({ bookingId: "booking-1", guests: [BOOKER, FRIEND] });
    expect(consentSeenByEngine()).toEqual([null, "PENDING"]);
  });

  it("without a booking id (the create wizard) nothing is read and the fresh-add answer stands", async () => {
    await post({ guests: [BOOKER, FRIEND], forBookingEdit: undefined });
    expect(mocks.prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(consentSeenByEngine()).toEqual([null, "PENDING"]);
  });
});

describe("the booking id is the caller's to name", () => {
  it("answers a booking the caller does not own exactly as a missing one, and reads no guest", async () => {
    mocks.session.user = { id: "stranger", role: "MEMBER", accessRoles: [{ role: "USER" }] };
    const notOwned = await post({ bookingId: "booking-1", guests: [BOOKER, FRIEND] });
    mocks.prisma.booking.findUnique.mockResolvedValueOnce(null);
    const missing = await post({ bookingId: "nope", guests: [BOOKER, FRIEND] });
    expect(notOwned.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await notOwned.json()).toEqual(await missing.json());
    expect(mocks.prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(mocks.validateSeveralPromoCodes).not.toHaveBeenCalled();
  });

  it("lets a booking officer preview an edit to another member's booking", async () => {
    mocks.session.user = { id: "officer", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] };
    mocks.prisma.bookingGuest.findMany.mockResolvedValue([{ id: "bg-friend", consentStatus: "CONFIRMED" }]);
    const res = await post({ bookingId: "booking-1", guests: [BOOKER, FRIEND] });
    expect(res.status).toBe(200);
    expect(consentSeenByEngine()).toEqual([null, "CONFIRMED"]);
  });
});

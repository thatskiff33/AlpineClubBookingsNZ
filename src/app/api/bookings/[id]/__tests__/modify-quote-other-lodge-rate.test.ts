import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The reciprocal "other club member" rate, at the PREVIEW boundary (Other Lodges
 * epic, follow-up to #2749).
 *
 * What this suite is really guarding is the #1036 locked-night trap, which the
 * unit tests of `resolveOtherLodgeRateElection` cannot see. A guest's booked
 * nights keep the price they were bought at, so ticking somebody re-rates
 * NOTHING unless their locks are cleared on the way into pricing — the officer
 * would tick the box, watch the total stay exactly the same, and have no idea
 * why. #2337 had to learn the same lesson for the member link.
 *
 * So the assertions are about the pricing INPUT: the flag arrives, the ticked
 * guest's locks are gone, and — the half that is easy to get wrong — an
 * untouched guest beside them keeps theirs.
 */

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  otherLodgeFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  isQuotePricedBooking: vi.fn(),
  // #2978 review: hoisted so the tests can assert what the ROUTE passes it. It
  // was previously an inline stub, which meant nothing checked that the route
  // handed it the booking's guests or the booking's season — the two inputs that
  // decide who gets a tick box.
  resolveOtherLodgeRateEligible: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    otherLodge: { findUnique: h.otherLodgeFindUnique },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
// Partial-mocked, not replaced: keeping `@/lib/booking-modify` real below widens
// the import graph as far as the email templates, which read
// `FALLBACK_LODGE_CAPACITY` from this module at import time. A wholesale mock
// kills the file before a single test runs (AGENTS.md, "test:related").
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lodge-capacity")>();
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
// The rate resolver is a PASSTHROUGH here, deliberately: it stamps a snapshot and
// hands the guest rows straight on, so whatever `priceGuests` receives is exactly
// what the route built — which is the thing under test. What the real resolver
// makes of the flag is unit-tested in `booking-other-lodge-rate.test.ts`.
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // #2978: every guest on this suite's fixtures is a plain non-member, so the
  // real helper would return all of them. Stubbed rather than run for real
  // because this file mocks the module wholesale and has no membership-type or
  // subscription fixtures behind it; WHO is eligible is tested against the real
  // resolver in `membership-type-policy-subscription-reprice.test.ts`, and the
  // FENCE against that answer in `booking-other-lodge-rate.test.ts`. What this
  // file tests is the quote route's behaviour once eligibility is settled.
  resolveOtherLodgeRateEligibleGuestIds: h.resolveOtherLodgeRateEligible,
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: g.otherLodgeMember ? "type-full" : "type-nonmember",
          rateSource: g.otherLodgeMember ? "OTHER_LODGE_MEMBER" : "NON_MEMBER_DEFAULT",
        })),
      ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
// `lockedNightPricesForGuest` is left REAL — it is half of what this suite
// asserts. Only the three collaborators that would need a database are stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    isQuotePricedBooking: h.isQuotePricedBooking,
    isMemberWholeLodgeBooking: vi.fn().mockResolvedValue(false),
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@/lib/booking-guests", () => ({
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  }),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  normalizeBookingGuestInputs: vi.fn().mockReturnValue([]),
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(30),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadModuleFlags,
  CLUB_MODULE_SETTINGS_ID: "default",
  normalizeClubModuleSettings: (record: unknown) => record ?? {},
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.isXeroConnected }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

/**
 * A future booking (the frozen clock is 2026-07-01) owned by a member, with two
 * non-member guests beside them, each holding two locked nights at the
 * non-member price.
 */
function booking(overrides: Record<string, unknown> = {}) {
  const nights = (priceCents: number) => [
    { stayDate: D("2026-08-01"), priceCents },
    { stayDate: D("2026-08-02"), priceCents },
  ];
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    otherLodgeId: null,
    checkIn: D("2026-08-01"),
    checkOut: D("2026-08-03"),
    totalPriceCents: 10600,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10600,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g-owner",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        otherLodgeMember: false,
        stayStart: D("2026-08-01"),
        stayEnd: D("2026-08-03"),
        priceCents: 2000,
        nights: nights(1000),
      },
      {
        id: "g-visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        otherLodgeMember: false,
        stayStart: D("2026-08-01"),
        stayEnd: D("2026-08-03"),
        priceCents: 4800,
        nights: nights(2400),
      },
      {
        id: "g-stranger",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        otherLodgeMember: false,
        stayStart: D("2026-08-01"),
        stayEnd: D("2026-08-03"),
        priceCents: 4800,
        nights: nights(2400),
      },
    ],
    ...overrides,
  };
}

/**
 * The guest rows the route handed to the pricing engine, keyed by guest id.
 *
 * The FIRST call, which is the one that produces the new price. A date change
 * makes several further passes to itemise what each part of the edit cost, and
 * those price the OLD dates from differently-shaped rows — reading the last call
 * would quietly assert against a comparison pass instead of the real quote.
 */
function pricedGuestsById() {
  const call = h.priceGuests.mock.calls[0]?.[1] as {
    guests: Array<{
      bookingGuestId?: string | null;
      otherLodgeMember?: boolean;
      lockedNightPrices?: unknown[];
    }>;
  };
  return new Map(call.guests.map((guest) => [guest.bookingGuestId, guest]));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(booking());
  h.otherLodgeFindUnique.mockResolvedValue({ id: "lodge-partner" });
  h.seasonFindMany.mockResolvedValue([]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.isQuotePricedBooking.mockResolvedValue(false);
  h.resolveOtherLodgeRateEligible.mockImplementation(
    (_db: unknown, { guests }: { guests: Array<{ id: string }> }) =>
      Promise.resolve(new Set(guests.map((guest) => guest.id))),
  );
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  // The visitor drops to the member rate (2000 for the stay); everybody else is
  // unchanged. This is the shape the engine would return once their locks go.
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 8800,
    guests: [
      { priceCents: 2000, perNightCents: [1000, 1000], nightDates: [] },
      { priceCents: 2000, perNightCents: [1000, 1000], nightDates: [] },
      { priceCents: 4800, perNightCents: [2400, 2400], nightDates: [] },
    ],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({});
  h.isXeroConnected.mockResolvedValue(false);
  h.getXeroLockDates.mockResolvedValue(null);
});

describe("modify-quote — other-lodge member rate", () => {
  it("clears ONLY the ticked guest's locked nights, so only they re-rate", async () => {
    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const priced = pricedGuestsById();
    // The ticked guest: flag on, locks gone — without this the re-rate is a no-op.
    expect(priced.get("g-visitor")).toMatchObject({ otherLodgeMember: true });
    expect(priced.get("g-visitor")?.lockedNightPrices).toEqual([]);
    // The non-member beside them: untouched, and STILL HOLDING their locks, so
    // an unrelated person is never silently repriced at today's season rates.
    expect(priced.get("g-stranger")).toMatchObject({ otherLodgeMember: false });
    expect(priced.get("g-stranger")?.lockedNightPrices).toHaveLength(2);
    expect(priced.get("g-owner")?.lockedNightPrices).toHaveLength(2);
  });

  it("returns each guest's recalculated fee and an itemised re-rate line", async () => {
    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );
    const body = await res.json();

    expect(body.guestPrices).toEqual([
      { guestId: "g-owner", priceCents: 2000 },
      { guestId: "g-visitor", priceCents: 2000 },
      { guestId: "g-stranger", priceCents: 4800 },
    ]);
    expect(body.itemizedChanges).toContainEqual({
      label: expect.stringContaining("other-lodge member rate"),
      // 2000 quoted against 4800 booked.
      amountCents: -2800,
    });
  });

  it("unticking clears the locks the other way, so the guest goes back to the non-member rate", async () => {
    h.bookingFindUnique.mockResolvedValue(
      booking({
        otherLodgeId: "lodge-partner",
        guests: booking().guests.map((guest) =>
          guest.id === "g-visitor"
            ? {
                ...guest,
                otherLodgeMember: true,
                priceCents: 2000,
                nights: [
                  { stayDate: D("2026-08-01"), priceCents: 1000 },
                  { stayDate: D("2026-08-02"), priceCents: 1000 },
                ],
              }
            : guest,
        ),
      }),
    );

    const res = await POST(
      req({ otherLodgeId: "lodge-partner", otherLodgeMemberGuestIds: [] }),
      { params },
    );

    expect(res.status).toBe(200);
    const priced = pricedGuestsById();
    expect(priced.get("g-visitor")).toMatchObject({ otherLodgeMember: false });
    expect(priced.get("g-visitor")?.lockedNightPrices).toEqual([]);
    expect(priced.get("g-stranger")?.lockedNightPrices).toHaveLength(2);
  });

  it("keeps pricing a stored other-lodge guest at the member rate on an unrelated edit", async () => {
    h.bookingFindUnique.mockResolvedValue(
      booking({
        otherLodgeId: "lodge-partner",
        guests: booking().guests.map((guest) =>
          guest.id === "g-visitor" ? { ...guest, otherLodgeMember: true } : guest,
        ),
      }),
    );

    // A plain date change that says nothing about the other-lodge rate.
    const res = await POST(req({ checkOut: "2026-08-04" }), { params });

    expect(res.status).toBe(200);
    const priced = pricedGuestsById();
    // The flag survives — dropping it here would quietly put a recognised
    // other-club member back on the non-member rate on the next date change.
    expect(priced.get("g-visitor")).toMatchObject({ otherLodgeMember: true });
    // …and their locks survive too: an unrelated edit reprices nobody.
    expect(priced.get("g-visitor")?.lockedNightPrices).toHaveLength(2);
  });

  it("refuses a non-admin actor", async () => {
    h.authorizationRole.mockReturnValue("MEMBER");

    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  /**
   * #2978 review: the same refusal, from the one actor who gets past the
   * ownership check — the booking's OWN member. That is the only shape in which
   * a non-admin reaches the election resolver at all (the test above is refused
   * ~300 lines earlier, for not owning the booking), so it is the only shape
   * that can show the reads are not done first.
   *
   * `resolveOtherLodgeRateElection` raises its admin-only 403 AFTER eligibility
   * is resolved in program order. Without the `isAdmin` gate on the resolution,
   * an ordinary member could make every one of their own previews pay for
   * several database reads whose answer they are then refused.
   */
  it("refuses the booking's own member without resolving eligibility first", async () => {
    h.auth.mockResolvedValue({ user: { id: "m1" } });
    h.authorizationRole.mockReturnValue("MEMBER");

    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.resolveOtherLodgeRateEligible).not.toHaveBeenCalled();
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  /**
   * #2978 review: this suite stubs eligibility, so without these two assertions
   * nothing checked the ROUTE's half of the contract — which guests it asks
   * about and in which season. A stub that answers "everybody is eligible"
   * cannot tell a correct call from one that passed the wrong booking.
   */
  it("asks about this booking's own guests, in this booking's own season", async () => {
    await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(h.resolveOtherLodgeRateEligible).toHaveBeenCalledTimes(1);
    const [, args] = h.resolveOtherLodgeRateEligible.mock.calls[0] as [
      unknown,
      { seasonYear: number; guests: Array<{ id: string }> },
    ];
    // Every guest on the STORED booking, member and non-member alike — the fence
    // is judged over the whole roster, not over the ticked subset.
    expect(args.guests.map((guest) => guest.id)).toEqual([
      "g-owner",
      "g-visitor",
      "g-stranger",
    ]);
    // The booking's check-in falls in the 2026 season (the fixture stays in
    // August 2026 against the frozen 2026-07-01 clock), NOT any new date this
    // edit proposes: the panel offered the ticks from the stored booking, so the
    // fence has to be judged in the same season or the screen and the save
    // disagree.
    expect(args.seasonYear).toBe(2026);
  });

  it("does not resolve eligibility at all on a modification that never mentions the rate", async () => {
    await POST(req({ checkOut: "2026-08-04" }), { params });

    expect(h.resolveOtherLodgeRateEligible).not.toHaveBeenCalled();
  });

  it("refuses a lodge id that names nothing", async () => {
    h.otherLodgeFindUnique.mockResolvedValue(null);

    const res = await POST(
      req({ otherLodgeId: "lodge-gone", otherLodgeMemberGuestIds: ["g-visitor"] }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Selected lodge not found" });
  });

  it("is exempt from the quote-priced edit block, which is where these guests come from", async () => {
    // A booking converted from a public request is quote-priced. That is exactly
    // the path the public "are you a member of another lodge?" answer arrives on,
    // so an election-only edit is allowed through — the same exemption #2337's
    // link carries, and for the same reason.
    h.isQuotePricedBooking.mockResolvedValue(true);

    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(200);
  });

  it("still blocks a quote-priced booking when the election rides a date change", async () => {
    h.isQuotePricedBooking.mockResolvedValue(true);

    const res = await POST(
      req({
        checkOut: "2026-08-04",
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(400);
  });
});

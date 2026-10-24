import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEGATIVE_EDITED_HEADLINE_MESSAGE } from "@/lib/edit-night-valuation";
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
  isMemberWholeLodgeBooking: vi.fn(),
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
    // #3032: the preview half of the pending-review fence reads this. Empty by
    // default - no financial review is open - so this suite asserts exactly what
    // it asserted before.
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findUnique: h.bookingFindUnique },
    // `findFirst` (#58): a newly chosen lodge must also be visible.
    otherLodge: { findUnique: h.otherLodgeFindUnique, findFirst: h.otherLodgeFindUnique },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
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
  const actual = (await importOriginal()) as typeof import("@/lib/lodge-capacity");
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
// The valued night locks (`editedGuestPricingLocks`) are left REAL — half of what this suite
// asserts. Only the three collaborators that would need a database are stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-modify");
  return {
    ...actual,
    isQuotePricedBooking: h.isQuotePricedBooking,
    isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
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
  const actual = (await importOriginal()) as typeof import("@/lib/xero-organisation");
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
  // #3809: the quote's give-back preview reads the applied credit; none here.
  deriveBookingAppliedCreditCents: vi.fn().mockResolvedValue(0),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";
import {
  OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE,
  OTHER_LODGE_RATE_LINKED_GUEST_MESSAGE,
} from "@/lib/booking-other-lodge-rate";

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
    { stayDate: D("2026-08-01"), priceCents, priceSource: "SOLD" as const },
    { stayDate: D("2026-08-02"), priceCents, priceSource: "SOLD" as const },
  ];
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    otherLodgeId: null,
    checkIn: D("2026-08-01"),
    checkOut: D("2026-08-03"),
    // The stored guest prices summed: 2000 + 4800 + 4800 (#4197).
    totalPriceCents: 11600,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 11600,
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
 * The FIRST call, which is the one that produces the new price. The breakdown
 * reads that same pass since #4197; before then a date change made further
 * comparison passes, which is why this names the first call rather than the last.
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
  h.isMemberWholeLodgeBooking.mockResolvedValue(false);
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

  it("itemises the re-rate once, so the breakdown adds up to the total (#4197)", async () => {
    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );
    const body = await res.json();

    // The re-rated guest's whole change is on the re-rate line; the stay line
    // must not count it a second time.
    expect(body.priceDiffCents).toBe(-2800);
    expect(body.itemizedChanges).toEqual([
      { label: expect.stringContaining("other-lodge member rate"), amountCents: -2800 },
    ]);
  });

  it("a re-rate beside a date change says its line includes the guest's date change (#4197)", async () => {
    // One more night: the owner and the stranger keep their locked nights and buy
    // the 3rd at their rates; the visitor's whole stay re-prices at the member rate.
    const nightDates = [D("2026-08-01"), D("2026-08-02"), D("2026-08-03")];
    h.priceGuests.mockResolvedValue({
      totalPriceCents: 13200,
      guests: [
        { priceCents: 3000, perNightCents: [1000, 1000, 1000], nightDates },
        { priceCents: 3000, perNightCents: [1000, 1000, 1000], nightDates },
        { priceCents: 7200, perNightCents: [2400, 2400, 2400], nightDates },
      ],
    });
    const res = await POST(
      req({
        checkOut: "2026-08-04",
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.priceDiffCents).toBe(13200 - 11600);
    expect(body.itemizedChanges).toEqual([
      {
        label: expect.stringMatching(/other-lodge member rate, including their date change$/),
        amountCents: 3000 - 4800,
      },
      { label: "Date change: 2 nights → 3 nights", amountCents: 1000 + 2400 },
    ]);
  });

  it("refuses linking a guest and changing their other-lodge rate in one change (#4197)", async () => {
    // Both would re-rate the same guest, and each has its own breakdown line, so
    // the quote would count the change twice. The same resolver refuses it on
    // the save. (On a real booking the negotiated-price block, which a link plus
    // an election does not escape, refuses first; this pins the rule itself.)
    h.isMemberWholeLodgeBooking.mockResolvedValue(true);
    h.bookingFindUnique.mockResolvedValue(booking({ wholeLodgeHold: true }));
    const res = await POST(
      req({
        linkGuestToMember: [{ guestId: "g-visitor", memberId: "member-9" }],
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: OTHER_LODGE_RATE_LINKED_GUEST_MESSAGE });
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("an untouched guest priced differently with no date change reads as a recalculation (#4197)", async () => {
    // The owner's nights do not move but come back dearer. In real data the
    // pre-check-in gate parks an unlocked strand before this line is built
    // (#3166); the pricer is stubbed here to reach the label regardless.
    h.priceGuests.mockResolvedValue({
      totalPriceCents: 9300,
      guests: [
        { priceCents: 2500, perNightCents: [1250, 1250], nightDates: [] },
        { priceCents: 2000, perNightCents: [1000, 1000], nightDates: [] },
        { priceCents: 4800, perNightCents: [2400, 2400], nightDates: [] },
      ],
    });
    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );
    const body = await res.json();

    expect(body.priceDiffCents).toBe(9300 - 11600);
    expect(body.itemizedChanges).toEqual([
      { label: expect.stringMatching(/other-lodge member rate$/), amountCents: -2800 },
      { label: "Price recalculated (rate difference)", amountCents: 500 },
    ]);
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
                  { stayDate: D("2026-08-01"), priceCents: 1000, priceSource: "SOLD" },
                  { stayDate: D("2026-08-02"), priceCents: 1000, priceSource: "SOLD" },
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

  it("still quotes an unrelated change on a booking whose stored lodge is HIDDEN (#58)", async () => {
    h.bookingFindUnique.mockResolvedValue(booking({ otherLodgeId: "lodge-hidden" }));
    h.otherLodgeFindUnique.mockResolvedValue(null); // hidden: not offered anew

    const res = await POST(req({ checkOut: "2026-08-04" }), { params });

    expect(res.status).not.toBe(400);
    expect(h.otherLodgeFindUnique).not.toHaveBeenCalled();
  });

  it("still quotes a tick-only change that keeps the booking's HIDDEN lodge (#58)", async () => {
    h.bookingFindUnique.mockResolvedValue(booking({ otherLodgeId: "lodge-hidden" }));
    h.otherLodgeFindUnique.mockResolvedValue(null);

    const res = await POST(
      req({ otherLodgeId: "lodge-hidden", otherLodgeMemberGuestIds: ["g-visitor"] }),
      { params },
    );

    expect(res.status).not.toBe(400);
    expect(h.otherLodgeFindUnique).not.toHaveBeenCalled();
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

/**
 * #4317 (epic #4302): AN ELECTION ON A BOOKING WHOSE ROWS DO NOT RECONCILE IS
 * PRICED, NEVER REFUSED.
 *
 * #3214 refused an other-lodge election on an edit that parked its money. No
 * edit parks since #4317 (`INV-MOD-028`), so the refusal is gone: `g-stranger`
 * carries a stored total that does not reconcile with its own night rows, and
 * the valuation keeps that total on the strand (R3), so the re-rate quotes
 * exactly what it quotes on the same booking with reconciling rows.
 */
describe("modify-quote — an election on a booking whose rows do not reconcile", () => {
  beforeEach(() => {
    // The engine's own lock rule: a guest whose nights are locked is priced at
    // its locks, which since #4317 are its VALUED nights - so the drifted
    // stranger keeps its stored $50 rather than the fixed $48 the default mock
    // returns. Without it the mock would reprice that strand as no real edit
    // does. A guest with its locks cleared (the re-rated visitor) takes the
    // figure the default mock gives it.
    const unlocked = [2000, 2000, 4800];
    h.priceGuests.mockImplementation(
      async (
        _db: unknown,
        input: { guests: Array<{ lockedNightPrices?: ReadonlyArray<{ priceCents: number }> | null }> },
      ) => {
        const guests = input.guests.map((guest, index) => {
          const locks = guest.lockedNightPrices ?? [];
          const priceCents =
            locks.length > 0
              ? locks.reduce((sum, lock) => sum + lock.priceCents, 0)
              : (unlocked[index] ?? 0);
          return { priceCents, perNightCents: [priceCents / 2, priceCents / 2], nightDates: [] };
        });
        return {
          totalPriceCents: guests.reduce((sum, guest) => sum + guest.priceCents, 0),
          guests,
        };
      },
    );
  });

  /** The same booking, with one strand whose stored total has drifted. */
  function unreconciled() {
    const stored = booking();
    return {
      ...stored,
      guests: stored.guests.map((guest) =>
        guest.id === "g-stranger" ? { ...guest, priceCents: 5000 } : guest,
      ),
    };
  }

  async function quoteDiff(stored: object, body: unknown) {
    h.bookingFindUnique.mockResolvedValue(stored);
    const res = await POST(req(body), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.financialReviewRequired).toBeUndefined();
    return json.priceDiffCents as number;
  }

  it("quotes an edit with no election, and no review notice", async () => {
    await quoteDiff(unreconciled(), { checkOut: "2026-08-04" });
  });

  it("prices a tick exactly as on the reconciled booking", async () => {
    const tick = { otherLodgeId: "lodge-partner", otherLodgeMemberGuestIds: ["g-visitor"] };
    expect(await quoteDiff(unreconciled(), tick)).toBe(await quoteDiff(booking(), tick));
  });

  it("prices an untick exactly as on the reconciled booking", async () => {
    const withTick = (stored: ReturnType<typeof booking>) => ({
      ...stored,
      otherLodgeId: "lodge-partner",
      guests: stored.guests.map((guest) =>
        guest.id === "g-visitor" ? { ...guest, otherLodgeMember: true } : guest,
      ),
    });
    const untick = { otherLodgeId: "lodge-partner", otherLodgeMemberGuestIds: [] };
    expect(await quoteDiff(withTick(unreconciled()), untick)).toBe(
      await quoteDiff(withTick(booking()), untick),
    );
  });
});

/**
 * #4317 review round 2: the preview refuses, in the save's words, an edit that
 * would carry a headline frozen below its guests under zero. The headline here
 * is $10 over $116 of guests; the tick takes the guests to $88, which carried
 * forward would be a -$18 total.
 */
describe("modify-quote — an edit that would carry a frozen headline below zero", () => {
  it("answers 409 with the save's refusal, quoting nothing", async () => {
    h.bookingFindUnique.mockResolvedValue(booking({ totalPriceCents: 1000, finalPriceCents: 1000 }));
    const res = await POST(
      req({ otherLodgeId: "lodge-partner", otherLodgeMemberGuestIds: ["g-visitor"] }),
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(NEGATIVE_EDITED_HEADLINE_MESSAGE);
  });
});

/**
 * THE MID-STAY REFUSAL, which had no test at all until #3214's review round.
 *
 * `OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE` refuses an election once the stay is
 * under way, on both surfaces, because the in-progress plan prices the STORED
 * guest rows and would settle $0, so the refusal is pinned here rather than
 * assumed.
 */
describe("modify-quote — an election once the stay is under way", () => {
  /** The same booking, moved so the frozen clock (2026-07-01) sits inside it. */
  function inProgress(overrides: Record<string, unknown> = {}) {
    const stored = booking();
    return {
      ...stored,
      checkIn: D("2026-06-29"),
      checkOut: D("2026-07-03"),
      guests: stored.guests.map((guest) => ({
        ...guest,
        stayStart: D("2026-06-29"),
        stayEnd: D("2026-07-03"),
      })),
      ...overrides,
    };
  }

  it("REFUSES a tick rather than quoting a $0 re-rate", async () => {
    h.bookingFindUnique.mockResolvedValue(inProgress());

    const res = await POST(
      req({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: ["g-visitor"],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE,
    });
  });

  it("REFUSES a request that names only the lodge, the half a `!== undefined` pair is easiest to lose", async () => {
    h.bookingFindUnique.mockResolvedValue(inProgress());

    const res = await POST(req({ otherLodgeId: "lodge-partner" }), { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE,
    });
  });

  it("REFUSES a request that CLEARS the lodge, so `null` is not read as silence", async () => {
    h.bookingFindUnique.mockResolvedValue(
      inProgress({ otherLodgeId: "lodge-partner" }),
    );

    const res = await POST(req({ otherLodgeId: null }), { params });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE,
    });
  });
});

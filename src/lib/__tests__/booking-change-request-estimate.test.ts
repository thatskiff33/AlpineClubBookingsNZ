import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part A: the estimate an in-progress change-request card shows for the
 * guests it adds. The pricing engine is real; only the reads around it are
 * stubbed.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  loadActiveSeasonRates: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  resolveGuestRateMembershipTypes: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    groupDiscountSetting: {
      findUnique: (...args: unknown[]) => mocks.groupDiscountFindUnique(...args),
    },
  },
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: async () => "lodge-1" }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  rateLimiters: { bookingQuery: { id: "booking-query" } },
}));
vi.mock("@/lib/booking-modify-plan", () => ({
  loadActiveSeasonRates: (...args: unknown[]) => mocks.loadActiveSeasonRates(...args),
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutMode: async () => "HARD_BLOCK",
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveGroupDiscountRateType: async (_db: unknown, config: unknown) => config,
  resolveGuestRateMembershipTypes: (...args: unknown[]) =>
    mocks.resolveGuestRateMembershipTypes(...args),
}));

import { estimateChangeRequestAddedGuests } from "@/lib/booking-change-request-estimate";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE } from "@/lib/booking-change-request-guests";
import {
  CHANGE_REQUEST_UNKNOWN_RANGE_GUEST_MESSAGE,
  CHANGE_REQUEST_UNKNOWN_REMOVED_GUEST_MESSAGE,
} from "@/lib/booking-change-request-input";
import { POST } from "@/app/api/bookings/[id]/change-requests/quote/route";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const SEASON = {
  seasonId: "season-1",
  startDate: day("2026-06-01"),
  endDate: day("2026-09-30"),
  type: "SUMMER" as const,
  rates: [
    { membershipTypeId: "NON_MEMBER", ageTier: "CHILD" as const, pricePerNightCents: 2000 },
    { membershipTypeId: "NON_MEMBER", ageTier: "ADULT" as const, pricePerNightCents: 4000 },
    { membershipTypeId: "FULL", ageTier: "CHILD" as const, pricePerNightCents: 1000 },
  ],
};

function booking(guestCount = 1) {
  return {
    memberId: "member-1",
    deletedAt: null,
    checkIn: day("2026-06-30"),
    checkOut: day("2026-07-03"),
    lodgeId: "lodge-1",
    guests: Array.from({ length: guestCount }, (_, index) => ({
      id: `guest-${index}`,
      firstName: "Existing",
      lastName: "Guest",
      stayStart: day("2026-06-30"),
      stayEnd: day("2026-07-03"),
      ageTier: "ADULT" as const,
      isMember: true,
      rateMembershipTypeId: "FULL",
      nights: [{ stayDate: day("2026-06-30") }, { stayDate: day("2026-07-01") }, { stayDate: day("2026-07-02") }],
    })),
  };
}

const child = (firstName: string, extra: Record<string, unknown> = {}) => ({
  firstName,
  lastName: "Example",
  ageTier: "CHILD" as const,
  isMember: false,
  ...extra,
});

describe("estimateChangeRequestAddedGuests (#4030)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadActiveSeasonRates.mockResolvedValue([SEASON]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.resolveGuestRateMembershipTypes.mockImplementation(
      async (_db: unknown, params: { guests: Array<Record<string, unknown>> }) =>
        params.guests.map((guest) => ({
          ...guest,
          rateMembershipTypeId: "NON_MEMBER",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
    );
  });

  it("prices each non-member guest on their own nights at the season rate", async () => {
    const estimate = await estimateChangeRequestAddedGuests(booking(), [
      child("Ari", { stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
      child("Bo", { stayStart: "2026-07-01", stayEnd: "2026-07-02" }),
    ]);
    expect(estimate).toEqual({
      outcome: "priced",
      guests: [
        { priceCents: 6000, nights: 3 },
        { priceCents: 2000, nights: 1 },
      ],
      totalCents: 8000,
      excludesMemberGuests: false,
    });
  });

  it("prices a grid night set on exactly its nights, gap and all (#4088)", async () => {
    const estimate = await estimateChangeRequestAddedGuests(booking(), [
      child("Ari", { nights: ["2026-06-30", "2026-07-02"] }),
      { ...child("Cam"), isMember: true, memberId: "member-9", nights: ["2026-07-01"] },
    ]);
    expect(estimate).toMatchObject({
      outcome: "priced",
      guests: [{ priceCents: 4000, nights: 2 }, { priceCents: null, nights: 1 }],
      totalCents: 4000,
    });
  });

  it("never resolves a member guest's rate, and leaves them out of the total", async () => {
    const estimate = await estimateChangeRequestAddedGuests(booking(), [
      child("Ari"),
      { ...child("Cam"), isMember: true, memberId: "member-9" },
    ]);
    expect(estimate).toMatchObject({
      outcome: "priced",
      guests: [{ priceCents: 6000, nights: 3 }, { priceCents: null, nights: 3 }],
      totalCents: 6000,
      excludesMemberGuests: true,
    });
    // The resolver was handed only the non-member, and with no member id.
    const resolved = mocks.resolveGuestRateMembershipTypes.mock.calls[0][1] as {
      guests: Array<{ memberId: unknown; isMember: boolean }>;
    };
    expect(resolved.guests).toEqual([expect.objectContaining({ isMember: false, memberId: null })]);
  });

  it("counts the guests already on the booking toward the group discount, without pricing them", async () => {
    mocks.groupDiscountFindUnique.mockResolvedValue({
      enabled: true,
      applyToEdits: true,
      minGroupSize: 3,
      summerOnly: false,
      rateMembershipTypeId: "FULL",
    });
    // Two existing + one added = 3: the added child is priced at the FULL rate.
    const estimate = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")]);
    expect(estimate).toMatchObject({ outcome: "priced", totalCents: 3000 });
    // One existing + one added = 2: below the size, the non-member rate.
    const smaller = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")]);
    expect(smaller).toMatchObject({ outcome: "priced", totalCents: 6000 });
  });

  it("counts an added member guest toward the group discount without pricing them (review M5)", async () => {
    mocks.groupDiscountFindUnique.mockResolvedValue({
      enabled: true,
      applyToEdits: true,
      minGroupSize: 3,
      summerOnly: false,
      rateMembershipTypeId: "FULL",
    });
    // One existing + one added member + one added child = 3: the child gets the
    // discounted FULL rate, and the member is counted but never priced.
    const estimate = await estimateChangeRequestAddedGuests(booking(1), [
      { ...child("Cam"), isMember: true, memberId: "member-9" },
      child("Ari"),
    ]);
    expect(estimate).toMatchObject({
      outcome: "priced",
      guests: [{ priceCents: null, nights: 3 }, { priceCents: 3000, nights: 3 }],
      totalCents: 3000,
      excludesMemberGuests: true,
    });
  });

  describe("the whole proposed party decides the group discount (#4203)", () => {
    const GROUP_OF_THREE = {
      enabled: true,
      applyToEdits: true,
      minGroupSize: 3,
      summerOnly: false,
      rateMembershipTypeId: "FULL",
    };
    const editorMember = { ...child("Cam"), isMember: true, memberId: "member-9" };

    beforeEach(() => {
      mocks.groupDiscountFindUnique.mockResolvedValue(GROUP_OF_THREE);
    });

    it("counts the editor's added member toward the threshold without pricing them", async () => {
      // Stored guest + card child = 2: below the size, the non-member rate.
      const without = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")]);
      expect(without).toMatchObject({ outcome: "priced", guests: [{ priceCents: 6000, nights: 3 }], totalCents: 6000 });
      mocks.resolveGuestRateMembershipTypes.mockClear();
      // + the editor's added member = 3: the child gets the FULL rate.
      const estimate = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")], {
        addGuests: [editorMember],
      });
      expect(estimate).toEqual({
        outcome: "priced",
        guests: [{ priceCents: 3000, nights: 3 }],
        totalCents: 3000,
        excludesMemberGuests: false,
      });
      // Only the card's non-member reached the rate resolver: the editor's
      // member was never resolved.
      const resolved = mocks.resolveGuestRateMembershipTypes.mock.calls[0][1] as {
        guests: Array<{ memberId: unknown; isMember: boolean }>;
      };
      expect(resolved.guests).toEqual([expect.objectContaining({ isMember: false, memberId: null })]);
    });

    it("counts an editor-added non-member without pricing or returning them", async () => {
      const estimate = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")], {
        addGuests: [child("Editor")],
      });
      expect(estimate).toMatchObject({ guests: [{ priceCents: 3000, nights: 3 }], totalCents: 3000 });
      expect(mocks.resolveGuestRateMembershipTypes.mock.calls[0][1].guests).toHaveLength(1);
    });

    it("an editor removal drops the party below the threshold", async () => {
      const full = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")]);
      expect(full).toMatchObject({ totalCents: 3000 });
      const removed = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")], {
        removeGuestIds: ["guest-1"],
      });
      expect(removed).toMatchObject({ guests: [{ priceCents: 6000, nights: 3 }], totalCents: 6000 });
    });

    it("an editor's changed nights move the threshold only on the nights they change", async () => {
      // guest-1 now holds only the first night: three on 30 Jun, two after.
      const estimate = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")], {
        guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30"] }],
      });
      expect(estimate).toMatchObject({ guests: [{ priceCents: 1000 + 2000 + 2000, nights: 3 }] });
    });

    it("INV-REQ-012: a repeated range keeps a gapped guest's nights in the count", async () => {
      const gapped = booking(2);
      gapped.guests[1].nights = [{ stayDate: day("2026-06-30") }, { stayDate: day("2026-07-02") }];
      // The form sends the gapped guest's own Date In and Date Out back: they
      // keep their two nights, so the party is three on those nights only.
      const estimate = await estimateChangeRequestAddedGuests(gapped, [child("Ari")], {
        guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      });
      expect(estimate).toMatchObject({ guests: [{ priceCents: 1000 + 2000 + 1000, nights: 3 }] });
    });

    it("a moved check-out with no ranges counts the guests on the new nights too", async () => {
      // Check-out moves a night later and no guest names a range: the staying
      // guests stretch to the new stay, as the planner writes them, so the party
      // is three on all four nights and the card child is priced on all four.
      const estimate = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")], {
        checkOut: "2026-07-04",
      });
      expect(estimate).toMatchObject({ guests: [{ priceCents: 4 * 1000, nights: 4 }], totalCents: 4000 });
    });

    it("resolves the card guest's rate in the season year of the proposed check-in", async () => {
      const moved = booking(1);
      moved.checkIn = day("2026-04-01");
      moved.checkOut = day("2026-04-03");
      moved.guests[0].stayStart = day("2026-04-01");
      moved.guests[0].stayEnd = day("2026-04-03");
      moved.guests[0].nights = [{ stayDate: day("2026-04-01") }, { stayDate: day("2026-04-02") }];
      // The premise: the proposal crosses a season-year boundary.
      expect(seasonYearOfStoredDate(day("2026-03-30"))).not.toBe(seasonYearOfStoredDate(moved.checkIn));
      await estimateChangeRequestAddedGuests(moved, [child("Ari")], { checkIn: "2026-03-30" });
      expect(mocks.resolveGuestRateMembershipTypes.mock.calls[0][1]).toMatchObject({
        seasonYear: seasonYearOfStoredDate(day("2026-03-30")),
      });
    });

    it("no editor change leaves the estimate as it was", async () => {
      const before = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")]);
      const empty = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")], {});
      expect(empty).toEqual(before);
    });
  });

  it("says the nights can't be priced when no active season covers them", async () => {
    mocks.loadActiveSeasonRates.mockResolvedValue([]);
    const estimate = await estimateChangeRequestAddedGuests(booking(), [child("Ari")]);
    expect(estimate).toEqual({ outcome: "unpriced", message: expect.stringMatching(/can't be priced/) });
  });
});

describe("POST /api/bookings/[id]/change-requests/quote (#4030)", () => {
  function post(body: unknown) {
    return POST(
      new NextRequest("http://localhost/api/bookings/booking-1/change-requests/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [] } });
    mocks.bookingFindUnique.mockResolvedValue(booking());
    mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: 0 });
    mocks.loadActiveSeasonRates.mockResolvedValue([SEASON]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.resolveGuestRateMembershipTypes.mockImplementation(
      async (_db: unknown, params: { guests: Array<Record<string, unknown>> }) =>
        params.guests.map((guest) => ({ ...guest, rateMembershipTypeId: "NON_MEMBER" })),
    );
  });

  it("answers the owner with the estimate", async () => {
    const response = await post({ addGuests: [child("Ari", { stayStart: "2026-07-01", stayEnd: "2026-07-03" })] });
    expect(response.status).toBe(200);
    expect((await response.json()).estimate).toMatchObject({ outcome: "priced", totalCents: 4000 });
  });

  it("keeps an added guest's night set, and refuses one reaching outside the stay (#4088)", async () => {
    const response = await post({ addGuests: [child("Ari", { nights: ["2026-06-30", "2026-07-02"] })] });
    expect(response.status).toBe(200);
    expect((await response.json()).estimate).toMatchObject({ outcome: "priced", totalCents: 4000 });
    const outside = await post({ addGuests: [child("Ari", { nights: ["2026-07-03"] })] });
    expect(outside.status).toBe(400);
  });

  it("INV-REQ-011: refuses a moved date the merged guest nights do not reach before pricing (#4090)", async () => {
    const response = await post({
      editorChanges: { checkOut: "2026-07-04" },
      addGuests: [child("Ari", { stayStart: "2026-07-01", stayEnd: "2026-07-03" })],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE });
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
    expect(mocks.resolveGuestRateMembershipTypes).not.toHaveBeenCalled();
  });

  it("accepts a moved date reached by the editor night set while pricing only card guests", async () => {
    const response = await post({
      editorChanges: {
        checkOut: "2026-07-04",
        guestStayRanges: [{ guestId: "guest-0", nights: ["2026-06-30", "2026-07-03"] }],
        addGuests: [child("Editor", { stayStart: "2026-06-30", stayEnd: "2026-07-04" })],
      },
      addGuests: [child("Ari", { nights: ["2026-07-01"] })],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).estimate).toMatchObject({ outcome: "priced", totalCents: 2000, guests: [{ nights: 1 }] });
    expect(mocks.resolveGuestRateMembershipTypes.mock.calls[0][1].guests).toHaveLength(1);
  });

  it("includes editor removals when checking the proposed envelope", async () => {
    const input = {
      editorChanges: { checkOut: "2026-07-02", removeGuestIds: ["guest-0"] },
      addGuests: [child("Ari", { nights: ["2026-07-01"] })],
    };
    expect((await post(input)).status).toBe(200);
    mocks.loadActiveSeasonRates.mockClear();
    const response = await post({ ...input, editorChanges: { checkOut: "2026-07-02" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE });
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("prices the card guest inside the editor's proposed party (#4203)", async () => {
    mocks.groupDiscountFindUnique.mockResolvedValue({
      enabled: true,
      applyToEdits: true,
      minGroupSize: 3,
      summerOnly: false,
      rateMembershipTypeId: "FULL",
    });
    // The canonical non-member rate source, which the group discount re-rates.
    mocks.resolveGuestRateMembershipTypes.mockImplementation(
      async (_db: unknown, params: { guests: Array<Record<string, unknown>> }) =>
        params.guests.map((guest) => ({ ...guest, rateMembershipTypeId: "NON_MEMBER", rateSource: "NON_MEMBER_DEFAULT" })),
    );
    const response = await post({
      editorChanges: { addGuests: [{ ...child("Cam"), isMember: true, memberId: "member-9" }] },
      addGuests: [child("Ari")],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).estimate).toEqual({
      outcome: "priced",
      guests: [{ priceCents: 3000, nights: 3 }],
      totalCents: 3000,
      excludesMemberGuests: false,
    });
    expect(mocks.resolveGuestRateMembershipTypes.mock.calls[0][1].guests).toEqual([
      expect.objectContaining({ isMember: false, memberId: null }),
    ]);
  });

  it.each([
    [{ removeGuestIds: ["guest-of-another-booking"] }, CHANGE_REQUEST_UNKNOWN_REMOVED_GUEST_MESSAGE],
    [
      { guestStayRanges: [{ guestId: "guest-of-another-booking", nights: ["2026-07-01"] }] },
      CHANGE_REQUEST_UNKNOWN_RANGE_GUEST_MESSAGE,
    ],
  ])("refuses editor changes naming a guest not on this booking (#4203) %j", async (editorChanges, message) => {
    const response = await post({ editorChanges, addGuests: [child("Ari")] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it.each([
    [{ checkOut: "2026-02-30" }, "Invalid booking date"],
    [{ checkOut: "2026-06-29" }, "Check-out must be after check-in"],
    [{ guestStayRanges: [{ guestId: "guest-0", stayStart: "bad", stayEnd: "2026-07-03" }] }, "yyyy-mm-dd"],
    [{ guestStayRanges: [{ guestId: "guest-0", nights: ["2026-02-30"] }] }, "night"],
    [{ guestStayRanges: [{ guestId: "guest-0", stayStart: "2026-07-01" }] }, "both"],
  ])("uses canonical date/night validation for editor input %j", async (editorChanges, message) => {
    const response = await post({ editorChanges, addGuests: [child("Ari")] });
    expect(response.status).toBe(400);
    expect((await response.json()).error.toLowerCase()).toContain(message.toLowerCase());
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("applies submission's guest cap to the merged additions", async () => {
    const response = await post({
      editorChanges: { addGuests: Array.from({ length: 200 }, () => child("Editor")) },
      addGuests: [child("Ari")],
    });
    expect(response.status).toBe(400);
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("throttles the estimate per member with the booking-query limiter (review S1)", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, resetAt: Date.now() + 30_000 });
    const response = await post({ addGuests: [child("Ari")] });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith({ id: "booking-query" }, "member-1");
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("spends no budget for a caller refused at the owner check", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [] } });
    expect((await post({ addGuests: [child("Ari")] })).status).toBe(403);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses somebody else's booking", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [] } });
    const response = await post({ addGuests: [child("Ari")] });
    expect(response.status).toBe(403);
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("answers a deleted booking exactly as a missing one, after the authorisation check (INV-ADDPAY-031)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...booking(), deletedAt: new Date("2026-06-01T00:00:00.000Z") });
    const response = await post({ addGuests: [child("Ari")] });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Booking not found" });
    // A caller with no claim is refused the same way, deleted or not.
    mocks.auth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [] } });
    expect((await post({ addGuests: [child("Ari")] })).status).toBe(403);
  });

  it("refuses nights outside the stay", async () => {
    const response = await post({ addGuests: [child("Ari", { stayStart: "2026-06-29" })] });
    expect(response.status).toBe(400);
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("refuses an empty list", async () => {
    const response = await post({ addGuests: [] });
    expect(response.status).toBe(400);
  });
});

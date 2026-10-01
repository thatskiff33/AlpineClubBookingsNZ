import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
  DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE,
  DIFFERENT_PERSON_SAME_NAME,
} from "@/lib/booking-dependant-identity";

/*
  #3451 — own-dependant identity on the edit panel's PREVIEW door
  (`INV-GUEST-019`; owner decision 1 Oct 2026, option C, "ask in place on
  add-guest"). `modify-quote` is where the panel learns that a name it is adding
  is one of the booking OWNER's recorded dependants: it refuses the quote with the
  create route's code so the panel asks, and re-checks the answer that comes back.

  Every refusal is asserted with "and pricing never ran", so the pin is that no
  quote is produced for the unanswered party — not merely that a message came
  back. The harness is `modify-quote-member-link-in-progress.test.ts`'s, with the
  member resolution left to the real normaliser.
*/

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
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
  validateMinimumStay: vi.fn(),
  isMemberWholeLodgeBooking: vi.fn(),
  resolveGuestMemberLinks: vi.fn(),
  memberFindMany: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
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
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
    // #3451: THE seam — `loadBookerDependants` reads the owner's parent links here.
    member: { findMany: h.memberFindMany },
    // Downstream of the guard: the cross-family marker's family-group read.
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
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
// #3032: PARTIAL mock. The pending-review fence added an import to
// `modify-quote/route.ts`, which widened this suite's module graph until
// `club-identity.ts` read `FALLBACK_LODGE_CAPACITY` at import time and the whole
// file died before a single test ran. `importOriginal` keeps every other export
// real, so the next widening cannot break it the same way (docs/TESTING.md).
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodge-capacity");
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: "type-nonmember",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
      ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
// #2337: the barrel is mocked, so the real in-progress refusal message is
// imported from the validation module and re-provided here — preview and apply
// therefore assert against ONE source of truth.
vi.mock("@/lib/booking-modify", async () => {
  const { GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE } = (await vi.importActual("@/lib/booking-modify-validation")) as typeof import("@/lib/booking-modify-validation");
  return {
    isQuotePricedBooking: vi.fn().mockResolvedValue(false),
    isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
    resolveGuestMemberLinks: h.resolveGuestMemberLinks,
    resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
    lockedNightPricesForGuest: vi.fn().mockReturnValue(null),
    // #3531: the wrapper the route reaches the reader through; answers as the reader stub does.
    editedGuestPricingLocks: vi.fn().mockReturnValue({ lockedNightPrices: null }),
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
    QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
    GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  };
});
vi.mock("@/lib/booking-guests", async (importOriginal) => {
  // `normalizeBookingGuestInputs` is the REAL one: it is what strips a member id
  // that did not resolve, so mocking it would make the forgery case prove nothing.
  const actual = (await importOriginal()) as typeof import("@/lib/booking-guests");
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(5),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadModuleFlags,
  CLUB_MODULE_SETTINGS_ID: "default",
  normalizeClubModuleSettings: (record: unknown) => record ?? {},
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/xero-organisation");
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const OWNER = "m1";
const DEPENDANT = { id: "dep-sam", firstName: "Sam", lastName: "Smith" };

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

// A FUTURE booking against the frozen 2026-07-01 clock, one member on it.
function futureBooking(extraGuests: Array<Record<string, unknown>> = []) {
  return {
    id: "b1",
    status: "PAID",
    memberId: OWNER,
    lodgeId: "lodge-1",
    wholeLodgeHold: false,
    checkIn: D("2026-08-10"),
    checkOut: D("2026-08-12"),
    totalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10000,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        firstName: "Pat",
        lastName: "Owner",
        ageTier: "ADULT",
        isMember: true,
        memberId: OWNER,
        stayStart: D("2026-08-10"),
        stayEnd: D("2026-08-12"),
        priceCents: 10000,
        nights: [
          { stayDate: D("2026-08-10"), priceCents: 5000, priceSource: "SOLD" },
          { stayDate: D("2026-08-11"), priceCents: 5000, priceSource: "SOLD" },
        ],
      },
      ...extraGuests,
    ],
  };
}

function added(firstName: string, lastName: string, extra: Record<string, unknown> = {}) {
  return { firstName, lastName, ageTier: "CHILD", isMember: false, ...extra };
}

function resolved(memberIds: string[]) {
  return {
    members: new Map(
      memberIds.map((id) => [
        id,
        { id, ageTier: "CHILD", firstName: "Sam", lastName: "Smith" },
      ]),
    ),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  };
}

const declaration = (dependantMemberId: string, normalizedName = "sam smith") => ({
  kind: DIFFERENT_PERSON_SAME_NAME,
  dependantMemberId,
  normalizedName,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: OWNER } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.bookingFindUnique.mockResolvedValue(futureBooking());
  h.seasonFindMany.mockResolvedValue([]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 16000,
    guests: [
      { priceCents: 10000, perNightCents: [5000, 5000], nightDates: [] },
      { priceCents: 6000, perNightCents: [3000, 3000], nightDates: [] },
    ],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.isMemberWholeLodgeBooking.mockResolvedValue(false);
  h.resolveGuestMemberLinks.mockReturnValue([]);
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(resolved([]));
  h.memberFindMany.mockResolvedValue([DEPENDANT]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote — #3451 own-dependant collision on an added guest", () => {
  it("reports an unanswered collision with the create route's code, and prices nothing", async () => {
    const res = await POST(req({ addGuests: [added("Sam", " smith")] }), { params });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
      error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
    });
    // The OWNER's parent links — the privacy boundary of the rule.
    expect(h.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ parentMemberId: OWNER }, { secondaryParentId: OWNER }],
        }),
      }),
    );
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("quotes once the member says it is a different person", async () => {
    const res = await POST(
      req({
        addGuests: [added("Sam", "Smith")],
        dependantIdentityDeclarations: [declaration(DEPENDANT.id)],
      }),
      { params },
    );

    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(h.priceGuests).toHaveBeenCalled();
  });

  it("quotes once the row is on the member path", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      resolved([DEPENDANT.id]),
    );
    const res = await POST(
      req({ addGuests: [added("Sam", "Smith", { isMember: true, memberId: DEPENDANT.id })] }),
      { params },
    );

    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(h.priceGuests).toHaveBeenCalled();
  });

  it("reads a forged member link as the free-text row it is", async () => {
    const res = await POST(
      req({ addGuests: [added("Sam", "Smith", { isMember: true, memberId: "made-up" })] }),
      { params },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("refuses a declaration about a dependant the owner does not have", async () => {
    const res = await POST(
      req({
        addGuests: [added("Sam", "Smith")],
        dependantIdentityDeclarations: [declaration("somebody-else")],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("refuses a malformed declaration at the schema — no generic override", async () => {
    const res = await POST(
      req({
        addGuests: [added("Sam", "Smith")],
        dependantIdentityDeclarations: [{ kind: "override", override: true }],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.priceGuests).not.toHaveBeenCalled();
  });

  it("leaves a name that is nobody's dependant alone", async () => {
    const res = await POST(req({ addGuests: [added("Alex", "Brown")] }), { params });

    expect((await res.json()).code).toBeUndefined();
    expect(h.priceGuests).toHaveBeenCalled();
  });

  it("does not re-ask about a guest already on the booking", async () => {
    h.bookingFindUnique.mockResolvedValue(
      futureBooking([
        {
          id: "g2",
          firstName: "Sam",
          lastName: "Smith",
          ageTier: "CHILD",
          isMember: false,
          memberId: null,
          stayStart: D("2026-08-10"),
          stayEnd: D("2026-08-12"),
          priceCents: 6000,
          nights: [
            { stayDate: D("2026-08-10"), priceCents: 3000, priceSource: "SOLD" },
            { stayDate: D("2026-08-11"), priceCents: 3000, priceSource: "SOLD" },
          ],
        },
      ]),
    );
    const res = await POST(req({ addGuests: [added("Alex", "Brown")] }), { params });

    expect((await res.json()).code).toBeUndefined();
  });

  it("asks an officer about the OWNER's dependants, in the officer's words", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin-1" } });
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await POST(req({ addGuests: [added("Sam", "Smith")] }), { params });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
      error: DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE,
    });
    const where = h.memberFindMany.mock.calls[0]?.[0]?.where;
    expect(where.OR).toEqual([
      { parentMemberId: OWNER },
      { secondaryParentId: OWNER },
    ]);
    expect(JSON.stringify(where)).not.toContain("admin-1");
  });

  it("refuses a stranger before saying anything about the owner's family", async () => {
    h.auth.mockResolvedValue({ user: { id: "stranger" } });

    const res = await POST(req({ addGuests: [added("Sam", "Smith")] }), { params });

    expect(res.status).toBe(403);
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });

  describe("renames and the identity-only echo (#3451)", () => {
    function withTypedGuest() {
      h.bookingFindUnique.mockResolvedValue(
        futureBooking([
          {
            id: "g2",
            firstName: "Alex",
            lastName: "Brown",
            ageTier: "CHILD",
            isMember: false,
            memberId: null,
            stayStart: D("2026-08-10"),
            stayEnd: D("2026-08-12"),
            priceCents: 6000,
            nights: [
              { stayDate: D("2026-08-10"), priceCents: 3000, priceSource: "SOLD" },
              { stayDate: D("2026-08-11"), priceCents: 3000, priceSource: "SOLD" },
            ],
          },
        ]),
      );
    }

    it("asks about an existing guest renamed onto the dependant's name", async () => {
      withTypedGuest();
      const res = await POST(
        req({ guestUpdates: [{ guestId: "g2", firstName: "Sam", lastName: "Smith" }] }),
        { params },
      );

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    });

    it("echoes the rename once the member says it is a different person", async () => {
      withTypedGuest();
      const res = await POST(
        req({
          guestUpdates: [{ guestId: "g2", firstName: "Sam", lastName: "Smith" }],
          dependantIdentityDeclarations: [declaration(DEPENDANT.id)],
        }),
        { params },
      );

      expect(res.status).toBe(200);
      expect((await res.json()).code).toBeUndefined();
    });

    it("refuses a parked declaration on a name-fix-only preview, exactly as the save does", async () => {
      withTypedGuest();
      const res = await POST(
        req({
          guestUpdates: [{ guestId: "g2", firstName: "Alexa", lastName: "Brown" }],
          dependantIdentityDeclarations: [declaration(DEPENDANT.id)],
        }),
        { params },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses a parked declaration on a credit-only preview too", async () => {
      const res = await POST(
        req({
          applyCreditCents: 0,
          dependantIdentityDeclarations: [declaration(DEPENDANT.id)],
        }),
        { params },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });
  });
});

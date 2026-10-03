import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
  #2721 — the server half of own-dependant identity (`INV-GUEST-019`), at the
  route.

  THE DEFECT BEING PINNED. A party row with no `memberId` is a NON-MEMBER guest:
  provisional under the club's hold policy (no bed reserved until the booking is
  confirmed and paid nearer the stay), bumpable when the lodge fills, invoiced as
  the deferred guest portion. A parent typing their own recorded dependant's name
  used to create exactly that row, silently, for a member of this club. Every
  refusal below is asserted together with "and no create service was called", so
  the pin is that no such row is ever written — not merely that a message came
  back.

  The unit suite `src/lib/__tests__/booking-dependant-identity.test.ts` owns the
  rule itself. This file owns the WIRING: that the route re-resolves the booker's
  dependants from authenticated data rather than from anything the client sent,
  that it runs BEFORE the member lookup against the claimed ids (#3770) while the
  lookup still refuses a forged member link, that it runs before any create
  service, and that an authorised on-behalf create is guarded TOO — against the
  dependants of the member the booking is for, never the officer's own.

  It also owns the #3770 ordering contract for the route's other input-only
  refusals: each answers the same whether a beyond-family member id in the party
  is real or nobody, because each runs before the lookup.
*/

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  managementRole: vi.fn(),
  hasAdminAccess: vi.fn(),
  hasAccessRole: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  createConfirmedBooking: vi.fn(),
  createDraftBooking: vi.fn(),
  createWaitlistedBooking: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  isXeroConnected: vi.fn(),
  getEffectiveXeroLockDate: vi.fn(),
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-1"),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  normalizeGuestStayRanges: vi.fn((guests: unknown[]) => guests),
  getLodgeCapacity: vi.fn(),
  validateMinimumStay: vi.fn(),
  checkInternetBankingLeadTime: vi.fn(),
  resolveSubscriptionLockoutMode: vi.fn(),
  requiresPaidSubscription: vi.fn(),
  promoCodeFindUnique: vi.fn(),
  workPartyEventFindUnique: vi.fn(),
  computeMemberGuestBoundary: vi.fn(),
  assertCanBeBooked: vi.fn(),
  findConflicts: vi.fn(),
  assertMembershipType: vi.fn(),
  findUnpaid: vi.fn(),
  evalNonMember: vi.fn(),
  evalHosting: vi.fn(),
  lodgeAccessFindMany: vi.fn(),
  lodgeRoomFindUnique: vi.fn(),
  planConsent: vi.fn(),
  checkCapacity: vi.fn(),
  holdDecision: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: h.hasAdminAccess,
  hasAccessRole: h.hasAccessRole,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
  CLUB_MODULE_SETTINGS_ID: "default",
  normalizeClubModuleSettings: (record: unknown) => record ?? {},
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // `member.findMany` is THE seam this file is about: it is what
    // `loadBookerDependants` calls, and it is served from the route's own
    // authenticated member id rather than from anything in the request body.
    member: { findUnique: h.memberFindUnique, findMany: h.memberFindMany },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    // #3770 R2: the booker's lodge restrictions, read before the lookup.
    memberLodgeAccess: { findMany: h.lodgeAccessFindMany },
    lodgeRoom: { findUnique: h.lodgeRoomFindUnique },
    // #3770: the pre-lookup owner-subscription and promo/working-bee checks.
    memberSubscription: { findFirst: vi.fn().mockResolvedValue(null) },
    promoCode: { findUnique: h.promoCodeFindUnique },
    workPartyEvent: { findUnique: h.workPartyEventFindUnique },
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    clubTimeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        timeZone: "Pacific/Auckland",
        updatedByMemberId: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
  },
}));
vi.mock("@/lib/booking-guests", async () => {
  // Partial: the real error classes and `memberGuestCrossFamilyRefusal`, so the
  // collapsed bodies compared below are the real ones. Since #3770 the guard runs
  // before the lookup on the claimed ids, so a forged member link is refused by
  // the lookup (mocked here to refuse as the real one does), not by
  // `normalizeBookingGuestInputs`.
  const actual = (await vi.importActual(
    "@/lib/booking-guests",
  )) as typeof import("@/lib/booking-guests");
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    computeMemberGuestBoundary: h.computeMemberGuestBoundary,
    assertLinkedBookingMembersCanBeBooked: h.assertCanBeBooked,
  };
});
vi.mock("@/lib/member-guest-add-policy", () => ({
  // Member guests ON: the #3770 suites are about a beyond-family member that
  // can resolve. The module-off order has its own case.
  loadMemberGuestAddPolicy: vi
    .fn()
    .mockResolvedValue({ wideningEnabled: true }),
  matchMemberGuestNotificationRows: () => [],
  planMemberGuestConsentWrites: (args: { guests: unknown[] }) => h.planConsent(args),
}));
vi.mock("@/lib/member-guest-probe-guard", () => ({
  handleMemberGuestAddRefusal: vi.fn().mockResolvedValue(undefined),
  memberGuestAddThrottleHook: () => async () => undefined,
  MemberGuestAddThrottledError: class extends Error {},
  startMemberGuestRefusalClock: () => 0,
}));
vi.mock("@/lib/booking-guest-stay-range-input", () => ({
  normalizeGuestStayRanges: h.normalizeGuestStayRanges,
  BookingGuestStayRangeValidationError: class extends Error {},
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  BookingMemberNightConflictError: class extends Error {
    conflicts: unknown[] = [];
  },
  getBookingMemberNightConflictResponse: () => ({ error: "conflict" }),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: h.resolveOptionalActiveLodgeId,
  resolvePolicyRowsForLodge: () => [],
}));
// #3770 R4: the route's full-lodge pre-flight, read before the outsider lookup.
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: h.checkCapacity,
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: h.getLodgeCapacity,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: h.assertMembershipType,
  getMembershipTypeBookingPolicyErrorBody: (e: { message: string }) => ({
    error: e.message,
  }),
  MembershipTypeBookingPolicyError: class extends Error {
    status = 400;
  },
  requiresPaidSubscriptionForMemberForBooking: h.requiresPaidSubscription,
}));
vi.mock("@/lib/member-subscription-eligibility", async (importActual) => ({
  ...((await importActual()) as object),
  resolveSubscriptionLockoutMode: h.resolveSubscriptionLockoutMode,
}));
vi.mock("@/lib/booking-policies", async (importActual) => ({
  ...((await importActual()) as object),
  validateMinimumStay: h.validateMinimumStay,
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: h.findUnpaid,
}));
// #3770: the two rules a beyond-family adult can satisfy, driven directly.
vi.mock("@/lib/subscription-lockout-enforcement", async (importActual) => ({
  ...((await importActual()) as object),
  evaluateNonMemberPricingRequirements: h.evalNonMember,
  buildPaidUpAdultRefusalBody: () => ({
    code: "PAID_UP_ADULT_MEMBER_REQUIRED",
    error: "This booking needs a paid-up adult member.",
  }),
}));
vi.mock("@/lib/adult-member-hosting-proposed", () => ({
  evaluateProposedAdultMemberHosting: h.evalHosting,
}));
vi.mock("@/lib/adult-member-hosting-refusal", async (importActual) => ({
  ...((await importActual()) as object),
  buildAdultMemberHostingRefusalBody: () => ({
    code: "ADULT_MEMBER_HOSTING_REQUIRED",
    error: "No adult member is staying on some nights.",
    violations: [],
  }),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
// Partial: `decideBookingSplit` is the real one — it is what the #3770 full-lodge
// pre-flight shares with the create service. The hold decision is driven.
vi.mock("@/lib/policies/booking-route-decisions", async (importActual) => ({
  ...((await importActual()) as object),
  calculateBookingHoldDecision: h.holdDecision,
  toGroupDiscountConfig: () => ({}),
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/internet-banking-settings", () => ({
  checkInternetBankingLeadTime: h.checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroLockDates: vi.fn().mockResolvedValue(null),
  getEffectiveXeroLockDate: h.getEffectiveXeroLockDate,
  getXeroFinancialYearEndMonth: vi.fn(async () => null),
}));
// #3029: the route reads the dietary seeding toggle before any create service
// runs; the real module reaches access-role definitions this file mocks.
vi.mock("@/lib/member-dietary-booking-writes", () => ({
  resolveBookingGuestDietarySeeding: vi.fn(async () => ({ seedFromProfile: false })),
}));
vi.mock("@/lib/booking-create", async () => {
  const actual = (await vi.importActual(
    "@/lib/booking-create-types",
  )) as typeof import("@/lib/booking-create-types");
  return {
    createConfirmedBooking: h.createConfirmedBooking,
    createDraftBooking: h.createDraftBooking,
    createWaitlistedBooking: h.createWaitlistedBooking,
    RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS:
      actual.RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS,
    BookingLodgeError: class extends Error {},
    // The real class: the route's #3770 promo pre-check throws it from
    // `booking-create-promo.ts`, which imports it from the types module.
    BookingPromoError: actual.BookingPromoError,
    BookingReviewJustificationRequiredError: class extends Error {},
  };
});
vi.mock("@/lib/family-booking-add-notifications", () => ({
  sendFamilyMemberBookingAddNotifications: vi.fn().mockResolvedValue({
    notifiedTargetMemberIds: [],
    failedTargetMemberIds: [],
    unreachableTargetMemberIds: [],
    suppressedByPreferenceMemberIds: [],
  }),
}));

import { POST } from "@/app/api/bookings/route";
import {
  DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE,
  DIFFERENT_PERSON_SAME_NAME,
} from "@/lib/booking-dependant-identity";
import {
  BookingGuestValidationError,
  memberGuestCrossFamilyRefusal,
} from "@/lib/booking-guests";
import { MembershipTypeBookingPolicyError } from "@/lib/membership-type-policy";
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import { BookingGuestStayRangeValidationError } from "@/lib/booking-guest-stay-range-input";

/** The neutral answers for every #3770 pre-lookup check: nothing refuses. */
function setPreLookupDefaults() {
  // #3770 lookup phases: nobody named is beyond the family, every guard passes.
  h.computeMemberGuestBoundary.mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  });
  h.assertCanBeBooked.mockResolvedValue(undefined);
  h.findConflicts.mockResolvedValue([]);
  h.assertMembershipType.mockResolvedValue(undefined);
  h.findUnpaid.mockResolvedValue([]);
  h.evalNonMember.mockResolvedValue(null);
  h.evalHosting.mockResolvedValue(null);
  h.lodgeAccessFindMany.mockResolvedValue([]);
  h.lodgeRoomFindUnique.mockResolvedValue(null);
  h.checkCapacity.mockResolvedValue({ available: true, minAvailable: 10, nightDetails: [] });
  // Inside the non-member hold window (or no hold): no split, the whole party counts.
  h.holdDecision.mockReturnValue({ shouldBePending: false, status: "PAYMENT_PENDING" });
  // Consent planning passes rows through: an outsider is as present as the
  // club's notify-only mode makes them. A case about approval-required consent
  // marks them PENDING itself.
  h.planConsent.mockImplementation(({ guests }: { guests: unknown[] }) => ({
    guests,
    entriesByMemberId: new Map(),
  }));
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.checkInternetBankingLeadTime.mockReturnValue({ allowed: true });
  h.resolveSubscriptionLockoutMode.mockResolvedValue("NO_BLOCK");
  h.requiresPaidSubscription.mockResolvedValue(false);
  h.promoCodeFindUnique.mockResolvedValue(null);
  h.workPartyEventFindUnique.mockResolvedValue(null);
}

// Fixed future nights relative to the repository's frozen clock
// (2026-07-01), per `docs/TESTING.md`. Never derived from the real calendar.
const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

const BOOKER_ID = "booker-1";
const DEPENDANT = { id: "dep-sam", firstName: "Sam", lastName: "Smith" };

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      lodgeId: "lodge-1",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      ...body,
    }),
    headers: { "Content-Type": "application/json" },
  });
}

/** The party the defect produces: the booker's own dependant as free text. */
const OWN_DEPENDANT_AS_FREE_TEXT = [
  {
    firstName: "Sam",
    lastName: "Smith",
    ageTier: "CHILD" as const,
    isMember: false,
  },
];

function expectNoBookingWritten() {
  expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  expect(h.createDraftBooking).not.toHaveBeenCalled();
  expect(h.createWaitlistedBooking).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({
    user: { id: BOOKER_ID, role: "USER", accessRoles: [{ role: "USER" }] },
  });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.managementRole.mockReturnValue("USER");
  h.hasAdminAccess.mockReturnValue(false);
  h.hasAccessRole.mockReturnValue(true);
  h.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    memberGuests: false,
  });
  h.memberFindUnique.mockResolvedValue({
    active: true,
    emailVerified: new Date("2026-01-01T00:00:00.000Z"),
    xeroContactId: "xc-1",
    ageTier: "ADULT",
  });
  h.memberFindMany.mockResolvedValue([DEPENDANT]);
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  h.isXeroConnected.mockResolvedValue(false);
  h.getEffectiveXeroLockDate.mockReturnValue(null);
  h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
  h.getLodgeCapacity.mockResolvedValue(30);
  h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
  setPreLookupDefaults();
  h.createConfirmedBooking.mockResolvedValue({
    type: "created",
    booking: { id: "b-new", status: "PAID", guests: [] },
  });
  h.createDraftBooking.mockResolvedValue({
    booking: { id: "b-draft", status: "DRAFT", guests: [] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/*
  #3770 — the two worlds every status-independence case compares. A beyond-family
  member id X is named; the boundary (read from the booker's family groups alone)
  says so in both. The family half of the party resolves normally in both. Only
  the lookup of X differs: a real, bookable member, or the collapsed refusal the
  real lookup gives an id with nobody behind it.
*/
const MEMBER_X = "member-x";
const PROMO_MODULES_ON = {
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  memberGuests: false,
  promoCodes: true,
  workParties: false,
};
/** A live, unrestricted percentage code; each case overrides what it is about. */
function promoCodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-1",
    code: "SUMMER",
    type: "PERCENT_OFF",
    active: true,
    internal: false,
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    maxUniqueMembersTotal: null,
    maxUsesPerMember: null,
    lifetimeFreeNightsCap: null,
    membersOnly: false,
    memberGuestsOnly: false,
    assignedMembersOnlyOwnNights: false,
    lodges: [],
    assignments: [],
    ...overrides,
  };
}
function familyMemberRow(id: string) {
  return { id, ageTier: "ADULT", firstName: id, lastName: "Family" };
}
function arrangeLookup(xIsReal: boolean, xAgeTier: "ADULT" | "CHILD" = "ADULT") {
  // The boundary names X beyond the family whenever the party names X.
  h.computeMemberGuestBoundary.mockImplementation(
    async (_db: unknown, _booker: unknown, ids: readonly string[]) =>
      ids.includes(MEMBER_X)
        ? { scopeByMemberId: new Map([[MEMBER_X, "BEYOND_FAMILY"]]), beyondFamilyMemberIds: [MEMBER_X] }
        : { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  );
  h.resolveLinkedBookingMembersWithBoundary.mockImplementation(
    async (_db: unknown, _booker: unknown, ids: Array<string | null | undefined>) => {
      const named = ids.filter((id): id is string => Boolean(id));
      if (named.includes(MEMBER_X)) {
        if (!xIsReal) throw memberGuestCrossFamilyRefusal([MEMBER_X]);
        return {
          members: new Map([
            [MEMBER_X, { id: MEMBER_X, ageTier: xAgeTier, firstName: "Grace", lastName: "Hopper" }],
          ]),
          boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [MEMBER_X] },
        };
      }
      return {
        members: new Map(named.map((id) => [id, familyMemberRow(id)])),
        boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      };
    },
  );
}
const X_ARRANGEMENTS = [
  ["X is a real member", () => arrangeLookup(true)],
  ["X is nobody", () => arrangeLookup(false)],
] as const;
/** Stay ranges as the real normaliser returns them: date-only instants. */
function datedStayRanges(guests: unknown[]) {
  return (guests as Array<Record<string, unknown>>).map((guest) => ({
    ...guest,
    ...(typeof guest.stayStart === "string"
      ? {
          stayStart: new Date(`${guest.stayStart}T00:00:00.000Z`),
          stayEnd: new Date(`${guest.stayEnd as string}T00:00:00.000Z`),
        }
      : {}),
  }));
}
function lookupNamedX() {
  return h.resolveLinkedBookingMembersWithBoundary.mock.calls.some(
    (call: unknown[]) => (call[2] as Array<string | undefined>).includes(MEMBER_X),
  );
}

describe("POST /api/bookings own-dependant identity guard (#2721)", () => {
  it("refuses the original defect before any booking is written", async () => {
    const res = await POST(makeRequest({ guests: OWN_DEPENDANT_AS_FREE_TEXT }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DEPENDANT_IDENTITY_UNRESOLVED");
    // Code and sentence, and nothing else (#2721 review). The collisions used to
    // travel with it and nothing read them: a client that meets this refusal has
    // a stale picture by definition, so the wizard re-reads the authoritative
    // list rather than believing the refusal's account of it.
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expectNoBookingWritten();
  });

  it("asks the database about the AUTHENTICATED booker, never about the payload", async () => {
    await POST(makeRequest({ guests: OWN_DEPENDANT_AS_FREE_TEXT }));

    expect(h.memberFindMany).toHaveBeenCalledTimes(1);
    expect(h.memberFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        active: true,
        OR: [{ parentMemberId: BOOKER_ID }, { secondaryParentId: BOOKER_ID }],
      },
    });
  });

  it("refuses a DRAFT the same way — a wrong-path row must not be parked either", async () => {
    const res = await POST(
      makeRequest({ guests: OWN_DEPENDANT_AS_FREE_TEXT, draft: true }),
    );

    expect(res.status).toBe(409);
    expectNoBookingWritten();
  });

  it("refuses a WAITLIST join the same way", async () => {
    const res = await POST(
      makeRequest({ guests: OWN_DEPENDANT_AS_FREE_TEXT, waitlist: true }),
    );

    expect(res.status).toBe(409);
    expectNoBookingWritten();
  });

  it("lets the guest path through on a declaration naming the dependant", async () => {
    const res = await POST(
      makeRequest({
        guests: OWN_DEPENDANT_AS_FREE_TEXT,
        dependantIdentityDeclarations: [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: DEPENDANT.id,
            normalizedName: "sam smith",
          },
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("does not ask the database at all for an all-member party", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
      members: new Map([
        [
          DEPENDANT.id,
          { id: DEPENDANT.id, ageTier: "CHILD", firstName: "Sam", lastName: "Smith" },
        ],
      ]),
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
    });

    const res = await POST(
      makeRequest({
        guests: [
          {
            firstName: "Sam",
            lastName: "Smith",
            ageTier: "CHILD",
            isMember: true,
            memberId: DEPENDANT.id,
          },
        ],
      }),
    );

    expect(res.status).toBe(201);
    // The ordinary family booking pays nothing for this guard.
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });

  it("lets an ordinary non-member guest through untouched", async () => {
    const res = await POST(
      makeRequest({
        guests: [
          {
            firstName: "Kiri",
            lastName: "Ngata",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
      }),
    );

    expect(res.status).toBe(201);
  });

  describe("a client cannot talk its way past it", () => {
    it("leaves a forged member link to the member lookup, which refuses it", async () => {
      // #3770: the guard runs before the lookup and takes the claimed id at its
      // word; the lookup is what refuses an id with nobody behind it (the real
      // one throws for any id that does not resolve), so the row never reaches
      // the guest split either way.
      h.resolveLinkedBookingMembersWithBoundary.mockRejectedValue(
        new BookingGuestValidationError("Linked member is inactive or not found", 400),
      );
      const res = await POST(
        makeRequest({
          guests: [
            {
              firstName: "Sam",
              lastName: "Smith",
              ageTier: "CHILD",
              isMember: true,
              memberId: "not-a-real-member",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Linked member is inactive or not found" });
      expect(h.resolveLinkedBookingMembersWithBoundary).toHaveBeenCalled();
      expectNoBookingWritten();
    });

    it("catches a bare `isMember: true` with no member id at all", async () => {
      const res = await POST(
        makeRequest({
          guests: [
            {
              firstName: "Sam",
              lastName: "Smith",
              ageTier: "CHILD",
              isMember: true,
            },
          ],
        }),
      );

      expect(res.status).toBe(409);
      expectNoBookingWritten();
    });

    it("rejects a generic override at schema level — it is not a shape the field holds", async () => {
      for (const forged of [
        [{ override: true }],
        [{ kind: "override", dependantMemberId: DEPENDANT.id }],
        [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: DEPENDANT.id,
          },
        ],
      ]) {
        const res = await POST(
          makeRequest({
            guests: OWN_DEPENDANT_AS_FREE_TEXT,
            dependantIdentityDeclarations: forged,
          }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("Invalid input");
      }
      expectNoBookingWritten();
    });

    it("rejects a fabricated dependant id", async () => {
      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: "invented",
              normalizedName: "sam smith",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("DEPENDANT_IDENTITY_DECLARATION_INVALID");
      // The body carries the code and the sentence and nothing else (#2721
      // review): it used to echo the collisions back, which no consumer read.
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      expectNoBookingWritten();
    });

    it("rejects an unrelated dependant of the SAME booker", async () => {
      h.memberFindMany.mockResolvedValue([
        DEPENDANT,
        { id: "dep-ana", firstName: "Ana", lastName: "Smith" },
      ]);

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: "dep-ana",
              normalizedName: "sam smith",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expectNoBookingWritten();
    });

    /*
      THE PRIVACY HALF OF THE RULE, which is the half a refusal can leak
      (#2721 review). A declaration naming another family's REAL dependant and
      one naming a person who does not exist must be indistinguishable: the
      moment the refusal is more "helpful" about one of them, the guest name box
      becomes a way to ask the club whether a name belongs to a member — the
      exact thing the owner rule forbids. The fabricated and same-booker cases
      were pinned; this one, the one that carries the leak, was not, and a
      helpful message would have passed everything that existed.
    */
    it("answers for ANOTHER family's real dependant exactly as for an invented id", async () => {
      async function refusalFor(dependantMemberId: string) {
        // The booker's OWN dependant set is the same either way — that is the
        // point: the query never widens, so the server does not know and cannot
        // say whether the id names a real member of some other family.
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        const res = await POST(
          makeRequest({
            guests: OWN_DEPENDANT_AS_FREE_TEXT,
            dependantIdentityDeclarations: [
              {
                kind: DIFFERENT_PERSON_SAME_NAME,
                dependantMemberId,
                normalizedName: "sam smith",
              },
            ],
          }),
        );
        return { status: res.status, body: await res.text() };
      }

      // `another-familys-child` is a real member on this club's books; `invented`
      // names nobody at all.
      const other = await refusalFor("another-familys-child");
      const nobody = await refusalFor("invented");

      expect(other.status).toBe(nobody.status);
      // Byte-identical, not merely the same code: a name, a count or a different
      // sentence would each be an oracle.
      expect(other.body).toBe(nobody.body);
      expectNoBookingWritten();
    });

    it("rejects a STALE declaration the club's own records have moved under", async () => {
      // The dependant has been recorded under a new surname since the wizard
      // asked the question, so the collision the booker answered is gone.
      h.memberFindMany.mockResolvedValue([
        { id: DEPENDANT.id, firstName: "Sam", lastName: "Smith-Ngata" },
      ]);

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: DEPENDANT.id,
              normalizedName: "sam smith",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(
        "DEPENDANT_IDENTITY_DECLARATION_INVALID",
      );
      expectNoBookingWritten();
    });
  });

  /*
    THE AUTHORISED ON-BEHALF CREATE (owner decision on #2721, D1 option A,
    15 Sep 2026).

    This path used to skip the guard entirely, on the reasoning that the
    member-guest boundary check beside it skips too and reads the same flag. The
    owner removed the exemption because the two are not the same class of check.
    The boundary check gates the OFFICER'S OWN AUTHORITY, which the officer can
    see in front of them. This one protects A THIRD PARTY'S BED — a real child on
    a provisional, bumpable, separately invoiced guest row at non-member prices —
    and the parent is not at the screen to notice. A silent path is worst exactly
    where the affected person cannot see it.
  */
  describe("an authorised on-behalf create", () => {
    const OFFICER_ID = "officer-1";

    function signInAsOfficer() {
      h.managementRole.mockReturnValue("ADMIN");
      h.hasAdminAccess.mockReturnValue(true);
      h.hasAccessRole.mockReturnValue(false);
      h.auth.mockResolvedValue({
        user: {
          id: OFFICER_ID,
          role: "ADMIN",
          accessRoles: [{ role: "ADMIN" }],
        },
      });
      h.memberFindUnique.mockResolvedValue({ active: true });
    }

    it("is asked the question too, and writes nothing until it is answered", async () => {
      signInAsOfficer();

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          forMemberId: BOOKER_ID,
        }),
      );

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("DEPENDANT_IDENTITY_UNRESOLVED");
      expectNoBookingWritten();
    });

    it("reads the dependants of the member the booking is FOR, never the officer's own", async () => {
      /*
        The disclosure half of the rule, and the half a wrong candidate set gets
        backwards in both directions at once: querying the signed-in officer
        would miss every real collision on the member's family AND start asking
        an officer about their own children on somebody else's booking.

        Asserted on the WHERE clause rather than on the outcome on purpose — an
        officer with no dependants of their own produces an empty set and a
        clean 201, which is indistinguishable from "the guard ran correctly and
        found nothing". Only the query says which family was asked about.
      */
      signInAsOfficer();

      await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          forMemberId: BOOKER_ID,
        }),
      );

      expect(h.memberFindMany).toHaveBeenCalledTimes(1);
      const where = h.memberFindMany.mock.calls[0]?.[0]?.where;
      expect(where).toMatchObject({
        active: true,
        OR: [{ parentMemberId: BOOKER_ID }, { secondaryParentId: BOOKER_ID }],
      });
      expect(JSON.stringify(where)).not.toContain(OFFICER_ID);
    });

    it("says whose dependant it is, because 'your dependant' is wrong when the reader is not the parent", async () => {
      signInAsOfficer();

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          forMemberId: BOOKER_ID,
        }),
      );

      const { error } = await res.json();
      expect(error).toBe(DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE);
      expect(error).not.toContain("your dependant");
    });

    it("proceeds once the officer declares the guest a different person of the same name", async () => {
      signInAsOfficer();

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          forMemberId: BOOKER_ID,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: DEPENDANT.id,
              normalizedName: "sam smith",
            },
          ],
        }),
      );

      expect(res.status).toBe(201);
    });

    it("refuses a declaration the member's own records do not support, as on the member path", async () => {
      // An officer cannot waive a collision by naming a dependant who is not
      // one: the declaration is checked against the booking member's records,
      // not accepted because an admin sent it.
      signInAsOfficer();

      const res = await POST(
        makeRequest({
          guests: OWN_DEPENDANT_AS_FREE_TEXT,
          forMemberId: BOOKER_ID,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: "dep-not-theirs",
              normalizedName: "sam smith",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(
        "DEPENDANT_IDENTITY_DECLARATION_INVALID",
      );
      expectNoBookingWritten();
    });
  });

  /*
    #3770 — THE MEMBERSHIP-EXISTENCE ORACLE ON THE CREATE ROUTE. A party naming
    another family's member id X beside an input that is refused anyway must get
    the SAME response whether X is a real, bookable member or nobody. "Nobody"
    is refused by the lookup with D-8's collapsed refusal (#2388), so each
    refusal below runs BEFORE the lookup and never reaches it.
  */
  describe("input-only refusals answer the same whether a claimed id resolves (#3770)", () => {
    const X = {
      firstName: "Grace",
      lastName: "Hopper",
      ageTier: "ADULT" as const,
      isMember: true,
      memberId: "member-x",
    };
    const KIRI = { firstName: "Kiri", lastName: "Ngata", ageTier: "ADULT" as const, isMember: false };
    const arrangements = X_ARRANGEMENTS;

    const refusals: Array<[string, () => Record<string, unknown>, number]> = [
      ["the own-dependant question", () => ({ guests: [X, ...OWN_DEPENDANT_AS_FREE_TEXT] }), 409],
      ["a malformed stay range", () => {
        h.normalizeGuestStayRanges.mockImplementationOnce(() => {
          throw new BookingGuestStayRangeValidationError(
            "Guest 2: Date In and Date Out are both required.",
          );
        });
        return { guests: [X, KIRI] };
      }, 400],
      ["a check-in in the past", () => ({
        guests: [X, KIRI],
        checkIn: "2026-06-01",
        checkOut: "2026-06-03",
      }), 400],
      ["a missing lodge", () => ({ guests: [X, KIRI], lodgeId: undefined }), 400],
      ["an unknown lodge", () => {
        h.resolveOptionalActiveLodgeId.mockResolvedValue(null);
        return { guests: [X, KIRI] };
      }, 400],
      ["the guest-count cap", () => {
        h.getLodgeCapacity.mockResolvedValue(1);
        return { guests: [X, KIRI] };
      }, 400],
      ["the booker's own unpaid subscription", () => {
        h.resolveSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
        h.requiresPaidSubscription.mockResolvedValue(true);
        return { guests: [X, KIRI] };
      }, 403],
      ["a stay shorter than the minimum", () => {
        h.validateMinimumStay.mockResolvedValue({
          valid: false,
          violations: [
            {
              reasonCode: "MINIMUM_STAY",
              policyId: "pol_min",
              policyVersion: 1,
              policyName: "Weekend minimum",
              resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
              affectedNights: ["2026-08-01"],
              exceptionEligible: true,
              capacityMode: "HOLD",
              message: "min stay",
              triggerDay: "Saturday",
              minimumNights: 3,
              actualNights: 2,
              requirements: { kind: "MINIMUM_STAY", minimumNights: 3, actualNights: 2, triggerDays: [6] },
            },
          ],
        });
        return { guests: [X, KIRI] };
      }, 400],
      ["Internet Banking at a club without it", () => ({
        guests: [X, KIRI],
        paymentMethod: "internet_banking",
      }), 400],
      ["Internet Banking inside its cutoff", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue({
          xeroIntegration: true,
          bedAllocation: false,
          internetBankingPayments: true,
          memberGuests: false,
        });
        h.checkInternetBankingLeadTime.mockReturnValue({
          allowed: false,
          unavailableReason: "Too close to check-in",
          minimumDaysBeforeCheckIn: 7,
          checkIn: CHECK_IN,
        });
        return { guests: [X, KIRI], paymentMethod: "internet_banking" };
      }, 400],
      ["an unknown promo code", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue({
          xeroIntegration: false,
          bedAllocation: false,
          internetBankingPayments: false,
          memberGuests: false,
          promoCodes: true,
          workParties: false,
        });
        return { guests: [X, KIRI], promoCode: "ZZZZ" };
      }, 400],
      ["a working-bee event that does not exist", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue({
          xeroIntegration: false,
          bedAllocation: false,
          internetBankingPayments: false,
          memberGuests: false,
          promoCodes: false,
          workParties: true,
        });
        return { guests: [X, KIRI], workPartyEventId: "nope" };
      }, 400],
      // #3770 R1: a guest who arrived yesterday on a booking that checks in
      // tomorrow — the stay the service would refuse as in the past.
      ["a guest whose own stay starts in the past", () => {
        h.normalizeGuestStayRanges.mockImplementation(datedStayRanges);
        return {
          guests: [X, { ...KIRI, stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
          checkIn: "2026-07-02",
          checkOut: "2026-07-03",
        };
      }, 400],
      // #3770 R2: the booker may not book this lodge.
      ["a lodge the booker is restricted from", () => {
        h.lodgeAccessFindMany.mockResolvedValue([{ lodgeId: "some-other-lodge" }]);
        return { guests: [X, KIRI] };
      }, 403],
      // #3770 R3: a room from another lodge.
      ["a requested room at another lodge", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue({
          xeroIntegration: false,
          bedAllocation: true,
          internetBankingPayments: false,
          memberGuests: false,
        });
        h.lodgeRoomFindUnique.mockResolvedValue({ id: "room-1", lodgeId: "lodge-2" });
        return { guests: [X, KIRI], requestedRoomId: "room-1" };
      }, 400],
      ["a code that needs guest selection with none chosen", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue(PROMO_MODULES_ON);
        h.promoCodeFindUnique.mockResolvedValue(
          promoCodeRow({ assignments: [{ memberId: "someone-else" }] }),
        );
        return { guests: [X, KIRI], promoCode: "SUMMER" };
      }, 400],
      ["a code assigned to somebody else", () => {
        h.loadEffectiveModuleFlags.mockResolvedValue(PROMO_MODULES_ON);
        h.promoCodeFindUnique.mockResolvedValue(
          promoCodeRow({ assignments: [{ memberId: "someone-else" }] }),
        );
        return { guests: [X, KIRI], promoCode: "SUMMER", promoGuestIndexes: [1] };
      }, 400],
    ];

    it.each(refusals)("%s", async (_label, arrangeRequest, status) => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const [, arrangeLookup] of arrangements) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        h.loadEffectiveModuleFlags.mockResolvedValue({
          xeroIntegration: false,
          bedAllocation: false,
          internetBankingPayments: false,
          memberGuests: false,
        });
        setPreLookupDefaults();
        arrangeLookup();
        const res = await POST(makeRequest(arrangeRequest()));
        responses.push({ status: res.status, body: await res.text() });
        expect(h.resolveLinkedBookingMembersWithBoundary).not.toHaveBeenCalled();
        expectNoBookingWritten();
      }

      expect(responses[0]?.status).toBe(status);
      expect(responses[0]).toEqual(responses[1]);
    });
  });

  /*
    #3770 — THE FAMILY IS JUDGED BEFORE ANY BEYOND-FAMILY MEMBER IS RESOLVED (owner
    decision, 2 Oct 2026, issue comment 5946598639). A refusal about the booker's
    own family must read the same whether a named beyond-family X is real or
    nobody, so it runs before X is looked up — which reverses, on this door, the
    "cross-family refusal wins" order the guards keep elsewhere.
  */
  // #3770 delta review, D1: the services judge a promo against the stay ENVELOPE
  // (#713), which a guest starting early widens; so must the pre-check.
  it("judges a promo window against the stay envelope, not the requested dates", async () => {
    h.loadEffectiveModuleFlags.mockResolvedValue(PROMO_MODULES_ON);
    h.normalizeGuestStayRanges.mockImplementation(datedStayRanges);
    // Valid for stays starting BEFORE 1 Aug (exclusive). The request asks for
    // 1 Aug, but Kiri arrives on 31 Jul, so the stay starts in the window.
    h.promoCodeFindUnique.mockResolvedValue(
      promoCodeRow({ bookingStartUntil: new Date("2026-08-01T00:00:00.000Z") }),
    );

    const res = await POST(
      makeRequest({
        guests: [
          {
            firstName: "Kiri",
            lastName: "Ngata",
            ageTier: "ADULT",
            isMember: false,
            stayStart: "2026-07-31",
            stayEnd: CHECK_OUT,
          },
        ],
        promoCode: "SUMMER",
      }),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  describe("family refusals answer the same whether a beyond-family id resolves (#3770)", () => {
    const X = { firstName: "Grace", lastName: "Hopper", ageTier: "ADULT" as const, isMember: true, memberId: MEMBER_X };
    const FAMILY = { firstName: "fam-1", lastName: "Family", ageTier: "ADULT" as const, isMember: true, memberId: "fam-1" };
    const hasFamily = (guests: Array<{ memberId?: string | null }>) =>
      guests.some((guest) => guest.memberId === "fam-1");

    const familyRefusals: Array<[string, () => void, number]> = [
      ["the family profile gate", () => {
        h.assertCanBeBooked.mockImplementation(async (_db: unknown, members: Map<string, unknown>) => {
          if (members.has("fam-1")) {
            throw new BookingGuestValidationError("Some member guests need their details completed.", 403);
          }
        });
      }, 403],
      ["an own-family night clash", () => {
        h.findConflicts.mockImplementation(async (_db: unknown, { guests }: { guests: Array<{ memberId?: string | null }> }) =>
          hasFamily(guests) ? [{ memberId: "fam-1" }] : []);
      }, 409],
      ["a family membership-type block", () => {
        h.assertMembershipType.mockImplementation(async (_db: unknown, { guests }: { guests: Array<{ memberId?: string | null }> }) => {
          if (hasFamily(guests)) throw new MembershipTypeBookingPolicyError([]);
        });
      }, 400],
      ["an unpaid family member", () => {
        h.resolveSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
        h.findUnpaid.mockImplementation(async (_db: unknown, { guests }: { guests: Array<{ memberId?: string | null }> }) =>
          hasFamily(guests)
            ? [{ memberId: "fam-1", name: "fam-1 Family", status: "UNPAID", invoiceUrl: null, invoiceNumber: null }]
            : []);
      }, 403],
    ];

    it.each(familyRefusals)("%s", async (_label, arrangeRefusal, status) => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const [, arrange] of X_ARRANGEMENTS) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrange();
        arrangeRefusal();
        const res = await POST(makeRequest({ guests: [FAMILY, X] }));
        responses.push({ status: res.status, body: await res.text() });
        expect(lookupNamedX()).toBe(false);
        expectNoBookingWritten();
      }

      expect(responses[0]?.status).toBe(status);
      expect(responses[0]).toEqual(responses[1]);
    });

    /*
      The two rules a beyond-family adult can satisfy. Judged on the whole party
      once X is known; if they still fail with X named, the answer is the
      lookup's collapsed refusal, never their own message.
    */
    const paidUpViolation = { reasonCode: "PAID_UP_ADULT_MEMBER", message: "paid-up" };
    const hostingViolation = { reasonCode: "ADULT_MEMBER_HOSTING", consequence: "ENFORCED", message: "hosting" };
    const namesX = (rows: Array<{ memberId?: string | null }>) =>
      rows.some((row) => row.memberId === MEMBER_X);

    const KID = { firstName: "Kid", lastName: "Ngata", ageTier: "CHILD" as const, isMember: false };
    /** A hosting violation shaped as the service's reconciler raises it. */
    const SERVICE_HOSTING_VIOLATION = {
      ...hostingViolation,
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "pol_host",
      policyVersion: 1,
      affectedNights: ["2026-08-01"],
      capacityMode: "HOLD",
      exceptionEligible: true,
    } as never;
    const policyFailures: Array<[string, () => void, Record<string, unknown>, (xIsReal: boolean) => void]> = [
      ["paid-up adult", () => h.evalNonMember.mockResolvedValue({ violation: paidUpViolation }),
        { guests: [FAMILY, X] }, (real) => arrangeLookup(real)],
      ["hosting", () => h.evalHosting.mockResolvedValue(hostingViolation),
        { guests: [FAMILY, X] }, (real) => arrangeLookup(real)],
      // #3770 F1: a member cannot skip the check by sending an officer's reason.
      ["hosting, with a member-supplied reason", () => h.evalHosting.mockResolvedValue(hostingViolation),
        { guests: [FAMILY, X], adultMemberHostingReason: "trust me" }, (real) => arrangeLookup(real)],
      // #3770 F1, the race path: the service's own refusal collapses too.
      ["hosting, refused inside the create service", () =>
        h.createConfirmedBooking.mockRejectedValue(
          new AdultMemberHostingRequiredError(SERVICE_HOSTING_VIOLATION),
        ),
        { guests: [FAMILY, X] }, (real) => arrangeLookup(real)],
      // #3770 N1: the same mapping in the draft and waitlist catches.
      ["hosting, refused inside the draft service", () =>
        h.createDraftBooking.mockRejectedValue(new AdultMemberHostingRequiredError(SERVICE_HOSTING_VIOLATION)),
        { guests: [FAMILY, X], draft: true }, (real) => arrangeLookup(real)],
      ["hosting, refused inside the waitlist service", () => {
        h.createConfirmedBooking.mockResolvedValue({ type: "capacity_exceeded", fullNights: [] });
        h.createWaitlistedBooking.mockRejectedValue(new AdultMemberHostingRequiredError(SERVICE_HOSTING_VIOLATION));
      },
        { guests: [FAMILY, X], waitlist: true }, (real) => arrangeLookup(real)],
      // #3770 F2: minors with no adult, where X is the only possible adult.
      ["adult supervision", () => undefined,
        { guests: [KID, X] }, (real) => arrangeLookup(real, "CHILD")],
    ];
    it.each(policyFailures)("a %s failure that X does not cure answers like the lookup", async (
      _label,
      arrangeFailure,
      body,
      arrangeWorld,
    ) => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const xIsReal of [true, false]) {
        const arrange = () => arrangeWorld(xIsReal);
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrange();
        arrangeFailure();
        const res = await POST(makeRequest(body));
        responses.push({ status: res.status, body: await res.text() });
      }

      expect(responses[0]?.status).toBe(403);
      expect(responses[0]).toEqual(responses[1]);
    });

    // The evaluator counts only an operationally PRESENT adult (D-12). An outsider
    // is present only where the club does not ask outsiders to consent first.
    const curedOnlyByPresentX = async (
      _db: unknown,
      { participants }: { participants: Array<{ memberId?: string | null; operationallyPresent?: boolean }> },
    ) =>
      participants.some((row) => row.memberId === MEMBER_X && row.operationallyPresent !== false)
        ? { violation: null }
        : { violation: paidUpViolation };

    it("books when a present beyond-family adult is the paid-up adult the party needs (notify-only consent)", async () => {
      arrangeLookup(true);
      h.evalNonMember.mockImplementation(curedOnlyByPresentX);

      const res = await POST(makeRequest({ guests: [FAMILY, X] }));

      expect(res.status).toBe(201);
      expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    });

    it("does not let a PENDING outsider cure it, and answers like the lookup", async () => {
      arrangeLookup(true);
      h.evalNonMember.mockImplementation(curedOnlyByPresentX);
      h.planConsent.mockImplementation(({ guests }: { guests: Array<{ memberId?: string | null }> }) => ({
        guests: guests.map((guest) =>
          guest.memberId === MEMBER_X
            ? { ...guest, memberGuestConsent: { consentStatus: "PENDING" } }
            : guest,
        ),
        entriesByMemberId: new Map(),
      }));

      const res = await POST(makeRequest({ guests: [FAMILY, X] }));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("MEMBER_GUEST_NOT_ADDABLE");
      expectNoBookingWritten();
    });

    // #3770 R4 (owner decision: "Check 'full' first"): a full lodge is answered
    // before the outsider is looked up, from the member half of the party.
    it("answers a full lodge the same whether X resolves", async () => {
      const full = {
        available: false,
        minAvailable: 0,
        nightDetails: [{ date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: 0, requested: 2, capacity: 30, wholeLodgeBlocked: false, custodianHeld: false }],
      };
      const responses: Array<{ status: number; body: string }> = [];
      for (const xIsReal of [true, false]) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrangeLookup(xIsReal);
        h.checkCapacity.mockResolvedValue(full);
        const res = await POST(makeRequest({ guests: [FAMILY, X, KID] }));
        responses.push({ status: res.status, body: await res.text() });
        expect(lookupNamedX()).toBe(false);
        expectNoBookingWritten();
        // Inside the hold window nothing splits: the whole party is counted (B1).
        const ranges = h.checkCapacity.mock.calls[0]?.[3] as unknown[];
        expect(ranges).toHaveLength(3);
      }

      expect(responses[0]).toEqual(responses[1]);
      expect(responses[0]?.status).toBe(409);
      expect(JSON.parse(responses[0]?.body ?? "{}").code).toBe("CAPACITY_EXCEEDED");
    });

    // #3770 B1: the pre-flight counts the rows the SERVICE will count. Inside the
    // hold window nothing splits, so padding the party with non-members cannot
    // slip a too-big booking past it while only the member half is measured.
    const KIRI = { firstName: "Kiri", lastName: "Ngata", ageTier: "ADULT" as const, isMember: false };
    const twoBedsLeft = async (
      _lodge: unknown,
      _in: unknown,
      _out: unknown,
      ranges: unknown[],
    ) =>
      ranges.length > 2
        ? {
            available: false,
            minAvailable: 0,
            nightDetails: [{ date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: 2, requested: ranges.length, capacity: 30, wholeLodgeBlocked: false, custodianHeld: false }],
          }
        : { available: true, minAvailable: 2, nightDetails: [] };

    it("answers a party padded with non-members the same whether X resolves", async () => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const xIsReal of [true, false]) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrangeLookup(xIsReal);
        h.checkCapacity.mockImplementation(twoBedsLeft);
        const res = await POST(makeRequest({ guests: [X, KIRI, KID] }));
        responses.push({ status: res.status, body: await res.text() });
        expect(lookupNamedX()).toBe(false);
        expectNoBookingWritten();
      }
      expect(responses[0]).toEqual(responses[1]);
      expect(JSON.parse(responses[0]?.body ?? "{}").code).toBe("CAPACITY_EXCEEDED");
    });

    it("still admits a booking that will split when its member half fits", async () => {
      arrangeLookup(true);
      h.checkCapacity.mockImplementation(twoBedsLeft);
      // Beyond the hold window: the non-members become the provisional child,
      // which holds no beds, so only the member half (FAMILY + X) is counted.
      h.holdDecision.mockReturnValue({ shouldBePending: true, status: "PENDING" });
      const res = await POST(makeRequest({ guests: [FAMILY, X, KIRI, KID] }));
      expect(res.status).toBe(201);
      expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
      expect((h.checkCapacity.mock.calls[0]?.[3] as unknown[]).length).toBe(2);
    });

    it("discards a justification when an adult other than X is known, as the service does", async () => {
      // FAMILY and KIRI are adults the service counts as present, so adult
      // supervision cannot trip and the booking still splits: only the member
      // half (FAMILY + X) is counted, and it fits.
      arrangeLookup(true);
      h.checkCapacity.mockImplementation(twoBedsLeft);
      h.holdDecision.mockReturnValue({ shouldBePending: true, status: "PENDING" });
      const res = await POST(
        makeRequest({ guests: [FAMILY, X, KIRI, KID], memberReviewJustification: "x" }),
      );
      expect(res.status).toBe(201);
      expect((h.checkCapacity.mock.calls[0]?.[3] as unknown[]).length).toBe(2);
    });

    it("counts the whole party when a justification is sent and no adult is known without X (held)", async () => {
      // Children only, plus X: whether the booking is held for review depends on
      // X, so the justification is taken as held and the whole party counted.
      arrangeLookup(true);
      h.checkCapacity.mockImplementation(async (_l: unknown, _i: unknown, _o: unknown, ranges: unknown[]) =>
        ranges.length > 1
          ? { available: false, minAvailable: 0, nightDetails: [] }
          : { available: true, minAvailable: 1, nightDetails: [] });
      h.holdDecision.mockReturnValue({ shouldBePending: true, status: "PENDING" });
      const res = await POST(
        makeRequest({ guests: [KID, X], memberReviewJustification: "x" }),
      );
      expect(res.status).toBe(409);
      expect((h.checkCapacity.mock.calls[0]?.[3] as unknown[]).length).toBe(2);
    });

    it("does not ask the pre-flight for a draft, a waitlist join or a family-only party", async () => {
      arrangeLookup(true);
      for (const body of [
        { guests: [FAMILY, X], draft: true },
        { guests: [FAMILY, X], waitlist: true },
        { guests: [FAMILY] },
      ]) {
        await POST(makeRequest(body));
      }
      expect(h.checkCapacity).not.toHaveBeenCalled();
    });

    // #3770, owner decision "only agreed adults count": a PENDING outsider adult
    // is not the responsible adult for the member's children.
    const markXPending = () =>
      h.planConsent.mockImplementation(({ guests }: { guests: Array<{ memberId?: string | null }> }) => ({
        guests: guests.map((guest) =>
          guest.memberId === MEMBER_X
            ? { ...guest, memberGuestConsent: { consentStatus: "PENDING" } }
            : guest,
        ),
        entriesByMemberId: new Map(),
      }));

    it("refuses children plus a pending outsider adult, with no justification, like the lookup", async () => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const xIsReal of [true, false]) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.normalizeGuestStayRanges.mockImplementation((guests: unknown[]) => guests);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrangeLookup(xIsReal);
        markXPending();
        const res = await POST(makeRequest({ guests: [KID, X] }));
        responses.push({ status: res.status, body: await res.text() });
        expectNoBookingWritten();
      }
      expect(responses[0]).toEqual(responses[1]);
      expect(JSON.parse(responses[0]?.body ?? "{}").code).toBe("MEMBER_GUEST_NOT_ADDABLE");
    });

    it("passes children plus a pending outsider adult WITH a justification on to the service, for review", async () => {
      arrangeLookup(true);
      markXPending();
      const res = await POST(
        makeRequest({ guests: [KID, X], memberReviewJustification: "Grandad is coming" }),
      );
      expect(res.status).toBe(201);
      expect(h.createConfirmedBooking.mock.calls[0]?.[0]).toMatchObject({
        memberReviewJustification: "Grandad is coming",
      });
    });

    it("counts a notify-only outsider adult (written CONFIRMED) as the adult", async () => {
      arrangeLookup(true);
      h.planConsent.mockImplementation(({ guests }: { guests: Array<{ memberId?: string | null }> }) => ({
        guests: guests.map((guest) =>
          guest.memberId === MEMBER_X
            ? { ...guest, memberGuestConsent: { consentStatus: "CONFIRMED" } }
            : guest,
        ),
        entriesByMemberId: new Map(),
      }));
      const res = await POST(makeRequest({ guests: [KID, X] }));
      expect(res.status).toBe(201);
    });

    it("counts a family adult as before", async () => {
      const res = await POST(makeRequest({ guests: [KID, FAMILY] }));
      expect(res.status).toBe(201);
    });

    it("leaves adult supervision to the create service when nobody beyond the family is named", async () => {
      const res = await POST(makeRequest({ guests: [KID] }));

      expect(res.status).toBe(201);
      expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    });

    // #3770 F4: with member guests switched off, a beyond-family id is refused
    // first, as before the redesign — that refusal never depended on X.
    it("refuses a beyond-family id before the family checks when member guests are off", async () => {
      const responses: Array<{ status: number; body: string }> = [];
      for (const xIsReal of [true, false]) {
        vi.clearAllMocks();
        h.memberFindMany.mockResolvedValue([DEPENDANT]);
        h.getLodgeCapacity.mockResolvedValue(30);
        h.resolveOptionalActiveLodgeId.mockResolvedValue("lodge-1");
        setPreLookupDefaults();
        arrangeLookup(xIsReal);
        const resolveForWorld = h.resolveLinkedBookingMembersWithBoundary.getMockImplementation();
        h.resolveLinkedBookingMembersWithBoundary.mockImplementation(
          async (db: unknown, booker: unknown, ids: string[], options: { memberGuestWideningEnabled?: boolean }) => {
            if (!options.memberGuestWideningEnabled && ids.includes(MEMBER_X)) {
              throw new BookingGuestValidationError("Invalid guest member reference", 403, {
                code: "GUEST_MEMBER_NOT_ALLOWED",
              });
            }
            return resolveForWorld?.(db, booker, ids, options);
          },
        );
        const { loadMemberGuestAddPolicy } = await import("@/lib/member-guest-add-policy");
        vi.mocked(loadMemberGuestAddPolicy).mockResolvedValueOnce({ wideningEnabled: false } as never);
        h.findConflicts.mockResolvedValue([{ memberId: "fam-1" }]);
        const res = await POST(makeRequest({ guests: [FAMILY, X] }));
        responses.push({ status: res.status, body: await res.text() });
        expect(h.findConflicts).not.toHaveBeenCalled();
      }

      expect(responses[0]).toEqual(responses[1]);
      expect(JSON.parse(responses[0]?.body ?? "{}").code).toBe("GUEST_MEMBER_NOT_ALLOWED");
    });

    it("books when a beyond-family adult is the host the party needs", async () => {
      arrangeLookup(true);
      h.evalHosting.mockImplementation(async (_db: unknown, { guests }: { guests: Array<{ memberId?: string | null }> }) =>
        namesX(guests) ? null : hostingViolation);

      const res = await POST(makeRequest({ guests: [FAMILY, X] }));

      expect(res.status).toBe(201);
      expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    });

    it("keeps the detailed paid-up refusal when nobody beyond the family is named", async () => {
      h.evalNonMember.mockResolvedValue({ violation: paidUpViolation });

      const res = await POST(makeRequest({ guests: [FAMILY] }));

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    });

    it("keeps the detailed hosting refusal when nobody beyond the family is named", async () => {
      h.evalHosting.mockResolvedValue(hostingViolation);

      const res = await POST(makeRequest({ guests: [FAMILY] }));

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    });
  });
});

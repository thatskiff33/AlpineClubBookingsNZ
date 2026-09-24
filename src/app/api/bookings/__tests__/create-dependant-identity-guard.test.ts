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
  that it runs on the NORMALISED party so a forged member link cannot walk past
  it, that it runs before any create service, and that an authorised on-behalf
  create is guarded TOO — against the dependants of the member the booking is
  for, never the officer's own.
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
  // `normalizeBookingGuestInputs` is the REAL one. It is what strips a
  // `memberId` that did not resolve and forces `isMember: false` — the step that
  // makes a forged client assertion irrelevant — so mocking it out would make
  // the tampering cases below prove nothing.
  const actual = (await vi.importActual(
    "@/lib/booking-guests",
  )) as typeof import("@/lib/booking-guests");
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/member-guest-add-policy", () => ({
  loadMemberGuestAddPolicy: vi
    .fn()
    .mockResolvedValue({ wideningEnabled: false }),
  matchMemberGuestNotificationRows: () => [],
  planMemberGuestConsentWrites: ({ guests }: { guests: unknown[] }) => ({
    guests,
    entriesByMemberId: new Map(),
  }),
}));
vi.mock("@/lib/member-guest-probe-guard", () => ({
  handleMemberGuestAddRefusal: vi.fn().mockResolvedValue(undefined),
  memberGuestAddThrottleHook: () => undefined,
  MemberGuestAddThrottledError: class extends Error {},
  startMemberGuestRefusalClock: () => 0,
}));
vi.mock("@/lib/booking-guest-stay-range-input", () => ({
  normalizeGuestStayRanges: (guests: unknown[]) => guests,
  BookingGuestStayRangeValidationError: class extends Error {},
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: vi.fn().mockResolvedValue([]),
  BookingMemberNightConflictError: class extends Error {
    conflicts: unknown[] = [];
  },
  getBookingMemberNightConflictResponse: () => ({ error: "conflict" }),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: h.resolveOptionalActiveLodgeId,
  resolvePolicyRowsForLodge: () => [],
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(30),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  getMembershipTypeBookingPolicyErrorBody: (e: { message: string }) => ({
    error: e.message,
  }),
  MembershipTypeBookingPolicyError: class extends Error {
    status = 400;
  },
  requiresPaidSubscriptionForMemberForBooking: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: () => ({
    shouldBePending: false,
    status: "PAYMENT_PENDING",
  }),
  toGroupDiscountConfig: () => ({}),
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/internet-banking-settings", () => ({
  checkInternetBankingLeadTime: () => ({ allowed: true }),
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
vi.mock("@/lib/member-dietary", () => ({
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
    BookingPromoError: class extends Error {},
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
    it("catches a row whose member id resolved to nobody — the forged member link", async () => {
      // The client asserts the row is already on the member path. The boundary
      // resolver returns no such member, so `normalizeBookingGuestInputs` strips
      // the id and the row is the free-text guest it really was.
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

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("DEPENDANT_IDENTITY_UNRESOLVED");
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
});

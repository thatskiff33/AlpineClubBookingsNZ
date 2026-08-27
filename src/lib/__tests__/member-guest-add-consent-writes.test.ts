// "+ Add Member Guest" (epic #2305) MG2 (#2307) — WHAT EACH ADD PATH PERSISTS.
//
// MG1 shipped the feature dark: no request through any call site could create a
// BookingGuest row with a non-null consentStatus. This file is the other half of
// that guarantee — with the module ON, a cross-family member resolves, and the row
// that follows carries EXACTLY the columns the eight-shape table defines for the
// actor and policy that produced it.
//
// EVERY ROW ASSERTION ENDS AT `classifyMemberGuestConsent`, on purpose. Checking
// the five columns one by one proves a writer wrote what this test expected;
// running the classifier proves it wrote something the MODEL recognises. A writer
// that invents a combination the table does not define — a CONFIRMED row carrying
// an expiry, a PENDING row with a responder — is a bug that the column-by-column
// assertions on their own would happily bless, and the classifier is the only
// thing that catches it. So each case asserts both: the columns, and a non-null
// sub-state equal to the one the writer claims.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGuestCreateData } from "@/lib/booking-create-guests";
import { requireClubTimeZone } from "@/lib/club-time";
import {
  BookingGuestValidationError,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import { addDaysDateOnly, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  classifyMemberGuestConsent,
  MEMBER_GUEST_CONSENT_MIN_HOLD_MS,
  type MemberGuestBoundaryState,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  markCrossFamilyMemberGuests,
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
} from "@/lib/member-guest-add-policy";

const h = vi.hoisted(() => ({
  isEffectiveModuleEnabled: vi.fn(),
  loadMemberGuestSettings: vi.fn(),
  readClubTimeZoneOutsideRequest: vi.fn(),
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: h.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/member-guest-settings", () => ({
  loadMemberGuestSettings: h.loadMemberGuestSettings,
}));
/*
  #3123 — the policy now carries the club's PERSISTED timezone, read here so the
  eight `planMemberGuestConsentWrites` call sites do not each have to. The reader
  is stubbed rather than left to reach Prisma, because the real one is fail-soft
  three ways — missing delegate, throwing query, absent row — and every one of
  them degrades quietly to the environment's zone. A suite that let it fall
  through would pass whether or not the club's setting was ever consulted, which
  is the false green this issue keeps finding. Which zone reaches the clamp for
  real is proved in `member-guest-consent-club-time-authority.test.ts`, against a
  Prisma mock that does carry a `clubTimeSettings` row.
*/
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: h.readClubTimeZoneOutsideRequest,
}));

const BOOKER = "m-booker";
const SIBLING = "m-sibling";
const OUTSIDER = "m-outsider";
const ADMIN = "m-admin";

const NOW = new Date("2026-08-01T09:00:00.000Z");
const CHECK_IN = parseDateOnly("2026-09-10");
const CHECK_OUT = parseDateOnly("2026-09-12");

/** SIBLING is inside the booker's family; OUTSIDER is the person MG1 refused. */
function boundary(): MemberGuestBoundaryState {
  return {
    scopeByMemberId: new Map([
      [BOOKER, "FAMILY" as const],
      [SIBLING, "FAMILY" as const],
      [OUTSIDER, "BEYOND_FAMILY" as const],
    ]),
    beyondFamilyMemberIds: [OUTSIDER],
  };
}

/**
 * A club BEHIND Greenwich, and deliberately NOT `Pacific/Auckland` (#3123): that
 * is what the environment falls back to, so a fixture using it cannot tell the
 * club's persisted zone from the container's.
 */
const CLUB_ZONE = requireClubTimeZone("America/Denver");

const ASK_FIRST: MemberGuestAddPolicy = {
  wideningEnabled: true,
  approvalRequired: true,
  pendingHoldExpiryDays: 5,
  timeZone: CLUB_ZONE,
};
const NOTIFY_ONLY: MemberGuestAddPolicy = {
  wideningEnabled: true,
  approvalRequired: false,
  pendingHoldExpiryDays: 5,
  timeZone: CLUB_ZONE,
};

function guest(memberId: string, firstName = "Test") {
  return {
    firstName,
    lastName: memberId,
    ageTier: "ADULT" as const,
    isMember: true,
    memberId,
  };
}

/**
 * Assert a written row's columns AND that the model recognises them.
 *
 * `targetMemberId` is what separates TARGET_APPROVED from DELEGATE_APPROVED in the
 * classifier, so it is always the guest's own member id here.
 */
function expectSubState(
  columns: MemberGuestConsentColumns,
  targetMemberId: string | null,
  expected: string,
) {
  expect(classifyMemberGuestConsent(columns, targetMemberId)).toBe(expected);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isEffectiveModuleEnabled.mockResolvedValue(false);
  h.loadMemberGuestSettings.mockResolvedValue({
    approvalRequired: true,
    pendingHoldExpiryDays: 5,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  });
  h.readClubTimeZoneOutsideRequest.mockResolvedValue(CLUB_ZONE);
});

describe("loadMemberGuestAddPolicy", () => {
  it("reads the module flag and, when it is on, the policy singleton", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(true);
    h.loadMemberGuestSettings.mockResolvedValue({
      approvalRequired: false,
      pendingHoldExpiryDays: 9,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });

    await expect(loadMemberGuestAddPolicy()).resolves.toEqual({
      wideningEnabled: true,
      approvalRequired: false,
      pendingHoldExpiryDays: 9,
      timeZone: CLUB_ZONE,
    });
    expect(h.isEffectiveModuleEnabled).toHaveBeenCalledWith("memberGuests");
  });

  it("does not read the settings singleton at all when the module is off", async () => {
    // The shipped state of every club (D-2). With no widening there is no
    // cross-family guest and neither policy value can be consulted, so the query
    // would be pure cost on the hot path of every create, quote and guest add.
    await expect(loadMemberGuestAddPolicy()).resolves.toEqual({
      wideningEnabled: false,
      approvalRequired: true,
      pendingHoldExpiryDays: 0,
    });
    expect(h.loadMemberGuestSettings).not.toHaveBeenCalled();
    // And no CLUB TIMEZONE query either (#3123). The zone lives only on the
    // widening-enabled member of the policy union, so the module-off branch
    // spends nothing — which is the whole reason the type is a union rather than
    // one flat interface carrying an inert placeholder zone.
    expect(h.readClubTimeZoneOutsideRequest).not.toHaveBeenCalled();
  });
});

describe("planMemberGuestConsentWrites", () => {
  it("attaches nothing to a family-scope guest, and owes nobody anything (D-6)", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(BOOKER), guest(SIBLING)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    // Not "five nulls" — NOTHING. A family-scope add must persist through exactly
    // the code path it used before MG2 existed.
    expect(plan.guests[0]).not.toHaveProperty("memberGuestConsent");
    expect(plan.guests[0]).not.toHaveProperty("crossFamilyMemberGuest");
    expect(plan.guests[1]).not.toHaveProperty("memberGuestConsent");
    expect(plan.entriesByMemberId.size).toBe(0);
  });

  it("a member add under the ask-first default is AWAITING_TARGET with a clamped expiry (D-3, D-4)", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    const columns = plan.guests[0].memberGuestConsent!;
    expect(columns.consentStatus).toBe("PENDING");
    expect(columns.consentRequestedAt).toEqual(NOW);
    expect(columns.consentRespondedAt).toBeNull();
    expect(columns.consentRespondedByMemberId).toBeNull();
    // 5 days from now, which is well before the day before check-in, so the
    // requested window wins over the clamp.
    expect(columns.consentExpiresAt).toEqual(
      new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
    );
    expectSubState(columns, OUTSIDER, "AWAITING_TARGET");
    expect(plan.guests[0].crossFamilyMemberGuest).toBe(true);
    expect(plan.entriesByMemberId.get(OUTSIDER)).toEqual({
      targetMemberId: OUTSIDER,
      notification: "CONSENT_REQUEST",
      subState: "AWAITING_TARGET",
    });
  });

  it("clamps the expiry to the day before check-in for a stay that starts sooner", () => {
    const soon = addDaysDateOnly(parseDateOnly(formatDateOnly(NOW)), 2);
    const plan = planMemberGuestConsentWrites({
      guests: [guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: soon,
      policy: ASK_FIRST,
    });

    const expiresAt = plan.guests[0].memberGuestConsent!.consentExpiresAt!;
    expect(expiresAt.getTime()).toBeLessThan(
      NOW.getTime() + 5 * 24 * 60 * 60 * 1000,
    );
    // Never sooner than the two-hour floor, or the request would lapse before the
    // email landed.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + MEMBER_GUEST_CONSENT_MIN_HOLD_MS,
    );
    expectSubState(plan.guests[0].memberGuestConsent!, OUTSIDER, "AWAITING_TARGET");
  });

  it("a member add on a notify-only club is NOTIFY_ONLY_AUTO_CONFIRMED and is never asked (D-3 opt-down)", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: NOTIFY_ONLY,
    });

    const columns = plan.guests[0].memberGuestConsent!;
    expect(columns).toEqual({
      consentStatus: "CONFIRMED",
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
    });
    expectSubState(columns, OUTSIDER, "NOTIFY_ONLY_AUTO_CONFIRMED");
    // Told, not asked — and exactly ONE notice for the row.
    expect(plan.entriesByMemberId.get(OUTSIDER)?.notification).toBe("ADDED_NOTICE");
    expect(plan.entriesByMemberId.size).toBe(1);
    // NOT recorded as FAMILY_OR_LEGACY: the guest IS cross-family and that has to
    // stay visible.
    expect(columns.consentStatus).not.toBeNull();
  });

  it("an ADMIN add is ADMIN_ASSIGNED naming the acting admin, and is never PENDING (MG4-D-a)", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "ADMIN", adminMemberId: ADMIN },
      now: NOW,
      // The ask-first policy is deliberately in force: an admin add must NOT
      // become a PENDING request just because the club asks members first.
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    const columns = plan.guests[0].memberGuestConsent!;
    expect(columns).toEqual({
      consentStatus: "CONFIRMED",
      consentRequestedAt: null,
      consentRespondedAt: NOW,
      consentRespondedByMemberId: ADMIN,
      consentExpiresAt: null,
    });
    expect(columns.consentStatus).not.toBe("PENDING");
    expectSubState(columns, OUTSIDER, "ADMIN_ASSIGNED");
    expect(plan.entriesByMemberId.get(OUTSIDER)?.notification).toBe("ADDED_NOTICE");
  });

  it("mixes scopes in one add without cross-contamination", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(SIBLING), guest(OUTSIDER), { ...guest(""), isMember: false, memberId: undefined }],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    expect(plan.guests[0]).not.toHaveProperty("memberGuestConsent");
    expect(plan.guests[1].memberGuestConsent?.consentStatus).toBe("PENDING");
    expect(plan.guests[2]).not.toHaveProperty("memberGuestConsent");
    expect([...plan.entriesByMemberId.keys()]).toEqual([OUTSIDER]);
  });

  it("marks without writing for the quote paths", () => {
    const marked = markCrossFamilyMemberGuests(
      [guest(SIBLING), guest(OUTSIDER)],
      boundary(),
    );

    expect(marked[0]).not.toHaveProperty("crossFamilyMemberGuest");
    expect(marked[1].crossFamilyMemberGuest).toBe(true);
    // The whole point: a quote resolves and prices a cross-family member and
    // persists nothing, so it must never carry consent columns anywhere.
    expect(marked[1]).not.toHaveProperty("memberGuestConsent");
  });
});

describe("buildGuestCreateData — the booking-create and booking-copy write", () => {
  const price = {
    guests: [
      { priceCents: 1000, perNightCents: [500, 500], nightDates: [CHECK_IN, addDaysDateOnly(CHECK_IN, 1)] },
      { priceCents: 1000, perNightCents: [500, 500], nightDates: [CHECK_IN, addDaysDateOnly(CHECK_IN, 1)] },
    ],
  };

  it("persists the planned consent columns for a cross-family guest and nothing for a family one", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(SIBLING), guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    const [family, crossFamily] = buildGuestCreateData(
      plan.guests,
      price,
      CHECK_IN,
      CHECK_OUT,
    );

    // The family row carries no consent keys at all — the row Prisma writes is
    // byte-identical to the pre-MG2 one.
    expect(Object.keys(family)).not.toContain("consentStatus");
    expect(Object.keys(family)).not.toContain("consentExpiresAt");

    const written = crossFamily as typeof crossFamily & MemberGuestConsentColumns;
    expect(written.consentStatus).toBe("PENDING");
    expect(written.consentRequestedAt).toEqual(NOW);
    expectSubState(
      {
        consentStatus: written.consentStatus,
        consentRequestedAt: written.consentRequestedAt,
        consentRespondedAt: written.consentRespondedAt,
        consentRespondedByMemberId: written.consentRespondedByMemberId,
        consentExpiresAt: written.consentExpiresAt,
      },
      OUTSIDER,
      "AWAITING_TARGET",
    );
    // The marker is a decision input, not a database column.
    expect(Object.keys(written)).not.toContain("crossFamilyMemberGuest");
    expect(Object.keys(written)).not.toContain("memberGuestConsent");
  });

  it("persists an ADMIN_ASSIGNED row for an on-behalf create", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "ADMIN", adminMemberId: ADMIN },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    const [written] = buildGuestCreateData(
      plan.guests,
      { guests: [price.guests[0]] },
      CHECK_IN,
      CHECK_OUT,
    ) as Array<MemberGuestConsentColumns & { memberId: string | null }>;

    expect(written.consentRespondedByMemberId).toBe(ADMIN);
    expectSubState(written, written.memberId, "ADMIN_ASSIGNED");
  });
});

describe("matchMemberGuestNotificationRows", () => {
  it("pairs the created rows with the notification each target is owed", () => {
    const plan = planMemberGuestConsentWrites({
      guests: [guest(SIBLING), guest(OUTSIDER)],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    const rows = matchMemberGuestNotificationRows({
      createdGuests: [
        { id: "bg-family", memberId: SIBLING },
        { id: "bg-cross", memberId: OUTSIDER },
        { id: "bg-nonmember", memberId: null },
      ],
      entriesByMemberId: plan.entriesByMemberId,
    });

    // Only the cross-family row is owed anything, and it is paired to the right id.
    expect(rows).toEqual([
      {
        bookingGuestId: "bg-cross",
        targetMemberId: OUTSIDER,
        notification: "CONSENT_REQUEST",
      },
    ]);
  });

  it("owes nothing when the plan is empty, whatever rows were created", () => {
    expect(
      matchMemberGuestNotificationRows({
        createdGuests: [{ id: "bg-1", memberId: SIBLING }],
        entriesByMemberId: new Map(),
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The switch itself, on the paths that enforce authorization
// ---------------------------------------------------------------------------

describe("the widening flag on an authorized (non-admin) add", () => {
  const FAMILY_LINKS: Record<string, string[]> = {
    [BOOKER]: ["fg-1"],
    [SIBLING]: ["fg-1"],
    [OUTSIDER]: ["fg-2"],
  };
  const RECORDS: Record<string, { active: boolean }> = {
    [BOOKER]: { active: true },
    [SIBLING]: { active: true },
    [OUTSIDER]: { active: true },
    "m-inactive": { active: false },
  };

  function lookupDb() {
    return {
      familyGroupMember: {
        findMany: async (args: {
          where?: { memberId?: string; familyGroupId?: { in: string[] } };
        }) => {
          const where = args.where ?? {};
          if (where.memberId) {
            return (FAMILY_LINKS[where.memberId] ?? []).map((familyGroupId) => ({
              familyGroupId,
            }));
          }
          const groupIds = where.familyGroupId?.in ?? [];
          return Object.entries(FAMILY_LINKS)
            .filter(([, groups]) => groups.some((g) => groupIds.includes(g)))
            .map(([memberId]) => ({ memberId }));
        },
      },
      member: {
        findMany: async (args: { where?: { id?: { in: string[] }; active?: boolean } }) => {
          const ids = args.where?.id?.in ?? [];
          return ids
            .filter((id) => RECORDS[id] && (args.where?.active !== true || RECORDS[id].active))
            .map((id) => ({
              id,
              ageTier: "ADULT",
              active: RECORDS[id].active,
              canLogin: true,
              firstName: "Test",
              lastName: id,
              accessRoles: [],
            }));
        },
      },
    } as unknown as Parameters<typeof resolveLinkedBookingMembersWithBoundary>[0];
  }

  it("refuses a beyond-family member with the byte-for-byte pre-existing error when the module is off", async () => {
    const error = await resolveLinkedBookingMembersWithBoundary(
      lookupDb(),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: false },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    // Byte for byte: a club that has not opted in sees the same refusal it always
    // saw, and no error text anywhere mentions member guests.
    expect((error as BookingGuestValidationError).message).toBe(
      "Invalid guest member reference",
    );
    expect((error as BookingGuestValidationError).status).toBe(403);
  });

  it("fails closed: a caller that forgets the option keeps MG1's refusal", async () => {
    await expect(
      resolveLinkedBookingMembersWithBoundary(lookupDb(), BOOKER, [OUTSIDER]),
    ).rejects.toThrow("Invalid guest member reference");
  });

  it("resolves a beyond-family ACTIVE member when the module is on, and marks the boundary", async () => {
    const { members, boundary } = await resolveLinkedBookingMembersWithBoundary(
      lookupDb(),
      BOOKER,
      [SIBLING, OUTSIDER],
      { memberGuestWideningEnabled: true },
    );

    expect([...members.keys()].sort()).toEqual([OUTSIDER, SIBLING].sort());
    expect(boundary.beyondFamilyMemberIds).toEqual([OUTSIDER]);
    expect(boundary.scopeByMemberId.get(SIBLING)).toBe("FAMILY");
  });

  it("keeps an INACTIVE member unresolvable in every module state", async () => {
    for (const memberGuestWideningEnabled of [false, true]) {
      await expect(
        resolveLinkedBookingMembersWithBoundary(lookupDb(), BOOKER, ["m-inactive"], {
          memberGuestWideningEnabled,
          // Even on an admin path that skips authorization entirely.
          skipAuthorization: true,
        }),
      ).rejects.toThrow("Linked member is inactive or not found");
    }
  });
});

// Plan §9.2's last criterion, which had no test (correctness review of MG3
// #2308, LOW-1): "consent badges render from server state only; a client-forged
// `consentStatus` changes nothing."
//
// The wizard carries `memberGuestConsentPreview` on its guest rows for display,
// and `buildGuestPayload` spreads those rows, so the field really is transmitted
// to `POST /api/bookings`. It is harmless because nothing server-side reads it —
// which is a claim worth asserting rather than assuming.
describe("a client cannot forge its way out of consent", () => {
  it("ignores every consent-shaped field a caller sends and derives from the boundary", () => {
    const forged = {
      ...guest(OUTSIDER),
      // What a hostile (or merely stale) client might put on the wire.
      memberGuestConsentPreview: "NOTIFY_ONLY",
      crossFamilyMemberGuest: false,
      memberGuestConsent: {
        consentStatus: "CONFIRMED",
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
    } as unknown as ReturnType<typeof guest>;

    const plan = planMemberGuestConsentWrites({
      guests: [forged],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy: ASK_FIRST,
    });

    // Still PENDING, still marked cross-family, and the club still owes the
    // target a consent request.
    expect(plan.guests[0].memberGuestConsent!.consentStatus).toBe("PENDING");
    expect(plan.guests[0].crossFamilyMemberGuest).toBe(true);
    expect(plan.entriesByMemberId.get(OUTSIDER)?.notification).toBe(
      "CONSENT_REQUEST",
    );
  });
});

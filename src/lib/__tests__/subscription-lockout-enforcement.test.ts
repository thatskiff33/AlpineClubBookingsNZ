import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * The #2543 enforcement matrix: what each of the three club modes does to a
 * party, and what the resulting refusal carries.
 *
 * `evaluateNonMemberPricingRequirements` is the ONE thing all five booking write
 * paths call for the new behaviour, so this file is where "consistent across
 * every write path" is actually pinned down — the five routes then only have to
 * be shown to call it (see the enforcement call-site coverage at the end).
 */

const mocks = vi.hoisted(() => ({
  peekSubscriptionLockoutMode: vi.fn(),
  resolveMembershipTypePoliciesForMembers: vi.fn(),
}));

vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: mocks.peekSubscriptionLockoutMode,
}));

vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers:
    mocks.resolveMembershipTypePoliciesForMembers,
}));

// Real age-tier rule, driven by real settings rows: ADULT and YOUTH owe a
// subscription, CHILD and INFANT do not.
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn(async () => [
    { tier: "INFANT", subscriptionRequiredForBooking: false },
    { tier: "CHILD", subscriptionRequiredForBooking: false },
    { tier: "YOUTH", subscriptionRequiredForBooking: true },
    { tier: "ADULT", subscriptionRequiredForBooking: true },
  ]),
}));

import { getAgeTierSettings, type AgeTierSettingData } from "@/lib/age-tier";
import { parseDateOnly } from "@/lib/date-only";
import { violationFingerprint } from "@/lib/booking-exception-requests";
import {
  isHardStopBookingFailureCode,
  isPolicyExceptionReasonCode,
} from "@/lib/booking-policy-exceptions";
import {
  PaidUpAdultMemberRequiredError,
  buildPaidUpAdultRefusalBody,
  buildPaidUpAdultRefusalBodyForOtherPartyMember,
  evaluateNonMemberPricingRequirements,
  evaluateProposedPaidUpAdultPresence,
  loadUnpaidSubscriptionMemberIds,
  toSubscriptionLockoutParticipants,
  type SubscriptionLockoutDb,
} from "@/lib/subscription-lockout-enforcement";

const SEASON = 2026;
const CHECK_IN = parseDateOnly("2026-07-04");
const CHECK_OUT = parseDateOnly("2026-07-06");

type TestMember = {
  id: string;
  ageTier: "ADULT" | "YOUTH" | "CHILD" | "INFANT";
  active?: boolean;
  cancelledAt?: Date | null;
  archivedAt?: Date | null;
  /** Season subscription status; omit for "no row at all". */
  status?: "PAID" | "UNPAID" | "NOT_INVOICED" | "NOT_REQUIRED";
  /** Effective membership-type subscription behaviour. */
  behavior?: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
};

/** A paid-up adult member: the participant the rule requires to be present. */
const PAID_ADULT: TestMember = { id: "adult-paid", ageTier: "ADULT", status: "PAID" };
/** An adult member whose season subscription is required and unpaid. */
const UNPAID_ADULT: TestMember = {
  id: "adult-unpaid",
  ageTier: "ADULT",
  status: "NOT_INVOICED",
};
/** A member the subscription rule never applies to (exempt age tier). */
const EXEMPT_CHILD: TestMember = { id: "child-exempt", ageTier: "CHILD" };

function makeDb(members: TestMember[]): SubscriptionLockoutDb {
  const rows = members.map((member) => ({
    id: member.id,
    ageTier: member.ageTier,
    active: member.active ?? true,
    cancelledAt: member.cancelledAt ?? null,
    archivedAt: member.archivedAt ?? null,
  }));
  const subs = members
    .filter((member) => member.status !== undefined)
    .map((member) => ({ memberId: member.id, status: member.status! }));

  mocks.resolveMembershipTypePoliciesForMembers.mockImplementation(
    async (_db: unknown, params: { memberIds: string[] }) =>
      new Map(
        params.memberIds.map((id) => [
          id,
          {
            subscriptionBehavior:
              members.find((member) => member.id === id)?.behavior ?? "REQUIRED",
          },
        ]),
      ),
  );

  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        rows.filter((row) => args.where.id.in.includes(row.id)),
      ),
    },
    memberSubscription: {
      findMany: vi.fn(
        async (args: { where: { memberId: { in: string[] } } }) =>
          subs.filter((sub) => args.where.memberId.in.includes(sub.memberId)),
      ),
    },
  } as unknown as SubscriptionLockoutDb;
}

function participantsFor(members: TestMember[]) {
  return members.map((member) => ({
    isMember: true as const,
    memberId: member.id,
  }));
}

function evaluate(
  members: TestMember[],
  participants: Array<{
    isMember: boolean;
    memberId?: string | null;
    operationallyPresent?: boolean;
  }> = participantsFor(members),
) {
  return evaluateNonMemberPricingRequirements(makeDb(members), {
    lodgeId: "lodge-1",
    seasonYear: SEASON,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    participants,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
});

// ---------------------------------------------------------------------------
// The mode axis: two of the three modes must be a total no-op.
// ---------------------------------------------------------------------------

describe("the mode gate (#2543)", () => {
  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "%s adds nothing at all, before touching the database",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = makeDb([UNPAID_ADULT]);

      await expect(
        evaluateNonMemberPricingRequirements(db, {
          mode,
          lodgeId: "lodge-1",
          seasonYear: SEASON,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          participants: participantsFor([UNPAID_ADULT]),
        }),
      ).resolves.toBeNull();

      // Not merely "no violation" — no query, no notice, no work. This is what
      // keeps the default (HARD_BLOCK) byte-identical to pre-#2543 and is the
      // property the whole opt-in design rests on.
      expect(db.member.findMany).not.toHaveBeenCalled();
      expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
      expect(mocks.resolveMembershipTypePoliciesForMembers).not.toHaveBeenCalled();
    },
  );

  it("resolves the mode itself when the caller did not pass one", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    await expect(evaluate([UNPAID_ADULT])).resolves.toBeNull();
    expect(mocks.peekSubscriptionLockoutMode).toHaveBeenCalledTimes(1);
  });

  it("honours a caller-supplied mode over its own read", async () => {
    // The five write paths resolve the mode once and pass it down, so the party is
    // judged against exactly the mode the HARD_BLOCK gate branched on. An admin
    // saving the setting mid-request must not make one request refuse under one
    // regime and price under the other.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NO_BLOCK");
    const result = await evaluateNonMemberPricingRequirements(
      makeDb([UNPAID_ADULT, PAID_ADULT]),
      {
        mode: "NON_MEMBER_PRICING",
        lodgeId: "lodge-1",
        seasonYear: SEASON,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        participants: participantsFor([UNPAID_ADULT, PAID_ADULT]),
      },
    );
    expect(result).not.toBeNull();
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NON_MEMBER_PRICING: who is repriced.
// ---------------------------------------------------------------------------

describe("NON_MEMBER_PRICING — who is repriced (#2543)", () => {
  it("reprices an adult member whose required subscription is unpaid", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual(["adult-unpaid"]);
  });

  it("does not reprice a paid-up member", async () => {
    const result = await evaluate([PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("does not reprice a member whose type says NOT_REQUIRED", async () => {
    const result = await evaluate([
      { ...UNPAID_ADULT, behavior: "NOT_REQUIRED" },
      PAID_ADULT,
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("does not reprice an exempt age tier even with no subscription row", async () => {
    const result = await evaluate([EXEMPT_CHILD, PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("honours the #2041 BASED_ON_AGE_TIER dominance of a NOT_REQUIRED row", async () => {
    const result = await evaluate([
      {
        id: "youth-exempted",
        ageTier: "YOUTH",
        behavior: "BASED_ON_AGE_TIER",
        status: "NOT_REQUIRED",
      },
      PAID_ADULT,
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("never reprices a row whose isMember snapshot is false", async () => {
    // A non-member already prices at the non-member rate, so asking about their
    // subscription would be a pointless query and a pointless disclosure.
    const result = await evaluate([PAID_ADULT], [
      { isMember: true, memberId: "adult-paid" },
      { isMember: false, memberId: null },
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("reprices an unresolvable member id — the safe direction on money", async () => {
    // A member id with no Member row must never silently price at member rates.
    const result = await evaluate([PAID_ADULT], [
      { isMember: true, memberId: "adult-paid" },
      { isMember: true, memberId: "ghost-member" },
    ]);
    expect(result?.repricedMemberIds).toEqual(["ghost-member"]);
  });

  it("returns a sorted, de-duplicated reprice list", async () => {
    const second: TestMember = {
      id: "adult-unpaid-2",
      ageTier: "ADULT",
      status: "UNPAID",
    };
    const result = await evaluate([second, UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid-2" },
      { isMember: true, memberId: "adult-unpaid" },
      // Same member twice (two guest rows, e.g. a split stay).
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "adult-paid" },
    ]);
    expect(result?.repricedMemberIds).toEqual([
      "adult-unpaid",
      "adult-unpaid-2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// NON_MEMBER_PRICING: the paid-up-adult requirement.
// ---------------------------------------------------------------------------

describe("NON_MEMBER_PRICING — the paid-up-adult requirement (#2543)", () => {
  it("passes a repriced party that has a paid-up adult member on it", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.hasPaidUpAdultMember).toBe(true);
    expect(result?.violation).toBeNull();
  });

  it("refuses a repriced party with no paid-up adult member", async () => {
    const result = await evaluate([UNPAID_ADULT, EXEMPT_CHILD]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
    expect(result?.violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
  });

  it("the unpaid member does not satisfy the requirement themselves", async () => {
    // The whole point of the rule: otherwise it would be vacuous.
    const result = await evaluate([UNPAID_ADULT]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a paid-up but NOT operationally present adult does not satisfy it (D-12)", async () => {
    // An unaccepted member-guest invite is not a responsible adult at the lodge,
    // and the arrival roster, kiosk and bed allocation all already agree.
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "adult-paid", operationallyPresent: false },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a lapsed adult with a paid subscription does not satisfy it", async () => {
    const result = await evaluate([
      UNPAID_ADULT,
      { id: "adult-lapsed", ageTier: "ADULT", status: "PAID", active: false },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a paid-up YOUTH member does not satisfy it — the rule asks for an adult", async () => {
    const result = await evaluate([
      UNPAID_ADULT,
      { id: "youth-paid", ageTier: "YOUTH", status: "PAID" },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  // The scoping decision, and the regression this guards is a real one: an
  // unconditional requirement would make switching to NON_MEMBER_PRICING — a
  // RELAXATION of the hard block — newly refuse whole classes of booking that are
  // legal today and have nothing to do with subscriptions.
  it("does NOT apply to a party nobody is being repriced on", async () => {
    const result = await evaluate([EXEMPT_CHILD]);
    expect(result?.repricedMemberIds).toEqual([]);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does NOT apply to an all-non-member party", async () => {
    const result = await evaluate([], [
      { isMember: false, memberId: null },
      { isMember: false, memberId: null },
    ]);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does NOT apply to an empty party", async () => {
    const result = await evaluate([], []);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The booking-owner arm of the trigger (owner decision, 3 Aug 2026).
// ---------------------------------------------------------------------------

/** A guest row that is not a member at all — the party the gap was about. */
const NON_MEMBER = { isMember: false, memberId: null } as const;

function evaluateFor(
  bookingOwnerMemberId: string | null,
  members: TestMember[],
  participants: Array<{
    isMember: boolean;
    memberId?: string | null;
    operationallyPresent?: boolean;
  }>,
  mode: "NO_BLOCK" | "HARD_BLOCK" | "NON_MEMBER_PRICING" = "NON_MEMBER_PRICING",
) {
  return evaluateNonMemberPricingRequirements(makeDb(members), {
    mode,
    bookingOwnerMemberId,
    lodgeId: "lodge-1",
    seasonYear: SEASON,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    participants,
  });
}

/**
 * THE HOLE THIS ARM CLOSES. `HARD_BLOCK` refuses an unfinancial member as a
 * PERSON: they cannot book at all, even for a party of non-members they will not
 * join. Keyed only on who stays, `NON_MEMBER_PRICING` let exactly that booking
 * through with no reprice, no requirement and no notice — so switching a club to
 * the softer rule quietly opened the one case the strict rule most reliably
 * closed, and lapsing cost a member nothing so long as they booked for others.
 *
 * Every test below is named so that deleting the owner arm from the trigger
 * reddens something that says what was lost.
 */
describe("the paid-up-adult trigger follows the unfinancial member, not only their bed (#2543, owner decision 3 Aug 2026)", () => {
  it("refuses an unfinancial owner who is NOT staying, booking beds for non-members", async () => {
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      NON_MEMBER,
      NON_MEMBER,
    ]);

    // Nobody's nights were repriced — the owner holds none — and the requirement
    // still applies. That combination is the whole point of the arm.
    expect(result?.repricedMemberIds).toEqual([]);
    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
    expect(result?.violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
  });

  it("passes an unfinancial owner who is NOT staying when a paid-up adult member IS on the party", async () => {
    // The intended family case: the financial spouse is on the booking, so it
    // books. The arm must not turn into a wall for them.
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-paid" },
      NON_MEMBER,
    ]);

    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.hasPaidUpAdultMember).toBe(true);
    expect(result?.violation).toBeNull();
  });

  it("refuses an unfinancial owner who IS staying with no paid-up adult member", async () => {
    // Reachable through the reprice arm as well, and it must stay reachable: this
    // is the case the rule was written for.
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT, EXEMPT_CHILD], [
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "child-exempt" },
    ]);

    expect(result?.repricedMemberIds).toEqual(["adult-unpaid"]);
    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.violation).not.toBeNull();
  });

  it("passes an unfinancial owner who IS staying alongside a paid-up adult member", async () => {
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "adult-paid" },
    ]);

    expect(result?.repricedMemberIds).toEqual(["adult-unpaid"]);
    expect(result?.hasPaidUpAdultMember).toBe(true);
    expect(result?.violation).toBeNull();
  });

  it("never lets an unfinancial owner satisfy their own requirement", async () => {
    // They fail the money half of the predicate, staying or not; otherwise the arm
    // would be vacuous.
    const staying = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
    ]);
    const notStaying = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      NON_MEMBER,
    ]);

    expect(staying?.hasPaidUpAdultMember).toBe(false);
    expect(notStaying?.hasPaidUpAdultMember).toBe(false);
  });

  it("emits NO rate notice when the trigger is the owner and nothing was repriced", async () => {
    // The notice says member rates "aren't available for those nights". With the
    // owner off the booking there are no such nights, and asserting a price nobody
    // was charged is the dishonesty this split prevents.
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [NON_MEMBER]);

    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.memberRateNotice).toBeNull();
  });

  it("still emits the rate notice when the owner stays and IS repriced", async () => {
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
    ]);

    expect(result?.memberRateNotice).toContain("2026/2027");
  });

  it("counts zero repriced members on an owner-triggered refusal, and names nobody", async () => {
    // The violation shape is unchanged by the new trigger: counts, no identities.
    // `repriced=0` is the only thing that distinguishes it, and it discloses only
    // that the trigger was not a member of the party — which the person receiving
    // the refusal already knows, because under this trigger they ARE the
    // unfinancial member.
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      NON_MEMBER,
      NON_MEMBER,
    ]);

    expect(result?.violation?.requirements).toEqual({
      kind: "PAID_UP_ADULT_MEMBER",
      requiredPaidUpAdultMembers: 1,
      repricedUnpaidMemberCount: 0,
      participantCount: 2,
    });
    expect(JSON.stringify(result?.violation)).not.toMatch(/adult-unpaid/);
  });

  it("refuses with the same 409, the same door and the same HOLD as the reprice arm", async () => {
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [NON_MEMBER]);
    const error = new PaidUpAdultMemberRequiredError(result!.violation!);

    expect(error.status).toBe(409);
    expect(error.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(isHardStopBookingFailureCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      false,
    );

    const body = buildPaidUpAdultRefusalBody(result!.violation!);
    expect(body.exceptionRequestPath).toBe("/api/bookings/exception-requests");
    expect(body.exceptionReview.capacityMode).toBe("HOLD");
  });

  it("holds the booking envelope when the arm fires on a party with no nights of its own", async () => {
    // A HOLD over zero nights would reserve nothing while promising the member
    // their beds. Only reachable through this arm, which can fire on a party the
    // caller describes without per-guest ranges.
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], []);

    expect(result?.violation?.affectedNights).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("fingerprints an owner-triggered hazard apart from a repriced one, and identically for two different owners", async () => {
    const alice = await evaluateFor("alice", [{ ...UNPAID_ADULT, id: "alice" }], [
      NON_MEMBER,
    ]);
    const bob = await evaluateFor("bob", [{ ...UNPAID_ADULT, id: "bob" }], [
      NON_MEMBER,
    ]);
    const repriced = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
    ]);

    // Same hazard, whoever the unfinancial booker is: a decided review is not
    // reopened by re-saving the same party shape.
    expect(violationFingerprint(alice!.violation!)).toBe(
      violationFingerprint(bob!.violation!),
    );
    expect(violationFingerprint(alice!.violation!)).toContain("repriced=0");
    // And a genuinely different hazard — somebody on the party being repriced —
    // is a different question an admin has not reviewed.
    expect(violationFingerprint(alice!.violation!)).not.toBe(
      violationFingerprint(repriced!.violation!),
    );
  });

  it("judges the owner from the party's own settlement batch, never a second read", async () => {
    // One batch, so the owner and the party cannot be judged by two settlements
    // that disagree — and the party's live standing facts stay a question about the
    // party, since a not-staying owner could not satisfy the requirement anyway.
    const db = makeDb([UNPAID_ADULT, PAID_ADULT]);
    await evaluateNonMemberPricingRequirements(db, {
      mode: "NON_MEMBER_PRICING",
      bookingOwnerMemberId: "adult-unpaid",
      lodgeId: "lodge-1",
      seasonYear: SEASON,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      participants: [{ isMember: true, memberId: "adult-paid" }],
    });

    const subscriptionCalls = (
      db.memberSubscription.findMany as unknown as Mock
    ).mock.calls as Array<[{ where: { memberId: { in: string[] } } }]>;
    expect(subscriptionCalls).toHaveLength(1);
    expect([...subscriptionCalls[0][0].where.memberId.in].sort()).toEqual([
      "adult-paid",
      "adult-unpaid",
    ]);

    const memberCalls = (db.member.findMany as unknown as Mock).mock
      .calls as Array<[{ where: { id: { in: string[] } } }]>;
    // First read: the party's standing facts, owner excluded.
    expect(memberCalls[0][0].where.id.in).toEqual(["adult-paid"]);
  });
});

describe("the owner arm changes nothing it was not meant to (#2543)", () => {
  it("leaves an all-non-member party alone when the owner is financial", async () => {
    // The relaxation guarantee: an unconditional requirement would refuse this,
    // and the club asked to stop turning unpaid members away rather than to start
    // turning these away.
    const result = await evaluateFor("adult-paid", [PAID_ADULT], [
      NON_MEMBER,
      NON_MEMBER,
    ]);

    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does not fire for an owner the subscription rule never applies to (exempt age tier)", async () => {
    const result = await evaluateFor("child-exempt", [EXEMPT_CHILD], [NON_MEMBER]);

    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does not fire for an owner whose membership type says NOT_REQUIRED", async () => {
    const result = await evaluateFor(
      "adult-unpaid",
      [{ ...UNPAID_ADULT, behavior: "NOT_REQUIRED" }],
      [NON_MEMBER],
    );

    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("honours the #2041 BASED_ON_AGE_TIER dominance of a NOT_REQUIRED row for the owner too", async () => {
    const result = await evaluateFor(
      "youth-exempted",
      [
        {
          id: "youth-exempted",
          ageTier: "YOUTH",
          behavior: "BASED_ON_AGE_TIER",
          status: "NOT_REQUIRED",
        },
      ],
      [NON_MEMBER],
    );

    expect(result?.paidUpAdultMemberRequired).toBe(false);
  });

  it.each([null, "", "   "])(
    "treats a blank or absent owner id (%p) as the party-only evaluation",
    async (ownerId) => {
      const result = await evaluateFor(ownerId, [UNPAID_ADULT], [NON_MEMBER]);

      expect(result?.paidUpAdultMemberRequired).toBe(false);
      expect(result?.violation).toBeNull();
    },
  );

  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "%s is provably unaffected: null before any query, even with an unfinancial owner and no paid-up adult",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = makeDb([UNPAID_ADULT]);

      await expect(
        evaluateNonMemberPricingRequirements(db, {
          mode,
          bookingOwnerMemberId: "adult-unpaid",
          lodgeId: "lodge-1",
          seasonYear: SEASON,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          participants: [NON_MEMBER],
        }),
      ).resolves.toBeNull();

      expect(db.member.findMany).not.toHaveBeenCalled();
      expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
      expect(mocks.resolveMembershipTypePoliciesForMembers).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Tell them why.
// ---------------------------------------------------------------------------

describe("the member-facing notice (#2543 / #2533 requirement 2)", () => {
  it("names the season and appears exactly when somebody is repriced", async () => {
    const repriced = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(repriced?.memberRateNotice).toContain("2026/2027");
    expect(repriced?.memberRateNotice).toMatch(/renew/i);

    const clean = await evaluate([PAID_ADULT]);
    expect(clean?.memberRateNotice).toBeNull();
  });

  it("names nobody and no amount — a family member may be reading it", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.memberRateNotice).not.toMatch(/adult-unpaid|\$/);
  });
});

// ---------------------------------------------------------------------------
// The refusal: 409, exception-eligible, HOLD, and a door the member can enter.
// ---------------------------------------------------------------------------

describe("the refusal payload (#2543)", () => {
  it("freezes the party's nights, sorted and de-duplicated", async () => {
    const result = await evaluate([UNPAID_ADULT, EXEMPT_CHILD]);
    expect(result?.violation?.affectedNights).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("uses a guest's own stay window when they carry one", async () => {
    const db = makeDb([UNPAID_ADULT]);
    const result = await evaluateNonMemberPricingRequirements(db, {
      mode: "NON_MEMBER_PRICING",
      lodgeId: "lodge-1",
      seasonYear: SEASON,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      participants: [
        {
          isMember: true,
          memberId: "adult-unpaid",
          // A string is accepted: the create and group-join paths carry the
          // member's raw request values this far.
          stayStart: "2026-07-05",
          stayEnd: "2026-07-06",
        },
      ],
    });
    expect(result?.violation?.affectedNights).toEqual(["2026-07-05"]);
  });

  it("is a 409 that carries the exception door and the HOLD promise", async () => {
    const result = await evaluate([UNPAID_ADULT]);
    const error = new PaidUpAdultMemberRequiredError(result!.violation!);

    // 409, not 403: this booking IS permitted, by a Booking Officer, through the
    // exception-request workflow — the state of the party is what conflicts.
    expect(error.status).toBe(409);
    expect(error.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");

    const body = buildPaidUpAdultRefusalBody(result!.violation!);
    expect(body).toMatchObject({
      code: "PAID_UP_ADULT_MEMBER_REQUIRED",
      exceptionRequestPath: "/api/bookings/exception-requests",
    });
    expect(body.error).toBe(result!.violation!.message);
    expect(body.violations).toHaveLength(1);
    // The client relies on this to promise that requesting an override keeps the
    // beds (owner decision 4).
    expect(body.exceptionReview.capacityMode).toBe("HOLD");
  });

  it("is exception-eligible and NOT a hard stop", async () => {
    // The two subscription hard stops (SUBSCRIPTION_REQUIRED /
    // GUEST_SUBSCRIPTION_REQUIRED) may never enter review; this refusal must.
    expect(isPolicyExceptionReasonCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      true,
    );
    expect(isHardStopBookingFailureCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      false,
    );
  });

  it("fingerprints the HAZARD, not who is unpaid", async () => {
    // The hazard an admin reviewed is "this party has nobody paid-up on it", and
    // it is the same hazard whether the unpaid member is Alice or Bob.
    // Fingerprinting identities would reopen a decided review every time the party
    // was re-saved with the same shape.
    const alice = await evaluate([{ ...UNPAID_ADULT, id: "alice" }]);
    const bob = await evaluate([{ ...UNPAID_ADULT, id: "bob" }]);

    expect(violationFingerprint(alice!.violation!)).toBe(
      violationFingerprint(bob!.violation!),
    );
    expect(violationFingerprint(alice!.violation!)).toContain("repriced=1");
    expect(violationFingerprint(alice!.violation!)).not.toMatch(/alice|bob/);
  });

  it("fingerprints a differently-shaped party differently", async () => {
    const one = await evaluate([UNPAID_ADULT]);
    const two = await evaluate([
      UNPAID_ADULT,
      { id: "adult-unpaid-2", ageTier: "ADULT", status: "UNPAID" },
    ]);
    expect(violationFingerprint(one!.violation!)).not.toBe(
      violationFingerprint(two!.violation!),
    );
  });
});

describe("the refusal is audience-scoped, and only where it has to be (#2543)", () => {
  /**
   * The owner-arm-alone violation: nobody in the party is repriced, so
   * `repricedUnpaidMemberCount` is 0 and the only rule that can have fired is the
   * booking owner's. That is the exact refusal a member self-removing from somebody
   * else's booking can receive, and the count is what points at the owner.
   */
  async function ownerArmOnlyViolation() {
    const result = await evaluateFor("adult-unpaid", [UNPAID_ADULT], [NON_MEMBER]);
    expect(result?.violation?.requirements.repricedUnpaidMemberCount).toBe(0);
    return result!.violation!;
  }

  it("gives the booker everything, including the count that names the trigger", async () => {
    const violation = await ownerArmOnlyViolation();
    const body = buildPaidUpAdultRefusalBody(violation);

    expect(body.violations[0]).toEqual(violation);
    expect(body.exceptionReview.violations[0]).toEqual(violation);
  });

  it("defaults to the booker, so a throw site that says nothing cannot silently narrow", async () => {
    const violation = await ownerArmOnlyViolation();
    expect(new PaidUpAdultMemberRequiredError(violation).audience).toBe("BOOKER");
    expect(
      new PaidUpAdultMemberRequiredError(violation, "OTHER_PARTY_MEMBER").audience,
    ).toBe("OTHER_PARTY_MEMBER");
  });

  it("withholds the trigger count from a member who does not own the booking", async () => {
    const violation = await ownerArmOnlyViolation();
    const body = buildPaidUpAdultRefusalBodyForOtherPartyMember(violation);

    for (const shown of [body.violations[0], body.exceptionReview.violations[0]]) {
      expect(shown.requirements).not.toHaveProperty(
        "repricedUnpaidMemberCount",
      );
      // The RULE still travels, so the refusal still reads as a threshold rather
      // than an unexplained no, and the party size is not a disclosure — the
      // recipient is on the booking and can count it.
      expect(shown.requirements).toMatchObject({
        kind: "PAID_UP_ADULT_MEMBER",
        requiredPaidUpAdultMembers: 1,
        participantCount: 1,
      });
    }
  });

  it("keeps the message, the door and the HOLD promise for that member", async () => {
    const violation = await ownerArmOnlyViolation();
    const narrowed = buildPaidUpAdultRefusalBodyForOtherPartyMember(violation);
    const full = buildPaidUpAdultRefusalBody(violation);

    // Everything the member acts on is identical. Narrowing must not turn a
    // reviewable refusal into a dead end.
    expect(narrowed.error).toBe(full.error);
    expect(narrowed.details).toBe(full.details);
    expect(narrowed.code).toBe(full.code);
    expect(narrowed.exceptionRequestPath).toBe(full.exceptionRequestPath);
    expect(narrowed.exceptionReview.capacityMode).toBe("HOLD");
    expect(narrowed.violations[0].affectedNights).toEqual(
      violation.affectedNights,
    );
  });

  it("never mutates the frozen violation, so the officer's snapshot and its fingerprint are untouched", async () => {
    const violation = await ownerArmOnlyViolation();
    const fingerprintBefore = violationFingerprint(violation);

    buildPaidUpAdultRefusalBodyForOtherPartyMember(violation);

    expect(violation.requirements.repricedUnpaidMemberCount).toBe(0);
    expect(violationFingerprint(violation)).toBe(fingerprintBefore);
    expect(fingerprintBefore).toContain("repriced=0");
  });
});

// ---------------------------------------------------------------------------
// The proposed-party form, and the hosting bridge.
// ---------------------------------------------------------------------------

describe("evaluateProposedPaidUpAdultPresence (#2543 <-> #2365)", () => {
  it("reproduces the same refusal a booking path raised", async () => {
    // A member refused by a booking path re-submits the same party as an override
    // request; the request machinery re-evaluates server-side and must get the
    // SAME answer from the SAME rule, or the refusal names a door that is shut.
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid", nights: ["2026-07-04"] }],
      },
    );
    expect(violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(violation?.affectedNights).toEqual(["2026-07-04"]);
  });

  it("returns null when the party is compliant — nothing to review", async () => {
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT, PAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          { isMember: true, memberId: "adult-unpaid" },
          { isMember: true, memberId: "adult-paid" },
        ],
      }),
    ).resolves.toBeNull();
  });

  it("returns null outside NON_MEMBER_PRICING", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid" }],
      }),
    ).resolves.toBeNull();
  });

  it("reproduces an OWNER-triggered refusal, so that door opens too", async () => {
    // Without this the widened trigger would refuse a booking and then name a
    // workflow the member cannot enter: the request machinery re-evaluates
    // server-side, finds no violation on a party of non-members, and correctly
    // declines to create a request there is nothing to review.
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        bookingOwnerMemberId: "adult-unpaid",
        guests: [{ isMember: false, memberId: null, nights: ["2026-07-04"] }],
      },
    );

    expect(violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(violation?.capacityMode).toBe("HOLD");
    expect(violation?.affectedNights).toEqual(["2026-07-04"]);
  });

  it("finds nothing to review when the owner is financial", async () => {
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([PAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        bookingOwnerMemberId: "adult-paid",
        guests: [{ isMember: false, memberId: null }],
      }),
    ).resolves.toBeNull();
  });

  /** The season the requirement's membership-type read was keyed on. */
  function seasonAsked(): unknown {
    const call = mocks.resolveMembershipTypePoliciesForMembers.mock.calls[0] as
      | [unknown, { seasonYear?: number }]
      | undefined;
    return call?.[1]?.seasonYear;
  }

  it("derives the season from the check-in night when the caller supplies none", async () => {
    // Every product caller: a booking write behind a gated request that has
    // already seeded the process-level financial-year cache, so the derivation is
    // correct for them and this parameter changed nothing about their answer. The
    // fixture's check-in is 4 July 2026, season 2026 on the default 31-March
    // year-end.
    await evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT]), {
      lodgeId: "lodge-1",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: [{ isMember: true, memberId: "adult-unpaid" }],
    });
    expect(seasonAsked()).toBe(SEASON);
  });

  it("uses the lockout mode the caller read, without peeking for itself (#2376)", async () => {
    // Same seam, same reason: the peek reads through two functions that each turn a
    // database failure into "every optional module off", composing to NO_BLOCK. A
    // read-only evidence caller reads the mode STRICTLY and passes it, so a failed
    // read becomes evidence-unavailable rather than "nothing is blocking them".
    mocks.peekSubscriptionLockoutMode.mockRejectedValue(
      new Error("the evaluator must not peek"),
    );
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid", nights: ["2026-07-04"] }],
        mode: "NON_MEMBER_PRICING",
      },
    );
    expect(violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });

  it("uses the season the caller resolved, when it resolved one (#2376)", async () => {
    // THE SEAM AI DIAGNOSTICS NEEDS. A read-only evidence caller has no gated
    // request behind it, so nothing has seeded that cache: on a cold process it is
    // still the March default, and a club with any other financial year-end would
    // have this requirement read `MemberSubscription` for a season that is not the
    // one these nights fall in — reporting a paid-up member as unfinancial, or the
    // reverse. Such a caller resolves the year-end month from stored state,
    // refuses when it cannot, and passes the season here. 2029 is deliberately a
    // year no derivation from this fixture produces.
    await evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT]), {
      lodgeId: "lodge-1",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: [{ isMember: true, memberId: "adult-unpaid" }],
      seasonYear: 2029,
    });
    expect(seasonAsked()).toBe(2029);
  });
});

describe("loadUnpaidSubscriptionMemberIds — the hosting bridge (#2543 <-> #2364)", () => {
  it("names the unpaid members under NON_MEMBER_PRICING", async () => {
    const unpaid = await loadUnpaidSubscriptionMemberIds(
      makeDb([UNPAID_ADULT, PAID_ADULT, EXEMPT_CHILD]),
      {
        memberIds: ["adult-unpaid", "adult-paid", "child-exempt"],
        seasonYear: SEASON,
      },
    );
    expect([...unpaid]).toEqual(["adult-unpaid"]);
  });

  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "is empty under %s, so hosting stays byte-identical for a club that has not opted in",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const unpaid = await loadUnpaidSubscriptionMemberIds(
        makeDb([UNPAID_ADULT]),
        { memberIds: ["adult-unpaid"], seasonYear: SEASON },
      );
      expect(unpaid.size).toBe(0);
    },
  );

  it("is empty for an empty request, without reading the mode", async () => {
    const unpaid = await loadUnpaidSubscriptionMemberIds(makeDb([]), {
      memberIds: [null, undefined, "  "],
      seasonYear: SEASON,
    });
    expect(unpaid.size).toBe(0);
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Whose age-tier reader decides (#2376, AI Diagnostics).
// ---------------------------------------------------------------------------

describe("the age-tier reader seam (#2376)", () => {
  /**
   * THE RULE THIS SEAM PROTECTS, and why an optional parameter is the whole fix.
   *
   * `loadMemberSubscriptionSettlements` decides whether a member OWES a season
   * subscription, and for a `BASED_ON_AGE_TIER`/`REQUIRED` member the answer comes
   * from the club's per-tier `subscriptionRequiredForBooking` flag. It read that
   * flag through `getAgeTierSettings`, which serves a five-minute cache, dynamic-
   * imports the global Prisma client, and CATCHES every database error to return
   * `AGE_TIER_DEFAULTS`.
   *
   * For a booking write that is right: default tiers beat an error. For AI
   * Diagnostics it is a fabricated financial accusation — a club that exempts a tier
   * gets `policy_paid_up_adult_member` raised against a named member after one
   * transient failure, with a fresh observed-at beside it — and the read also sat
   * outside the evidence transaction's snapshot, statement timeout and `READ ONLY`.
   *
   * So the reader is a parameter. The assertions below are in both directions: the
   * writer path must be untouched, and the evidence path must actually decide the
   * answer and must propagate its own failure.
   */
  const cachedReader = () => vi.mocked(getAgeTierSettings);

  /** An evidence reader whose club exempts ADULT — the opposite of the default. */
  const adultExemptReader = vi.fn(async () => [
    { tier: "INFANT", subscriptionRequiredForBooking: false },
    { tier: "CHILD", subscriptionRequiredForBooking: false },
    { tier: "YOUTH", subscriptionRequiredForBooking: true },
    { tier: "ADULT", subscriptionRequiredForBooking: false },
  ]) as unknown as () => Promise<AgeTierSettingData[]>;

  it("uses the CACHED product reader when none is passed, and that answer is unchanged", async () => {
    const requirements = await evaluate([UNPAID_ADULT]);
    expect(requirements?.repricedMemberIds).toEqual(["adult-unpaid"]);
    expect(cachedReader()).toHaveBeenCalledTimes(1);
  });

  it("lets a supplied reader decide, and never touches the cached one", async () => {
    // The discriminating fixture: the same unpaid adult, judged against a club whose
    // ADULT tier owes nothing. If the loader had kept reading the cached settings the
    // member would still be repriced, and this assertion would fail on the value
    // rather than on a spy.
    const requirements = await evaluateNonMemberPricingRequirements(
      makeDb([UNPAID_ADULT]),
      {
        mode: "NON_MEMBER_PRICING",
        lodgeId: "lodge-1",
        seasonYear: SEASON,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        participants: participantsFor([UNPAID_ADULT]),
        readAgeTierSettings: adultExemptReader,
      },
    );
    expect(requirements?.repricedMemberIds).toEqual([]);
    expect(requirements?.violation ?? null).toBeNull();
    expect(cachedReader()).not.toHaveBeenCalled();
  });

  it("propagates a FAILED evidence read instead of falling back to the defaults", async () => {
    // The whole point of the strict reader: the caller reports
    // `evidence_unavailable` rather than a confident finding derived from the
    // platform's default tiers. The cached reader would have swallowed this.
    await expect(
      evaluateNonMemberPricingRequirements(makeDb([UNPAID_ADULT]), {
        mode: "NON_MEMBER_PRICING",
        lodgeId: "lodge-1",
        seasonYear: SEASON,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        participants: participantsFor([UNPAID_ADULT]),
        readAgeTierSettings: async () => {
          throw new Error("age tier settings unavailable");
        },
      }),
    ).rejects.toThrow("age tier settings unavailable");
    expect(cachedReader()).not.toHaveBeenCalled();
  });

  it("threads it through the PROPOSAL form, so the exception door judges the same rule", async () => {
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid" }],
        readAgeTierSettings: adultExemptReader,
      }),
    ).resolves.toBeNull();
    expect(cachedReader()).not.toHaveBeenCalled();
  });

  it("threads it through the HOSTING BRIDGE, which is the second reachable path", async () => {
    // `loadUnpaidSubscriptionMemberIds` reaches the same loader, so a fix that
    // covered only the paid-up-adult rule would still have let
    // `policy_adult_member_hosting` be raised from unobserved settings.
    const unpaid = await loadUnpaidSubscriptionMemberIds(makeDb([UNPAID_ADULT]), {
      memberIds: ["adult-unpaid"],
      seasonYear: SEASON,
      readAgeTierSettings: adultExemptReader,
    });
    expect([...unpaid]).toEqual([]);
    expect(cachedReader()).not.toHaveBeenCalled();
  });
});

describe("toSubscriptionLockoutParticipants", () => {
  /**
   * THE COLUMN NAME IS THE GUARD. This suite used to construct its rows with an
   * invented field, `memberGuestConsentStatus`, which exists nowhere in the schema
   * — the Prisma column is `BookingGuest.consentStatus`. Because the helper's
   * generic constraint made it optional, `BookingGuest[]` type-checked, every
   * persisted row read `undefined`, `isOperationallyPresentConsent(undefined)`
   * returned true, and the D-12 half of the paid-up-adult test never ran on a real
   * party — while this suite stayed green. So the fixtures below are shaped like
   * REAL rows, and the first case feeds a realistic persisted row rather than a
   * hand-made object with a convenient key.
   */
  it("treats a PENDING member-guest invite on a PERSISTED row as not operationally present", async () => {
    const persistedRows = [
      {
        id: "bg-1",
        bookingId: "bk-1",
        isMember: true,
        memberId: "adult-paid",
        firstName: "Ada",
        lastName: "Paid",
        ageTier: "ADULT" as const,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
        priceCents: 2000,
        consentStatus: "PENDING" as const,
      },
      {
        id: "bg-2",
        bookingId: "bk-1",
        isMember: true,
        memberId: "adult-paid-2",
        firstName: "Bo",
        lastName: "Paid",
        ageTier: "ADULT" as const,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
        priceCents: 2000,
        consentStatus: "CONFIRMED" as const,
      },
      {
        // A family-scope guest: consent-FREE, not consent-given. NULL means
        // present, exactly as #2364 has it.
        id: "bg-3",
        bookingId: "bk-1",
        isMember: true,
        memberId: "adult-paid-3",
        firstName: "Cy",
        lastName: "Paid",
        ageTier: "ADULT" as const,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
        priceCents: 2000,
        consentStatus: null,
      },
    ];

    const participants = toSubscriptionLockoutParticipants(persistedRows);

    expect(participants.map((p) => p.operationallyPresent)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("reads the PLANNED consent status of a pre-persist row (the create path)", async () => {
    // `guestInputs` on the create path is `consentPlan.guests`, so a cross-family
    // member guest already carries the PENDING columns the write is about to make.
    // Without this the requirement was trivially satisfiable: name any paid-up
    // adult member from beyond your family, and the invite need never be accepted.
    const participants = toSubscriptionLockoutParticipants([
      {
        isMember: true,
        memberId: "adult-cross-family",
        memberGuestConsent: { consentStatus: "PENDING" as const },
      },
      {
        isMember: true,
        memberId: "adult-notify-only",
        memberGuestConsent: { consentStatus: "CONFIRMED" as const },
      },
      // Family scope: nothing attached at all.
      { isMember: true, memberId: "adult-family" },
    ]);

    expect(participants.map((p) => p.operationallyPresent)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("carries per-guest nights through, so a refusal names the right lodge nights", async () => {
    const participants = toSubscriptionLockoutParticipants([
      {
        isMember: true,
        memberId: "adult-paid",
        nights: [{ stayDate: new Date("2026-08-02T00:00:00.000Z") }],
      },
    ]);
    expect(participants[0].nights).toEqual([
      { stayDate: new Date("2026-08-02T00:00:00.000Z") },
    ]);
  });
});

describe("the proposed-party evaluator honours D-12 presence (#2543)", () => {
  /**
   * THIS IS THE OVERRIDE DOOR. A booking path refuses a party because its only
   * paid-up adult member is a cross-family member guest whose invite is still
   * PENDING. The member submits the SAME party to the exception-request machinery.
   * If this evaluator counts that PENDING adult as present it finds no violation,
   * the machinery refuses to create a request there is nothing to review, and the
   * 409's promised door leads nowhere.
   */
  beforeEach(() => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
  });

  const party = [
    { isMember: true, memberId: UNPAID_ADULT.id, nights: ["2026-07-04"] },
    { isMember: true, memberId: PAID_ADULT.id, nights: ["2026-07-04"] },
  ];

  it("reproduces the violation when the only paid-up adult is not yet present", async () => {
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT, PAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: party.map((guest) =>
          guest.memberId === PAID_ADULT.id
            ? { ...guest, operationallyPresent: false }
            : guest,
        ),
      },
    );

    expect(violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    // HOLD, so asking for the override does not cost the member their beds.
    expect(violation?.capacityMode).toBe("HOLD");
  });

  it("finds nothing to review when that adult IS present", async () => {
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT, PAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: party.map((guest) =>
          guest.memberId === PAID_ADULT.id
            ? { ...guest, operationallyPresent: true }
            : guest,
        ),
      },
    );

    expect(violation).toBeNull();
  });

  it("absent means present, so a caller supplying nothing is unchanged", async () => {
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT, PAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: party,
      },
    );

    expect(violation).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  participantIsNonMemberGuest,
  participantQualifiesAsHost,
  type HostingMemberFacts,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";
import {
  PAID_UP_ADULT_MEMBER_CAPACITY_MODE,
  PAID_UP_ADULT_MEMBER_POLICY_ID,
  PAID_UP_ADULT_MEMBER_POLICY_VERSION,
  buildPaidUpAdultMemberViolation,
  evaluatePaidUpAdultPresence,
  formatMissingPaidUpAdultRefusal,
  formatMissingPaidUpAdultWaitlistRefusal,
  formatUnpaidSubscriptionRateReason,
  memberUnpaidSubscriptionForcesNonMemberRate,
  participantIsPaidUpAdultMember,
  type PaidUpAdultParticipant,
} from "@/lib/policies/subscription-lockout-pricing";

const goodStandingAdult: HostingMemberFacts = {
  id: "m-adult",
  ageTier: "ADULT",
  active: true,
  cancelledAt: null,
  archivedAt: null,
};

const goodStandingChild: HostingMemberFacts = {
  ...goodStandingAdult,
  id: "m-child",
  ageTier: "CHILD",
};

const lapsedAdult: HostingMemberFacts = {
  ...goodStandingAdult,
  id: "m-lapsed",
  active: false,
};

function paidUpAdult(
  overrides: Partial<PaidUpAdultParticipant> = {},
): PaidUpAdultParticipant {
  return {
    member: goodStandingAdult,
    subscriptionSettled: true,
    ...overrides,
  };
}

describe("memberUnpaidSubscriptionForcesNonMemberRate (#2533 requirement 1)", () => {
  it("forces non-member rate for a member who owes an unpaid subscription", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: true,
        subscriptionPaid: false,
      }),
    ).toBe(true);
  });

  // Mutation guard: dropping the `subscriptionPaid === false` clause would force
  // non-member rates on a paid-up member — the club billing a paid member at the
  // wrong rate.
  it("does NOT force non-member rate once the subscription is paid", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: true,
        subscriptionPaid: true,
      }),
    ).toBe(false);
  });

  // Mutation guard: dropping the `subscriptionRequired === true` clause would
  // force non-member rates on a member the lockout never applied to (Xero off,
  // an opted-out membership type, or an exempt age tier).
  it("does NOT force non-member rate when a subscription is not required", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: false,
        subscriptionPaid: false,
      }),
    ).toBe(false);
  });

  // Mutation guard: dropping the `isMember === true` clause would have the rule
  // claim to "force" a non-member — who is already non-member-priced — muddying
  // the reason surfaced to them.
  it("does NOT apply to a true non-member", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: false,
        subscriptionRequired: true,
        subscriptionPaid: false,
      }),
    ).toBe(false);
  });
});

describe("participantIsPaidUpAdultMember (#2533 requirement 3)", () => {
  it("counts an active, present, paid-up ADULT member", () => {
    expect(participantIsPaidUpAdultMember(paidUpAdult())).toBe(true);
  });

  // Mutation guard: dropping the `subscriptionSettled === true` clause would let
  // an unpaid adult satisfy the "paid-up adult present" requirement — exactly the
  // hole the owner's rule closes.
  it("does NOT count an adult member whose subscription is unpaid", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ subscriptionSettled: false })),
    ).toBe(false);
  });

  // Mutation guard: the #2364 standing half must still bind. A lapsed adult with
  // a paid subscription is not a member in good standing and cannot count.
  it("does NOT count a lapsed adult even with a settled subscription", () => {
    expect(
      participantIsPaidUpAdultMember(
        paidUpAdult({ member: lapsedAdult, subscriptionSettled: true }),
      ),
    ).toBe(false);
  });

  it("does NOT count a paid-up CHILD member (not an adult)", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ member: goodStandingChild })),
    ).toBe(false);
  });

  it("does NOT count an adult who is not operationally present (D-12)", () => {
    expect(
      participantIsPaidUpAdultMember(
        paidUpAdult({ operationallyPresent: false }),
      ),
    ).toBe(false);
  });

  it("does NOT count a non-member participant", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ member: null })),
    ).toBe(false);
  });
});

describe("evaluatePaidUpAdultPresence (#2533 requirement 3)", () => {
  it("passes when at least one paid-up adult is present alongside others", () => {
    const result = evaluatePaidUpAdultPresence([
      { member: null, subscriptionSettled: false },
      paidUpAdult({ member: goodStandingChild }),
      paidUpAdult(),
    ]);
    expect(result.hasPaidUpAdult).toBe(true);
    expect(result.refusalReason).toBeNull();
  });

  it("refuses a booking with no paid-up adult member and gives the reason", () => {
    const result = evaluatePaidUpAdultPresence([
      paidUpAdult({ subscriptionSettled: false }),
      paidUpAdult({ member: goodStandingChild }),
      { member: null, subscriptionSettled: true },
    ]);
    expect(result.hasPaidUpAdult).toBe(false);
    expect(result.refusalReason).toBe(formatMissingPaidUpAdultRefusal());
  });

  // Mutation guard: an empty party has no paid-up adult, so it must refuse rather
  // than vacuously pass.
  it("refuses an empty party", () => {
    const result = evaluatePaidUpAdultPresence([]);
    expect(result.hasPaidUpAdult).toBe(false);
    expect(result.refusalReason).not.toBeNull();
  });
});

describe("member-facing reasons (#2533 requirement 2)", () => {
  it("names the season and never promises a booking in the rate reason", () => {
    const reason = formatUnpaidSubscriptionRateReason("2026/2027");
    expect(reason).toContain("2026/2027");
    expect(reason).toMatch(/member rates aren't available/i);
    expect(reason).toMatch(/renew/i);
  });

  it("is PARTY-scoped, not second-person, so it cannot misinform the reader", () => {
    // The notice is emitted whenever ANYONE on the party is repriced, and it renders
    // to whoever is reading the quote — very often not that person. A paid-up adult
    // member booking for their adult son, whose subscription is unpaid, was told
    // "Your 2026/2027 membership subscription isn't paid" about an account in perfect
    // standing. The plausible response is to pay a subscription they do not owe, or
    // to ring the club about a debt that is not theirs.
    //
    // "Names nobody" and "asserts it is the reader" are different things. The privacy
    // constraint still holds — no name, no amount — but the sentence is now about the
    // booking.
    const reason = formatUnpaidSubscriptionRateReason("2026/2027");
    expect(reason).toMatch(/on this booking/i);
    expect(reason).not.toMatch(/\byour\b/i);
    expect(reason).not.toMatch(/\bto you\b/i);
    expect(reason).not.toMatch(/\$/);
  });

  it("names neither a person nor an amount in the paid-up-adult refusal", () => {
    const reason = formatMissingPaidUpAdultRefusal();
    expect(reason).toMatch(/at least one paid-up adult member/i);
    expect(reason).not.toMatch(/\$/);
  });

  it("adds the kept-your-place reassurance for the waitlist paths, and only there", () => {
    // The two waitlist paths reject the offer WITHOUT consuming it, so answering
    // "confirm my offer" with the bare sentence read as though the member had lost
    // the offer AND their spot. They lost neither — both paths revert the entry to
    // WAITLISTED and keeps its `createdAt` (#5402) — so the sentence is
    // literally true rather than reassuring padding.
    const waitlist = formatMissingPaidUpAdultWaitlistRefusal();

    // A strict extension of the shared sentence: the booking-time refusal is not
    // re-worded, so the two cannot describe the same rule differently.
    expect(waitlist.startsWith(formatMissingPaidUpAdultRefusal())).toBe(true);
    expect(waitlist).toContain("You've kept your place on the waitlist.");
    // Same discretion as the sentence it extends.
    expect(waitlist).not.toMatch(/\$/);
    // The booking-time refusal has no waitlist place, and must not claim one.
    expect(formatMissingPaidUpAdultRefusal()).not.toMatch(/waitlist/i);
  });
});

// ---------------------------------------------------------------------------
// #2543 — the hosting bridge, and the exception-eligible refusal.
// ---------------------------------------------------------------------------

describe("participantQualifiesAsHost + subscriptionSettled (#2543 owner decision 3)", () => {
  it("an adult member the club is repricing stops counting as a host", () => {
    expect(
      participantQualifiesAsHost({
        member: goodStandingAdult,
        subscriptionSettled: false,
      }),
    ).toBe(false);
  });

  it("ABSENT means settled, so every pre-#2543 caller keeps its answer", () => {
    // Load-bearing default: under NO_BLOCK and HARD_BLOCK the booking-side loader
    // never populates the field, so a club that has not opted in must get exactly
    // the hosting answer it got before #2543.
    expect(participantQualifiesAsHost({ member: goodStandingAdult })).toBe(true);
    expect(
      participantQualifiesAsHost({
        member: goodStandingAdult,
        subscriptionSettled: true,
      }),
    ).toBe(true);
  });

  it("does NOT turn the repriced member into a guest who needs hosting", () => {
    // Deliberately asymmetric (see the field's doc comment). An unpaid
    // subscription is a membership in good standing with a bill outstanding, so
    // their own nights are not suddenly uncovered guest-nights needing admin
    // review; only the paid-up-adult requirement covers the party.
    //
    // Built as a full participant (as the real booking-side loader hands over)
    // rather than an inline literal, because the predicate's parameter type is
    // deliberately narrowed to `Pick<..., "member">` — it cannot even see the
    // field, which is the guarantee under test.
    const repriced: HostingParticipant = {
      guestRef: "g-1",
      guestName: "Alex Member",
      member: goodStandingAdult,
      subscriptionSettled: false,
      nights: ["2026-07-04"],
    };
    expect(participantIsNonMemberGuest(repriced)).toBe(false);
    // Contrast: a LAPSED member is a guest needing hosting, as #2364 already had it.
    expect(participantIsNonMemberGuest({ member: lapsedAdult })).toBe(true);
  });
});

describe("buildPaidUpAdultMemberViolation (#2543 + #2363)", () => {
  const violation = buildPaidUpAdultMemberViolation({
    affectedNights: ["2026-07-04", "2026-07-05"],
    effectiveLodgeId: "lodge-1",
    repricedUnpaidMemberCount: 1,
    participantCount: 3,
  });

  it("is club-wide, exception-eligible, and HOLDs the bed while pending", () => {
    expect(violation).toMatchObject({
      reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED",
      policyId: PAID_UP_ADULT_MEMBER_POLICY_ID,
      policyVersion: PAID_UP_ADULT_MEMBER_POLICY_VERSION,
      exceptionEligible: true,
      // Owner decision 4: a pending override holds the bed, so approval is
      // meaningful rather than a race the member has already lost.
      capacityMode: "HOLD",
      resolvedScope: {
        kind: "CLUB_WIDE",
        lodgeId: null,
        effectiveLodgeId: "lodge-1",
      },
    });
    expect(PAID_UP_ADULT_MEMBER_CAPACITY_MODE).toBe("HOLD");
  });

  it("carries counts and NO identities", () => {
    // Every field here is rendered back to the refused member, so naming who is
    // unpaid would turn a booking refusal into a financial-status oracle — the
    // disclosure the D-8 cross-family collapse closed on the member-guest paths.
    expect(violation.requirements).toEqual({
      kind: "PAID_UP_ADULT_MEMBER",
      requiredPaidUpAdultMembers: 1,
      repricedUnpaidMemberCount: 1,
      participantCount: 3,
    });
    expect(JSON.stringify(violation)).not.toMatch(/m-adult|m-child|m-lapsed/);
  });

  it("is pure: the same party twice is byte-identical (freezable, hashable)", () => {
    const again = buildPaidUpAdultMemberViolation({
      affectedNights: ["2026-07-04", "2026-07-05"],
      effectiveLodgeId: "lodge-1",
      repricedUnpaidMemberCount: 1,
      participantCount: 3,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(violation));
  });

  it("copies affectedNights rather than aliasing the caller's array", () => {
    const nights = ["2026-07-04"];
    const built = buildPaidUpAdultMemberViolation({
      affectedNights: nights,
      effectiveLodgeId: "lodge-1",
      repricedUnpaidMemberCount: 1,
      participantCount: 1,
    });
    nights.push("2026-12-25");
    expect(built.affectedNights).toEqual(["2026-07-04"]);
  });
});

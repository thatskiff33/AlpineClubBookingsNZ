import { describe, expect, it } from "vitest";

import {
  EXCEPTION_ELIGIBLE_REFUSAL_CODES,
  newBookingExceptionOmittedChanges,
  newBookingExceptionOmitsPricedChoice,
  readExceptionOffer,
  type NewBookingExceptionExtras,
} from "@/lib/booking-exception-offer";
import {
  HARD_STOP_BOOKING_FAILURE_CODES,
  POLICY_EXCEPTION_REASON_CODES,
  aggregatePolicyExceptionViolations,
  type MinimumStayPolicyExceptionViolation,
  type PaidUpAdultMemberPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import { buildPaidUpAdultRefusalBody } from "@/lib/subscription-lockout-enforcement";

/**
 * #2562 — the ONE rule that decides whether a member-facing refusal may offer to
 * ask a Booking Officer.
 *
 * The owner's decision is that the action appears ONLY where the server confirms
 * every blocking failure is exception-eligible, and never for a hard failure. So
 * these tests are mostly about what the rule REFUSES: each gate is exercised on
 * its own, and the two real refusal bodies the shipped paths return are fed in
 * verbatim rather than hand-approximated.
 */

const MIN_STAY_VIOLATION: MinimumStayPolicyExceptionViolation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-1",
  policyVersion: 3,
  policyName: "Winter minimum stay",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-07-03"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Friday nights need a two-night booking.",
  triggerDay: "FRIDAY",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [5],
  },
};

const PAID_UP_VIOLATION: PaidUpAdultMemberPolicyExceptionViolation = {
  reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED",
  policyId: "subscription-lockout",
  policyVersion: 1,
  policyName: "Paid-up adult member required",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-07-03", "2026-07-04"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "There has to be a paid-up adult member on the booking.",
  requirements: {
    kind: "PAID_UP_ADULT_MEMBER",
    requiredPaidUpAdultMembers: 1,
    repricedUnpaidMemberCount: 1,
    participantCount: 3,
  },
};

/** The exact body `/api/bookings` returns for a minimum-stay refusal. */
function minimumStayRefusalBody() {
  const exceptionReview = aggregatePolicyExceptionViolations([MIN_STAY_VIOLATION]);
  return {
    error: "Booking does not meet minimum stay requirement",
    details: MIN_STAY_VIOLATION.message,
    code: "MINIMUM_STAY_VIOLATION",
    violations: exceptionReview.violations,
    exceptionReview,
  };
}

describe("readExceptionOffer — what it accepts", () => {
  it("accepts the shipped minimum-stay refusal body and carries its violations verbatim", () => {
    const offer = readExceptionOffer(minimumStayRefusalBody());
    expect(offer).not.toBeNull();
    expect(offer?.code).toBe("MINIMUM_STAY_VIOLATION");
    expect(offer?.message).toBe("Booking does not meet minimum stay requirement");
    expect(offer?.capacityMode).toBe("HOLD");
    expect(offer?.violations).toEqual([
      {
        reasonCode: "MINIMUM_STAY",
        message: "Friday nights need a two-night booking.",
        affectedNights: ["2026-07-03"],
        capacityMode: "HOLD",
      },
    ]);
  });

  it("accepts the shipped paid-up-adult refusal body, from the shared builder itself", () => {
    // Fed from `buildPaidUpAdultRefusalBody` rather than a copy of its shape, so a
    // change to that body fails HERE rather than silently closing the door.
    const offer = readExceptionOffer(buildPaidUpAdultRefusalBody(PAID_UP_VIOLATION));
    expect(offer?.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(offer?.violations).toHaveLength(1);
    expect(offer?.violations[0].reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
  });

  it("accepts the narrowed paid-up body too — withholding one count does not close the door", () => {
    // The other-party-member form withholds `repricedUnpaidMemberCount`. That is a
    // disclosure narrowing, not an eligibility change, and the offer must survive
    // it: the person is still refused and still entitled to ask.
    const body = buildPaidUpAdultRefusalBody(PAID_UP_VIOLATION);
    const narrowed = {
      ...body,
      violations: body.violations.map((violation) => ({
        ...violation,
        requirements: {
          kind: "PAID_UP_ADULT_MEMBER",
          requiredPaidUpAdultMembers: 1,
          participantCount: 3,
        },
      })),
      exceptionReview: {
        ...body.exceptionReview,
        violations: body.exceptionReview.violations.map((violation) => ({
          ...violation,
          requirements: {
            kind: "PAID_UP_ADULT_MEMBER",
            requiredPaidUpAdultMembers: 1,
            participantCount: 3,
          },
        })),
      },
    };
    expect(readExceptionOffer(narrowed)).not.toBeNull();
  });

  it("carries EVERY covered violation, so several failures are explained at once", () => {
    const exceptionReview = aggregatePolicyExceptionViolations([
      MIN_STAY_VIOLATION,
      PAID_UP_VIOLATION,
    ]);
    const offer = readExceptionOffer({
      error: "Refused",
      code: "MINIMUM_STAY_VIOLATION",
      exceptionReview,
    });
    expect(offer?.violations.map((violation) => violation.reasonCode)).toEqual([
      "MINIMUM_STAY",
      "PAID_UP_ADULT_MEMBER_REQUIRED",
    ]);
  });

  it("falls back to the first violation's own sentence when the body has no error string", () => {
    const offer = readExceptionOffer({
      code: "MINIMUM_STAY_VIOLATION",
      exceptionReview: aggregatePolicyExceptionViolations([MIN_STAY_VIOLATION]),
    });
    expect(offer?.message).toBe("Friday nights need a two-night booking.");
  });
});

describe("readExceptionOffer — what it refuses", () => {
  it("refuses every hard-stop failure code, even carrying a full exceptionReview", () => {
    // The pathological case: a body that has somehow acquired a valid frozen
    // review while reporting a hard stop. The code gate refuses it regardless.
    for (const code of HARD_STOP_BOOKING_FAILURE_CODES) {
      expect(
        readExceptionOffer({
          error: "Refused",
          code,
          exceptionReview: aggregatePolicyExceptionViolations([MIN_STAY_VIOLATION]),
        }),
      ).toBeNull();
    }
  });

  it("refuses the admin-only adult-member hosting confirmation 409", () => {
    // That refusal goes to an ADMIN booking on somebody's behalf and asks them for
    // a reason to record. The person refused is the person who would approve a
    // request, so offering them one would be a loop, not a remedy.
    expect(
      readExceptionOffer({
        error: "Give a reason to record with the booking.",
        code: "ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED",
        exceptionReview: aggregatePolicyExceptionViolations([MIN_STAY_VIOLATION]),
      }),
    ).toBeNull();
  });

  it("refuses a body with no code at all", () => {
    expect(
      readExceptionOffer({
        error: "Something went wrong",
        exceptionReview: aggregatePolicyExceptionViolations([MIN_STAY_VIOLATION]),
      }),
    ).toBeNull();
  });

  it("refuses an eligible code with no exceptionReview, and with an empty one", () => {
    expect(readExceptionOffer({ code: "MINIMUM_STAY_VIOLATION" })).toBeNull();
    expect(
      readExceptionOffer({
        code: "MINIMUM_STAY_VIOLATION",
        exceptionReview: { violations: [], capacityMode: null },
      }),
    ).toBeNull();
  });

  it("refuses when ONE violation in the list is not recognisably eligible", () => {
    // A partial override is not a thing the workflow can do, so a single
    // unrecognised entry disqualifies the whole refusal.
    const offer = readExceptionOffer({
      code: "MINIMUM_STAY_VIOLATION",
      exceptionReview: {
        capacityMode: "HOLD",
        violations: [
          MIN_STAY_VIOLATION,
          { reasonCode: "CAPACITY_EXCEEDED", message: "Full", capacityMode: "HOLD" },
        ],
      },
    });
    expect(offer).toBeNull();
  });

  it("refuses a violation missing the server's own exceptionEligible flag", () => {
    const { exceptionEligible, ...withoutFlag } = MIN_STAY_VIOLATION;
    expect(exceptionEligible).toBe(true);
    expect(
      readExceptionOffer({
        code: "MINIMUM_STAY_VIOLATION",
        exceptionReview: { capacityMode: "HOLD", violations: [withoutFlag] },
      }),
    ).toBeNull();
  });

  it("refuses a violation whose exceptionEligible is merely truthy, not true", () => {
    expect(
      readExceptionOffer({
        code: "MINIMUM_STAY_VIOLATION",
        exceptionReview: {
          capacityMode: "HOLD",
          violations: [{ ...MIN_STAY_VIOLATION, exceptionEligible: "yes" }],
        },
      }),
    ).toBeNull();
  });

  it("refuses an unknown capacity mode, on the violation and on the aggregate", () => {
    expect(
      readExceptionOffer({
        code: "MINIMUM_STAY_VIOLATION",
        exceptionReview: {
          capacityMode: "HOLD",
          violations: [{ ...MIN_STAY_VIOLATION, capacityMode: "MAYBE" }],
        },
      }),
    ).toBeNull();
    expect(
      readExceptionOffer({
        code: "MINIMUM_STAY_VIOLATION",
        exceptionReview: { capacityMode: null, violations: [MIN_STAY_VIOLATION] },
      }),
    ).toBeNull();
  });

  it("refuses non-objects, arrays and empty input", () => {
    for (const input of [null, undefined, "", 0, "MINIMUM_STAY_VIOLATION", []]) {
      expect(readExceptionOffer(input)).toBeNull();
    }
  });
});

describe("the allowlist itself", () => {
  it("contains no hard-stop failure code", () => {
    for (const code of EXCEPTION_ELIGIBLE_REFUSAL_CODES) {
      expect(HARD_STOP_BOOKING_FAILURE_CODES as readonly string[]).not.toContain(
        code,
      );
    }
  });

  it("is a closed list, so adding a refusal code is a deliberate act", () => {
    // Pinned by value. A new member-facing refusal that should open the door has to
    // change this expectation, which is where somebody has to think about whether
    // the refusal is really overridable.
    expect([...EXCEPTION_ELIGIBLE_REFUSAL_CODES]).toEqual([
      "MINIMUM_STAY_VIOLATION",
      "PAID_UP_ADULT_MEMBER_REQUIRED",
    ]);
  });

  it("every soft reason code the allowlist can carry is a #2363 allowlisted code", () => {
    // The reason codes and the refusal codes are different vocabularies; this pins
    // that the offer only ever reports codes from the soft-policy allowlist.
    const offer = readExceptionOffer(minimumStayRefusalBody());
    for (const violation of offer?.violations ?? []) {
      expect(POLICY_EXCEPTION_REASON_CODES as readonly string[]).toContain(
        violation.reasonCode,
      );
    }
  });
});


/**
 * #2562 review — what a NEW-booking exception request cannot carry.
 *
 * The wizard used to tell the card there was nothing to disclose here, on the
 * grounds that "a new booking's whole intent IS the party and the nights". That is
 * true of the PROPOSAL and false of the member's screen: the create call also sends
 * a promo, a credit election, a room request, a note and a payment
 * choice (an arrival time too, until #2621 retired that entry),
 * `POST /api/bookings/exception-requests` accepts none of them, and
 * `executeApprovedNewBooking` calls the canonical create with none of them. So a
 * working-bee attendee whose free night is expressed as a promo saw the discounted
 * figure with no notice and the approved booking billed the full rate.
 */
describe("new-booking exception omissions", () => {
  function extras(
    overrides: Partial<NewBookingExceptionExtras> = {},
  ): NewBookingExceptionExtras {
    return {
      promoCode: null,
      workPartyEventId: null,
      workPartyDiscountApplied: false,
      appliedCreditCents: 0,
      requestedRoomId: null,
      notes: null,
      internetBankingChosen: false,
      cancelIfGuestsBumped: false,
      groupTrip: false,
      ...overrides,
    };
  }

  it("discloses nothing when the member chose nothing beyond the party and the nights", () => {
    expect(newBookingExceptionOmittedChanges(extras())).toEqual([]);
    expect(newBookingExceptionOmitsPricedChoice(extras())).toBe(false);
  });

  it("names the promo and treats it as price-affecting", () => {
    const applied = extras({ promoCode: "WINTER20" });
    expect(newBookingExceptionOmittedChanges(applied)).toContain("the promo code");
    expect(newBookingExceptionOmitsPricedChoice(applied)).toBe(true);
  });

  it("catches a working-bee discount that carries no member-visible code", () => {
    // The failure this pins: a work-party discount arrives as an applied promo with
    // `code: null` (the internal code never reaches the client), so a check on the
    // code alone missed the free night entirely.
    const workParty = extras({ workPartyDiscountApplied: true });
    expect(newBookingExceptionOmittedChanges(workParty)).toContain(
      "the working bee discount",
    );
    expect(newBookingExceptionOmitsPricedChoice(workParty)).toBe(true);
  });

  it("names account credit as both omitted and price-affecting", () => {
    const credit = extras({ appliedCreditCents: 4800 });
    expect(newBookingExceptionOmittedChanges(credit)).toContain(
      "using account credit",
    );
    expect(newBookingExceptionOmitsPricedChoice(credit)).toBe(true);
  });

  it("names the choices that do not move the price without relabelling the figure", () => {
    const soft = extras({
      requestedRoomId: "room-2",
      notes: "Arriving after dark.",
      internetBankingChosen: true,
      cancelIfGuestsBumped: true,
      groupTrip: true,
    });
    const omitted = newBookingExceptionOmittedChanges(soft);
    expect(omitted).toEqual([
      "the room you asked for",
      "your note to the club",
      "paying by internet banking",
      'the "only book if my guests can come" choice',
      "opening this as a group trip",
    ]);
    // None of these changes what the club would charge, so the price label stays
    // the plain one.
    expect(newBookingExceptionOmitsPricedChoice(soft)).toBe(false);
  });
});

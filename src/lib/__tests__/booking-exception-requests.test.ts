import { describe, expect, it } from "vitest";

import type {
  AdultMemberHostingPolicyExceptionViolation,
  MinimumStayPolicyExceptionViolation,
  PolicyExceptionCapacityMode,
} from "@/lib/booking-policy-exceptions";
import {
  canonicalizeProposalParty,
  classifyPolicyExceptionDrift,
  computeProposalHash,
  computeProposalReservation,
  freezePolicyExceptionEvidence,
  isPolicyExceptionTransitionAllowed,
  isTerminalReleasingStatus,
  normalizeMemberMessage,
  parseFrozenEvidence,
  perNightBedDemand,
  PolicyExceptionMemberMessageError,
  reviewedViolationsFromEvidence,
  violationFingerprint,
  type ExceptionProposalSnapshot,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";
import { MEMBER_MESSAGE_MAX_LENGTH } from "@/lib/booking-exception-request-shared";

// --- builders -------------------------------------------------------------

function guest(overrides: Partial<ProposalGuest> = {}): ProposalGuest {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    nights: ["2026-07-04", "2026-07-05"],
    ...overrides,
  };
}

function minimumStayViolation(
  overrides: Partial<MinimumStayPolicyExceptionViolation> = {},
): MinimumStayPolicyExceptionViolation {
  return {
    reasonCode: "MINIMUM_STAY",
    policyId: "pol_min",
    policyVersion: 1,
    policyName: "Weekend minimum",
    resolvedScope: {
      kind: "CLUB_WIDE",
      lodgeId: null,
      effectiveLodgeId: "lodge_1",
    },
    affectedNights: ["2026-07-04"],
    exceptionEligible: true,
    capacityMode: "HOLD",
    message: "min stay",
    triggerDay: "Saturday",
    minimumNights: 2,
    actualNights: 1,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights: 2,
      actualNights: 1,
      triggerDays: [6],
    },
    ...overrides,
  };
}

function hostingViolation(
  overrides: Partial<AdultMemberHostingPolicyExceptionViolation> = {},
): AdultMemberHostingPolicyExceptionViolation {
  return {
    reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
    policyId: "pol_host",
    policyVersion: 3,
    policyName: "Adult member hosting requirement",
    resolvedScope: {
      kind: "LODGE",
      lodgeId: "lodge_1",
      effectiveLodgeId: "lodge_1",
    },
    affectedNights: ["2026-07-04"],
    exceptionEligible: true,
    capacityMode: "NO_HOLD",
    message: "hosting",
    requirements: {
      kind: "ADULT_MEMBER_HOSTING",
      requiredAdultMemberParticipantsPerGuestNight: 1,
      uncoveredNonMemberGuestNights: 1,
      uncovered: [
        { guestRef: "guest:0", guestName: "Ada Lovelace", night: "2026-07-04" },
      ],
      qualifyingHostsByNight: [{ night: "2026-07-04", memberIds: [] }],
    },
    ...overrides,
  };
}

function party(guests: ProposalGuest[]): ProposalParty {
  const nights = guests.flatMap((g) => g.nights).sort();
  return { checkIn: nights[0] ?? "2026-07-04", checkOut: "2026-07-06", guests };
}

// --- member message -------------------------------------------------------

describe("normalizeMemberMessage", () => {
  it("trims a valid message", () => {
    expect(normalizeMemberMessage("  please allow this  ")).toBe(
      "please allow this",
    );
  });

  it("MUTATION: refuses an empty-after-trim message", () => {
    expect(() => normalizeMemberMessage("   ")).toThrowError(
      PolicyExceptionMemberMessageError,
    );
    expect(() => normalizeMemberMessage("")).toThrowError(
      PolicyExceptionMemberMessageError,
    );
    expect(() => normalizeMemberMessage(null)).toThrowError(
      PolicyExceptionMemberMessageError,
    );
  });

  it("MUTATION: refuses a message longer than the 1000-char cap", () => {
    const tooLong = "a".repeat(MEMBER_MESSAGE_MAX_LENGTH + 1);
    expect(() => normalizeMemberMessage(tooLong)).toThrowError(
      PolicyExceptionMemberMessageError,
    );
    expect(normalizeMemberMessage("a".repeat(MEMBER_MESSAGE_MAX_LENGTH))).toHaveLength(
      MEMBER_MESSAGE_MAX_LENGTH,
    );
  });
});

// --- proposal hash --------------------------------------------------------

describe("computeProposalHash", () => {
  const snapshot: ExceptionProposalSnapshot = {
    kind: "NEW_BOOKING",
    lodgeId: "lodge_1",
    proposed: party([
      guest({ firstName: "Ada", lastName: "Lovelace" }),
      guest({ firstName: "Alan", lastName: "Turing", nights: ["2026-07-05"] }),
    ]),
  };

  it("is a 64-char lowercase hex digest", () => {
    expect(computeProposalHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PINS the digest for a fixed snapshot, because a stored proposalHash must still validate after any refactor (#3030)", () => {
    // Every other test here recomputes the hash on both sides, so all of them
    // would pass if the canonicalisation itself changed - and a changed
    // canonicalisation silently invalidates every BookingExceptionRequest row
    // already on file, whose stored proposalHash approval re-derives and
    // compares. #3030 moved `stableStringify` out to `@/lib/stable-json` for a
    // second hasher to share; the move was byte-identical, and this pin is what
    // makes the NEXT such change fail loudly instead of quietly.
    expect(computeProposalHash(snapshot)).toBe(
      "b3f4e6183c223af0703c0e080edfcba14695455f0630d7beda613a393d478ff2",
    );
  });

  it("MUTATION: is order-independent (guest input order does not change the hash)", () => {
    const reordered: ExceptionProposalSnapshot = {
      kind: "NEW_BOOKING",
      lodgeId: "lodge_1",
      proposed: party([
        guest({ firstName: "Alan", lastName: "Turing", nights: ["2026-07-05"] }),
        guest({ firstName: "Ada", lastName: "Lovelace" }),
      ]),
    };
    expect(computeProposalHash(reordered)).toBe(computeProposalHash(snapshot));
  });

  it("MUTATION: changes when any night changes", () => {
    const moved: ExceptionProposalSnapshot = {
      kind: "NEW_BOOKING",
      lodgeId: "lodge_1",
      proposed: party([
        guest({ nights: ["2026-07-04", "2026-07-06"] }),
        guest({ firstName: "Alan", lastName: "Turing", nights: ["2026-07-05"] }),
      ]),
    };
    expect(computeProposalHash(moved)).not.toBe(computeProposalHash(snapshot));
  });

  it("MUTATION: a modification hash changes when the live base drifts", () => {
    const base = party([guest({ nights: ["2026-07-04"] })]);
    const proposed = party([guest({ nights: ["2026-07-04", "2026-07-05"] })]);
    const original: ExceptionProposalSnapshot = {
      kind: "MODIFICATION",
      lodgeId: "lodge_1",
      bookingId: "bk_1",
      base,
      proposed,
    };
    const drifted: ExceptionProposalSnapshot = {
      kind: "MODIFICATION",
      lodgeId: "lodge_1",
      bookingId: "bk_1",
      base: party([guest({ nights: ["2026-07-04", "2026-07-05"] })]),
      proposed,
    };
    expect(computeProposalHash(drifted)).not.toBe(computeProposalHash(original));
  });
});

describe("canonicalizeProposalParty", () => {
  it("sorts and de-duplicates guest nights", () => {
    const canonical = canonicalizeProposalParty(
      party([guest({ nights: ["2026-07-05", "2026-07-04", "2026-07-04"] })]),
    );
    expect(canonical.guests[0].nights).toEqual(["2026-07-04", "2026-07-05"]);
  });
});

// --- reservation math -----------------------------------------------------

describe("computeProposalReservation", () => {
  it("reserves the full proposal for a new booking", () => {
    const snapshot: ExceptionProposalSnapshot = {
      kind: "NEW_BOOKING",
      lodgeId: "lodge_1",
      proposed: party([
        guest({ nights: ["2026-07-04", "2026-07-05"] }),
        guest({ firstName: "B", lastName: "B", nights: ["2026-07-04"] }),
      ]),
    };
    expect(computeProposalReservation(snapshot)).toEqual([
      { night: "2026-07-04", beds: 2 },
      { night: "2026-07-05", beds: 1 },
    ]);
  });

  it("MUTATION: a modification reserves ONLY the incremental per-night beds", () => {
    // Live booking: 1 guest on 07-04 and 07-05.
    // Proposal: adds a guest on 07-04 (delta +1), extends to 07-06 (delta +1 there),
    // and shrinks 07-05 to zero-extra (delta 0). Only the positive deltas reserve.
    const snapshot: ExceptionProposalSnapshot = {
      kind: "MODIFICATION",
      lodgeId: "lodge_1",
      bookingId: "bk_1",
      base: party([guest({ nights: ["2026-07-04", "2026-07-05"] })]),
      proposed: party([
        guest({ nights: ["2026-07-04", "2026-07-05", "2026-07-06"] }),
        guest({ firstName: "B", lastName: "B", nights: ["2026-07-04"] }),
      ]),
    };
    expect(computeProposalReservation(snapshot)).toEqual([
      { night: "2026-07-04", beds: 1 }, // 2 proposed - 1 live
      { night: "2026-07-06", beds: 1 }, // 1 proposed - 0 live
      // 07-05: 1 proposed - 1 live = 0, not reserved
    ]);
  });

  it("MUTATION: a shrinking modification reserves nothing", () => {
    const snapshot: ExceptionProposalSnapshot = {
      kind: "MODIFICATION",
      lodgeId: "lodge_1",
      bookingId: "bk_1",
      base: party([
        guest({ nights: ["2026-07-04"] }),
        guest({ firstName: "B", lastName: "B", nights: ["2026-07-04"] }),
      ]),
      proposed: party([guest({ nights: ["2026-07-04"] })]),
    };
    expect(computeProposalReservation(snapshot)).toEqual([]);
  });

  it("FIX 7: a non-capacity-holding base reserves the FULL proposed footprint", () => {
    // #2525 FIX 7: with baseHoldsCapacity:false the base holds no beds of its own,
    // so the FULL proposed footprint must be reserved — not the incremental delta.
    const snapshot: ExceptionProposalSnapshot = {
      kind: "MODIFICATION",
      lodgeId: "lodge_1",
      bookingId: "bk_1",
      base: party([guest({ nights: ["2026-07-04", "2026-07-05"] })]),
      proposed: party([
        guest({ nights: ["2026-07-04", "2026-07-05"] }),
        guest({ firstName: "B", lastName: "B", nights: ["2026-07-04"] }),
      ]),
    };
    // Holding base (default): only the incremental extra guest on 07-04.
    expect(computeProposalReservation(snapshot)).toEqual([
      { night: "2026-07-04", beds: 1 },
    ]);
    // Non-holding base: the entire proposed party is held.
    expect(
      computeProposalReservation(snapshot, { baseHoldsCapacity: false }),
    ).toEqual([
      { night: "2026-07-04", beds: 2 },
      { night: "2026-07-05", beds: 1 },
    ]);
  });

  it("perNightBedDemand counts each guest once per night", () => {
    const demand = perNightBedDemand(
      party([
        guest({ nights: ["2026-07-04", "2026-07-04"] }), // duplicate ignored
        guest({ firstName: "B", lastName: "B", nights: ["2026-07-04"] }),
      ]),
    );
    expect(demand.get("2026-07-04")).toBe(2);
  });
});

// --- frozen evidence / HOLD-if-any-HOLD -----------------------------------

describe("freezePolicyExceptionEvidence", () => {
  it("MUTATION: aggregates HOLD if ANY covered violation is HOLD", () => {
    const evidence = freezePolicyExceptionEvidence([
      hostingViolation({ capacityMode: "NO_HOLD" }),
      minimumStayViolation({ capacityMode: "HOLD" }),
    ]);
    expect(evidence.capacityMode).toBe("HOLD");
  });

  it("MUTATION: aggregates NO_HOLD only when every violation is NO_HOLD", () => {
    const evidence = freezePolicyExceptionEvidence([
      hostingViolation({ capacityMode: "NO_HOLD" }),
      minimumStayViolation({ capacityMode: "NO_HOLD" }),
    ]);
    expect(evidence.capacityMode).toBe("NO_HOLD");
  });

  it("derives sorted reasonCodes, policyRefs and affectedNights", () => {
    const evidence = freezePolicyExceptionEvidence([
      hostingViolation({ affectedNights: ["2026-07-05"] }),
      minimumStayViolation({ affectedNights: ["2026-07-04"] }),
    ]);
    expect(evidence.reasonCodes).toEqual([
      "ADULT_MEMBER_HOSTING_REQUIRED",
      "MINIMUM_STAY",
    ]);
    expect(evidence.affectedNights).toEqual(["2026-07-04", "2026-07-05"]);
    expect(evidence.policyRefs).toHaveLength(2);
  });

  it("round-trips through parseFrozenEvidence", () => {
    const evidence = freezePolicyExceptionEvidence([minimumStayViolation()]);
    const json = JSON.parse(JSON.stringify(evidence));
    const parsed = parseFrozenEvidence(json);
    expect(parsed).not.toBeNull();
    expect(reviewedViolationsFromEvidence(parsed!)).toHaveLength(1);
  });
});

describe("parseFrozenEvidence", () => {
  it("rejects a non-object", () => {
    expect(parseFrozenEvidence(null)).toBeNull();
    expect(parseFrozenEvidence(42)).toBeNull();
    expect(parseFrozenEvidence([])).toBeNull();
  });

  it("MUTATION: rejects evidence carrying a non-allowlisted reason code", () => {
    expect(
      parseFrozenEvidence({
        violations: [{ reasonCode: "CAPACITY_EXCEEDED" }],
        capacityMode: "HOLD",
      }),
    ).toBeNull();
  });
});

// --- drift classification -------------------------------------------------

describe("classifyPolicyExceptionDrift", () => {
  it("clean when reviewed and current are byte-identical", () => {
    const reviewed = [minimumStayViolation(), hostingViolation()];
    const result = classifyPolicyExceptionDrift(reviewed, [
      minimumStayViolation(),
      hostingViolation(),
    ]);
    expect(result.executable).toBe(true);
    expect(result.overridable).toHaveLength(2);
    expect(result.clearedReviewed).toHaveLength(0);
  });

  it("MUTATION: a reviewed rule that DISAPPEARED executes without override", () => {
    const reviewed = [minimumStayViolation(), hostingViolation()];
    // Current: hosting policy was switched off, so only minimum-stay still trips.
    const result = classifyPolicyExceptionDrift(reviewed, [minimumStayViolation()]);
    expect(result.executable).toBe(true);
    expect(result.clearedReviewed).toEqual([
      { reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED", policyId: "pol_host" },
    ]);
    // The disappeared rule must NOT be in the override set.
    expect(result.overridable).toEqual([
      { reasonCode: "MINIMUM_STAY", policyId: "pol_min" },
    ]);
  });

  it("MUTATION: a reviewed rule at a NEW policy version forces resubmission", () => {
    const reviewed = [minimumStayViolation({ policyVersion: 1 })];
    const result = classifyPolicyExceptionDrift(reviewed, [
      minimumStayViolation({ policyVersion: 2 }),
    ]);
    expect(result.executable).toBe(false);
    expect(result.changedReviewed).toEqual([
      { reasonCode: "MINIMUM_STAY", policyId: "pol_min" },
    ]);
  });

  it("MUTATION: a materially changed hosting hazard (different uncovered set) forces resubmission", () => {
    const reviewed = [hostingViolation()];
    const changed = hostingViolation({
      requirements: {
        kind: "ADULT_MEMBER_HOSTING",
        requiredAdultMemberParticipantsPerGuestNight: 1,
        uncoveredNonMemberGuestNights: 1,
        uncovered: [
          { guestRef: "guest:1", guestName: "Someone Else", night: "2026-07-05" },
        ],
        qualifyingHostsByNight: [{ night: "2026-07-05", memberIds: [] }],
      },
      affectedNights: ["2026-07-05"],
    });
    const result = classifyPolicyExceptionDrift(reviewed, [changed]);
    expect(result.executable).toBe(false);
    expect(result.changedReviewed).toHaveLength(1);
  });

  it("MUTATION: a brand-new violation forces resubmission", () => {
    const reviewed = [minimumStayViolation()];
    const result = classifyPolicyExceptionDrift(reviewed, [
      minimumStayViolation(),
      hostingViolation(),
    ]);
    expect(result.executable).toBe(false);
    expect(result.newViolations).toEqual([
      { reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED", policyId: "pol_host" },
    ]);
  });
});

describe("violationFingerprint", () => {
  it("is stable for identical facts and distinct for different nights", () => {
    expect(violationFingerprint(minimumStayViolation())).toBe(
      violationFingerprint(minimumStayViolation()),
    );
    expect(violationFingerprint(minimumStayViolation())).not.toBe(
      violationFingerprint(minimumStayViolation({ affectedNights: ["2026-07-11"] })),
    );
  });
});

// --- lifecycle ------------------------------------------------------------

describe("request lifecycle", () => {
  it("MUTATION: only REQUESTED may transition, and only to the five outcomes", () => {
    for (const to of [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "SUPERSEDED",
      // #2553: the hold reaper's outcome.
      "EXPIRED",
    ] as const) {
      expect(isPolicyExceptionTransitionAllowed("REQUESTED", to)).toBe(true);
    }
    expect(isPolicyExceptionTransitionAllowed("REQUESTED", "REQUESTED")).toBe(false);
    expect(isPolicyExceptionTransitionAllowed("APPROVED", "REJECTED")).toBe(false);
    expect(isPolicyExceptionTransitionAllowed("CANCELLED", "APPROVED")).toBe(false);
    // #2553: EXPIRED is terminal like the rest — an expired request is closed, and
    // a member resubmits rather than an officer reviving it in place.
    expect(isPolicyExceptionTransitionAllowed("EXPIRED", "APPROVED")).toBe(false);
    expect(isPolicyExceptionTransitionAllowed("EXPIRED", "REQUESTED")).toBe(false);
  });

  it("classifies the four releasing terminal statuses", () => {
    expect(isTerminalReleasingStatus("REJECTED")).toBe(true);
    expect(isTerminalReleasingStatus("CANCELLED")).toBe(true);
    expect(isTerminalReleasingStatus("SUPERSEDED")).toBe(true);
    // #2553: an expiry releases the hold on exactly the same terms.
    expect(isTerminalReleasingStatus("EXPIRED")).toBe(true);
    expect(isTerminalReleasingStatus("APPROVED")).toBe(false);
    expect(isTerminalReleasingStatus("REQUESTED")).toBe(false);
  });
});

// keep the capacity-mode type import meaningful
const _mode: PolicyExceptionCapacityMode = "HOLD";
void _mode;

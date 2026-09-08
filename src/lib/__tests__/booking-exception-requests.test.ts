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

  /** The child on the modification pin: a macron, an apostrophe and an em dash. */
  function modificationPinChild(): ProposalGuest {
    return guest({
      firstName: "Tāne",
      lastName: "O'Brien — Māhuta",
      ageTier: "CHILD",
      isMember: true,
      memberId: "mem_9",
      nights: ["2026-07-05"],
    });
  }

  /**
   * A frozen MODIFICATION snapshot, written out field by field rather than via
   * `party()`, so a later edit to that shared builder cannot silently move a
   * pinned digest.
   */
  const MODIFICATION_PIN_SNAPSHOT: ExceptionProposalSnapshot = {
    kind: "MODIFICATION",
    lodgeId: "lodge_1",
    bookingId: "bk_1",
    base: {
      checkIn: "2026-07-04",
      checkOut: "2026-07-06",
      guests: [guest({ nights: ["2026-07-04"] })],
    },
    proposed: {
      checkIn: "2026-07-04",
      checkOut: "2026-07-06",
      guests: [
        guest({ nights: ["2026-07-05", "2026-07-04", "2026-07-05"] }),
        modificationPinChild(),
      ],
    },
  };

  it("is a 64-char lowercase hex digest", () => {
    expect(computeProposalHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PINS the digest for a fixed snapshot, because a stored proposalHash must still validate after any refactor (#3030)", () => {
    // Every other test here recomputes the hash on both sides, so all of them
    // would pass if the canonicalisation itself changed - and a changed
    // canonicalisation silently invalidates every BookingExceptionRequest row
    // already on file, whose stored proposalHash approval re-derives and
    // compares. #3030 moved `stableStringify` out to a shared module for a
    // second hasher to share, and #3218 routed this function through
    // `stableDigest` rather than spelling the composition out again. Both moves
    // were byte-identical, and this literal is what MEASURED that rather than
    // asserting it - it passed #3218 unchanged. It is also what makes the NEXT
    // such change fail loudly instead of quietly.
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

  it("PINS the digest for a fixed MODIFICATION snapshot, the shape the pin above does not cover (#3218)", () => {
    // The NEW_BOOKING pin above hashes a snapshot with no `bookingId` and no
    // `base` party. A modification hashes a strictly larger canonical shape, and
    // it is the one `booking-exception-execution.ts` re-derives from a LIVE
    // booking before executing an approved request - so a canonicalisation
    // change that happened to leave the smaller shape alone would still turn
    // every stored modification request into an apparently tampered row.
    //
    // The guest names carry a macron, an apostrophe and an em dash on purpose:
    // the digest is `createHash(...).update(text, "utf8")`, and a member's real
    // name is exactly where a lost encoding argument would first bite.
    //
    // If you are here because this failed: do NOT re-pin it. Work out what
    // changed in the canonicalisation - rows already on file cannot be
    // re-verified against new bytes.
    expect(computeProposalHash(MODIFICATION_PIN_SNAPSHOT)).toBe(
      "345262ed82caa5333b8171c17d6cc50b6717b6f8787c81d9c02ea3ba35b93d96",
    );
  });

  it("MUTATION: the modification pin is reached from a differently-ordered party too", () => {
    // Same facts, guests listed in the other order and one guest's nights
    // supplied unsorted and duplicated. Canonicalisation must erase all of that
    // before the digest, or a member re-opening an editor would re-hash to a
    // different value than the one already stored.
    const shuffled: ExceptionProposalSnapshot = {
      ...MODIFICATION_PIN_SNAPSHOT,
      proposed: {
        checkIn: "2026-07-04",
        checkOut: "2026-07-06",
        guests: [
          modificationPinChild(),
          guest({ nights: ["2026-07-05", "2026-07-04", "2026-07-05"] }),
        ],
      },
    };
    expect(computeProposalHash(shuffled)).toBe(
      "345262ed82caa5333b8171c17d6cc50b6717b6f8787c81d9c02ea3ba35b93d96",
    );
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

// ---------------------------------------------------------------------------
// #3252 — the canonical order must not depend on the server's collation
// ---------------------------------------------------------------------------

describe("computeProposalHash is locale-proof (#3252)", () => {
  // A pair whose two surnames order ONE way under `localeCompare` and the OTHER
  // way under a code-unit comparison. Measured inside the production container
  // (node 24.17, ICU 78.3, resolved locale `en-US`): `"de la Cruz"` vs
  // `"Delacruz"` is −1 under `localeCompare` and +1 ordinally, because locale
  // collation treats the space as ignorable at the primary level and a code-unit
  // comparison does not. A surname with a space is ordinary in this club's
  // membership.
  //
  // THIS IS THE FIXTURE THE PINS ABOVE DO NOT GIVE. `Lovelace`/`Turing` and
  // `Lovelace`/`O'Brien — Māhuta` order identically under both comparators, so
  // both pre-#3252 pins would have passed a comparator change untouched — they
  // were built to catch a change in the SERIALISATION, and a comparator lives
  // one level below that.
  const divergentParty: ProposalParty = {
    checkIn: "2026-07-04",
    checkOut: "2026-07-06",
    guests: [
      guest({ firstName: "Ana", lastName: "de la Cruz" }),
      guest({ firstName: "Bo", lastName: "Delacruz", nights: ["2026-07-05"] }),
    ],
  };
  const divergentSnapshot: ExceptionProposalSnapshot = {
    kind: "NEW_BOOKING",
    lodgeId: "lodge_1",
    proposed: divergentParty,
  };

  it("orders the divergent pair the ORDINAL way, not the locale way", () => {
    // Asserted against an EXPLICITLY CONSTRUCTED divergence rather than by
    // running the suite under another `LANG`. Setting an env var proves nothing
    // here: this very machine resolves a locale that agrees with the ordinal
    // answer on the pairs the old pins used, so a locale-parameterised run can
    // be green while the defect is fully present. What closes it is naming a
    // pair whose two answers differ and asserting WHICH ONE the code gives.
    expect(
      canonicalizeProposalParty(divergentParty).guests.map(
        (entry) => entry.lastName,
      ),
    ).toEqual(["Delacruz", "de la Cruz"]);
    // The locale answer, stated so the divergence is visible in the test rather
    // than only in the commit message. If ICU ever changes its mind about this
    // pair the assertion below fails and the one above does not, which is
    // exactly the right way round.
    expect("de la Cruz".localeCompare("Delacruz")).toBe(-1);
    expect(
      "de la Cruz" < "Delacruz" ? -1 : "de la Cruz" > "Delacruz" ? 1 : 0,
    ).toBe(1);
  });

  it("PINS the digest of the divergent party", () => {
    // MUTATION-VERIFIED: reverting `canonicalizeProposalParty` to
    // `a.lastName.localeCompare(b.lastName)` reorders these two guests and this
    // literal fails. That is the only construction that proves the pin is
    // load-bearing — the two pins above pass either way.
    //
    // If you are here because this failed: do NOT re-pin it. A stored
    // `proposalHash` cannot be re-verified against new bytes, so a change here
    // needs a data migration like the one #3252 shipped.
    expect(computeProposalHash(divergentSnapshot)).toBe(
      "79e4cff36fbc4ba69f3bf7ecc1b12818ae29cd56ec9acac6aa816937b6a914aa",
    );
  });

  it("orders a case-only divergence ordinally too", () => {
    // `"Smith"` vs `"smith"`: +1 under `localeCompare` (lower case first), −1
    // ordinally (upper case first). Measured on the live server.
    expect("Smith".localeCompare("smith")).toBe(1);
    expect(
      canonicalizeProposalParty({
        checkIn: "2026-07-04",
        checkOut: "2026-07-06",
        guests: [
          guest({ firstName: "Ada", lastName: "Smith" }),
          guest({ firstName: "Bo", lastName: "smith", nights: ["2026-07-05"] }),
        ],
      }).guests.map((entry) => entry.lastName),
    ).toEqual(["Smith", "smith"]);
  });

  it("MUTATION: the guest order is TOTAL, so a tie cannot fall back to input order", () => {
    // Before #3252 the comparator chain stopped at `nights`, so two guests
    // alike in surname, first name, member link and nights but differing in age
    // tier TIED — and `Array#sort` is stable, which means the tie kept INPUT
    // order and the digest depended on the order the caller happened to build
    // the party in. That is the exact property `computeProposalHash` exists to
    // remove, and it was false for this shape.
    const tied: ProposalGuest[] = [
      guest({ firstName: "Sam", lastName: "Smith", ageTier: "CHILD" }),
      guest({ firstName: "Sam", lastName: "Smith", ageTier: "ADULT" }),
    ];
    const forwards: ExceptionProposalSnapshot = {
      kind: "NEW_BOOKING",
      lodgeId: "lodge_1",
      proposed: { checkIn: "2026-07-04", checkOut: "2026-07-06", guests: tied },
    };
    const backwards: ExceptionProposalSnapshot = {
      kind: "NEW_BOOKING",
      lodgeId: "lodge_1",
      proposed: {
        checkIn: "2026-07-04",
        checkOut: "2026-07-06",
        guests: [...tied].reverse(),
      },
    };
    expect(computeProposalHash(backwards)).toBe(computeProposalHash(forwards));
    expect(
      canonicalizeProposalParty(forwards.proposed).guests.map(
        (entry) => entry.ageTier,
      ),
    ).toEqual(["ADULT", "CHILD"]);
  });
});

// keep the capacity-mode type import meaningful
const _mode: PolicyExceptionCapacityMode = "HOLD";
void _mode;

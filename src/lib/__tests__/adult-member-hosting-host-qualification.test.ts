// #2569 — the configurable adult-member-hosting policy: a third CONSEQUENCE and a
// second, independent HOST-QUALIFICATION dimension.
//
// The two claims this file exists to hold down, because both are silent when they
// break:
//
//   * THE UPGRADE MOVES NOBODY. Every pre-#2569 row carries NULL host-scope
//     columns and a mode nothing rewrote, so a club that changes nothing must get
//     byte-identical answers — including the member-facing sentence. A regression
//     here reads as "the rule got a bit stricter" in production, months later.
//   * THE TWO DIMENSIONS ARE INDEPENDENT. A lodge may override the consequence and
//     inherit the scopes, or the reverse. Folding one into the other still passes
//     any test that only ever overrides both at once.
import { AgeTier } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ADULT_MEMBER_HOST_SCOPES,
  aggregatePolicyExceptionViolations,
} from "@/lib/booking-policy-exceptions";
import {
  ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS,
  ADULT_MEMBER_HOST_SCOPE_LABELS,
  DEFAULT_ADULT_MEMBER_HOST_SCOPES,
  EmptyAdultMemberHostScopeSetError,
  PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE,
  describeAdultMemberHostingPolicy,
  formatAdultMemberHostingWaitlistRefusal,
  enabledHostScopeList,
  evaluateAdultMemberHostingWithPolicy,
  formatAdultMemberHostingMessage,
  hostScopeEnabled,
  hostScopeSetIsEmpty,
  hostingModeIsActive,
  resolveAdultMemberHostingPolicy,
  type AdultMemberHostScopeSet,
  type AdultMemberHostingPolicyLike,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";
import { AdultMemberHostingRequiredError, buildAdultMemberHostingRefusalBody } from "@/lib/adult-member-hosting-refusal";

/** A row as it exists BEFORE this issue: every scope column is NULL. */
function legacyRow(
  overrides: Partial<AdultMemberHostingPolicyLike> = {},
): AdultMemberHostingPolicyLike {
  return {
    id: "club-policy",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "NO_HOLD",
    version: 4,
    hostScopeSameBooking: null,
    hostScopeSameBookingOwner: null,
    // #3037's column is NULL on a legacy row too, and — unlike the pair — it is
    // ALSO null on a row that decided the pair before this migration. Both read
    // as OFF, which is what makes the upgrade a no-op.
    hostScopeSameGroupTrip: null,
    ...overrides,
  };
}

function scopeColumns(scopes: AdultMemberHostScopeSet) {
  return {
    hostScopeSameBooking: scopes.sameBooking,
    hostScopeSameBookingOwner: scopes.sameBookingOwner,
    hostScopeSameGroupTrip: scopes.sameGroupTrip,
  };
}

const SCOPES = {
  sameBookingOnly: {
    sameBooking: true,
    sameBookingOwner: false,
    sameGroupTrip: false,
  },
  sameOwnerOnly: {
    sameBooking: false,
    sameBookingOwner: true,
    sameGroupTrip: false,
  },
  sameGroupTripOnly: {
    sameBooking: false,
    sameBookingOwner: false,
    sameGroupTrip: true,
  },
  all: { sameBooking: true, sameBookingOwner: true, sameGroupTrip: true },
  none: { sameBooking: false, sameBookingOwner: false, sameGroupTrip: false },
} satisfies Record<string, AdultMemberHostScopeSet>;

function adult(
  guestRef: string,
  nights: string[],
  extra: Partial<HostingParticipant> = {},
): HostingParticipant {
  return {
    guestRef,
    guestName: `Member ${guestRef}`,
    member: {
      id: `member-${guestRef}`,
      ageTier: AgeTier.ADULT,
      active: true,
      cancelledAt: null,
      archivedAt: null,
    },
    nights,
    ...extra,
  };
}

function nonMember(guestRef: string, nights: string[]): HostingParticipant {
  return { guestRef, guestName: `Guest ${guestRef}`, member: null, nights };
}

describe("host-qualification resolution is a second, independent dimension", () => {
  it("resolves a legacy row to the built-in same-booking default, from the built-in source", () => {
    const resolved = resolveAdultMemberHostingPolicy([legacyRow()], "lodge-1");
    expect(resolved.mode).toBe("ADMIN_REVIEW_REQUIRED");
    expect(resolved.hostScopes).toEqual(DEFAULT_ADULT_MEMBER_HOST_SCOPES);
    // BUILT_IN_DEFAULT, not CLUB_WIDE: the club row exists but decided nothing
    // about who counts, and the admin card has to be able to say so.
    expect(resolved.hostScopeSource).toBe("BUILT_IN_DEFAULT");
  });

  it("lets a lodge override the CONSEQUENCE while inheriting the club's scopes", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        legacyRow({ ...scopeColumns(SCOPES.all) }),
        legacyRow({
          id: "lodge-policy",
          scopeKey: "lodge-1",
          lodgeId: "lodge-1",
          mode: "ENFORCED",
        }),
      ],
      "lodge-1",
    );
    expect(resolved.mode).toBe("ENFORCED");
    expect(resolved.resolvedScope.kind).toBe("LODGE");
    // The scope set came from the CLUB row, while the consequence came from the
    // lodge row. Two dimensions, two sources, one resolution.
    expect(resolved.hostScopes).toEqual(SCOPES.all);
    expect(resolved.hostScopeSource).toBe("CLUB_WIDE");
  });

  it("lets a lodge override the SCOPES while inheriting the club's consequence", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        legacyRow({ mode: "ENFORCED" }),
        legacyRow({
          id: "lodge-policy",
          scopeKey: "lodge-1",
          lodgeId: "lodge-1",
          // INHERIT about the consequence, custom about who counts. A resolver
          // that read the scope set only inside its non-INHERIT branch would
          // silently drop this lodge's decision.
          mode: "INHERIT",
          ...scopeColumns(SCOPES.sameOwnerOnly),
        }),
      ],
      "lodge-1",
    );
    expect(resolved.mode).toBe("ENFORCED");
    expect(resolved.resolvedScope.kind).toBe("CLUB_WIDE");
    expect(resolved.hostScopes).toEqual(SCOPES.sameOwnerOnly);
    expect(resolved.hostScopeSource).toBe("LODGE");
  });

  it("keeps a DISABLED lodge's saved scope set rather than resetting it (§16)", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        legacyRow(),
        legacyRow({
          id: "lodge-policy",
          scopeKey: "lodge-1",
          lodgeId: "lodge-1",
          mode: "DISABLED",
          ...scopeColumns(SCOPES.all),
        }),
      ],
      "lodge-1",
    );
    expect(resolved.mode).toBe("DISABLED");
    // Saved for later reuse, and reported, even though it is not being applied.
    expect(resolved.hostScopes).toEqual(SCOPES.all);
    expect(resolved.hostScopeSource).toBe("LODGE");
  });

  it("treats a half-written row as undecided rather than guessing (the CHECK's backstop)", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        legacyRow({
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: null,
        }),
      ],
      "lodge-1",
    );
    // The database CHECK forbids this shape; reaching it means somebody wrote
    // around the constraint, and inheriting is the safe reading — asserting a
    // scope set from half a row would apply a rule nobody chose.
    expect(resolved.hostScopes).toEqual(DEFAULT_ADULT_MEMBER_HOST_SCOPES);
    expect(resolved.hostScopeSource).toBe("BUILT_IN_DEFAULT");
  });

  it("resolves DISABLED with the built-in scopes when nothing is configured at all", () => {
    const resolved = resolveAdultMemberHostingPolicy([], "lodge-1");
    expect(resolved.mode).toBe("DISABLED");
    expect(resolved.hostScopes).toEqual(DEFAULT_ADULT_MEMBER_HOST_SCOPES);
    expect(resolved.hostScopeSource).toBe("BUILT_IN_DEFAULT");
  });
});

describe("the evaluator counts a host only under an ENABLED scope, per night", () => {
  const resolvedWith = (
    mode: "ADMIN_REVIEW_REQUIRED" | "ENFORCED" | "DISABLED",
    scopes: AdultMemberHostScopeSet,
  ) =>
    resolveAdultMemberHostingPolicy(
      [legacyRow({ mode, ...scopeColumns(scopes) })],
      "lodge-1",
    );

  it("ignores a same-owner host while that scope is off, and counts them when it is on", () => {
    const party = [
      // Stamped SAME_BOOKING_OWNER: an adult member attending another booking with
      // the same `Booking.memberId`, at this lodge on this night (#2576 s1).
      adult("h1", ["2026-07-04"], {
        hostScope: "SAME_BOOKING_OWNER",
        hostOnly: true,
      }),
      nonMember("g1", ["2026-07-04"]),
    ];

    const off = evaluateAdultMemberHostingWithPolicy(
      party,
      resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.sameBookingOnly),
    );
    expect(off).not.toBeNull();
    expect(off!.requirements.uncoveredNonMemberGuestNights).toBe(1);

    const on = evaluateAdultMemberHostingWithPolicy(
      party,
      resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.sameOwnerOnly),
    );
    expect(on).toBeNull();
  });

  it("ORs across scopes night by night, so different nights are covered differently", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        // Monday covered on the same booking; Tuesday by an adult member on
        // another booking on the same account; Wednesday by nobody.
        adult("a1", ["2026-07-04"]),
        adult("a2", ["2026-07-05"], {
          hostScope: "SAME_BOOKING_OWNER",
          hostOnly: true,
        }),
        nonMember("g1", ["2026-07-04", "2026-07-05", "2026-07-06"]),
      ],
      resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.all),
    );
    expect(violation!.requirements.uncovered).toEqual([
      { guestRef: "g1", guestName: "Guest g1", night: "2026-07-06" },
    ]);
    // Partial coverage is NOT compliance: every non-member guest-night must be
    // covered, so two of three nights still leaves a violation.
    expect(violation!.requirements.qualifyingHostsByNight).toEqual([
      {
        night: "2026-07-04",
        memberIds: ["member-a1"],
        coveredByScopes: ["SAME_BOOKING"],
      },
      {
        night: "2026-07-05",
        memberIds: ["member-a2"],
        coveredByScopes: ["SAME_BOOKING_OWNER"],
      },
      { night: "2026-07-06", memberIds: [], coveredByScopes: [] },
    ]);
  });

  it("treats an unstamped participant as SAME_BOOKING, which is what keeps existing loaders exact", () => {
    // No `hostScope` anywhere — every pre-#2569 loader and test double.
    const covered = evaluateAdultMemberHostingWithPolicy(
      [adult("a1", ["2026-07-04"]), nonMember("g1", ["2026-07-04"])],
      resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.sameBookingOnly),
    );
    expect(covered).toBeNull();

    // And they stop counting when the club turns the same-booking scope off,
    // which is the proof the default is a real scope rather than a bypass.
    const notCovered = evaluateAdultMemberHostingWithPolicy(
      [adult("a1", ["2026-07-04"]), nonMember("g1", ["2026-07-04"])],
      resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.sameOwnerOnly),
    );
    expect(notCovered).not.toBeNull();
  });

  it("still applies every eligibility rule to a host offered under a wider scope", () => {
    // A wider scope changes WHERE a host may be, never WHO qualifies (#2576 s13:
    // one shared definition of an eligible adult member): a lapsed member, a youth,
    // an unaccepted invite and an unpaid subscription are refused on another booking
    // of the same account exactly as they are on this one.
    for (const disqualified of [
      adult("x", ["2026-07-04"], {
        hostScope: "SAME_BOOKING_OWNER",
        hostOnly: true,
        member: {
          id: "member-x",
          ageTier: AgeTier.ADULT,
          active: false,
          cancelledAt: null,
          archivedAt: null,
        },
      }),
      adult("y", ["2026-07-04"], {
        hostScope: "SAME_BOOKING_OWNER",
        hostOnly: true,
        member: {
          id: "member-y",
          ageTier: AgeTier.YOUTH,
          active: true,
          cancelledAt: null,
          archivedAt: null,
        },
      }),
      adult("z", ["2026-07-04"], {
        hostScope: "SAME_BOOKING_OWNER",
        hostOnly: true,
        operationallyPresent: false,
      }),
      adult("w", ["2026-07-04"], {
        hostScope: "SAME_BOOKING_OWNER",
        hostOnly: true,
        subscriptionSettled: false,
      }),
    ]) {
      const violation = evaluateAdultMemberHostingWithPolicy(
        [disqualified, nonMember("g1", ["2026-07-04"])],
        resolvedWith("ADMIN_REVIEW_REQUIRED", SCOPES.all),
      );
      expect(violation).not.toBeNull();
    }
  });

  it("refuses to evaluate an active policy that enables no scope at all", () => {
    for (const mode of ["ADMIN_REVIEW_REQUIRED", "ENFORCED"] as const) {
      expect(() =>
        evaluateAdultMemberHostingWithPolicy(
          [nonMember("g1", ["2026-07-04"])],
          resolvedWith(mode, SCOPES.none),
        ),
      ).toThrow(EmptyAdultMemberHostScopeSetError);
    }
    // DISABLED is not active, so it is not evaluated and does not throw.
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [nonMember("g1", ["2026-07-04"])],
        resolvedWith("DISABLED", SCOPES.none),
      ),
    ).toBeNull();
  });
});

describe("the ENFORCED consequence", () => {
  const enforced = resolveAdultMemberHostingPolicy(
    [
      legacyRow({
        mode: "ENFORCED",
        capacityMode: "NO_HOLD",
        ...scopeColumns(SCOPES.sameBookingOnly),
      }),
    ],
    "lodge-1",
  );

  it("produces the same frozen violation shape, recording the consequence and the scopes", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      enforced,
    )!;
    // Same reason code and same exception eligibility as review mode: one
    // refusal family, not two.
    expect(violation.reasonCode).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(violation.exceptionEligible).toBe(true);
    // Recorded rather than inferred: an officer reading a stored snapshot cannot
    // work out which consequence applied, because the club may have changed the
    // setting since.
    expect(violation.consequence).toBe("ENFORCED");
    expect(violation.requirements.enabledHostScopes).toEqual(["SAME_BOOKING"]);
  });

  it("tells the member the booking is stopped and names the four ways out", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      enforced,
    )!;
    expect(violation.message).toMatch(/cannot be confirmed as it stands/);
    expect(violation.message).toMatch(/change the guests or the dates/);
    expect(violation.message).toMatch(/choose another lodge/);
    expect(violation.message).toMatch(/exception/);
    // And it must NOT say the thing review mode says, because there is no
    // booking for an admin to look at.
    expect(violation.message).not.toMatch(/an admin needs to look at it/);
  });

  it("refuses with 409 and hands over the exception door", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      enforced,
    )!;
    const error = new AdultMemberHostingRequiredError(violation);
    // 409, not 403: the booking IS permitted by a Booking Officer, and 403 would
    // also put the code in the hard-stop family that may never enter review.
    expect(error.status).toBe(409);
    expect(error.code).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(error.exceptionReview).toEqual(
      aggregatePolicyExceptionViolations([violation]),
    );

    const body = buildAdultMemberHostingRefusalBody(violation);
    expect(body.exceptionRequestPath).toBe("/api/bookings/exception-requests");
    expect(body.code).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    // NO_HOLD is reported honestly: a new-booking exception request reserves no
    // beds, and capacity is checked again at approval (§1).
    expect(body.exceptionReview.capacityMode).toBe("NO_HOLD");
  });

  it("withholds host identities from the member-facing body but not from the snapshot", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        adult("a2", ["2026-07-05"], {
          hostScope: "SAME_BOOKING_OWNER",
          hostOnly: true,
        }),
        nonMember("g1", ["2026-07-04", "2026-07-05"]),
      ],
      resolveAdultMemberHostingPolicy(
        [legacyRow({ mode: "ENFORCED", ...scopeColumns(SCOPES.all) })],
        "lodge-1",
      ),
    )!;

    // The frozen violation an officer reviews keeps the member id, for
    // validation, dependency tracking and audit.
    expect(
      violation.requirements.qualifyingHostsByNight.flatMap(
        (night) => night.memberIds,
      ),
    ).toEqual(["member-a2"]);

    // The member-facing body does not: a member id is an internal identity that no
    // member-facing body carries under any scope (#2576 §11). The nights and the
    // covering scopes survive, because those are the advice §17 asks for and
    // neither names a person.
    const body = buildAdultMemberHostingRefusalBody(violation);
    const published = body.violations[0] as typeof violation;
    expect(
      published.requirements.qualifyingHostsByNight.flatMap(
        (night) => night.memberIds,
      ),
    ).toEqual([]);
    expect(
      published.requirements.qualifyingHostsByNight.map((night) => night.night),
    ).toEqual(["2026-07-04", "2026-07-05"]);
    expect(
      published.requirements.qualifyingHostsByNight[1].coveredByScopes,
    ).toEqual(["SAME_BOOKING_OWNER"]);
  });
});

describe("the refusal reaches every refusing surface in a shape that fits it", () => {
  const enforced = resolveAdultMemberHostingPolicy(
    [legacyRow({ mode: "ENFORCED", ...scopeColumns(SCOPES.sameBookingOnly) })],
    "lodge-1",
  );

  it("adds the un-consumed-offer fact for a waitlist confirm, and nothing else", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      enforced,
    )!;
    const body = buildAdultMemberHostingRefusalBody(violation);
    const sentence = formatAdultMemberHostingWaitlistRefusal(body.error);

    // The base refusal survives whole — the member still gets the rule, the size
    // of the problem and all four ways out.
    expect(sentence.startsWith(body.error)).toBe(true);
    // Plus the one fact the booking paths cannot state: the offer was not spent.
    // Both waitlist confirms roll their claim back, so the entry is still
    // WAITLIST_OFFERED on its original expiry.
    expect(sentence).toMatch(/waitlist offer has not been used/);
    expect(sentence).toMatch(/stays open until it expires/);
    // And it must NOT say the #2543 refusal's thing. That one reverts the offer to
    // the queue, so "you've kept your place on the waitlist" is true there and
    // false here — the member would go looking for a queue position they still
    // hold an offer for.
    expect(sentence).not.toMatch(/kept your place/);
  });

  it("tells an unauthenticated non-member joiner nothing about the club's settings", () => {
    // The whole point of this constant: the verified-join confirm is reached from
    // an emailed token with no session, so the consequence setting, the enabled
    // host scopes and the uncovered nights must not appear in it. Asserted as
    // absences, because the failure mode is somebody "improving" the sentence by
    // pasting the frozen violation's message into it.
    const message = PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE;
    expect(message).toMatch(/contact the organiser/i);
    expect(message).not.toMatch(/guest night/i);
    expect(message).not.toMatch(/exception/i);
    expect(message).not.toMatch(/Booking Officer/i);
    expect(message).not.toMatch(/another booking/i);

    // It is also NOT the member-facing refusal, which names all four ways out —
    // three of which a non-login contact cannot take.
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      enforced,
    )!;
    expect(message).not.toBe(violation.message);
  });
});

describe("the upgrade moves nobody (§15)", () => {
  it("keeps the review-mode sentence byte-identical for a club on the default set", () => {
    // The exact string #2364 shipped. If this changes, every club that upgraded
    // and touched nothing sees different words for the same situation.
    expect(
      formatAdultMemberHostingMessage(
        2,
        1,
        "ADMIN_REVIEW_REQUIRED",
        DEFAULT_ADULT_MEMBER_HOST_SCOPES,
      ),
    ).toBe(
      "This club asks that an adult member stays on the same booking as any " +
        "non-member guest. On 1 night of this booking, 2 guest nights have no " +
        "adult member staying, so an admin needs to look at it.",
    );
    // And the same string when the arguments are omitted, which is what every
    // pre-#2569 caller passes.
    expect(formatAdultMemberHostingMessage(2, 1)).toBe(
      formatAdultMemberHostingMessage(
        2,
        1,
        "ADMIN_REVIEW_REQUIRED",
        DEFAULT_ADULT_MEMBER_HOST_SCOPES,
      ),
    );
  });

  it("evaluates a legacy row exactly as same-booking-only, whatever else is stored", () => {
    const legacy = resolveAdultMemberHostingPolicy([legacyRow()], "lodge-1");
    // An adult on ANOTHER of this member's bookings does NOT quietly start covering
    // guests just because #2569 shipped. That is the "do not silently broaden" rule.
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        adult("a2", ["2026-07-04"], {
          hostScope: "SAME_BOOKING_OWNER",
          hostOnly: true,
        }),
        nonMember("g1", ["2026-07-04"]),
      ],
      legacy,
    );
    expect(violation).not.toBeNull();
    expect(violation!.consequence).toBe("ADMIN_REVIEW_REQUIRED");
  });
});

describe("scope-set helpers and the settled scope model", () => {
  it("lists enabled scopes in the canonical order, whatever order the flags are read in", () => {
    expect(enabledHostScopeList(SCOPES.all)).toEqual([
      ...ADULT_MEMBER_HOST_SCOPES,
    ]);
    expect(enabledHostScopeList(SCOPES.none)).toEqual([]);
    expect(enabledHostScopeList(SCOPES.sameOwnerOnly)).toEqual([
      "SAME_BOOKING_OWNER",
    ]);
  });

  it("maps every scope name to a flag, with no silent default", () => {
    for (const scope of ADULT_MEMBER_HOST_SCOPES) {
      expect(hostScopeEnabled(SCOPES.all, scope)).toBe(true);
      expect(hostScopeEnabled(SCOPES.none, scope)).toBe(false);
    }
    expect(hostScopeSetIsEmpty(SCOPES.none)).toBe(true);
    expect(hostScopeSetIsEmpty(SCOPES.sameBookingOnly)).toBe(false);
  });

  it("holds the model to the scopes the owner settled on, in order", () => {
    // #2569's spec named three scopes. #2575 REMOVED the lodge-wide scope and
    // #2576 REPLACED the nominated-host scope with same-owner coverage, both as
    // removals rather than deferrals - so a value coming back has to come back
    // through a decision rather than a typo. #3037 (epic #2943) is such a
    // decision: SAME_GROUP_TRIP is APPENDED, and this assertion is written as an
    // ordered list rather than a set precisely so that appending is visible and
    // REORDERING is a failure. The order is not cosmetic - `enabledHostScopeList`
    // iterates this constant to sort `coveredByScopes` and `enabledHostScopes`
    // onto frozen violation snapshots that two evaluations must produce
    // byte-identically, so moving a value would rewrite snapshots nobody edited.
    expect([...ADULT_MEMBER_HOST_SCOPES]).toEqual([
      "SAME_BOOKING",
      "SAME_BOOKING_OWNER",
      "SAME_GROUP_TRIP",
    ]);
    // Every scope has a label and an administrator-facing sentence, or the settings
    // card and the refusal wording would name an enum value.
    for (const scope of ADULT_MEMBER_HOST_SCOPES) {
      expect(ADULT_MEMBER_HOST_SCOPE_LABELS[scope]).toBeTruthy();
      expect(ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS[scope]).toBeTruthy();
    }
    // The owner's own words for the new scope (#2576 §12), so a later edit that
    // reads more loosely than the rule is caught here.
    expect(ADULT_MEMBER_HOST_SCOPE_LABELS.SAME_BOOKING_OWNER).toBe(
      "Another booking on the same account",
    );
    expect(ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS.SAME_BOOKING_OWNER).toBe(
      "Allow a qualifying adult member on another confirmed booking owned by " +
        "the same member account to provide coverage for the same lodge and nights.",
    );
    // #3037. The description says "even when that booking belongs to a different
    // member" because that is the whole difference from the scope above it, and
    // it says "off unless you turn it on" because the default-OFF promise is the
    // release invariant an administrator most needs to read on the card itself.
    expect(ADULT_MEMBER_HOST_SCOPE_LABELS.SAME_GROUP_TRIP).toBe(
      "Another booking in the same Group Trip",
    );
    expect(ADULT_MEMBER_HOST_SCOPE_DESCRIPTIONS.SAME_GROUP_TRIP).toBe(
      "Allow a qualifying adult member on another confirmed booking in the same " +
        "Group Trip to provide coverage for the same lodge and nights, even when " +
        "that booking belongs to a different member. Off unless you turn it on.",
    );
  });

  it("says which consequences actually evaluate the rule", () => {
    expect(hostingModeIsActive("DISABLED")).toBe(false);
    expect(hostingModeIsActive("ADMIN_REVIEW_REQUIRED")).toBe(true);
    expect(hostingModeIsActive("ENFORCED")).toBe(true);
  });
});

describe("the plain-English preview the settings card shows (§16)", () => {
  it("states the consequence and the coverage, and never a person", () => {
    expect(
      describeAdultMemberHostingPolicy("ENFORCED", SCOPES.all),
    ).toBe(
      "This lodge stops bookings where non-member guests are not covered. " +
        "Coverage may be supplied by an adult member staying on this booking, " +
        "an adult member staying at the same lodge that night on another booking " +
        "on your account or an adult member staying at the same lodge that night " +
        "on another booking in the same Group Trip.",
    );
    // #3037. The Group Trip clause names the RULE and never the source: no
    // booking, no organiser, no member. The other booking may belong to somebody
    // else, so anything more specific here would be a cross-account disclosure in
    // a sentence rendered straight back to whoever was refused.
    expect(
      describeAdultMemberHostingPolicy("ENFORCED", SCOPES.sameGroupTripOnly),
    ).toBe(
      "This lodge stops bookings where non-member guests are not covered. " +
        "Coverage may be supplied by an adult member staying at the same lodge " +
        "that night on another booking in the same Group Trip.",
    );
    expect(
      describeAdultMemberHostingPolicy(
        "ADMIN_REVIEW_REQUIRED",
        SCOPES.sameBookingOnly,
      ),
    ).toMatch(/allows the booking but sends it to a Booking Officer/);
    expect(
      describeAdultMemberHostingPolicy("DISABLED", SCOPES.all),
    ).toMatch(/does not require/);
  });
});

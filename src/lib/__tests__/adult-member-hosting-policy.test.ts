import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgeTier } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { mergeFamilySource } from "@/lib/__tests__/support/member-merge-family";

import {
  ADULT_MEMBER_HOSTING_POLICY_NAME,
  UnknownAdultMemberHostingScopeError,
  adultMemberHostingReviewChanged,
  evaluateAdultMemberHostingWithPolicy,
  participantIsNonMemberGuest,
  participantQualifiesAsHost,
  resolveAdultMemberHostingPolicy,
  type AdultMemberHostingPolicyLike,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";
import {
  aggregatePolicyExceptionViolations,
  isPolicyExceptionReasonCode,
} from "@/lib/booking-policy-exceptions";
import {
  ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY,
  lockAdultMemberHostingPolicySet,
  tryLockAdultMemberHostingPolicySet,
} from "@/lib/adult-member-hosting-policy-set";

const MIGRATION = "20260802160000_add_adult_member_hosting_policy";

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function policyRow(
  overrides: Partial<AdultMemberHostingPolicyLike> = {},
): AdultMemberHostingPolicyLike {
  return {
    id: "club-policy",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "NO_HOLD",
    version: 4,
    ...overrides,
  };
}

function adult(
  guestRef: string,
  nights: string[],
  overrides: Partial<NonNullable<HostingParticipant["member"]>> = {},
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
      ...overrides,
    },
    nights,
  };
}

function nonMember(guestRef: string, nights: string[]): HostingParticipant {
  return {
    guestRef,
    guestName: `Guest ${guestRef}`,
    member: null,
    nights,
  };
}

const RESOLVED_LODGE = resolveAdultMemberHostingPolicy(
  [policyRow({ id: "lodge-policy", lodgeId: "lodge-1", scopeKey: "lodge-1" })],
  "lodge-1",
);

describe("adult-member hosting policy resolution (#2364)", () => {
  it("uses the club default when a lodge has no row", () => {
    const resolved = resolveAdultMemberHostingPolicy([policyRow()], "lodge-1");
    expect(resolved.mode).toBe("ADMIN_REVIEW_REQUIRED");
    expect(resolved.policyId).toBe("club-policy");
    expect(resolved.policyVersion).toBe(4);
    expect(resolved.resolvedScope).toEqual({
      kind: "CLUB_WIDE",
      lodgeId: null,
      effectiveLodgeId: "lodge-1",
    });
  });

  it("lets a lodge row override the club default", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        policyRow(),
        policyRow({
          id: "lodge-policy",
          scopeKey: "lodge-1",
          lodgeId: "lodge-1",
          mode: "DISABLED",
          version: 2,
        }),
      ],
      "lodge-1",
    );
    expect(resolved.mode).toBe("DISABLED");
    expect(resolved.policyId).toBe("lodge-policy");
    expect(resolved.resolvedScope).toEqual({
      kind: "LODGE",
      lodgeId: "lodge-1",
      effectiveLodgeId: "lodge-1",
    });
  });

  it("falls through to the club default when the lodge row says INHERIT", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        policyRow(),
        policyRow({
          id: "lodge-policy",
          scopeKey: "lodge-1",
          lodgeId: "lodge-1",
          mode: "INHERIT",
        }),
      ],
      "lodge-1",
    );
    expect(resolved.policyId).toBe("club-policy");
    expect(resolved.resolvedScope.kind).toBe("CLUB_WIDE");
  });

  it("ignores rows belonging to other lodges", () => {
    const resolved = resolveAdultMemberHostingPolicy(
      [
        policyRow({
          id: "other-lodge",
          scopeKey: "lodge-2",
          lodgeId: "lodge-2",
          mode: "ADMIN_REVIEW_REQUIRED",
        }),
      ],
      "lodge-1",
    );
    expect(resolved.mode).toBe("DISABLED");
    expect(resolved.policyId).toBeNull();
  });

  it("resolves DISABLED when nothing is configured anywhere", () => {
    const resolved = resolveAdultMemberHostingPolicy([], "lodge-1");
    expect(resolved.mode).toBe("DISABLED");
    expect(resolved.policyId).toBeNull();
    expect(resolved.policyVersion).toBe(0);
  });

  it("refuses an unresolvable scope instead of answering DISABLED", () => {
    expect(() => resolveAdultMemberHostingPolicy([policyRow()], "")).toThrow(
      UnknownAdultMemberHostingScopeError,
    );
  });

  it("refuses duplicate rows for one scope rather than picking between them", () => {
    expect(() =>
      resolveAdultMemberHostingPolicy(
        [policyRow({ id: "a" }), policyRow({ id: "b" })],
        "lodge-1",
      ),
    ).toThrow(UnknownAdultMemberHostingScopeError);
    expect(() =>
      resolveAdultMemberHostingPolicy(
        [
          policyRow({ id: "a", lodgeId: "lodge-1", scopeKey: "lodge-1" }),
          policyRow({ id: "b", lodgeId: "lodge-1", scopeKey: "lodge-1" }),
        ],
        "lodge-1",
      ),
    ).toThrow(UnknownAdultMemberHostingScopeError);
  });

  it("refuses a club-wide INHERIT row, which has nothing to inherit from", () => {
    expect(() =>
      resolveAdultMemberHostingPolicy([policyRow({ mode: "INHERIT" })], "lodge-1"),
    ).toThrow(UnknownAdultMemberHostingScopeError);
  });
});

describe("who may host (#2364 acceptance: adult member only)", () => {
  const cases: Array<[string, Partial<NonNullable<HostingParticipant["member"]>>, boolean]> = [
    ["an active adult member", {}, true],
    ["a child member", { ageTier: AgeTier.CHILD }, false],
    ["a youth member", { ageTier: AgeTier.YOUTH }, false],
    ["an infant member", { ageTier: AgeTier.INFANT }, false],
    ["an organisation", { ageTier: AgeTier.NOT_APPLICABLE }, false],
    ["an inactive member", { active: false }, false],
    ["a cancelled member", { cancelledAt: new Date("2026-01-01") }, false],
    ["an archived member", { archivedAt: new Date("2026-01-01") }, false],
  ];

  for (const [label, overrides, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${label}`, () => {
      expect(
        participantQualifiesAsHost(adult("a", ["2026-07-04"], overrides)),
      ).toBe(expected);
    });
  }

  it("rejects a participant with no member link at all", () => {
    expect(participantQualifiesAsHost(nonMember("g1", ["2026-07-04"]))).toBe(
      false,
    );
  });

  it("rejects an adult member whose invite has not been accepted (D-12)", () => {
    // The same row the kiosk, the arrival roster, bed allocation and the
    // arrival emails all leave out. Counting them here would let a member
    // suppress the review with an adult who never agreed to come.
    expect(
      participantQualifiesAsHost({
        ...adult("m1", ["2026-07-04"]),
        operationallyPresent: false,
      }),
    ).toBe(false);
    // Present is the default: the pre-persist create path has no consent facts.
    expect(participantQualifiesAsHost(adult("m1", ["2026-07-04"]))).toBe(true);
  });
});

describe("who needs hosting (#2364 review: a lapsed membership is not a membership)", () => {
  // The complement of the host table above, and the reason it exists: before
  // this, a participant whose Member row was inactive, cancelled or archived
  // fell BETWEEN the two predicates — they could not host, and they were not
  // counted as a guest-night needing a host, so the club's own rule protected
  // them LESS than a plain non-member. The applied principle is the module's
  // own stated safe direction: not in good standing means judged as a
  // non-member guest.
  const disqualified: Array<
    [string, Partial<NonNullable<HostingParticipant["member"]>>]
  > = [
    ["an inactive member", { active: false }],
    ["a cancelled member", { cancelledAt: new Date("2026-01-01") }],
    ["an archived member", { archivedAt: new Date("2026-01-01") }],
  ];

  for (const [label, overrides] of disqualified) {
    it(`counts ${label} as a guest who needs hosting`, () => {
      expect(
        participantIsNonMemberGuest(adult("g1", ["2026-07-04"], overrides)),
      ).toBe(true);

      const violation = evaluateAdultMemberHostingWithPolicy(
        [adult("g1", ["2026-07-04"], overrides)],
        RESOLVED_LODGE,
      );
      expect(violation).not.toBeNull();
      expect(violation!.requirements.uncovered).toEqual([
        { guestRef: "g1", guestName: "Member g1", night: "2026-07-04" },
      ]);
    });

    it(`does not let ${label} host anybody either`, () => {
      const violation = evaluateAdultMemberHostingWithPolicy(
        [
          adult("m1", ["2026-07-04"], overrides),
          nonMember("g1", ["2026-07-04"]),
        ],
        RESOLVED_LODGE,
      );
      // Two uncovered rows: the plain guest, and the lapsed member themselves.
      expect(violation).not.toBeNull();
      expect(violation!.requirements.uncoveredNonMemberGuestNights).toBe(2);
    });
  }

  it("leaves member CHILDREN and YOUTH out of it — the minors rule owns them", () => {
    // Deliberately keyed off standing, never ageTier. A member child does not
    // need an adult MEMBER on the booking under this rule; they need an adult
    // guest, which is `requiresAdminReview` in booking-review.ts.
    for (const tier of [AgeTier.CHILD, AgeTier.YOUTH, AgeTier.INFANT]) {
      expect(
        participantIsNonMemberGuest(adult("c1", ["2026-07-04"], { ageTier: tier })),
      ).toBe(false);
      expect(
        evaluateAdultMemberHostingWithPolicy(
          [adult("c1", ["2026-07-04"], { ageTier: tier })],
          RESOLVED_LODGE,
        ),
      ).toBeNull();
    }
  });

  it("leaves an active organisation member exactly where it was", () => {
    // NOT_APPLICABLE (#1440) cannot host — an organisation is not a person —
    // and is unchanged by the widening: an active organisation member is still
    // not counted as a guest-night needing a host.
    const organisation = adult("org", ["2026-07-04"], {
      ageTier: AgeTier.NOT_APPLICABLE,
    });
    expect(participantQualifiesAsHost(organisation)).toBe(false);
    expect(participantIsNonMemberGuest(organisation)).toBe(false);
    expect(
      evaluateAdultMemberHostingWithPolicy([organisation], RESOLVED_LODGE),
    ).toBeNull();
  });

  it("clears the moment the lapsed member is reinstated", () => {
    const lapsed = adult("m1", ["2026-07-04"], { active: false });
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [lapsed, nonMember("g1", ["2026-07-04"])],
        RESOLVED_LODGE,
      ),
    ).not.toBeNull();
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [adult("m1", ["2026-07-04"]), nonMember("g1", ["2026-07-04"])],
        RESOLVED_LODGE,
      ),
    ).toBeNull();
  });
});

describe("adult-member hosting evaluation (#2364)", () => {
  it("returns nothing while the policy is disabled", () => {
    const disabled = resolveAdultMemberHostingPolicy([], "lodge-1");
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [nonMember("g1", ["2026-07-04", "2026-07-05"])],
        disabled,
      ),
    ).toBeNull();
  });

  it("returns nothing when every non-member night has an adult member on it", () => {
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [
          adult("m1", ["2026-07-04", "2026-07-05"]),
          nonMember("g1", ["2026-07-04", "2026-07-05"]),
        ],
        RESOLVED_LODGE,
      ),
    ).toBeNull();
  });

  it("reports only the nights the member is NOT there — sparse night sets", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        // The member skips the middle night; the guest stays all three.
        adult("m1", ["2026-07-04", "2026-07-06"]),
        nonMember("g1", ["2026-07-04", "2026-07-05", "2026-07-06"]),
      ],
      RESOLVED_LODGE,
    );
    expect(violation).not.toBeNull();
    expect(violation!.affectedNights).toEqual(["2026-07-05"]);
    expect(violation!.requirements.uncoveredNonMemberGuestNights).toBe(1);
    expect(violation!.requirements.uncovered).toEqual([
      { guestRef: "g1", guestName: "Guest g1", night: "2026-07-05" },
    ]);
  });

  it("publishes the qualifying member ids for every candidate night, covered or not", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        adult("m1", ["2026-07-04"]),
        adult("m2", ["2026-07-04"]),
        nonMember("g1", ["2026-07-04", "2026-07-05"]),
      ],
      RESOLVED_LODGE,
    );
    expect(violation!.requirements.qualifyingHostsByNight).toEqual([
      {
        night: "2026-07-04",
        memberIds: ["member-m1", "member-m2"],
        // #2569 §11 — WHICH scope supplied the cover, not just that it exists.
        coveredByScopes: ["SAME_BOOKING"],
      },
      { night: "2026-07-05", memberIds: [], coveredByScopes: [] },
    ]);
  });

  it("does not let a child member cover a non-member guest", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [
        adult("m1", ["2026-07-04"], { ageTier: AgeTier.CHILD }),
        nonMember("g1", ["2026-07-04"]),
      ],
      RESOLVED_LODGE,
    );
    expect(violation!.affectedNights).toEqual(["2026-07-04"]);
  });

  it("never treats a member participant's own night as needing cover", () => {
    // A child MEMBER is not a non-member guest: they need no host, they just
    // cannot be one. A party of members alone therefore never trips the rule.
    expect(
      evaluateAdultMemberHostingWithPolicy(
        [adult("m1", ["2026-07-04"], { ageTier: AgeTier.CHILD })],
        RESOLVED_LODGE,
      ),
    ).toBeNull();
  });

  it("freezes policy identity, scope and capacity mode onto the violation", () => {
    const holdPolicy = resolveAdultMemberHostingPolicy(
      [policyRow({ capacityMode: "HOLD", version: 9 })],
      "lodge-1",
    );
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      holdPolicy,
    )!;
    expect(violation.reasonCode).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(violation.policyId).toBe("club-policy");
    expect(violation.policyVersion).toBe(9);
    expect(violation.policyName).toBe(ADULT_MEMBER_HOSTING_POLICY_NAME);
    expect(violation.capacityMode).toBe("HOLD");
    expect(violation.exceptionEligible).toBe(true);
    expect(violation.resolvedScope).toEqual({
      kind: "CLUB_WIDE",
      lodgeId: null,
      effectiveLodgeId: "lodge-1",
    });
  });

  it("is deterministic: input order never changes the snapshot", () => {
    const participants = [
      nonMember("g2", ["2026-07-05", "2026-07-04"]),
      nonMember("g1", ["2026-07-04"]),
      adult("m1", []),
    ];
    const forward = evaluateAdultMemberHostingWithPolicy(
      participants,
      RESOLVED_LODGE,
    );
    const reversed = evaluateAdultMemberHostingWithPolicy(
      [...participants].reverse(),
      RESOLVED_LODGE,
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward!.requirements.uncovered.map((row) => row.night)).toEqual([
      "2026-07-04",
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("de-duplicates a repeated night on one participant", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04", "2026-07-04"])],
      RESOLVED_LODGE,
    )!;
    expect(violation.requirements.uncoveredNonMemberGuestNights).toBe(1);
  });

  it("aggregates through the #2363 registry, which allowlists its reason code", () => {
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      resolveAdultMemberHostingPolicy([policyRow({ capacityMode: "HOLD" })], "lodge-1"),
    )!;
    expect(isPolicyExceptionReasonCode(violation.reasonCode)).toBe(true);
    const aggregated = aggregatePolicyExceptionViolations([violation]);
    expect(aggregated.capacityMode).toBe("HOLD");
    expect(aggregated.violations).toHaveLength(1);
  });
});

describe("material-change detection (#2364 acceptance: reopen only on a different hazard)", () => {
  const base = evaluateAdultMemberHostingWithPolicy(
    [nonMember("g1", ["2026-07-04"])],
    RESOLVED_LODGE,
  )!;

  it("treats appearing and clearing as changes", () => {
    expect(adultMemberHostingReviewChanged(null, base)).toBe(true);
    expect(adultMemberHostingReviewChanged(base, null)).toBe(true);
    expect(adultMemberHostingReviewChanged(null, null)).toBe(false);
  });

  it("ignores a re-evaluation of the same facts", () => {
    const again = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      RESOLVED_LODGE,
    );
    expect(adultMemberHostingReviewChanged(base, again)).toBe(false);
  });

  it("ignores a renamed guest and an extra host on an already-covered night", () => {
    const renamed = evaluateAdultMemberHostingWithPolicy(
      [
        { ...nonMember("g1", ["2026-07-04"]), guestName: "Renamed Person" },
        adult("m9", ["2026-07-09"]),
      ],
      RESOLVED_LODGE,
    );
    expect(adultMemberHostingReviewChanged(base, renamed)).toBe(false);
  });

  it("notices a different uncovered night", () => {
    const moved = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-05"])],
      RESOLVED_LODGE,
    );
    expect(adultMemberHostingReviewChanged(base, moved)).toBe(true);
  });

  it("notices an additional uncovered guest on the same night", () => {
    const extra = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"]), nonMember("g2", ["2026-07-04"])],
      RESOLVED_LODGE,
    );
    expect(adultMemberHostingReviewChanged(base, extra)).toBe(true);
  });

  it("notices that a DIFFERENT policy row now governs the same evidence", () => {
    // A lodge that used to inherit the club rule now has its own. The uncovered
    // nights are identical and both rows are at revision 4, so only the policy
    // identity distinguishes them — and it must, because an admin's decision was
    // made about the club's rule, not this lodge's.
    const clubGoverned = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      resolveAdultMemberHostingPolicy([policyRow()], "lodge-1"),
    );
    const lodgeGoverned = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      resolveAdultMemberHostingPolicy(
        [
          policyRow(),
          policyRow({ id: "lodge-policy", lodgeId: "lodge-1", scopeKey: "lodge-1" }),
        ],
        "lodge-1",
      ),
    );
    expect(clubGoverned!.policyVersion).toBe(lodgeGoverned!.policyVersion);
    expect(adultMemberHostingReviewChanged(clubGoverned, lodgeGoverned)).toBe(true);
  });

  it("notices a new policy revision on identical evidence", () => {
    const rerevised = evaluateAdultMemberHostingWithPolicy(
      [nonMember("g1", ["2026-07-04"])],
      resolveAdultMemberHostingPolicy(
        [policyRow({ id: "lodge-policy", lodgeId: "lodge-1", scopeKey: "lodge-1", version: 99 })],
        "lodge-1",
      ),
    );
    expect(adultMemberHostingReviewChanged(base, rerevised)).toBe(true);
  });
});

describe("hosting policy set locking and migration shape (#2364)", () => {
  it("locks the set through one named key before any read", async () => {
    const calls: string[] = [];
    await lockAdultMemberHostingPolicySet({
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`${strings.join("?")}::${String(values[0])}`);
        return Promise.resolve(1);
      },
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("pg_advisory_xact_lock");
    expect(calls[0]).toContain(ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY);
  });

  it.each([true, false])(
    "reports a %s fail-fast policy-lock attempt without blocking",
    async (acquired) => {
      const calls: string[] = [];
      const result = await tryLockAdultMemberHostingPolicySet({
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push(`${strings.join("?")}::${String(values[0])}`);
          return Promise.resolve([{ acquired }]);
        },
      } as any);

      expect(result).toBe(acquired);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("pg_try_advisory_xact_lock");
      expect(calls[0]).toContain(ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY);
    },
  );

  it("takes the set lock in a BEFORE STATEMENT trigger, ahead of any tuple lock", () => {
    const sql = repoFile(`prisma/migrations/${MIGRATION}/migration.sql`);
    expect(sql).toContain(
      "pg_advisory_xact_lock(hashtext('adult-member-hosting-policy-set'))",
    );
    expect(sql).toMatch(
      /CREATE TRIGGER "AdultMemberHostingPolicy_lock_set"[\s\S]*?FOR EACH STATEMENT/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER "AdultMemberHostingPolicy_version"[\s\S]*?FOR EACH ROW/,
    );
  });

  it("pins scope identity and refuses a club-wide INHERIT row in the database", () => {
    const sql = repoFile(`prisma/migrations/${MIGRATION}/migration.sql`);
    expect(sql).toContain(
      'CHECK ("scopeKey" = COALESCE("lodgeId", \'club-wide\'))',
    );
    expect(sql).toContain(
      'CHECK ("lodgeId" IS NOT NULL OR "mode" <> \'INHERIT\')',
    );
    expect(sql).toContain('CREATE UNIQUE INDEX "AdultMemberHostingPolicy_scopeKey_key"');
  });

  it("gives capacityMode no database default, so every writer states it (D-R6)", () => {
    const sql = repoFile(`prisma/migrations/${MIGRATION}/migration.sql`);
    expect(sql).toMatch(/"capacityMode" "PolicyExceptionCapacityMode" NOT NULL,/);
    expect(sql).not.toMatch(/"capacityMode"[^\n]*DEFAULT/);
  });

  it("makes the D-R4 reviewer a real foreign key that merge and deletion can see", () => {
    // A bare String id would outlive the member it names: member merge walks
    // Prisma relations to repoint actor columns and deletion SetNulls them, so
    // an unrelated id is skipped by both and "who accepted this hazard" decays
    // into a dangling id the database would never surface. The DMMF
    // completeness guard (member-merge-dmmf.test.ts) only sees Member-TYPED
    // fields, which is exactly why the relation has to exist.
    const sql = repoFile(`prisma/migrations/${MIGRATION}/migration.sql`);
    expect(sql).toMatch(
      /ADD CONSTRAINT "Booking_adultMemberHostingReviewedById_fkey"[\s\S]*?REFERENCES "Member"\("id"\)[\s\S]*?ON DELETE SET NULL/,
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "Booking_adultMemberHostingReviewedById_fkey"',
    );

    const schema = repoFile("prisma/schema.prisma");
    expect(schema).toMatch(
      /adultMemberHostingReviewedBy\s+Member\?\s+@relation\("BookingsAdultMemberHostingReviewed", fields: \[adultMemberHostingReviewedById\], references: \[id\], onDelete: SetNull\)/,
    );

    // READ THE MERGE FAMILY, NOT ONE FILE. The relation specs used to live in
    // `member-merge.ts`; #3128 moved them to `member-merge-relations.ts`, and a
    // hardcoded path turned this pin into a false red. A path is a guess about
    // where code lives — this one has now been wrong once.
    const merge = mergeFamilySource();
    expect(merge).toContain('"adultMemberHostingReviewedBy"');
    expect(merge).toContain('"adultMemberHostingReviewedById"');
  });
});

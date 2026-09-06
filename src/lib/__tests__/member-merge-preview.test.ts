import { describe, expect, it, vi } from "vitest";
import { buildMemberMergePreview } from "@/lib/member-merge";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function makeMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    active: true,
    archivedAt: null,
    canLogin: true,
    xeroContactId: null,
    joinedDate: null,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    detailsConfirmedByMemberId: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2021-01-01T00:00:00Z"),
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    ...overrides,
  };
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
}

function makeDb(params: {
  master?: Record<string, unknown>;
  loser?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) {
  const master = params.master ?? makeMember(MASTER_ID);
  const loser = params.loser ?? makeMember(LOSER_ID);
  const overrides = params.overrides ?? {};
  const memberDelegate = {
    ...defaultDelegate(),
    findUnique: vi.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null,
      ),
    ),
    // actorIsFullAdmin -> 1 for the actor; wouldRemoveLastFullAdmin(loser) -> 0;
    // self-relation move-count queries (no `id` in where) -> 0.
    count: vi.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
    ),
  };
  const cache = new Map<string, unknown>();
  cache.set("member", overrides.member ?? memberDelegate);
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );
}

async function preview(params: {
  master?: Record<string, unknown>;
  loser?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) {
  return buildMemberMergePreview({
    masterId: MASTER_ID,
    loserId: LOSER_ID,
    actorMemberId: ACTOR_ID,
    db: makeDb(params) as never,
  });
}

describe("buildMemberMergePreview warnings", () => {
  it("includes definition-backed custom roles in the gained-role warning (M1)", async () => {
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [
                {
                  role: null,
                  roleDefinitionId: "def-fin",
                  roleDefinition: { label: "Finance Manager" },
                },
              ]
            : [],
        ),
      ),
    };
    const result = await preview({ overrides: { memberAccessRole } });
    expect(result.blockers).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("Master will gain access role(s)") &&
          w.includes("Finance Manager (custom role)"),
      ),
    ).toBe(true);
  });

  it("still lists gained enum roles alongside custom ones", async () => {
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [
                { role: "FINANCE_ADMIN", roleDefinitionId: null, roleDefinition: null },
                {
                  role: null,
                  roleDefinitionId: "def-x",
                  roleDefinition: { label: "Custom Ops" },
                },
              ]
            : [],
        ),
      ),
    };
    const result = await preview({ overrides: { memberAccessRole } });
    const warning = result.warnings.find((w) => w.includes("Master will gain"));
    expect(warning).toContain("FINANCE_ADMIN");
    expect(warning).toContain("Custom Ops (custom role)");
  });

  it("surfaces the CONFIRMED partner-link drop warning and counts memberB-side loser links (M3/m2)", async () => {
    // The loser sits on the memberB side of its link (A < B canonical order),
    // which the old memberA-only count missed entirely.
    const loserLinks = [
      { id: "L1", memberAId: "aaa-third", memberBId: LOSER_ID, status: "CONFIRMED" },
    ];
    const masterLinks = [
      { id: "M1", memberAId: MASTER_ID, memberBId: "zzz-partner", status: "CONFIRMED" },
    ];
    const memberPartnerLink = {
      ...defaultDelegate(),
      findMany: vi.fn(
        ({ where }: { where: { OR: { memberAId?: string; memberBId?: string }[] } }) =>
          Promise.resolve(
            where.OR?.[0]?.memberAId === LOSER_ID ? loserLinks : masterLinks,
          ),
      ),
    };
    const result = await preview({ overrides: { memberPartnerLink } });
    expect(
      result.warnings.some((w) => w.includes("confirmed partner link dropped")),
    ).toBe(true);
    const collision = result.collisions.find(
      (c) => c.model === "MemberPartnerLink.memberA/memberB",
    );
    expect(collision?.count).toBe(1);
  });

  it("warns that the loser's own outbound self-relation links are discarded (m4)", async () => {
    const result = await preview({
      loser: makeMember(LOSER_ID, {
        parentMemberId: "someone-else",
        inheritEmailFromId: "someone-else",
      }),
    });
    const warning = result.warnings.find((w) => w.includes("discarded"));
    expect(warning).toBeDefined();
    expect(warning).toContain("parent");
    expect(warning).toContain("inheritEmailFrom");
  });

  it("does not warn about a loser self-relation that points at the master (deleted self-cycle)", async () => {
    const result = await preview({
      loser: makeMember(LOSER_ID, { parentMemberId: MASTER_ID }),
    });
    expect(result.warnings.some((w) => w.includes("discarded"))).toBe(false);
  });

  it("warns that the MASTER's own link at the duplicate will be CLEARED, and never counts it as a move (#2437)", async () => {
    // Step 1 of the merge NULLS a master self-relation column pointing at the
    // duplicate — the link is deleted, not carried. Counting the master's own
    // row under "History moved" told the operator the opposite, and the audit
    // then recorded a move that never happened. The row is excluded from the
    // move counts (with the same predicate the execute-time token
    // re-derivation uses, so the digest still verifies) and surfaced as an
    // explicit clearance warning instead.
    const master = makeMember(MASTER_ID, { inheritEmailFromId: LOSER_ID });
    const loser = makeMember(LOSER_ID);
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null,
        ),
      ),
      count: vi.fn(({ where }: { where?: { id?: unknown } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
    };
    const result = await preview({
      master,
      loser,
      overrides: { member: memberDelegate },
    });

    const warning = result.warnings.find((w) => w.includes("CLEARED"));
    expect(warning).toBeDefined();
    expect(warning).toContain("inheritEmailFrom");
    expect(warning).toContain("not moved");
    expect(
      result.relationMoves.find((m) => m.model === "Member.inheritEmailFrom"),
    ).toBeUndefined();
    // The count predicate excludes the master's own row.
    expect(
      memberDelegate.count.mock.calls.map(
        ([arg]) => (arg as { where: unknown }).where,
      ),
    ).toContainEqual({ inheritEmailFromId: LOSER_ID, id: { not: MASTER_ID } });
  });

  it("does not warn about a clearance when the master holds no link at the duplicate", async () => {
    const result = await preview({});
    expect(result.warnings.some((w) => w.includes("CLEARED"))).toBe(false);
  });

  it("adds a specific note when duplicate promo-money allocation rows will be dropped (m5)", async () => {
    const promoRedemptionAllocation = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(
          where.memberId === LOSER_ID
            ? [{ id: "pa-L", promoRedemptionId: "pr1", promoCodeId: "pc1", bookingId: "b1" }]
            : [{ id: "pa-M", promoRedemptionId: "pr1", promoCodeId: "pcM", bookingId: "bM" }],
        ),
      ),
    };
    const result = await preview({ overrides: { promoRedemptionAllocation } });
    expect(
      result.warnings.some((w) =>
        w.includes("promo redemption allocation row(s) will be dropped"),
      ),
    ).toBe(true);
  });

  it("adds a specific note when duplicate group-booking join rows will be dropped (m5)", async () => {
    const groupBookingJoin = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { joinerMemberId: string } }) =>
        Promise.resolve(
          where.joinerMemberId === LOSER_ID
            ? [{ id: "gj-L", groupBookingId: "gb1" }]
            : [{ id: "gj-M", groupBookingId: "gb1" }],
        ),
      ),
    };
    const result = await preview({ overrides: { groupBookingJoin } });
    expect(
      result.warnings.some((w) =>
        w.includes("group-booking join row(s) will be dropped"),
      ),
    ).toBe(true);
  });

  it("always warns about manual Xero cleanup timing loser sign-out", async () => {
    const result = await preview({});
    expect(
      result.warnings.some((w) => w.includes("signed out on their next request")),
    ).toBe(true);
  });
});

/**
 * #2255 (M1). Merge is a parent-link writer by consequence rather than by
 * intent, which is how it stayed ungated: it never creates a link, but
 * re-pointing the loser's inbound links onto the master collapses two nodes
 * into one and JOINS their family chains.
 */
describe("family-link graph blockers on merge (#2255)", () => {
  /**
   * A member delegate backed by a real little family graph, so the two bounded
   * walks answer from the same edges rather than from per-test constants.
   * `edges[child] = parent`.
   */
  function familyGraphMemberDelegate(edges: Record<string, string | null>) {
    const idsBelow = (parentId: string) =>
      Object.entries(edges)
        .filter(([, parent]) => parent === parentId)
        .map(([child]) => child);

    return {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID
            ? makeMember(MASTER_ID)
            : where.id === LOSER_ID
              ? makeMember(LOSER_ID)
              : null,
        ),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      findMany: vi.fn(({ where }: { where: any }) => {
        // Walking UP: "these ids".
        if (where?.id?.in) {
          return Promise.resolve(
            where.id.in.map((id: string) => ({
              id,
              parentMemberId: edges[id] ?? null,
              secondaryParentId: null,
            })),
          );
        }
        // Walking DOWN: "children of these ids".
        if (where?.OR) {
          const parents: string[] = where.OR.flatMap((clause: any) => [
            ...(clause.parentMemberId?.in ?? []),
            ...(clause.secondaryParentId?.in ?? []),
          ]);
          return Promise.resolve(
            parents.flatMap((id) => idsBelow(id).map((child) => ({ id: child }))),
          );
        }
        return Promise.resolve([]);
      }),
    };
  }

  const blockerCodes = (result: { blockers: Array<{ code: string }> }) =>
    result.blockers.map((blocker) => blocker.code);

  it("refuses a merge that would join two chains past four generations", async () => {
    // master-1 sits three links below ggp; loser-1 heads two generations of its
    // own. Neither breaches the cap alone; merged they span six.
    const result = await preview({
      overrides: {
        member: familyGraphMemberDelegate({
          [MASTER_ID]: "gp",
          gp: "ggp",
          ggp: "gggp",
          gggp: null,
          "kid-1": LOSER_ID,
          "grandkid-1": "kid-1",
        }),
      },
    });

    expect(blockerCodes(result)).toContain("family_link_depth");
    expect(
      result.blockers.find((blocker) => blocker.code === "family_link_depth")
        ?.label,
    ).toMatch(/4 generations/i);
  });

  it("refuses a merge between members already related by parentage", async () => {
    // master-1 is the parent of X, and X is the parent of loser-1. Merging
    // loser into master makes X both master's child and master's parent.
    // `nullSelfRelationCycles` cannot see this: it only nulls MASTER columns
    // equal to the loser id, and the loop here is closed through X.
    const result = await preview({
      overrides: {
        member: familyGraphMemberDelegate({
          [MASTER_ID]: null,
          x: MASTER_ID,
          [LOSER_ID]: "x",
        }),
      },
    });

    expect(blockerCodes(result)).toContain("family_link_cycle");
  });

  it("refuses it in the other direction too", async () => {
    const result = await preview({
      overrides: {
        member: familyGraphMemberDelegate({
          [LOSER_ID]: null,
          x: LOSER_ID,
          [MASTER_ID]: "x",
        }),
      },
    });

    expect(blockerCodes(result)).toContain("family_link_cycle");
  });

  it("allows a merge whose combined family still fits", async () => {
    // master-1 one link below gp, loser-1 with one generation beneath: the
    // merged node spans three generations, which is inside the cap.
    const result = await preview({
      overrides: {
        member: familyGraphMemberDelegate({
          [MASTER_ID]: "gp",
          gp: null,
          "kid-1": LOSER_ID,
        }),
      },
    });

    expect(blockerCodes(result)).not.toContain("family_link_depth");
    expect(blockerCodes(result)).not.toContain("family_link_cycle");
  });

  it("allows a merge between two unrelated members with no family at all", async () => {
    const result = await preview({
      overrides: {
        member: familyGraphMemberDelegate({
          [MASTER_ID]: null,
          [LOSER_ID]: null,
        }),
      },
    });

    expect(blockerCodes(result)).not.toContain("family_link_depth");
    expect(blockerCodes(result)).not.toContain("family_link_cycle");
  });

  it("blocks a merge whose loser-to-master parent move would overlap a partner pair", async () => {
    const familyMember = familyGraphMemberDelegate({
      [MASTER_ID]: null,
      [LOSER_ID]: null,
      "partner-child": LOSER_ID,
    });
    const member = {
      ...familyMember,
      findMany: vi.fn((args: { where: { OR?: Array<Record<string, unknown>> } }) => {
        const topologyRead = args.where?.OR?.some(
          (clause) =>
            typeof (clause.id as { in?: unknown } | undefined)?.in !==
            "undefined",
        );
        if (topologyRead) {
          return Promise.resolve([
            {
              id: "partner-child",
              parentMemberId: LOSER_ID,
              secondaryParentId: null,
            },
          ]);
        }
        return familyMember.findMany(args);
      }),
    };
    const partnerRow = {
      id: "partner-link",
      memberAId: MASTER_ID,
      memberBId: "partner-child",
      status: "PENDING",
    };
    const memberPartnerLink = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where?: { OR?: Array<Record<string, unknown>> } }) => {
        const clauses = where?.OR ?? [];
        const isTopologyRead = clauses.some(
          (clause) =>
            typeof (clause.memberAId as { in?: unknown } | undefined)?.in !==
              "undefined" ||
            typeof (clause.memberBId as { in?: unknown } | undefined)?.in !==
              "undefined",
        );
        if (isTopologyRead) return Promise.resolve([partnerRow]);
        const mentionsMaster = clauses.some(
          (clause) =>
            clause.memberAId === MASTER_ID || clause.memberBId === MASTER_ID,
        );
        return Promise.resolve(mentionsMaster ? [partnerRow] : []);
      }),
    };

    const result = await preview({ overrides: { member, memberPartnerLink } });

    expect(blockerCodes(result)).toContain("parent_partner_overlap");
    expect(
      result.blockers.find(
        (blocker) => blocker.code === "parent_partner_overlap",
      )?.label,
    ).toMatch(/cannot be both direct parent\/dependant and partners/i);
  });
});

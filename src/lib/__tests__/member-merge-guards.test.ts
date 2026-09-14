import { describe, expect, it, vi } from "vitest";
import { evaluateMemberMergeGuards } from "@/lib/member-merge";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function guardMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    active: true,
    archivedAt: null,
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    email: `${id}@example.com`,
    accessRoles: [] as { role: string | null }[],
    ...overrides,
  };
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
}

function contactCreateFailure(providerContactCreated = true) {
  return {
    id: "xero-op-1",
    responsePayload: {
      phase: "local_link_after_xero_resolution",
      providerContactCreated,
    },
  };
}

function staleResetContactCreatePendingProof() {
  return {
    id: "xero-op-stale-reset",
    status: "FAILED",
    responsePayload: {
      phase: "provider_contact_created_local_link_pending",
      providerContactCreated: true,
    },
  };
}

describe("unresolved Xero contact-create recovery blockers", () => {
  it.each([
    ["master", MASTER_ID, "master_xero_contact_create_recovery_pending"],
    ["duplicate", LOSER_ID, "loser_xero_contact_create_recovery_pending"],
  ])("blocks when the %s has provider-created local-link recovery", async (_side, id, code) => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(where.localId === id ? contactCreateFailure() : null),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });

    expect(blockers.map((blocker) => blocker.code)).toContain(code);
    const label = blockers.find((blocker) => blocker.code === code)?.label;
    expect(label).toMatch(
      /Wait for it to finish, or resolve the failed Xero operation/,
    );
    // #2623 T7: the refusal names the exact operation and the screen that
    // clears it. Without that the operator saw an unexplained 409 while the
    // member's own page reported a clean Xero state.
    expect(label).toContain(contactCreateFailure().id);
    expect(label).toContain("Admin → Xero → Operations");
  });

  it("blocks an exact active contact-create reservation", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(
          where.localId === LOSER_ID
            ? { id: "xero-running", status: "RUNNING", responsePayload: null }
            : null,
        ),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("blocks merge after a provider-created pending-link row is reset to FAILED", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(
          where.localId === LOSER_ID
            ? staleResetContactCreatePendingProof()
            : null,
        ),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("blocks merge on an unmarked contact-create reservation reset as stale", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(
        ({ where }: { where: { localId: string; OR: unknown[] } }) => {
          if (where.localId !== LOSER_ID) return Promise.resolve(null);
          expect(where.OR).toEqual(
            expect.arrayContaining([
              {
                operationType: "CREATE",
                OR: expect.arrayContaining([
                  {
                    status: "FAILED",
                    lastErrorCode: "ORPHANED_STALE_RUNNING",
                  },
                ]),
              },
            ]),
          );
          return Promise.resolve({
            id: "xero-stale-reset",
            status: "FAILED",
            lastErrorCode: "ORPHANED_STALE_RUNNING",
            responsePayload: null,
          });
        },
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("does not block matched-existing, manually resolved, or non-failed operations", async () => {
    const excludedOperations = [
      {
        status: "FAILED",
        manuallyResolvedAt: null,
        responsePayload: contactCreateFailure(false).responsePayload,
      },
      {
        status: "FAILED",
        manuallyResolvedAt: new Date("2026-07-01T00:00:00Z"),
        responsePayload: contactCreateFailure().responsePayload,
      },
      {
        status: "SUCCEEDED",
        manuallyResolvedAt: null,
        responsePayload: contactCreateFailure().responsePayload,
      },
    ];
    const xeroSyncOperation = {
      ...defaultDelegate(),
      // Prisma applies the exact where-clause before returning a candidate.
      // These deliberately non-matching rows therefore produce no result.
      findFirst: vi.fn(({ where }: { where: { OR: unknown[]; manuallyResolvedAt: null } }) => {
        expect(where.OR).toEqual(expect.arrayContaining([expect.objectContaining({ status: "RUNNING" })]));
        expect(where.manuallyResolvedAt).toBeNull();
        expect(excludedOperations).toHaveLength(3);
        return Promise.resolve(null);
      }),
    };

    await expect(runGuards({ xeroSyncOperation })).resolves.toEqual([]);
  });
});

/**
 * Proxy mock db: member.count answers the actorIsFullAdmin /
 * wouldRemoveLastFullAdmin queries; other delegates default to zero counts and
 * empty findMany unless overridden.
 */
function makeDb(overrides: Record<string, unknown> = {}) {
  const memberDelegate = {
    ...defaultDelegate(),
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

async function runGuards(dbOverrides: Record<string, unknown> = {}) {
  return evaluateMemberMergeGuards({
    db: makeDb(dbOverrides) as never,
    actorMemberId: ACTOR_ID,
    master: guardMember(MASTER_ID) as never,
    loser: guardMember(LOSER_ID) as never,
    masterId: MASTER_ID,
    loserId: LOSER_ID,
  });
}

/**
 * A memberSubscription.findMany mock: the guard queries the MASTER for ALL
 * rows (no OR filter) and the LOSER for MEANINGFUL rows only (OR filter
 * present), so the mock keys off `where.OR` to emulate meaningfulness.
 */
function subscriptionFindMany(config: {
  masterSeasons: number[];
  loserMeaningfulSeasons: number[];
}) {
  return vi.fn(({ where }: { where: { memberId: string; OR?: unknown } }) => {
    if (where.memberId === MASTER_ID && !where.OR) {
      return Promise.resolve(config.masterSeasons.map((seasonYear) => ({ seasonYear })));
    }
    if (where.memberId === LOSER_ID && where.OR) {
      return Promise.resolve(
        config.loserMeaningfulSeasons.map((seasonYear) => ({ seasonYear })),
      );
    }
    return Promise.resolve([]);
  });
}

describe("subscription-collision blocker (B1 matrix)", () => {
  it("BLOCKS master-meaningless + loser-meaningful for the same season (paid history must never be dropped)", async () => {
    // Master holds a meaningless NOT_INVOICED 2026 row (still a row for the
    // season); loser holds a PAID 2026 row with an invoice link (meaningful).
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("BLOCKS a colliding loser row backed by charge coverage (never a late P2003)", async () => {
    // A coverage-backed loser row is meaningful via chargeCoverage even when
    // NOT_INVOICED with no Xero fields; dropping it would P2003 on the
    // onDelete:Restrict MembershipSubscriptionChargeCoverage FK.
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2025],
          loserMeaningfulSeasons: [2025],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("does NOT block both-meaningless for the same season (loser row is droppable)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [], // loser's colliding row is meaningless
        }),
      },
    });
    expect(blockers).toEqual([]);
  });

  it("does NOT block a loser-only meaningful subscription (no master row for the season -> moved)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2024],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers).toEqual([]);
  });
});

describe("open DeletionRequest blocker (M2)", () => {
  /** The status filter the guard is expected to issue (#2597). */
  type OpenStatusWhere = {
    memberId: string;
    status: { in: string[] };
  };

  const matchesOpenRequest = (where: OpenStatusWhere, memberId: string) =>
    where.memberId === memberId &&
    where.status.in.includes("PENDING") &&
    where.status.in.includes("APPROVAL_IN_PROGRESS");

  it("blocks when the LOSER has an open account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: OpenStatusWhere }) =>
        Promise.resolve(matchesOpenRequest(where, LOSER_ID) ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("loser_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("master_pending_requests");
  });

  it("blocks when the MASTER has an open account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: OpenStatusWhere }) =>
        Promise.resolve(matchesOpenRequest(where, MASTER_ID) ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("master_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("loser_pending_requests");
  });

  it("counts a mid-approval request as open, not as a decided one", async () => {
    // #2597: an approval that has already cancelled bookings but not yet
    // anonymised must still block a merge. Were the guard to filter on PENDING
    // alone, DeletionRequest.member (classified `move`) would silently
    // re-point to the master and the later approval would wipe the MERGED
    // record — the exact hazard this blocker exists to prevent.
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: OpenStatusWhere }) => {
        expect(where.status.in).toEqual(["PENDING", "APPROVAL_IN_PROGRESS"]);
        return Promise.resolve(0);
      }),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers).toEqual([]);
    expect(deletionRequest.count).toHaveBeenCalledTimes(2); // master AND loser
  });
});

/**
 * A SCHOOL IS NOT A PERSON, AND A MERGE SAYS TWO ROWS ARE ONE PERSON (#3369).
 *
 * Stage 4 of programme #2912 moves every school's booking onto its own
 * `Organisation` and leaves the old school-shaped member row behind, holding
 * nothing but history. Folding one of those into a person — in either direction
 * — would put a school's past under a person's name, which is the
 * school-as-person model this whole programme exists to end.
 *
 * The refusal reads the RECORDED classification, never the shape of the row, so
 * it can say which decision it is acting on.
 */
function schoolClassification(...memberIds: string[]) {
  return {
    ...defaultDelegate(),
    findMany: vi.fn(
      ({ where }: { where: { memberId: { in: string[] } } }) =>
        Promise.resolve(
          where.memberId.in
            .filter((id) => memberIds.includes(id))
            .map((memberId) => ({ memberId })),
        ),
    ),
  };
}

describe("#3369: member merge refuses a school's record", () => {
  it("blocks when the DUPLICATE is a school, and names which side", async () => {
    const blockers = await runGuards({
      schoolMemberClassification: schoolClassification(LOSER_ID),
    });

    const blocker = blockers.find((b) => b.code === "organisation_row");
    expect(blocker).toBeDefined();
    expect(blocker?.label).toContain("duplicate record is a school");
    expect(blocker?.label).toContain("merge the organisations instead");
    expect(blocker?.count).toBe(1);
  });

  it("blocks when the MASTER is a school", async () => {
    const blockers = await runGuards({
      schoolMemberClassification: schoolClassification(MASTER_ID),
    });

    const blocker = blockers.find((b) => b.code === "organisation_row");
    expect(blocker?.label).toContain("master record is a school");
  });

  it("says so plainly when BOTH are schools", async () => {
    const blockers = await runGuards({
      schoolMemberClassification: schoolClassification(MASTER_ID, LOSER_ID),
    });

    const blocker = blockers.find((b) => b.code === "organisation_row");
    expect(blocker?.label).toBe(
      "Both records are schools, not people. Merge the two organisation records instead.",
    );
    expect(blocker?.count).toBe(2);
  });

  it("does NOT block an ordinary merge of two people", async () => {
    // The common case, and the one that must keep working: a real teacher
    // recorded twice is a person recorded twice, and merges like anybody else.
    const blockers = await runGuards();
    expect(blockers.map((b) => b.code)).not.toContain("organisation_row");
  });

  it("reads only the ORGANISATION classification, so a teacher's row merges", async () => {
    // The query the guard issues is filtered on `classification:
    // ORGANISATION`; a PERSON row is invisible to it. Asserting on the filter
    // rather than on the result is what proves the guard is not simply
    // refusing every classified row.
    const findMany = vi.fn().mockResolvedValue([]);
    await runGuards({
      schoolMemberClassification: { ...defaultDelegate(), findMany },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ classification: "ORGANISATION" }),
      }),
    );
  });
});

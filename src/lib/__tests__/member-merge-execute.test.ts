import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  buildMemberMergePreviewToken,
  executeMemberMerge,
  MemberMergeError,
  type MemberMergePreviewCore,
} from "@/lib/member-merge";
import { mergeMemberFields } from "@/lib/member-merge-fields";
import { MEMBER_MERGE_RELATION_SPECS } from "@/lib/member-merge-relations";
import { BookingRequestStatus, type MemberGuestConsentStatus } from "@prisma/client";
import { claimAlreadyConvertedBookingRequest } from "@/lib/booking-request-shared";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";
import {
  ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY,
  lockAdultMemberHostingPolicySet,
} from "@/lib/adult-member-hosting-policy-set";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function makeMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    active: true,
    archivedAt: null,
    canLogin: true,
    xeroContactId: null,
    joinedDate: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2021-01-01T00:00:00Z"),
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    ...overrides,
  };
}

const master = makeMember(MASTER_ID, { occupation: null });
const loser = makeMember(LOSER_ID, { occupation: "Engineer" });

function validToken() {
  const core: MemberMergePreviewCore = {
    fieldMerge: mergeMemberFields(
      master as unknown as Record<string, unknown>,
      loser as unknown as Record<string, unknown>,
    ).diff,
    relationMoves: [],
    collisions: [],
    blockers: [],
    warnings: [],
  };
  return buildMemberMergePreviewToken(
    MASTER_ID,
    LOSER_ID,
    master.updatedAt,
    loser.updatedAt,
    core,
  );
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Build a mock transaction client. `overrides` supplies specific delegates;
 * everything else falls back to a benign default delegate (0 counts, empty
 * findMany, etc.). Returns { tx, spies } where spies are the shared delegates
 * used for assertions.
 */
/**
 * A member row shaped as `EMAIL_INHERITANCE_SUBJECT_SELECT` returns it — every
 * selected column present and NULL, never absent. Real Prisma never hands back a
 * selected column as `undefined`, and the reconciler's "did the pointer move?"
 * test is `next === before.inheritEmailFromId`: a bare `{ id }` row makes that
 * `null === undefined` (a false "moved"), which would spuriously write and audit
 * an effective-source change the merge never made (#2822).
 */
function reconcileSubjectRows(ids: string[]) {
  return ids
    .slice()
    .sort()
    .map((id) => ({
      id,
      inheritParentEmail: false,
      parentMemberId: null,
      secondaryParentId: null,
      inheritEmailChoiceId: null,
      inheritEmailFromId: null,
    }));
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const memberDelegate = {
    ...defaultDelegate(),
    findMany: vi.fn(({ where }: { where?: { id?: { in?: string[] } } }) =>
      Promise.resolve(reconcileSubjectRows(where?.id?.in ?? [])),
    ),
    findUnique: vi.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
    ),
    // actorIsFullAdmin -> 1 for the actor; wouldRemoveLastFullAdmin(loser) -> 0.
    count: vi.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
    ),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };

  const cache = new Map<string, unknown>();
  const overriddenMember = overrides.member as
    | (Record<string, unknown> & {
        findMany?: (args: unknown) => unknown;
      })
    | undefined;
  cache.set(
    "member",
    overriddenMember
      ? {
          ...overriddenMember,
          findMany: vi.fn((args: unknown) => {
            const ids = (
              args as { where?: { id?: { in?: string[] } } }
            ).where?.id?.in;
            if (ids) {
              return Promise.resolve(reconcileSubjectRows(ids));
            }
            return overriddenMember.findMany?.(args) ?? Promise.resolve([]);
          }),
        }
      : memberDelegate,
  );
  cache.set("auditLog", overrides.auditLog ?? { create: vi.fn().mockResolvedValue({}) });

  // One stable spy lets tests distinguish advisory-lock statements from the
  // id-ordered Member `FOR UPDATE` statement (#2243, #2597).
  const executeRaw = vi.fn().mockResolvedValue(0);

  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$executeRaw") return executeRaw;
        if (prop === "member") return cache.get("member");
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );

  // The real Prisma client exposes BOTH `$transaction` and the model delegates
  // (`auditLog`, `member`, …). The refused-member-merge audit (#2498) is written
  // on this base client OUTSIDE the rolled-back transaction, so the mock must
  // serve `client.auditLog` from the SAME shared cache as `tx.auditLog` for a
  // test to observe it.
  const client = new Proxy(
    { $transaction: (cb: (tx: unknown) => unknown) => cb(tx) },
    {
      get(target, prop: string) {
        if (prop === "$transaction") {
          return (target as { $transaction: unknown }).$transaction;
        }
        if (prop === "member") return cache.get("member");
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );

  return {
    client,
    tx,
    executeRaw,
    member: cache.get("member"),
    auditLog: cache.get("auditLog"),
  };
}

type AuditCreateSpy = ReturnType<typeof vi.fn>;

function rawStatement(input: unknown): string {
  if (Array.isArray(input)) return input.join("?");
  const strings = (input as { strings?: readonly string[] })?.strings;
  return strings ? strings.join("?") : String(input);
}

/** MEMBER_MERGE_REFUSED audit rows written by the refusal boundary (#2498). */
function refusalAuditCalls(create: AuditCreateSpy) {
  return create.mock.calls.filter(
    ([arg]) =>
      (arg as { data?: { action?: string } })?.data?.action ===
      "MEMBER_MERGE_REFUSED",
  );
}

/** MEMBER_MERGED audit rows — written ONLY by a completed merge, never a refusal. */
function successAuditCalls(create: AuditCreateSpy) {
  return create.mock.calls.filter(
    ([arg]) =>
      (arg as { data?: { action?: string } })?.data?.action === "MEMBER_MERGED",
  );
}

/**
 * Assert a refusal was audited (#2498): at least one MEMBER_MERGE_REFUSED row
 * carrying the given reason code, and NO MEMBER_MERGED row claiming the merge
 * completed. Removing the refusal-audit call reddens every test that uses this.
 */
function expectRefusedAudit(create: AuditCreateSpy, code: string) {
  const refusals = refusalAuditCalls(create);
  expect(refusals.length).toBeGreaterThanOrEqual(1);
  const metadata = (
    refusals[0][0] as { data: { metadata: { reasonCode?: string } } }
  ).data.metadata;
  expect(metadata.reasonCode).toBe(code);
  expect(successAuditCalls(create)).toHaveLength(0);
}

describe("executeMemberMerge", () => {
  it("rejects a self-merge before opening a transaction", async () => {
    const { client } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: MASTER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "x",
        confirmationText: "x",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "same_member" });
  });

  it("merges: verifies token, moves history, writes MEMBER_MERGED audit, deletes the loser", async () => {
    const { client, member, auditLog } = makeClient();

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "  MERGE   Dup Person ",
      db: client as never,
    });

    expect(result.masterId).toBe(MASTER_ID);
    // Field merge patch (occupation filled from loser) applied to master.
    const memberSpy = member as { update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.update).toHaveBeenCalled();
    // One critical audit.
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(auditSpy.create).toHaveBeenCalledTimes(1);
    // Loser hard-deleted.
    expect(memberSpy.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("re-checks under the complete participant locks and rolls back when Xero recovery proof appears after preview", async () => {
    let lookup = 0;
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) => {
        lookup += 1;
        // The first master/loser pair is the transaction-opening guard pass.
        // The second pair is the dedicated re-check after the complete sorted
        // Member participant lock. Model proof appearing in that interval.
        if (lookup <= 2 || where.localId === MASTER_ID) return Promise.resolve(null);
        return Promise.resolve({
          id: "xero-op-late",
          responsePayload: {
            phase: "local_link_after_xero_resolution",
            providerContactCreated: true,
          },
        });
      }),
    };
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn().mockResolvedValue([]),
    };
    const { client, executeRaw, member, auditLog } = makeClient({
      xeroSyncOperation,
      xeroObjectLink,
    });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_blocked",
      details: {
        blockers: [
          expect.objectContaining({
            code: "loser_xero_contact_create_recovery_pending",
          }),
        ],
      },
    });

    expect(xeroSyncOperation.findFirst).toHaveBeenCalledTimes(4);
    const participantLockCall = executeRaw.mock.calls.findIndex(([statement]) =>
      rawStatement(statement).includes('FROM "Member"'),
    );
    expect(participantLockCall).toBeGreaterThanOrEqual(0);
    expect(
      xeroSyncOperation.findFirst.mock.invocationCallOrder[2],
    ).toBeGreaterThan(executeRaw.mock.invocationCallOrder[participantLockCall]);
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).not.toHaveBeenCalled();
    expect(xeroObjectLink.findMany).not.toHaveBeenCalled();
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_blocked",
    );
  });

  it("resolves family-group memberships without touching the retired role column (#2520)", async () => {
    // #2520 removed the `maxFamilyRole` upgrade from resolveFamilyGroupMembers.
    // Everything else it does must be bit-for-bit unchanged, so this pins the
    // real behaviour: a colliding membership is DROPPED (after re-pointing the
    // family's billing membership at the surviving row, so billing never dangles
    // at a deleted row), and a non-colliding membership is MOVED. The removed
    // write is pinned negatively — `update` must never be called, because the
    // only reason it ever was is gone.
    const SHARED_GROUP = "group-shared";
    const LOSER_ONLY_GROUP = "group-loser-only";
    const loserSharedRow = { id: "fgm-loser-shared", familyGroupId: SHARED_GROUP };
    const loserOnlyRow = { id: "fgm-loser-only", familyGroupId: LOSER_ONLY_GROUP };
    const masterSharedRow = { id: "fgm-master-shared", familyGroupId: SHARED_GROUP };

    const familyGroupMember = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId?: string } }) =>
        Promise.resolve(
          where?.memberId === LOSER_ID
            ? [loserSharedRow, loserOnlyRow]
            : where?.memberId === MASTER_ID
              ? [masterSharedRow]
              : [],
        ),
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const familyGroup = { ...defaultDelegate(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { client } = makeClient({ familyGroupMember, familyGroup });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // The colliding loser row is deleted; the non-colliding one is not.
    expect(familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [loserSharedRow.id] } },
    });
    // Family billing that pointed at the dropped row is re-pointed at the survivor.
    expect(familyGroup.updateMany).toHaveBeenCalledWith({
      where: { billingMembershipId: loserSharedRow.id },
      data: { billingMembershipId: masterSharedRow.id },
    });
    // Surviving loser memberships are re-pointed at the master.
    expect(familyGroupMember.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
    // The retired column is neither written…
    expect(familyGroupMember.update).not.toHaveBeenCalled();
    for (const [arg] of familyGroupMember.updateMany.mock.calls) {
      expect((arg as { data: Record<string, unknown> }).data).not.toHaveProperty("role");
    }
    // …nor projected. Every read of the delegate during a merge must be
    // narrowed, and none may name `role`. There are three: this resolver's two,
    // plus `collectMovedIdSample`'s generic per-spec `select: { id: true }` scan.
    const selects = familyGroupMember.findMany.mock.calls.map(
      ([arg]) => (arg as { select?: Record<string, unknown> }).select,
    );
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const select of selects) {
      expect(select).toBeDefined();
      expect(select).not.toHaveProperty("role");
    }
    // The resolver's own two reads take exactly the two columns it uses.
    const resolverSelects = selects.filter((s) => s && "familyGroupId" in s);
    expect(resolverSelects).toHaveLength(2);
    for (const select of resolverSelects) {
      expect(Object.keys(select!).sort()).toEqual(["familyGroupId", "id"]);
    }
  });

  it("nulls the loser's googleSub before delete and never transfers it to the master (#2035)", async () => {
    // Loser carries a linked Google account; master has none. googleSub is a
    // scalar @unique excluded from the field-fill lists, so the master must NOT
    // inherit it (no login-identity takeover), and the loser's is nulled before
    // the hard-delete. Recomputed preview token is unaffected (googleSub is not
    // a merged field), so validToken() still verifies.
    const loserWithGoogle = { ...loser, googleSub: "sub-loser" };
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID
            ? master
            : where.id === LOSER_ID
              ? loserWithGoogle
              : null,
        ),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client } = makeClient({ member: memberDelegate });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const updateCalls = memberDelegate.update.mock.calls.map(([arg]) => arg) as {
      where: { id: string };
      data: Record<string, unknown>;
    }[];
    // Loser's googleSub explicitly nulled.
    expect(updateCalls).toContainEqual({
      where: { id: LOSER_ID },
      data: { googleSub: null },
    });
    // Master is never written a googleSub value.
    for (const call of updateCalls) {
      if (call.where.id === MASTER_ID) {
        expect(call.data).not.toHaveProperty("googleSub");
      }
    }
    expect(memberDelegate.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("bounds every Member self-relation move to the captured ids and excludes the master's OWN row (#2243, #2445, #2437)", async () => {
    // Two write-side bounds on one predicate. The master exclusion (#2445): a
    // writer outside the member-lifecycle lock can set
    // `master.parentMemberId = loserId` after the transaction's opening
    // snapshot, and a blanket `updateMany({ where: { parentMemberId: loserId } })`
    // would rewrite the MASTER's own pointer to the master — master as its own
    // parent. The id bound (#2437): a third member's link at the duplicate that
    // commits after the token counts were captured must NOT be silently
    // absorbed onto the master (the family-graph guards never evaluated it) —
    // bounded to the captured ids it stays pointing at the duplicate, where the
    // step-5 inbound re-check refuses the merge.
    const { client, member } = makeClient();

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const selfRelationColumns = MEMBER_MERGE_RELATION_SPECS.filter(
      (s) => s.selfRelation && s.bucket === "move",
    ).map((s) => s.column);
    // All five of them — and the DMMF-driven flag test in
    // member-merge-dmmf.test.ts is what forces a new Member self-FK to carry
    // `selfRelation: true` and join this sweep shape. #2716's
    // `inheritEmailChoiceId` is the column that proves it works.
    expect(selfRelationColumns).toEqual([
      "parentMemberId",
      "secondaryParentId",
      "inheritEmailFromId",
      // #2716 added the fifth: the CHOICE behind the shared email address. It
      // moves with the pointer rather than after it, because a merge that
      // carried one and not the other would leave the surviving member with a
      // mailbox whose decision names a row that no longer exists.
      "inheritEmailChoiceId",
      "detailsConfirmedByMemberId",
    ]);

    const memberUpdateMany = (member as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    const wheres = memberUpdateMany.mock.calls.map(
      ([arg]) => (arg as { where: Record<string, unknown> }).where,
    );
    for (const column of selfRelationColumns) {
      // No captured rows in this mock, so the bound is the empty id list.
      expect(wheres).toContainEqual({
        [column]: LOSER_ID,
        id: { in: [], not: MASTER_ID },
      });
    }
  });

  it("re-points BookingRequest.convertedMemberId onto the master (#2243)", async () => {
    // Not an actor/audit column: it is the identity pointer the idempotent
    // approval replay hands back as a live member id, so left on the deleted
    // loser it would replay a conversion as a member that no longer exists.
    const bookingRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.convertedMemberId === LOSER_ID ? 1 : 0),
      ),
      updateMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve({ count: where.convertedMemberId === LOSER_ID ? 1 : 0 }),
      ),
    };
    const { client } = makeClient({ bookingRequest });

    // The preview counts it too, so the token digest must carry it.
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [{ model: "BookingRequest.convertedMemberId", count: 1 }],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: buildMemberMergePreviewToken(
        MASTER_ID,
        LOSER_ID,
        master.updatedAt,
        loser.updatedAt,
        core,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(bookingRequest.updateMany).toHaveBeenCalledWith({
      where: { convertedMemberId: LOSER_ID },
      data: { convertedMemberId: MASTER_ID },
    });
    expect(result.relationMoves).toContainEqual({
      model: "BookingRequest.convertedMemberId",
      count: 1,
    });
  });

  it("re-points queued hosting actor attribution before hard-deleting the loser", async () => {
    let actorRows = 1;
    const hostingCoverageReevaluation = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.actorMemberId === LOSER_ID ? 1 : 0),
      ),
      updateMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        if (where.actorMemberId !== LOSER_ID) {
          return Promise.resolve({ count: 0 });
        }
        const count = actorRows;
        actorRows = 0;
        return Promise.resolve({ count });
      }),
    };
    const { client } = makeClient({ hostingCoverageReevaluation });
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [
        {
          model: "HostingCoverageReevaluation.actorMemberId",
          count: 1,
        },
      ],
      collisions: [],
      blockers: [],
      warnings: [],
    };

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: buildMemberMergePreviewToken(
        MASTER_ID,
        LOSER_ID,
        master.updatedAt,
        loser.updatedAt,
        core,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(hostingCoverageReevaluation.updateMany).toHaveBeenCalledWith({
      where: { actorMemberId: LOSER_ID },
      data: { actorMemberId: MASTER_ID },
    });
    expect(result.relationMoves).toContainEqual({
      model: "HostingCoverageReevaluation.actorMemberId",
      count: 1,
    });
  });

  it("folds late hosting owner and actor sweeps into one result row per relation", async () => {
    let ownerSweep = 0;
    let actorSweep = 0;
    const hostingCoverageReevaluation = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.memberId === LOSER_ID || where.actorMemberId === LOSER_ID
            ? 1
            : 0,
        ),
      ),
      updateMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        if (where.memberId === LOSER_ID) {
          ownerSweep += 1;
          return Promise.resolve({ count: ownerSweep === 1 ? 1 : 2 });
        }
        if (where.actorMemberId === LOSER_ID) {
          actorSweep += 1;
          return Promise.resolve({ count: actorSweep === 1 ? 1 : 3 });
        }
        return Promise.resolve({ count: 0 });
      }),
    };
    const { client } = makeClient({ hostingCoverageReevaluation });
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [
        { model: "HostingCoverageReevaluation.member", count: 1 },
        {
          model: "HostingCoverageReevaluation.actorMemberId",
          count: 1,
        },
      ],
      collisions: [],
      blockers: [],
      warnings: [],
    };

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: buildMemberMergePreviewToken(
        MASTER_ID,
        LOSER_ID,
        master.updatedAt,
        loser.updatedAt,
        core,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(
      result.relationMoves.filter(
        (move) => move.model === "HostingCoverageReevaluation.member",
      ),
    ).toEqual([
      { model: "HostingCoverageReevaluation.member", count: 3 },
    ]);
    expect(
      result.relationMoves.filter(
        (move) =>
          move.model === "HostingCoverageReevaluation.actorMemberId",
      ),
    ).toEqual([
      {
        model: "HostingCoverageReevaluation.actorMemberId",
        count: 4,
      },
    ]);
  });

  it("refuses a loser-linked guest inserted after the generic sweep even when its booking was already planned", async () => {
    let guestRead = 0;
    const bookingGuest = {
      ...defaultDelegate(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(() => {
        guestRead += 1;
        // collectMovedIdSample reads first. The residual read after the one
        // sorted Member FOR UPDATE statement sees the late committed row.
        return Promise.resolve(
          guestRead === 1
            ? []
            : [{ id: "late-guest", bookingId: "already-planned-booking" }],
        );
      }),
    };
    const { client, member, auditLog } = makeClient({ bookingGuest });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: {
        driftFields: ["BookingGuest.member"],
        bookingGuestIds: ["late-guest"],
        bookingIds: ["already-planned-booking"],
      },
    });

    expect(bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).not.toHaveBeenCalled();
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it("refuses a loser-owned booking that appears after the bounded ownership capture", async () => {
    const booking = {
      ...defaultDelegate(),
      findMany: vi.fn((args: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
      }) => {
        if (args.where?.memberId === LOSER_ID && args.orderBy) {
          return Promise.resolve([{ id: "late-booking" }]);
        }
        return Promise.resolve([]);
      }),
    };
    const { client, member, auditLog } = makeClient({ booking });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: {
        driftFields: ["Booking.member"],
        bookingIds: ["late-booking"],
      },
    });

    expect(
      (member as { delete: ReturnType<typeof vi.fn> }).delete,
    ).not.toHaveBeenCalled();
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it("hands the MASTER's id to the conversion replay path after the merge (#2243)", async () => {
    // End of the chain: `claimAlreadyConvertedBookingRequest` is what
    // booking-request.ts and school-booking-request.ts read the pointer through.
    // After the move above it must return the surviving member.
    const tx = {
      bookingRequest: {
        findUnique: vi.fn().mockResolvedValue({
          convertedBookingId: "booking-1",
          convertedMemberId: MASTER_ID, // re-pointed by the merge
          status: BookingRequestStatus.CONVERTED,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    await expect(
      claimAlreadyConvertedBookingRequest(tx as never, "req-1"),
    ).resolves.toEqual({ convertedBookingId: "booking-1", convertedMemberId: MASTER_ID });
  });

  it("returns 409 preview_drift when the token does not match current state", async () => {
    const { client, member } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "stale-token",
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "preview_drift" });
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("returns 422 when the confirmation phrase is wrong (loser not deleted)", async () => {
    const { client, member } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Wrong Name",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "confirmation_mismatch" });
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("blocks (409) when the actor is not a Full Admin; loser untouched", async () => {
    const nonAdminMember = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
      ),
      count: vi.fn().mockResolvedValue(0), // actor not a full admin
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client } = makeClient({ member: nonAdminMember });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });
    expect(nonAdminMember.delete).not.toHaveBeenCalled();
  });

  it("blocks when the loser holds an admin access role", async () => {
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      delete: vi.fn().mockResolvedValue({}),
    };
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(where.memberId === LOSER_ID ? [{ role: "ADMIN" }] : []),
      ),
    };
    const { client } = makeClient({ member: memberDelegate, memberAccessRole });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });
    expect(memberDelegate.delete).not.toHaveBeenCalled();
  });

  it("rolls back (no delete, no audit) when a move fails mid-transaction", async () => {
    const booking = {
      ...defaultDelegate(),
      updateMany: vi.fn().mockRejectedValue(new Error("db exploded during move")),
    };
    const { client, member, auditLog } = makeClient({ booking });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toThrow("db exploded during move");

    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
    expect(auditSpy.create).not.toHaveBeenCalled();
  });

  it("re-points the loser's ENTRANCE_FEE_INVOICE link to the master", async () => {
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "x1",
          role: "ENTRANCE_FEE_INVOICE",
          xeroObjectType: "Invoice",
          xeroObjectId: "inv-1",
          active: true,
        },
      ]),
      count: vi.fn().mockResolvedValue(0), // master has no entrance-fee link
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const { client } = makeClient({ xeroObjectLink });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(xeroObjectLink.update).toHaveBeenCalledWith({
      where: { id: "x1" },
      data: { localId: MASTER_ID },
    });
  });

  it("deactivates the loser's ENTRANCE_FEE_INVOICE link when the master already has one", async () => {
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "x1",
          role: "ENTRANCE_FEE_INVOICE",
          xeroObjectType: "Invoice",
          xeroObjectId: "inv-1",
          active: true,
        },
      ]),
      count: vi.fn().mockResolvedValue(1), // master already has an entrance-fee link
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const { client } = makeClient({ xeroObjectLink });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(xeroObjectLink.update).toHaveBeenCalledWith({
      where: { id: "x1" },
      data: { active: false },
    });
  });
});

describe("subscription collision handling at execute time (B1)", () => {
  /**
   * memberSubscription delegate: `count` (used for the token collision
   * summary) stays 0 so validToken() matches; `findMany` distinguishes the
   * guard's meaningful-loser query (has `OR`) from the resolver's plain
   * member queries (no `OR`).
   */
  function subscriptionDelegate(config: {
    masterRows: { id: string; seasonYear: number }[];
    loserRows: { id: string; seasonYear: number }[];
    loserMeaningfulSeasons: number[];
  }) {
    return {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId?: string; OR?: unknown } }) => {
        if (where.OR) {
          return Promise.resolve(
            where.memberId === LOSER_ID
              ? config.loserMeaningfulSeasons.map((seasonYear) => ({ seasonYear }))
              : [],
          );
        }
        if (where.memberId === LOSER_ID) return Promise.resolve(config.loserRows);
        if (where.memberId === MASTER_ID) return Promise.resolve(config.masterRows);
        return Promise.resolve([]);
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
  }

  it("blocks in-tx when a meaningful loser subscription collides with ANY master row (no delete, no drop)", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [{ id: "MS1", seasonYear: 2026 }], // master's row may be meaningless
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [2026], // loser's is PAID/invoiced/covered
    });
    const { client, member } = makeClient({ memberSubscription });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });

    expect(memberSubscription.deleteMany).not.toHaveBeenCalled();
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("drops a MEANINGLESS colliding loser subscription row (both-meaningless case)", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [{ id: "MS1", seasonYear: 2026 }],
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [], // loser row is NOT_INVOICED with no history
    });
    const { client } = makeClient({ memberSubscription });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["LS1"] } },
    });
    expect(memberSubscription.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
  });

  it("moves a loser-only subscription (even a meaningful one) without dropping anything", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [], // master has no row for the season
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [2026],
    });
    const { client } = makeClient({ memberSubscription });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberSubscription.deleteMany).not.toHaveBeenCalled();
    expect(memberSubscription.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
  });
});

describe("partner-link warnings reach the audit metadata (M3)", () => {
  it("records the CONFIRMED-drop warning in the MEMBER_MERGED audit", async () => {
    const loserLinks = [
      { id: "L1", memberAId: LOSER_ID, memberBId: "zzz-third", status: "CONFIRMED" },
    ];
    const masterLinks = [
      { id: "M1", memberAId: MASTER_ID, memberBId: "yyy-partner", status: "CONFIRMED" },
    ];
    const memberPartnerLink = {
      ...defaultDelegate(),
      findMany: vi.fn(
        ({ where }: { where: { OR?: { memberAId?: string }[] } }) =>
          Promise.resolve(
            where.OR?.[0]?.memberAId === LOSER_ID ? loserLinks : masterLinks,
          ),
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    };
    const { client, auditLog } = makeClient({ memberPartnerLink });

    // The token digest includes the partner collision summary, so build it
    // exactly as the execute path will compute it pre-mutation.
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [],
      collisions: [
        {
          model: "MemberPartnerLink.memberA/memberB",
          resolution: "re-point 0, drop 1 (self-pair/duplicate/confirmed)",
          count: 1,
        },
      ],
      blockers: [],
      warnings: [],
    };
    const token = buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      master.updatedAt,
      loser.updatedAt,
      core,
    );

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: token,
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberPartnerLink.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["L1"] } },
    });
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(auditSpy.create).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(auditSpy.create.mock.calls[0][0]);
    expect(serialized).toContain("resolutionWarnings");
    expect(serialized).toContain("confirmed partner link dropped");
  });
});

describe("member-photo reconciliation at execute time (MP1, #189)", () => {
  /** A member delegate whose findUnique returns the supplied photo-bearing pair. */
  function photoMemberDelegate(masterRow: unknown, loserRow: unknown) {
    return {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID ? masterRow : where.id === LOSER_ID ? loserRow : null,
        ),
      ),
      // actorIsFullAdmin -> 1 for the actor; every other count (e.g.
      // wouldRemoveLastFullAdmin) -> 0.
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
  }

  function photoToken(masterRow: Record<string, unknown>, loserRow: Record<string, unknown>) {
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(masterRow, loserRow).diff,
      relationMoves: [],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    return buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      masterRow.updatedAt as Date,
      loserRow.updatedAt as Date,
      core,
    );
  }

  /**
   * A member delegate whose loser reads flip from `stale` to `fresh` the moment
   * the merge reaches its Xero teardown (step 4) — i.e. after the
   * top-of-transaction snapshot, the guards and the preview-token check have all
   * read the loser, and before the field merge writes.
   *
   * That is exactly where a real on-behalf photo upload has to commit to cause
   * #2243: the photo route takes no member-lifecycle advisory lock, and the
   * merge does not hold the loser's ROW lock until `teardownLoserXero`'s
   * unconditional `member.update`.
   *
   * The master's `update` refuses a patch naming the deleted blob "L1" with a
   * Prisma P2003, standing in for the real `Member_photoImageId_fkey` violation
   * that rolls the whole merge back as a bare 500.
   */
  function raceHarness(
    masterRow: Record<string, unknown>,
    stale: Record<string, unknown>,
    fresh: Record<string, unknown>,
  ) {
    let uploadLanded = false;
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        if (where.id === MASTER_ID) return Promise.resolve(masterRow);
        if (where.id !== LOSER_ID) return Promise.resolve(null);
        return Promise.resolve(uploadLanded ? fresh : stale);
      }),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id === MASTER_ID && data.photoImageId === "L1") {
            return Promise.reject(
              Object.assign(
                new Error(
                  "Foreign key constraint violated on the constraint: `Member_photoImageId_fkey`",
                ),
                { code: "P2003" },
              ),
            );
          }
          return Promise.resolve({});
        },
      ),
      delete: vi.fn().mockResolvedValue({}),
    };
    // Step 4 runs between the snapshot and the field merge; landing the upload
    // here is what makes the snapshot stale at write time.
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn(() => {
        uploadLanded = true;
        return Promise.resolve([]);
      }),
    };
    return { memberDelegate, xeroObjectLink };
  }

  it("keeps the master's photo and deletes the loser's orphaned MEMBER_PHOTO blob", async () => {
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: "master-img" });
    const loserRow = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "loser-img" });
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { client, member } = makeClient({
      member: photoMemberDelegate(masterRow, loserRow),
      mediaImage,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        loserRow as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // Master keeps master-img; the loser's own MEMBER_PHOTO plus any blob it
    // uploaded that no OTHER surviving member references is swept, excluding the
    // master's kept photo. The `photoOfMembers` carve-out spares photos the
    // loser uploaded on behalf of members who still reference them.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "loser-img" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "master-img" },
      },
    });
    // The loser is still hard-deleted.
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("absorbs the loser's photo when the master has none and never deletes the absorbed blob", async () => {
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: null });
    const loserRow = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "loser-img" });
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
    const { client, member } = makeClient({
      member: photoMemberDelegate(masterRow, loserRow),
      mediaImage,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        loserRow as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // Master absorbs loser-img via the field merge...
    const memberSpy = member as { update: ReturnType<typeof vi.fn> };
    expect(memberSpy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MASTER_ID },
        data: expect.objectContaining({ photoImageId: "loser-img" }),
      }),
    );
    // ...and the sweep excludes loser-img (now the master's photo) from deletion.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "loser-img" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "loser-img" },
      },
    });
  });

  it("sweeps the loser's CURRENT photo (read fresh under lock), not the stale snapshot", async () => {
    // Race: an admin POSTs a photo ON BEHALF OF the loser AFTER the merge's
    // top-of-transaction `loserFull` snapshot (photoImageId "L1") but BEFORE the
    // field merge. The upload creates blob "L2" (uploadedByMemberId = the ADMIN,
    // NOT the loser), repoints the loser to L2 and deletes L1. By field-merge time
    // the loser row is row-locked (teardownLoserXero's member.update), so a fresh
    // locked read returns L2 — the value the sweep must key on so L2 is not
    // orphaned once the loser is hard-deleted.
    //
    // The upload is modelled as landing during the Xero teardown (step 4), which
    // is where the real one has to land: after the snapshot, before the merge
    // takes the loser's row lock.
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: "master-img" });
    const staleLoser = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "L1" });
    const freshLoser = { ...staleLoser, photoImageId: "L2" };
    const race = raceHarness(masterRow, staleLoser, freshLoser);
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { client, member } = makeClient({
      member: race.memberDelegate,
      xeroObjectLink: race.xeroObjectLink,
      mediaImage,
    });

    // The preview token is built from the stale snapshot (what the admin saw when
    // opening the merge). Master keeps its own photo, so photoImageId is not in
    // the field-merge patch and the token is unaffected by the loser's pointer.
    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        staleLoser as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // The sweep predicate keys on the FRESH pointer L2 (not the stale L1), so the
    // just-created L2 blob — still referenced only by the loser at reconcile time
    // — is swept and cannot orphan once the loser is deleted.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "L2" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "master-img" },
      },
    });
    // Guard against regression: the stale L1 must NOT be the swept id.
    const sweep = mediaImage.deleteMany.mock.calls[0][0] as {
      where: { OR: { id?: string }[] };
    };
    expect(sweep.where.OR).not.toContainEqual({ id: "L1" });
    // The loser is still hard-deleted.
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith({
      where: { id: LOSER_ID },
    });
  });

  // -------------------------------------------------------------------------
  // #2243 — the field-merge PATCH must come from the fresh read too.
  // -------------------------------------------------------------------------

  it("REFUSES a mid-merge change with a 409 instead of applying values nobody previewed (#2243)", async () => {
    // The master has no photo, so the field merge absorbs the loser's — putting a
    // real FK value (`Member.photoImageId` -> `MediaImage`) into the patch. The
    // racing on-behalf upload deletes blob L1 and repoints the loser to L2. A
    // patch derived from the transaction-opening snapshot would write the deleted
    // L1 and roll the ENTIRE merge back on a Postgres 23503 / Prisma P2003, as a
    // bare 500 the preview could not have predicted (the token verifies against
    // that same stale snapshot, so it passes).
    //
    // The fix detects that from the FRESH read BEFORE the write — so the stale FK
    // never reaches Postgres — and then REFUSES rather than silently applying the
    // fresh value, because what was previewed must be exactly what is applied.
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: null });
    const staleLoser = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "L1" });
    const freshLoser = { ...staleLoser, photoImageId: "L2" };
    // `raceHarness` is single-shot (its upload latch never resets), so each
    // attempt gets its own.
    function attempt() {
      const race = raceHarness(masterRow, staleLoser, freshLoser);
      const mediaImage = {
        ...defaultDelegate(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      };
      const { client, auditLog } = makeClient({
        member: race.memberDelegate,
        xeroObjectLink: race.xeroObjectLink,
        mediaImage,
      });
      return {
        race,
        auditLog: auditLog as { create: ReturnType<typeof vi.fn> },
        run: () =>
          executeMemberMerge({
            masterId: MASTER_ID,
            loserId: LOSER_ID,
            actorMemberId: ACTOR_ID,
            previewToken: photoToken(
              masterRow as unknown as Record<string, unknown>,
              staleLoser as unknown as Record<string, unknown>,
            ),
            confirmationText: "MERGE Dup Person",
            db: client as never,
          }),
      };
    }

    const first = attempt();
    await expect(first.run()).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: { driftFields: ["photoImageId"] },
    });

    // Plain English, and it names the field that moved.
    await expect(attempt().run()).rejects.toThrow(
      /changed while the merge was running: photoImageId/,
    );

    // Nothing was written to the master, the loser survives, and no SUCCESS
    // audit claims a merge happened — but the refusal itself is now recorded
    // (#2498). (The real transaction rolls back; the mock has none, so assert
    // the merge never got that far.)
    const masterPatches = first.race.memberDelegate.update.mock.calls
      .map(([arg]) => arg as { where: { id: string } })
      .filter((call) => call.where.id === MASTER_ID);
    expect(masterPatches).toHaveLength(0);
    expect(first.race.memberDelegate.delete).not.toHaveBeenCalled();
    expectRefusedAudit(first.auditLog.create, "merge_drift_in_transaction");
  });

  it("does NOT 409 an ordinary uncontended merge (#2243 negative control)", async () => {
    // The refusal above must stay silent when nothing races, or every merge
    // becomes a 409 and the feature is unusable.
    const { client, auditLog, member } = makeClient();

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(result.masterId).toBe(MASTER_ID);
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith({
      where: { id: LOSER_ID },
    });
    // A committed merge can no longer carry drift, so the audit records none.
    const auditSpy = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    const metadata = (auditSpy.mock.calls[0][0] as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(metadata).not.toHaveProperty("fieldMergeDriftFields");
  });

  it("nulls and audits a googleSub that appeared AFTER the transaction opened (#2243)", async () => {
    // The Google link lands mid-transaction (the sign-in path takes no
    // member-lifecycle lock). Reading `googleSub` from the transaction-opening
    // snapshot would leave it set on a row about to be hard-deleted — and would
    // break the promise the code makes right there, that "the sub is recorded in
    // the loser snapshot audited above". googleSub is not a merged field, so
    // this does not (and must not) trip the drift refusal.
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: "master-img" });
    const staleLoser = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "master-img" });
    const freshLoser = { ...staleLoser, googleSub: "sub-landed-mid-merge" };
    const race = raceHarness(masterRow, staleLoser, freshLoser);
    const { client, auditLog } = makeClient({
      member: race.memberDelegate,
      xeroObjectLink: race.xeroObjectLink,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        staleLoser as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(race.memberDelegate.update.mock.calls.map(([arg]) => arg)).toContainEqual({
      where: { id: LOSER_ID },
      data: { googleSub: null },
    });
    const auditSpy = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    const metadata = (
      auditSpy.mock.calls[0][0] as {
        data: { metadata: { loserSnapshot: { googleSub: string | null } } };
      }
    ).data.metadata;
    expect(metadata.loserSnapshot.googleSub).toBe("sub-landed-mid-merge");
  });

  it("keeps the audited xeroContactId from the transaction's opening row (#2243)", async () => {
    // The merge itself nulls the loser's `xeroContactId` at the Xero teardown, so
    // the fresh pre-write row reports null. The audit must still name the contact
    // that was torn down — this vintage is deliberately NOT the fresh one.
    const masterRow = makeMember(MASTER_ID, { occupation: null });
    const staleLoser = makeMember(LOSER_ID, { occupation: "Engineer", xeroContactId: "xc-1" });
    const freshLoser = { ...staleLoser, xeroContactId: null };
    const race = raceHarness(masterRow, staleLoser, freshLoser);
    const { client, auditLog } = makeClient({
      member: race.memberDelegate,
      xeroObjectLink: race.xeroObjectLink,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        staleLoser as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const auditSpy = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    const metadata = (
      auditSpy.mock.calls[0][0] as {
        data: { metadata: { loserSnapshot: { xeroContactId: string | null } } };
      }
    ).data.metadata;
    expect(metadata.loserSnapshot.xeroContactId).toBe("xc-1");
  });

  it("row-locks BOTH members in id order immediately before the fresh read (#2243)", async () => {
    // Without the master's row lock a concurrent on-behalf upload FOR THE MASTER
    // can commit blob M2 between the fresh read and the update; the merge then
    // overwrites the pointer and nothing sweeps M2 (the reconcile only sweeps the
    // LOSER's blobs), leaving an orphaned public asset.
    const { client, executeRaw } = makeClient();

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const statements = executeRaw.mock.calls.map(([statement]) =>
      rawStatement(statement),
    );
    const rowLockIndex = statements.findIndex((s) => s.includes("FOR UPDATE"));
    expect(rowLockIndex).toBeGreaterThanOrEqual(0);
    expect(statements[rowLockIndex]).toContain('FROM "Member"');
    expect(statements[rowLockIndex]).toContain('ORDER BY "id"');
    // One statement covering both ids, sorted — same ordering rule as the two
    // advisory locks above it, so the mirror merge cannot deadlock against it.
    const lockInput = executeRaw.mock.calls[rowLockIndex][0] as {
      values?: string[];
    };
    const lockArgs =
      lockInput.values ??
      (executeRaw.mock.calls[rowLockIndex].slice(1) as string[]);
    expect(lockArgs).toEqual([MASTER_ID, LOSER_ID].sort());
    // Hosting policy-set first, then the #2595 partner-share lodge prefix, then
    // both lifecycle keys in sorted order. This is the counterpart order shared
    // with policy reconciliation and the drain.
    expect(
      statements
        .slice(0, 3)
        .every((s) => s.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(executeRaw.mock.calls[0][1]).toBe(
      ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY,
    );
    // #2595 — merge's partner-share prefix is the affected LODGE capacity keys
    // and NOTHING ELSE. This fixture's members hold no future allocation and no
    // future guest-night, so the derived set is empty and the two member-lifecycle
    // keys follow the policy-set key directly;
    // `acquireMemberMergePartnerSharedLodgeLocks` owns the derivation and
    // `bed-allocation-lifecycle.test.ts` covers it.
    expect(executeRaw.mock.calls.slice(1, 3).map((call) => call[1])).toEqual(
      [MASTER_ID, LOSER_ID]
        .sort()
        .map((id) => `member-lifecycle:${id}`),
    );
    // #2595 — and then the partner-link pair, LAST and sorted. Merge writes
    // partner links (step 2) and reads them to decide which future shared
    // doubles step 3b deletes; the CONFIRMED partial uniques are per side, so
    // this key is the only thing enforcing "at most one confirmed partner".
    // Pinned by position as well as presence: taking it BEFORE member-lifecycle
    // would invert the order the reviewed move uses and create a wait-graph edge
    // that does not exist today.
    expect(executeRaw.mock.calls.slice(3, 5).map((call) => call[1])).toEqual(
      [MASTER_ID, LOSER_ID]
        .sort()
        .map((id) => `member-partner-link:${id}`),
    );
    // The owner decision on #2595, pinned: a merge must NEVER take the global
    // cohort key. It is held until COMMIT and a merge runs on a 120s budget, so
    // taking it here rejects every 5s-budget cohort writer in the club. Written
    // as a whole-transaction assertion, not a positional one, so re-adding it
    // anywhere in `executeMemberMerge` fails this test.
    expect(
      statements.filter((s) => /pg_advisory_xact_lock\(\s*1\s*\)/.test(s)),
    ).toEqual([]);
  });

  it("409s partner_share_lodge_drift when step 3b finds a bed-night in a lodge it never locked", async () => {
    // #2595 — the run-time enforcement of the guest-night derivation, end to
    // end. `acquireMemberMergePartnerSharedLodgeLocks` derives the lodge set
    // from the two members' future allocations and guest-nights; the sweep is
    // handed that exact set and REFUSES if a candidate row turns up outside it,
    // rather than deleting bed inventory in a lodge this transaction never
    // serialised against. That is only reachable when a lodge appears for one of
    // the members AFTER the derivation — a booking guest row added by a
    // concurrent writer — so it is a drift refusal in the same shape as the ones
    // above it, and the operator's retry derives the new lodge and covers it.
    //
    // `bed-allocation-lifecycle.test.ts` proves the sweep throws. Only this test
    // proves `executeMemberMerge` turns that into a 409 with the right code and
    // lodge ids, refuses BEFORE deleting the loser, and audits the refusal.
    const UNLOCKED_LODGE_ID = "lodge-appeared-mid-merge";
    const bedAllocation = {
      ...defaultDelegate(),
      findMany: vi.fn((args: unknown) => {
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        // The prefix's own derivation read: no future allocation anywhere, and
        // `bookingGuest.findMany` defaults to empty too, so the locked lodge set
        // is EMPTY and any candidate at all is out of scope.
        if (where.isSecondOccupant !== true) return Promise.resolve([]);
        // The sweep's first candidate query, in a lodge nobody locked.
        return Promise.resolve([
          {
            id: "alloc-in-unlocked-lodge",
            bookingId: "booking-x",
            bookingGuestId: "guest-x",
            bedId: "bed-x",
            roomId: "room-x",
            stayDate: new Date("2099-08-01"),
            bookingGuest: {
              memberId: MASTER_ID,
              firstName: "Pat",
              lastName: "Pine",
            },
            room: { lodgeId: UNLOCKED_LODGE_ID },
          },
        ]);
      }),
    };
    const { client, auditLog } = makeClient({ bedAllocation });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "partner_share_lodge_drift",
      details: { lodgeIds: [UNLOCKED_LODGE_ID] },
    });

    // Refused, not repaired: nothing was deleted in the unlocked lodge and the
    // loser survives (the real transaction rolls back; the mock has none, so
    // assert the merge never got that far).
    expect(bedAllocation.deleteMany).not.toHaveBeenCalled();
    expectRefusedAudit(
      (auditLog as { create: AuditCreateSpy }).create,
      "partner_share_lodge_drift",
    );

    // Plain English for the operator, and it does NOT leak the lodge id into
    // the message the admin sees.
    const message = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: makeClient({ bedAllocation }).client as never,
    }).catch((err: Error) => err.message);
    expect(message).toMatch(/changed while the merge was running/i);
    expect(message).not.toContain(UNLOCKED_LODGE_ID);
  });

  it("holds the policy set through booking moves and loser deletion so a late reconcile sees the survivor", async () => {
    let bookingOwnerId = LOSER_ID;
    const queuedOwners: string[] = [];
    const booking = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: Record<string, any> }) => {
        if (where.memberId === LOSER_ID) {
          return Promise.resolve(
            bookingOwnerId === LOSER_ID ? [{ id: "booking-1" }] : [],
          );
        }
        if (where.id?.in?.includes("booking-1")) {
          return Promise.resolve([
            {
              id: "booking-1",
              memberId: bookingOwnerId,
              lodgeId: "lodge-1",
              checkIn: new Date("2026-08-01T00:00:00Z"),
              checkOut: new Date("2026-08-02T00:00:00Z"),
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.memberId === LOSER_ID ? 1 : 0),
      ),
      updateMany: vi.fn(
        ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.memberId === LOSER_ID && data.memberId === MASTER_ID) {
            bookingOwnerId = MASTER_ID;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
      ),
    };
    const { client, executeRaw, member } = makeClient({ booking });

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const mergeHasPolicyLock = deferred();
    const letMergeContinue = deferred();
    const mergeCommitted = deferred();

    executeRaw.mockImplementation(async (strings, ...values) => {
      const statement = rawStatement(strings);
      if (
        statement.includes("pg_advisory_xact_lock") &&
        values[0] === ADULT_MEMBER_HOSTING_POLICY_SET_LOCK_KEY
      ) {
        mergeHasPolicyLock.resolve();
        await letMergeContinue.promise;
      }
      return 0;
    });

    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [{ model: "Booking.member", count: 1 }],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    const merge = executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: buildMemberMergePreviewToken(
        MASTER_ID,
        LOSER_ID,
        master.updatedAt,
        loser.updatedAt,
        core,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });
    await mergeHasPolicyLock.promise;

    // This is the old lost-row window: policy reconciliation starts after merge
    // has begun but before its relation sweep. Its real helper must wait for the
    // merge transaction to commit before it can read ownership and enqueue.
    const policyWriterRaw = vi.fn(async () => {
      await mergeCommitted.promise;
      return 0;
    });
    const policyWriter = (async () => {
      await lockAdultMemberHostingPolicySet({
        $executeRaw: policyWriterRaw,
      } as never);
      if (bookingOwnerId === LOSER_ID) {
        throw new Error("policy reconciliation observed the deleted merge loser");
      }
      queuedOwners.push(bookingOwnerId);
    })();
    await Promise.resolve();
    expect(policyWriterRaw).toHaveBeenCalledTimes(1);
    expect(queuedOwners).toEqual([]);

    letMergeContinue.resolve();
    await merge;
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith({
      where: { id: LOSER_ID },
    });
    expect(bookingOwnerId).toBe(MASTER_ID);
    mergeCommitted.resolve();
    await policyWriter;
    expect(queuedOwners).toEqual([MASTER_ID]);
  });
});

// ---------------------------------------------------------------------------
// #2437 — family links are re-checked under the lock; drift refuses the merge
// ---------------------------------------------------------------------------
//
// The four Member self-relation columns are written by admin paths that take no
// member-lifecycle advisory lock (admin-members-service.ts, the dependents link
// route), so a family link can land mid-merge. #2445 already keeps the master's
// own row out of the moves, so the master can never become its own parent; what
// these prove is the OTHER arm: the concurrently-saved link is not silently
// LOST either (the loser's hard-delete would null it via onDelete: SetNull with
// no error and no audit). Any mid-merge change to the four columns — on the
// master, on the duplicate, or an inbound link from a third member still
// pointing at the duplicate after the moves — refuses with the same 409 drift
// refusal as the field check, and nothing is written.
describe("family-link drift under the lock (#2437)", () => {
  const SELF_RELATION_COLUMNS = [
    "parentMemberId",
    "secondaryParentId",
    "inheritEmailFromId",
    // #2716: the choice behind the shared email address.
    "inheritEmailChoiceId",
    "detailsConfirmedByMemberId",
  ] as const;

  function tokenFor(
    masterRow: Record<string, unknown>,
    loserRow: Record<string, unknown>,
  ) {
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(masterRow, loserRow).diff,
      relationMoves: [],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    return buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      masterRow.updatedAt as Date,
      loserRow.updatedAt as Date,
      core,
    );
  }

  /**
   * A member delegate whose master/loser reads flip from `stale` to `fresh`
   * the moment the merge reaches its Xero teardown (step 4) — after the
   * snapshot, the guards, step 1's self-cycle nulling and the token check have
   * all consumed the stale rows, and before the step-5 under-lock fresh read.
   * Same landing window as the #2243 raceHarness, because it is where a real
   * unlocked family-link write has to commit to be missed by the snapshot yet
   * visible to the under-lock re-read.
   */
  function familyLinkRace(
    masterStale: Record<string, unknown>,
    masterFresh: Record<string, unknown>,
    loserStale: Record<string, unknown>,
    loserFresh: Record<string, unknown>,
  ) {
    let linkLanded = false;
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        if (where.id === MASTER_ID) {
          return Promise.resolve(linkLanded ? masterFresh : masterStale);
        }
        if (where.id === LOSER_ID) {
          return Promise.resolve(linkLanded ? loserFresh : loserStale);
        }
        return Promise.resolve(null);
      }),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn(() => {
        linkLanded = true;
        return Promise.resolve([]);
      }),
    };
    return { memberDelegate, xeroObjectLink };
  }

  /**
   * A tiny predicate interpreter over an in-memory Member store, so the
   * interleaving tests exercise the merge against QUERY SEMANTICS rather than
   * canned per-call return values: step 1's value-conditional null, the
   * id-bounded sweep and the step-5 re-reads all evaluate their real
   * predicates against the same mutable rows, and a concurrent write injected
   * mid-merge propagates — or is refused — exactly as it would in Postgres
   * under READ COMMITTED. Supports the operators the merge actually issues:
   * scalar equality, in / notIn / not, OR and AND.
   */
  function rowMatches(
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "OR") {
        if (!(cond as Record<string, unknown>[]).some((c) => rowMatches(row, c))) {
          return false;
        }
        continue;
      }
      if (key === "AND") {
        const clauses = (Array.isArray(cond) ? cond : [cond]) as Record<string, unknown>[];
        if (!clauses.every((c) => rowMatches(row, c))) return false;
        continue;
      }
      const value = row[key] ?? null;
      if (cond !== null && typeof cond === "object") {
        const f = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
        if (f.in !== undefined && !f.in.includes(value)) return false;
        if (f.notIn !== undefined && f.notIn.includes(value)) return false;
        if (f.not !== undefined && value === f.not) return false;
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  }

  function storeMember(id: string, overrides: Record<string, unknown> = {}) {
    return makeMember(id, {
      parentMemberId: null,
      secondaryParentId: null,
      inheritEmailFromId: null,
      detailsConfirmedByMemberId: null,
      ...overrides,
    });
  }

  function storeMemberDelegate(
    store: Map<string, Record<string, unknown>>,
    hooks: {
      onFindMany?: (args: { where?: Record<string, unknown>; take?: number }) => void;
    } = {},
  ) {
    return {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const row = store.get(where.id);
        // Clone on read, like a real row fetch: the transaction-opening
        // snapshot must keep the pre-merge values after later steps mutate the
        // stored row.
        return Promise.resolve(row ? { ...row } : null);
      }),
      findMany: vi.fn(
        (args: { where?: Record<string, unknown>; take?: number } = {}) => {
          hooks.onFindMany?.(args);
          const rows = [...store.values()].filter((r) =>
            rowMatches(r, args.where ?? {}),
          );
          const limited =
            typeof args.take === "number" ? rows.slice(0, args.take) : rows;
          return Promise.resolve(limited.map((r) => ({ ...r })));
        },
      ),
      // actorIsFullAdmin -> 1 for the actor; every aggregate count -> 0.
      count: vi.fn(({ where }: { where?: { id?: unknown } } = {}) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      updateMany: vi.fn(
        ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const row of store.values()) {
            if (rowMatches(row, where)) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return Promise.resolve({ count });
        },
      ),
      update: vi.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.get(where.id);
          if (row) Object.assign(row, data);
          return Promise.resolve(row ? { ...row } : {});
        },
      ),
      delete: vi.fn(({ where }: { where: { id: string } }) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return Promise.resolve(row ? { ...row } : {});
      }),
    };
  }

  it("REFUSES (409) at step 1 when the master's link flips from the duplicate to a THIRD member mid-merge — the clobber shape (#2437)", async () => {
    // Snapshot: master.inheritEmailFromId = the duplicate (a self-cycle the
    // merge legitimately clears). Between the token re-derivation and step 1 —
    // the moved-id-sample stretch, dozens of sequential round-trips — another
    // admin re-points the master's email inheritance to the REAL holder. An
    // unconditional step-1 null keyed off the stale snapshot would destroy
    // that write and then read its own null back as "expected" at step 5:
    // silent loss with no drift report. The value-conditional null misses
    // (count 0) and refuses instead.
    const store = new Map<string, Record<string, unknown>>();
    store.set(
      MASTER_ID,
      storeMember(MASTER_ID, { occupation: null, inheritEmailFromId: LOSER_ID }),
    );
    store.set(LOSER_ID, storeMember(LOSER_ID, { occupation: "Engineer" }));
    const token = tokenFor(store.get(MASTER_ID)!, store.get(LOSER_ID)!);
    let flipped = false;
    const memberDelegate = storeMemberDelegate(store, {
      // The moved-id sample is the first member read carrying `take`, and it
      // runs AFTER the token counts were captured and BEFORE step 1 — the real
      // window an unlocked family-link writer can land in.
      onFindMany: (args) => {
        if (flipped || typeof args.take !== "number") return;
        flipped = true;
        store.get(MASTER_ID)!.inheritEmailFromId = "real-holder-9";
      },
    });
    const { client, auditLog } = makeClient({ member: memberDelegate });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: token,
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: {
        driftFamilyLinks: [{ column: "inheritEmailFromId", where: "master" }],
      },
    });

    // The concurrent write SURVIVED: step 1's predicate missed so it wrote
    // nothing, the merge never got further, and the admin's link is intact.
    expect(store.get(MASTER_ID)!.inheritEmailFromId).toBe("real-holder-9");
    expect(store.has(LOSER_ID)).toBe(true);
    // #2498: the refusal is now audited (no success audit still claims a merge).
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it("REFUSES (409) a dependants link that lands between the token capture and the moves — never absorbs it unvetted (#2437)", async () => {
    // The absorption shape: `late-joiner.parentMemberId = loser` commits in the
    // window between the token re-derivation's capture and applyMoves. An
    // unbounded sweep would re-point it onto the master — a family link the
    // graph guards (cycle / depth) never evaluated and the operator never
    // previewed, silently committed by an irreversible merge. Bounded to the
    // captured ids, the late row keeps pointing at the duplicate and the
    // step-5 inbound re-check refuses the whole merge.
    const store = new Map<string, Record<string, unknown>>();
    store.set(MASTER_ID, storeMember(MASTER_ID, { occupation: null }));
    store.set(LOSER_ID, storeMember(LOSER_ID, { occupation: "Engineer" }));
    const token = tokenFor(store.get(MASTER_ID)!, store.get(LOSER_ID)!);
    let landed = false;
    const memberDelegate = storeMemberDelegate(store, {
      // The moved-id sample (first `take`-bearing member read) runs after the
      // token capture and before the moves — the real landing window.
      onFindMany: (args) => {
        if (landed || typeof args.take !== "number") return;
        landed = true;
        store.set(
          "late-joiner",
          storeMember("late-joiner", { parentMemberId: LOSER_ID }),
        );
      },
    });
    const { client, auditLog } = makeClient({ member: memberDelegate });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: token,
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: {
        driftFamilyLinks: [{ column: "parentMemberId", where: "inbound" }],
      },
    });

    // The late link was NOT swept onto the master (that is exactly what the
    // bound forbids), the duplicate was not deleted, and nothing was audited.
    expect(store.get("late-joiner")!.parentMemberId).toBe(LOSER_ID);
    expect(store.has(LOSER_ID)).toBe(true);
    // #2498: the refusal is now audited (no success audit still claims a merge).
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it.each(SELF_RELATION_COLUMNS)(
    "REFUSES (409) when a mid-merge write points the master's %s at the duplicate — the silent-loss shape",
    async (column) => {
      // Snapshot: no link. Mid-merge an admin saves `master.<column> = loser`.
      // applyMoves rightly leaves the master's own row alone (#2445), so
      // without the re-check the hard-delete's SET NULL would quietly erase the
      // admin's link (and pre-#2445 this exact shape made the master its own
      // parent). The re-check sees the fresh row disagree with the
      // snapshot-derived expectation and refuses; the transaction rolls back.
      const masterStale = makeMember(MASTER_ID, { occupation: null });
      const masterFresh = { ...masterStale, [column]: LOSER_ID };
      const loserStale = makeMember(LOSER_ID, { occupation: "Engineer" });
      const race = familyLinkRace(masterStale, masterFresh, loserStale, loserStale);
      const { client, auditLog } = makeClient({
        member: race.memberDelegate,
        xeroObjectLink: race.xeroObjectLink,
      });

      await expect(
        executeMemberMerge({
          masterId: MASTER_ID,
          loserId: LOSER_ID,
          actorMemberId: ACTOR_ID,
          previewToken: tokenFor(masterStale, loserStale),
          confirmationText: "MERGE Dup Person",
          db: client as never,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "merge_drift_in_transaction",
        details: { driftFamilyLinks: [{ column, where: "master" }] },
      });

      // NO partial write: the master was never patched, the loser was never
      // deleted, and no audit row claims a merge happened. (The real
      // transaction rolls back whole; the mock has none, so assert the merge
      // never got that far.)
      const masterPatches = race.memberDelegate.update.mock.calls
        .map(([arg]) => arg as { where: { id: string } })
        .filter((call) => call.where.id === MASTER_ID);
      expect(masterPatches).toHaveLength(0);
      expect(race.memberDelegate.delete).not.toHaveBeenCalled();
      // #2498: the refusal is now audited (no success audit still claims a merge).
      expectRefusedAudit(
        (auditLog as { create: ReturnType<typeof vi.fn> }).create,
        "merge_drift_in_transaction",
      );
    },
  );

  it("names the changed link in plain English and says to re-run the preview", async () => {
    const masterStale = makeMember(MASTER_ID, { occupation: null });
    const masterFresh = { ...masterStale, parentMemberId: LOSER_ID };
    const loserStale = makeMember(LOSER_ID, { occupation: "Engineer" });
    const race = familyLinkRace(masterStale, masterFresh, loserStale, loserStale);
    const { client } = makeClient({
      member: race.memberDelegate,
      xeroObjectLink: race.xeroObjectLink,
    });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: tokenFor(masterStale, loserStale),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toThrow(
      /family links changed while the merge was running: parent \(on the surviving member\).*Re-run the preview/,
    );
  });

  it("REFUSES (409) when a link saved ON the duplicate mid-merge would be discarded unseen", async () => {
    // inheritEmailFromId is the member-visible one: it decides who receives the
    // member's club email. The duplicate's own outgoing links are discarded by
    // design — but the operator previewed that discard against the OLD values,
    // so a link that landed after the snapshot refuses rather than vanishing.
    const masterStale = makeMember(MASTER_ID, { occupation: null });
    const loserStale = makeMember(LOSER_ID, { occupation: "Engineer" });
    const loserFresh = { ...loserStale, inheritEmailFromId: "third-member-1" };
    const race = familyLinkRace(masterStale, masterStale, loserStale, loserFresh);
    const { client, auditLog } = makeClient({
      member: race.memberDelegate,
      xeroObjectLink: race.xeroObjectLink,
    });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: tokenFor(masterStale, loserStale),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: {
        driftFamilyLinks: [{ column: "inheritEmailFromId", where: "duplicate" }],
      },
    });
    expect(race.memberDelegate.delete).not.toHaveBeenCalled();
    // #2498: the refusal is now audited (no success audit still claims a merge).
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it("REFUSES (409) an inbound link from a third member still pointing at the duplicate after the moves", async () => {
    // A dependants link (`X.parentMemberId = loser`) committed after
    // applyMoves swept that column would dangle on the doomed row and be
    // SET-NULLed by the hard-delete. The under-lock re-count finds it.
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null,
        ),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      // The lingering-inbound query is the one filtered to
      // `id: { notIn: [master, loser] }`; the guards' family-graph walks use
      // `id: { in: … }` or bare OR filters and keep returning empty.
      findMany: vi.fn(({ where }: { where: { id?: { notIn?: string[] } } }) =>
        Promise.resolve(
          where?.id?.notIn
            ? [{ id: "bystander-1", parentMemberId: LOSER_ID }]
            : [],
        ),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client, auditLog } = makeClient({ member: memberDelegate });

    const run = () =>
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      });
    await expect(run()).rejects.toMatchObject({
      statusCode: 409,
      code: "merge_drift_in_transaction",
      details: { driftFamilyLinks: [{ column: "parentMemberId", where: "inbound" }] },
    });
    await expect(run()).rejects.toThrow(
      /parent \(another member now links to the duplicate\)/,
    );
    expect(memberDelegate.delete).not.toHaveBeenCalled();
    // #2498: each refused attempt is audited (this test refuses twice); no
    // success audit ever claims the merge completed.
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "merge_drift_in_transaction",
    );
  });

  it("does NOT refuse the merge's own rewrites: a snapshot self-cycle nulled at step 1 reads clean at step 5", async () => {
    // The master legitimately inherited email from the duplicate at snapshot
    // time and nobody raced. Step 1's VALUE-CONDITIONAL null must match
    // (count 1) and the under-lock re-check must recognise the null as the
    // merge's own write, not as drift — otherwise every self-cycle merge would
    // 409 forever and the refusal's "re-run the preview" advice would be a lie.
    const store = new Map<string, Record<string, unknown>>();
    store.set(
      MASTER_ID,
      storeMember(MASTER_ID, { occupation: null, inheritEmailFromId: LOSER_ID }),
    );
    store.set(LOSER_ID, storeMember(LOSER_ID, { occupation: "Engineer" }));
    const token = tokenFor(store.get(MASTER_ID)!, store.get(LOSER_ID)!);
    const memberDelegate = storeMemberDelegate(store);
    const { client, auditLog } = makeClient({ member: memberDelegate });

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: token,
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(result.masterId).toBe(MASTER_ID);
    // Step 1 nulled the self-cycle with the value-conditional predicate — the
    // shape that cannot clobber a concurrent write (#2437)...
    expect(memberDelegate.updateMany.mock.calls.map(([arg]) => arg)).toContainEqual({
      where: { id: MASTER_ID, inheritEmailFromId: LOSER_ID },
      data: { inheritEmailFromId: null },
    });
    expect(store.get(MASTER_ID)!.inheritEmailFromId).toBeNull();
    // ...and the merge completed: the duplicate was deleted, no 409.
    expect(memberDelegate.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });

    // AUDIT HONESTY (#2437): the cleared link is recorded as a clearance, and
    // the master's own row is NOT listed in movedIdSample as a "moved" row —
    // the audit of an irreversible merge must never claim a link the merge
    // deleted was carried over.
    const auditCall = (auditLog as { create: ReturnType<typeof vi.fn> }).create.mock
      .calls[0]?.[0] as {
      data: { metadata: { selfRelationCyclesNulled: string[]; movedIdSample: { model: string; id: string }[] } };
    };
    expect(auditCall.data.metadata.selfRelationCyclesNulled).toEqual([
      "inheritEmailFromId",
    ]);
    expect(auditCall.data.metadata.movedIdSample).not.toContainEqual({
      model: "Member.inheritEmailFrom",
      id: MASTER_ID,
    });
  });

  it("re-checks inbound links with the id-excluded five-column query (shape pin)", async () => {
    // Pin the query so it cannot silently narrow: both merge parties excluded,
    // every self-relation column OR-ed, and every column selected for the
    // differ to inspect.
    const { client, member } = makeClient();

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const findMany = (member as { findMany: ReturnType<typeof vi.fn> }).findMany;
    const lingering = findMany.mock.calls
      .map(
        ([arg]) =>
          arg as {
            where?: { id?: { notIn?: string[] }; OR?: Record<string, unknown>[] };
            select?: Record<string, boolean>;
          },
      )
      .find((arg) => arg?.where?.id?.notIn);
    expect(lingering).toBeDefined();
    expect(lingering?.where?.id?.notIn).toEqual([MASTER_ID, LOSER_ID]);
    expect(lingering?.where?.OR).toEqual([
      { parentMemberId: LOSER_ID },
      { secondaryParentId: LOSER_ID },
      { inheritEmailFromId: LOSER_ID },
      { inheritEmailChoiceId: LOSER_ID },
      { detailsConfirmedByMemberId: LOSER_ID },
    ]);
    expect(lingering?.select).toEqual({
      id: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
      inheritEmailChoiceId: true,
      detailsConfirmedByMemberId: true,
    });
  });
});

// ---------------------------------------------------------------------------
// "+ Add Member Guest" (epic #2305) MG2 (#2307) — what a merge does to consent
// ---------------------------------------------------------------------------
//
// `BookingGuest.member` is classified `move`, so merging A into B re-points A's
// guest rows onto B — INCLUDING their consent columns. MG1 (#2306) recorded that
// as an accepted consequence and noted it was unreachable in that release, because
// every `consentStatus` was NULL and there was nothing to inherit. MG2 makes rows
// carry a status, so the consequence is now real and these are its tests.
//
// Two of them describe behaviour that is arguably wrong and is asserted anyway,
// because an unasserted hazard is one nobody can find later: the merge silently
// changes what an approval MEANS, and it can leave two guest rows for the same
// person on one booking. Both are called out where they appear.
describe("a merge and the consent columns it carries with it (#2307)", () => {
  const BOOKING = "bk-merge";

  type GuestRow = {
    id: string;
    bookingId: string;
    memberId: string | null;
    // The real column type, so a row can be handed straight to
    // classifyMemberGuestConsent without a cast dulling the assertion.
    consentStatus: MemberGuestConsentStatus | null;
    consentRequestedAt: Date | null;
    consentRespondedAt: Date | null;
    consentRespondedByMemberId: string | null;
    consentExpiresAt: Date | null;
  };

  /**
   * A stateful `bookingGuest` delegate: `updateMany` really re-points rows, so the
   * end state can be inspected instead of only the call arguments.
   */
  function bookingGuestDelegate(rows: GuestRow[]) {
    const store = rows.map((row) => ({ ...row }));
    return {
      ...defaultDelegate(),
      count: vi.fn(async ({ where }: { where: { memberId?: string } }) =>
        store.filter((row) => row.memberId === where.memberId).length,
      ),
      findMany: vi.fn(async ({ where }: { where: { memberId?: string } }) =>
        store.filter((row) => row.memberId === where.memberId).map((row) => ({ id: row.id })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { memberId?: string };
          data: { memberId?: string };
        }) => {
          const hits = store.filter((row) => row.memberId === where.memberId);
          for (const row of hits) Object.assign(row, data);
          return { count: hits.length };
        },
      ),
      store,
    };
  }

  /** The preview token the execute path will recompute, given the guest-row count. */
  function tokenWithGuestRows(count: number) {
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: count > 0 ? [{ model: "BookingGuest.member", count }] : [],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    return buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      master.updatedAt,
      loser.updatedAt,
      core,
    );
  }

  async function mergeWithGuests(rows: GuestRow[]) {
    const bookingGuest = bookingGuestDelegate(rows);
    const { client, auditLog } = makeClient({ bookingGuest });
    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: tokenWithGuestRows(
        rows.filter((row) => row.memberId === LOSER_ID).length,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });
    return { result, store: bookingGuest.store, bookingGuest, auditLog };
  }

  it("re-points the loser's guest rows, so the survivor inherits the consent", async () => {
    // The plain case. The loser said yes to being on somebody's booking; after the
    // merge that same place belongs to the survivor, consent and all. Nothing is
    // re-asked and nothing is cleared — which is the right outcome for the booking
    // (the bed is still legitimately held) even though it means the survivor is
    // now standing behind a decision the loser made.
    const { result, store } = await mergeWithGuests([
      {
        id: "g-1",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-07-01T00:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T00:00:00.000Z"),
        consentRespondedByMemberId: LOSER_ID,
        consentExpiresAt: null,
      },
    ]);

    expect(store[0].memberId).toBe(MASTER_ID);
    expect(store[0].consentStatus).toBe("CONFIRMED");
    expect(result.relationMoves).toContainEqual({ model: "BookingGuest.member", count: 1 });
  });

  it("QUIETLY CHANGES WHAT THE APPROVAL MEANS: a target approval becomes a delegate approval", async () => {
    // ASSERTED BECAUSE IT IS SURPRISING, not because it is desirable.
    //
    // `consentRespondedByMemberId` is a deliberate FK-less SNAPSHOT column: if the
    // person who approved is later merged away, the id stays as it was, because the
    // audit answer to "who stood behind this add" is the person who did it at the
    // time. But `memberId` is `move`, so it becomes the survivor's — and the
    // classifier tells TARGET_APPROVED from DELEGATE_APPROVED by comparing the two.
    //
    // The row therefore reads, after the merge, as though somebody ELSE approved on
    // the survivor's behalf. Both column classifications are individually correct
    // and documented; the interaction between them is not written down anywhere,
    // and it changes an audit answer without any writer having touched the row.
    const requestedAt = new Date("2026-07-01T00:00:00.000Z");
    const respondedAt = new Date("2026-07-02T00:00:00.000Z");
    const before = {
      consentStatus: "CONFIRMED" as const,
      consentRequestedAt: requestedAt,
      consentRespondedAt: respondedAt,
      consentRespondedByMemberId: LOSER_ID,
      consentExpiresAt: null,
    };

    // Before: the member who was asked answered for themselves.
    expect(classifyMemberGuestConsent(before, LOSER_ID)).toBe("TARGET_APPROVED");

    const { store } = await mergeWithGuests([
      { id: "g-1", bookingId: BOOKING, memberId: LOSER_ID, ...before },
    ]);

    // After: the responder is unchanged (it is a snapshot) but the target moved.
    expect(store[0].consentRespondedByMemberId).toBe(LOSER_ID);
    expect(classifyMemberGuestConsent(store[0], store[0].memberId)).toBe("DELEGATE_APPROVED");
  });

  it("carries a PENDING hold and its deadline across, so the sweep inherits it too", async () => {
    // A `PENDING` row holds a bed (D-4) and the sweep finds it through the partial
    // index. Re-pointing it does not touch `consentExpiresAt`, so the survivor
    // inherits both the bed hold and the deadline — and if nobody answers, the
    // lapse is processed against the survivor.
    const expiresAt = new Date("2026-08-01T11:00:00.000Z");
    const { store } = await mergeWithGuests([
      {
        id: "g-1",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "PENDING",
        consentRequestedAt: new Date("2026-07-25T00:00:00.000Z"),
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: expiresAt,
      },
    ]);

    expect(store[0]).toMatchObject({
      memberId: MASTER_ID,
      consentStatus: "PENDING",
      consentExpiresAt: expiresAt,
    });
    expect(classifyMemberGuestConsent(store[0], store[0].memberId)).toBe("AWAITING_TARGET");
  });

  it("PRODUCES TWO GUEST ROWS FOR ONE PERSON ON ONE BOOKING, and says nothing about it", async () => {
    // ASSERTED BECAUSE IT IS UNSAFE, and papering over it would hide it.
    //
    // If both members were already guests on the same booking — which is exactly
    // what a duplicate-member record makes likely, since the duplicate is how the
    // same human ended up entered twice — the merge re-points one row onto the
    // other's member and the booking is left holding TWO places for ONE person.
    // That is a person-night conflict of the kind the booking write paths refuse
    // outright, arrived at through the back door: two beds, two charges, two
    // arrival rows, two chore slots.
    //
    // The merge does not detect it. `BookingGuest.member` is a `move`, not a
    // `resolve`, so there is no collision resolver; the database cannot stop it
    // either, because `BookingGuest` carries no unique on (bookingId, memberId);
    // and the merge reports it as an ordinary relation move with no warning and no
    // blocker. Every part of that is asserted below so the shape of the hazard is
    // on record.
    const { result, store, bookingGuest, auditLog } = await mergeWithGuests([
      {
        id: "g-loser",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-07-01T00:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T00:00:00.000Z"),
        consentRespondedByMemberId: LOSER_ID,
        consentExpiresAt: null,
      },
      {
        id: "g-master",
        bookingId: BOOKING,
        memberId: MASTER_ID,
        consentStatus: null,
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
    ]);

    // Two rows, one booking, one member.
    const onBooking = store.filter((row) => row.bookingId === BOOKING);
    expect(onBooking).toHaveLength(2);
    expect(onBooking.map((row) => row.memberId)).toEqual([MASTER_ID, MASTER_ID]);

    // A single unconditional updateMany, and no collision handling of any kind.
    expect(bookingGuest.updateMany).toHaveBeenCalledTimes(1);
    expect(bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
    expect(result.relationMoves).toContainEqual({ model: "BookingGuest.member", count: 1 });
    expect(result.collisions.map((collision) => collision.model)).not.toContain(
      "BookingGuest.member",
    );
    // Nor does the one critical MEMBER_MERGED audit entry say anything about a
    // duplicated place — so there is no record an operator could act on later.
    const auditSpy = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toMatch(/duplicat|conflict/i);
  });

  it("has no resolver and no database constraint standing behind that", () => {
    // The structural half of the case above, so the hazard is pinned to its two
    // causes rather than to one test's fixture. If somebody later adds a
    // (bookingId, memberId) unique or reclassifies the relation as `resolve`, this
    // fails and the test above should be rewritten to describe the new behaviour.
    const spec = MEMBER_MERGE_RELATION_SPECS.find(
      (candidate) => candidate.key === "BookingGuest.member",
    );
    expect(spec?.bucket).toBe("move");

    const schema = readFileSync(
      path.resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const model = schema.slice(
      schema.indexOf("model BookingGuest {"),
      schema.indexOf("enum MemberGuestConsentStatus"),
    );
    expect(model).not.toMatch(/@@unique\(\[bookingId,\s*memberId\]\)/);
  });
});

describe("refused member merges are audited (#2498)", () => {
  // Every refusal throws a MemberMergeError from inside the transaction, which
  // rolls the transaction (and the success audit written there) back. Owner
  // decision, 2 Aug 2026: record the refused attempt too — once, best-effort,
  // on the base client OUTSIDE the rolled-back transaction, and never in a way
  // that turns a clean 4xx/409 refusal into a 500.

  it("audits a self-merge refusal, before a transaction is opened (same_member)", async () => {
    const { client, auditLog } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: MASTER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "x",
        confirmationText: "x",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "same_member" });
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "same_member",
    );
  });

  it("audits a missing-member refusal (member_missing)", async () => {
    const { client, auditLog } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: "ghost-member",
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "member_missing" });
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "member_missing",
    );
  });

  it("audits a blocked refusal with actor + both ids + blocker codes, and no member PII (merge_blocked)", async () => {
    const nonAdminMember = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null,
        ),
      ),
      count: vi.fn().mockResolvedValue(0), // actor not a full admin
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client, auditLog } = makeClient({ member: nonAdminMember });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });

    const create = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    expectRefusedAudit(create, "merge_blocked");
    const data = (
      refusalAuditCalls(create)[0][0] as {
        data: {
          action: string;
          actorMemberId: string;
          outcome: string;
          metadata: Record<string, unknown>;
        };
      }
    ).data;
    expect(data.action).toBe("MEMBER_MERGE_REFUSED");
    expect(data.actorMemberId).toBe(ACTOR_ID);
    expect(data.outcome).toBe("blocked");
    expect(data.metadata.masterId).toBe(MASTER_ID);
    expect(data.metadata.loserId).toBe(LOSER_ID);
    const refusal = data.metadata.refusal as { blockerCodes?: string[] };
    expect(refusal.blockerCodes?.length ?? 0).toBeGreaterThanOrEqual(1);
    // Strictly a non-PII subset of the success audit: no loser snapshot, no
    // member names or email addresses ever reach a refusal row.
    expect(data.metadata).not.toHaveProperty("loserSnapshot");
    expect(JSON.stringify(data.metadata)).not.toContain("@example.com");
  });

  it("audits a preview-drift refusal (preview_drift)", async () => {
    const { client, auditLog } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "stale-token",
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "preview_drift" });
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "preview_drift",
    );
  });

  it("audits a confirmation-mismatch refusal (confirmation_mismatch)", async () => {
    const { client, auditLog } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Wrong Name",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "confirmation_mismatch" });
    expectRefusedAudit(
      (auditLog as { create: ReturnType<typeof vi.fn> }).create,
      "confirmation_mismatch",
    );
  });

  it("writes exactly ONE refusal audit per refused attempt (idempotent)", async () => {
    const { client, auditLog } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "stale-token",
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ code: "preview_drift" });
    expect(
      refusalAuditCalls((auditLog as { create: ReturnType<typeof vi.fn> }).create),
    ).toHaveLength(1);
  });

  it("a completed merge writes the success audit and NO refusal audit", async () => {
    const { client, auditLog } = makeClient();
    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });
    const create = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    expect(successAuditCalls(create)).toHaveLength(1);
    expect(refusalAuditCalls(create)).toHaveLength(0);
  });

  it("is best-effort: a failing refusal audit never turns the refusal into a 500", async () => {
    // The audit sink itself throws. The original refusal (preview_drift) must
    // still surface unchanged — recording the attempt can never mask, escalate,
    // or replace the refusal the operator receives.
    const auditLog = {
      create: vi.fn().mockRejectedValue(new Error("audit sink down")),
    };
    const { client, member } = makeClient({ auditLog });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "stale-token",
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "preview_drift" });

    // The audit was attempted once (and its failure swallowed); nothing merged.
    expect(auditLog.create).toHaveBeenCalledTimes(1);
    expect(
      (member as { delete: ReturnType<typeof vi.fn> }).delete,
    ).not.toHaveBeenCalled();
  });
});

describe("MemberMergeError", () => {
  it("carries a status code and code", () => {
    const err = new MemberMergeError("nope", 409, "preview_drift", { a: 1 });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("preview_drift");
    expect(err.details).toEqual({ a: 1 });
  });
});

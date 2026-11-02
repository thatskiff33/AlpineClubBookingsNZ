import { describe, expect, it, vi } from "vitest";

import {
  claimDeletionRequestApproval,
  claimDeletionRequestDecision,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
  DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
  deletionApprovalWasReleased,
  OPEN_DELETION_REQUEST_STATUSES,
  releaseDeletionRequestApprovalClaim,
} from "@/lib/deletion-request-decision";
import { isTransactionContention } from "@/lib/prisma-errors";

describe("deletion request approval ownership claim (#2597)", () => {
  it("moves PENDING to APPROVAL_IN_PROGRESS with one guarded mutation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn();

    await expect(
      claimDeletionRequestApproval(
        { deletionRequest: { updateMany, findUnique } as never },
        { id: "request-1", reviewedBy: "admin-1", adminNote: "agreed" },
      ),
    ).resolves.toBe("CLAIMED");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "request-1", status: "PENDING" },
      data: {
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "agreed",
        reviewedBy: "admin-1",
        // Not a decision yet: the request is owned, not finished, so it must
        // not carry a reviewed timestamp that would read as a final outcome.
        reviewedAt: null,
      },
    });
    // The winning path costs exactly one round trip.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("resumes its own in-progress claim instead of failing the retry", async () => {
    // The claim is idempotent by design: an approval that crashed after
    // cancelling bookings must be completable, not permanently stuck.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi
      .fn()
      .mockResolvedValue({ status: "APPROVAL_IN_PROGRESS" });

    await expect(
      claimDeletionRequestApproval(
        { deletionRequest: { updateMany, findUnique } as never },
        { id: "request-1", reviewedBy: "admin-2", adminNote: null },
      ),
    ).resolves.toBe("RESUMED");

    // Resuming must not overwrite the original claim's attribution.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["APPROVED", "REJECTED", undefined] as const)(
    "refuses to start an approval once the request is %s",
    async (status) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const findUnique = vi
        .fn()
        .mockResolvedValue(status ? { status } : null);

      await expect(
        claimDeletionRequestApproval(
          { deletionRequest: { updateMany, findUnique } as never },
          { id: "request-1", reviewedBy: "admin-2", adminNote: null },
        ),
      ).rejects.toMatchObject({
        code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
        statusCode: 409,
      });
    },
  );
});

describe("deletion request final decision claim", () => {
  it("finalises an approval only from its durable APPROVAL_IN_PROGRESS claim", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: "agreed",
        },
      ),
    ).resolves.toBeUndefined();

    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: "request-1",
      status: "APPROVAL_IN_PROGRESS",
    });
    expect(call.data.status).toBe("APPROVED");
    expect(call.data.reviewedAt).toBeInstanceOf(Date);
    // Attribution was written when the claim was taken; finalisation must not
    // silently re-stamp it to whoever happened to finish the cleanup.
    expect(call.data.reviewedBy).toBeUndefined();
    expect(call.data.adminNote).toBeUndefined();
  });

  it("finalises from PENDING when the approval never needed a claim", async () => {
    // #2627: an approval with no future bookings to cancel takes no claim, so
    // its single guarded transition is PENDING -> APPROVED. Defaulting to
    // APPROVAL_IN_PROGRESS there would match zero rows and refuse a perfectly
    // ordinary approval.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: "agreed",
          approvalFrom: "PENDING",
        },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "request-1",
      status: "PENDING",
    });
  });

  it("still defaults an approval to its durable claim when no origin is named", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await claimDeletionRequestDecision(
      { deletionRequest: { updateMany } as never },
      {
        id: "request-1",
        decision: "APPROVED",
        reviewedBy: "admin-1",
        adminNote: null,
      },
    );

    expect(updateMany.mock.calls[0][0].where.status).toBe(
      "APPROVAL_IN_PROGRESS",
    );
  });

  it("ignores an approval origin on the rejection path", async () => {
    // Rejection's guard is not negotiable: it may only ever claim PENDING.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await claimDeletionRequestDecision(
      { deletionRequest: { updateMany } as never },
      {
        id: "request-1",
        decision: "REJECTED",
        reviewedBy: "admin-2",
        adminNote: null,
        approvalFrom: "APPROVAL_IN_PROGRESS",
      },
    );

    expect(updateMany.mock.calls[0][0].where.status).toBe("PENDING");
  });

  it("lets a rejection claim only a still-PENDING request that carries no release marker", async () => {
    // #2627 re-review: `status: "PENDING"` alone is not the whole guard. A
    // rejection nobody warned about the release must also be unable to win a
    // MARKED row, because the route evaluated that gate against a row it read
    // before this write — so the marker's absence belongs in the guard, not in a
    // preceding check.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "not yet",
        },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "request-1", status: "PENDING", reviewedAt: null },
      data: expect.objectContaining({
        status: "REJECTED",
        reviewedBy: "admin-2",
        adminNote: "not yet",
      }),
    });
  });

  it("lets a confirmed reject-after-release win only a row that still carries the marker", async () => {
    // The other half of the partition. A Full Admin who was shown the disclosure
    // and confirmed it is deciding a RELEASED request, so its guard names that
    // shape — and the two shapes together cover PENDING exactly, so no rejection
    // can land on the flavour it was not authorised against.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "the blocker will not clear",
          rejectFrom: "PENDING_RELEASED",
        },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "request-1",
      status: "PENDING",
      reviewedAt: { not: null },
    });
  });

  it("refuses an unconfirmed rejection once the release marker has appeared", async () => {
    // The interleaving itself, at this seam: the caller read a row with no
    // marker, a release committed, and the guarded mutation now matches zero
    // rows. Before the guard carried `reviewedAt`, this same call landed a final
    // REJECTED over already-committed cancellations with no Full-Admin check and
    // no confirmation.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "unaware",
          rejectFrom: "PENDING",
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("fails closed on the strict guard when no rejection origin is named", async () => {
    // A caller who has shown nobody a disclosure cannot take a released row by
    // omission.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await claimDeletionRequestDecision(
      { deletionRequest: { updateMany } as never },
      {
        id: "request-1",
        decision: "REJECTED",
        reviewedBy: "admin-2",
        adminNote: null,
      },
    );

    expect(updateMany.mock.calls[0][0].where.reviewedAt).toBeNull();
  });

  it("cannot reject a request whose approval already began", async () => {
    // The invariant that makes the whole intermediate state worth having: an
    // approval that has already committed booking cancellations can never be
    // overtaken by a final REJECTED. The guarded where-clause is what enforces
    // it, so a losing rejection matches zero rows.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "late",
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.status).toBe("PENDING");
  });

  it("reports a lost approval without a second mutation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: null,
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("releasing a started approval (#2627)", () => {
  function releaseTx(
    overrides: {
      locked?: number;
      current?: {
        status: string;
        reviewedBy: string | null;
        adminNote: string | null;
      } | null;
      count?: number;
    } = {},
  ) {
    const executeRaw = vi.fn().mockResolvedValue(overrides.locked ?? 1);
    const findUnique = vi.fn().mockResolvedValue(
      overrides.current === undefined
        ? {
            status: "APPROVAL_IN_PROGRESS",
            reviewedBy: "admin-9",
            adminNote: "starting approval",
          }
        : overrides.current,
    );
    const updateMany = vi
      .fn()
      .mockResolvedValue({ count: overrides.count ?? 1 });
    return {
      executeRaw,
      findUnique,
      updateMany,
      tx: {
        $executeRaw: executeRaw,
        deletionRequest: { findUnique, updateMany },
      } as never,
    };
  }

  it("returns the claim to PENDING, marks the release, and reports the attribution it destroyed", async () => {
    const { tx, executeRaw, findUnique, updateMany } = releaseTx();

    const released = await releaseDeletionRequestApprovalClaim(tx, {
      id: "request-1",
      adminNote: "blocker will never clear",
    });

    expect(updateMany).toHaveBeenCalledWith({
      // The guard is the whole race protection: a release that arrives while a
      // finalisation is committing waits on this row's write lock and then
      // matches nothing, and a release that commits first makes the
      // finalisation match nothing.
      where: { id: "request-1", status: "APPROVAL_IN_PROGRESS" },
      data: {
        status: "PENDING",
        adminNote: "blocker will never clear",
        // A PENDING request has no reviewer: the claim being abandoned must not
        // leave attribution behind that reads as a decision.
        reviewedBy: null,
        // ...but NOT a null timestamp. `PENDING` + `reviewedAt` + no reviewer is
        // the durable marker that an approval was started and released here, and
        // it is what stops the next decider rejecting the request without being
        // told the member's stays may already be cancelled. Written by the same
        // guarded mutation as the transition, so it cannot go missing.
        reviewedAt: released.releasedAt,
      },
    });
    expect(deletionApprovalWasReleased({
      status: "PENDING",
      reviewedBy: null,
      reviewedAt: released.releasedAt,
    })).toBe(true);

    // The attribution comes from a read taken under this row's own lock, inside
    // the caller's transaction — not from an earlier unguarded read that an
    // ABA interleaving could have made stale.
    expect(released).toEqual({
      releasedAt: expect.any(Date),
      previousClaimHeldBy: "admin-9",
      previousAdminNote: "starting approval",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "request-1" },
      select: { status: true, reviewedBy: true, adminNote: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Lock raw, read typed (#2289): the lock selects a CONSTANT — never columns —
    // and the data comes back through the Prisma model under it. The id travels
    // as a bound parameter.
    const [lockStrings, lockValue] = executeRaw.mock.calls[0] as [
      readonly string[],
      string,
    ];
    expect(lockStrings.join("?")).toMatch(
      /SELECT\s+1\s+FROM\s+"DeletionRequest"\s+WHERE\s+"id" = \?\s+FOR UPDATE\s*$/,
    );
    expect(lockValue).toBe("request-1");

    // Lock, then read, then transition — in that order, or the attribution is a
    // guess and the transition is unprotected.
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
    expect(findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses when the row it locked no longer holds the claim, mutating nothing", async () => {
    const { tx, updateMany } = releaseTx({
      current: { status: "APPROVED", reviewedBy: "admin-9", adminNote: "won" },
    });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "too late",
      }),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
      statusCode: 409,
    });
    // A finalisation that committed while this release waited on the row lock
    // must not be overwritten.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the request itself is gone, so the lock matched nothing", async () => {
    // A member hard delete cascades the request away. Zero locked rows is
    // emphatically not a held claim, and the follow-up model read would take a
    // FRESH statement snapshot with no lock held (#2289's zero-match exception).
    const { tx, findUnique, updateMany } = releaseTx({ locked: 0 });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "gone",
      }),
    ).rejects.toMatchObject({ code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE });
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still fails closed if the guarded transition itself matches nothing", async () => {
    // Unreachable while the caller holds the row lock, which is the point: the
    // guard, not the lock, is the protocol every transition on this row shares,
    // so a caller that forgets the transaction cannot get a silent false
    // success.
    const { tx } = releaseTx({ count: 0 });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "no transaction",
      }),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
      statusCode: 409,
    });
  });
});

describe("the released-approval marker (#2627)", () => {
  /**
   * The marker has no column of its own: it is the (status, reviewedBy,
   * reviewedAt) combination that NO other writer of this row can produce, and
   * that claim is the whole reason the predicate is trustworthy.
   *
   * So these rows are DERIVED from the writers rather than restated next to them.
   * Each case runs the real function against a capturing mock and applies the
   * `data` it wrote over the row it wrote it to — which means an omitted field is
   * part of the derivation too (an approval that never writes `reviewedBy`
   * inherits whatever the claim left there). A change to any of the three
   * functions in this module therefore lands here on its own.
   *
   * What this does NOT prove: the member's own `create`, which lives in
   * `src/app/api/member/request-deletion/route.ts` and cannot be driven from
   * here. Its `data` is pinned field for field — so an added `reviewedAt` fails —
   * by `src/lib/__tests__/phase10b.test.ts` -> "creates a deletion request for a
   * member".
   */
  type MarkerRow = {
    status: string;
    reviewedBy: string | null;
    reviewedAt: Date | string | null;
  };

  type CapturedDb = Parameters<typeof releaseDeletionRequestApprovalClaim>[0] &
    Parameters<typeof claimDeletionRequestApproval>[0];

  async function rowAfter(
    before: MarkerRow,
    write: (db: CapturedDb) => Promise<unknown>,
  ): Promise<MarkerRow> {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      status: before.status,
      reviewedBy: before.reviewedBy,
      adminNote: null,
    });
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      deletionRequest: { updateMany, findUnique },
    } as unknown as CapturedDb;

    await write(db);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const written = updateMany.mock.calls[0][0].data as Record<string, unknown>;
    // Projected back onto the marker's three fields: everything the writer did
    // not mention keeps the value it had, which is the whole point of deriving
    // rather than restating.
    const after = { ...before, ...written } as Record<string, unknown>;
    return {
      status: after.status as string,
      reviewedBy: (after.reviewedBy ?? null) as string | null,
      reviewedAt: (after.reviewedAt ?? null) as Date | string | null,
    };
  }

  const writers: Array<{
    writer: string;
    before: MarkerRow;
    write: (db: CapturedDb) => Promise<unknown>;
    expected: MarkerRow;
    released: boolean;
  }> = [
    {
      writer: "claimDeletionRequestApproval",
      before: { status: "PENDING", reviewedBy: null, reviewedAt: null },
      write: (db: CapturedDb) =>
        claimDeletionRequestApproval(db, {
          id: "request-1",
          reviewedBy: "admin-1",
          adminNote: "starting approval",
        }),
      expected: {
        status: "APPROVAL_IN_PROGRESS",
        reviewedBy: "admin-1",
        reviewedAt: null,
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestApproval re-claiming a released request",
      before: {
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: new Date("2026-08-01T00:00:00Z"),
      },
      write: (db: CapturedDb) =>
        claimDeletionRequestApproval(db, {
          id: "request-1",
          reviewedBy: "admin-1",
          adminNote: "trying again",
        }),
      // The marker is cleared, deliberately: from APPROVAL_IN_PROGRESS a
      // rejection cannot win at all, and releasing THIS claim writes it again.
      expected: {
        status: "APPROVAL_IN_PROGRESS",
        reviewedBy: "admin-1",
        reviewedAt: null,
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestDecision (approved from its claim)",
      before: {
        status: "APPROVAL_IN_PROGRESS",
        reviewedBy: "admin-1",
        reviewedAt: null,
      },
      write: (db: CapturedDb) =>
        claimDeletionRequestDecision(db, {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: null,
        }),
      // Finalisation writes status + reviewedAt only, so the attribution is
      // whatever the CLAIM recorded — it is not re-stamped here.
      expected: {
        status: "APPROVED",
        reviewedBy: "admin-1",
        reviewedAt: expect.any(Date),
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestDecision (approved with no claim, #2627)",
      before: { status: "PENDING", reviewedBy: null, reviewedAt: null },
      write: (db: CapturedDb) =>
        claimDeletionRequestDecision(db, {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: null,
          approvalFrom: "PENDING",
        }),
      // An approval that never needed a claim leaves NO reviewer behind, which
      // the previous hand-written table did not have at all.
      expected: {
        status: "APPROVED",
        reviewedBy: null,
        reviewedAt: expect.any(Date),
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestDecision (rejected)",
      before: { status: "PENDING", reviewedBy: null, reviewedAt: null },
      write: (db: CapturedDb) =>
        claimDeletionRequestDecision(db, {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "declined",
        }),
      expected: {
        status: "REJECTED",
        reviewedBy: "admin-2",
        reviewedAt: expect.any(Date),
      },
      released: false,
    },
    {
      writer: "releaseDeletionRequestApprovalClaim",
      before: {
        status: "APPROVAL_IN_PROGRESS",
        reviewedBy: "admin-1",
        reviewedAt: null,
      },
      write: (db: CapturedDb) =>
        releaseDeletionRequestApprovalClaim(db, {
          id: "request-1",
          adminNote: "blocker will never clear",
        }),
      expected: {
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: expect.any(Date),
      },
      released: true,
    },
  ];

  it.each(writers)(
    "derives $writer from what it writes, and reads it as released=$released",
    async ({ before, write, expected, released }) => {
      const row = await rowAfter(before, write);

      expect(row).toEqual(expected);
      expect(deletionApprovalWasReleased(row)).toBe(released);
    },
  );

  it("reads the marker off the JSON the admin queue is served", () => {
    // The admin client derives the row warning from the same predicate over the
    // API's serialised shape, where a Date has become an ISO string.
    expect(
      deletionApprovalWasReleased({
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("open deletion request statuses", () => {
  it("treats a mid-approval request as still open", () => {
    // Every "does this member have an outstanding deletion request?" reader
    // shares this list. Dropping APPROVAL_IN_PROGRESS would hide a request
    // that has already cancelled bookings from the admin queue, the pending
    // counts, the merge blocker and the member's own re-request guard.
    expect(OPEN_DELETION_REQUEST_STATUSES).toEqual([
      "PENDING",
      "APPROVAL_IN_PROGRESS",
    ]);
  });

  it("is a mutable array Prisma's `in` filter accepts", () => {
    expect(Array.isArray(OPEN_DELETION_REQUEST_STATUSES)).toBe(true);
  });
});

describe("release transaction contention (#2627)", () => {
  // The release's first statement takes the request row FOR UPDATE while the
  // counterpart anonymisation transaction may legitimately hold it to commit, so
  // an exhausted wait is contention, not a fault. The route maps this set to a
  // 503 retry-later; before the release moved into a transaction the same
  // interleaving blocked on an auto-commit statement and returned the mapped 409,
  // so a bare 500 would be a regression. #4656: the route asks the one
  // shared reading (`isTransactionContention`), pinned here for this branch.
  it.each(["P2028", "P2034"])("recognises Prisma %s as contention", (code) => {
    expect(isTransactionContention({ code })).toBe(true);
  });

  it.each([
    ["a foreign key violation", { code: "P2003" }],
    ["a record-not-found error", { code: "P2025" }],
    ["a non-string code", { code: 2028 }],
    ["an ordinary error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
  ])("does not treat %s as contention", (_label, error) => {
    expect(isTransactionContention(error)).toBe(false);
  });
});

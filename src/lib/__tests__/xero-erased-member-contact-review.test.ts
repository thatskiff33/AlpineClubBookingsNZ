/**
 * #3058 — the erased-member Xero contact review. `INV-INT-024`.
 *
 * TWO KINDS OF PROOF, and the second is the reason this file exists.
 *
 * The first is ordinary classification: given a retired contact link, a home
 * and an erasure record, does a row appear and is it the right one. The
 * interesting cases are all NEGATIVE, because the defect this review could
 * plausibly ship is a false accusation — telling a treasurer that a school's
 * live Xero customer has been abandoned, or that a member an administrator
 * deliberately unlinked ten minutes ago has been forgotten.
 *
 * The second is that the review is NON-DESTRUCTIVE, asserted rather than
 * assumed. The prisma double below is a Proxy whose every MUTATING method — on
 * every model, including models that do not exist yet — is a function that
 * throws with its own name. A write added anywhere under this call therefore
 * fails the suite and says what it was. Asserting
 * `expect(member.update).not.toHaveBeenCalled()` for the handful of delegates
 * this engine happens to read would prove nothing about a write to a delegate
 * nobody has thought of.
 *
 * `findXeroContactHomes` is deliberately NOT mocked. The rule it owns — which
 * columns count as a local home — is exactly what a school row depends on, and
 * a mock of it would be a second opinion written to agree with the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /** Anything on a Prisma delegate that can change stored state. */
  const MUTATING_METHODS = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
  ]);
  /** Client-level members that can change state or run arbitrary SQL. */
  const MUTATING_CLIENT_MEMBERS = new Set([
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRaw",
    "$queryRawUnsafe",
    "$transaction",
  ]);

  const reads: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
    xeroSyncCursor: { findUnique: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    member: { findMany: vi.fn() },
    organisation: { findMany: vi.fn() },
    deletionRequest: { findMany: vi.fn() },
    memberLifecycleActionRequest: { findMany: vi.fn() },
    xeroContactCache: { findMany: vi.fn() },
  };

  const refuse = (what: string) => () => {
    throw new Error(
      `The erased-member contact review must write nothing, and it called ${what}.`,
    );
  };

  const delegateProxy = (model: string) =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          if (MUTATING_METHODS.has(method)) return refuse(`${model}.${method}`);
          const stub = reads[model]?.[method];
          if (stub) return stub;
          // An unstubbed READ is a real gap in the fixture rather than a
          // violation, so it says which one instead of returning empty.
          return () => {
            throw new Error(`unstubbed read: prisma.${model}.${method}`);
          };
        },
      },
    );

  const delegates = new Map<string, object>();
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (MUTATING_CLIENT_MEMBERS.has(prop)) return refuse(`prisma.${prop}`);
        if (!delegates.has(prop)) delegates.set(prop, delegateProxy(prop));
        return delegates.get(prop);
      },
    },
  );

  return { prisma, reads, MUTATING_METHODS };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { getErasedMemberXeroContactReview } from "@/lib/xero-erased-member-contact-review";

const { reads } = mocks;

/** A retired `Member` → `CONTACT` link, which is the review's candidate list. */
function retiredLink(
  memberId: string,
  contactId: string,
  /**
   * What the live status check last observed about this contact in Xero, if
   * anything. It is stamped on the retired link's `metadata` because that is
   * the only durable home available: the erasure deleted the contact's cache
   * row, and re-creating one would manufacture the NZBN write permission the
   * deletion exists to remove.
   */
  observation?: { contactStatus: string; observedAt: string },
) {
  return {
    localId: memberId,
    xeroObjectId: contactId,
    metadata: observation
      ? { linkedVia: "email_match", erasedContactReview: observation }
      : null,
  };
}

describe("erased-member Xero contact review (#3058)", () => {
  beforeEach(() => {
    for (const delegate of Object.values(reads)) {
      for (const stub of Object.values(delegate)) stub.mockReset();
    }
    reads.xeroSyncCursor.findUnique.mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-06-30T00:00:00.000Z"),
    });
    reads.xeroObjectLink.findMany.mockResolvedValue([]);
    reads.member.findMany.mockResolvedValue([]);
    reads.organisation.findMany.mockResolvedValue([]);
    reads.deletionRequest.findMany.mockResolvedValue([]);
    reads.memberLifecycleActionRequest.findMany.mockResolvedValue([]);
    reads.xeroContactCache.findMany.mockResolvedValue([]);
  });

  /**
   * The link read is asked twice with different `where` clauses — the retired
   * candidates, then the contacts anything is still actively linked to. Routing
   * by `active` keeps the two answerable independently.
   */
  function linkLedger(input: {
    retired: Array<{ localId: string; xeroObjectId: string }>;
    active?: string[];
  }) {
    reads.xeroObjectLink.findMany.mockImplementation(
      async (args: { where: { active: boolean } }) =>
        args.where.active === true
          ? (input.active ?? []).map((id) => ({ xeroObjectId: id }))
          : input.retired,
    );
  }

  it("reports the contact an approved deletion request left behind", async () => {
    linkLedger({ retired: [retiredLink("m1", "contact-1")] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m1", reviewedAt: new Date("2026-05-01T03:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.needsReview).toBe(1);
    expect(review.rows).toEqual([
      {
        memberId: "m1",
        xeroContactId: "contact-1",
        erasure: "ANONYMISED_BY_DELETION_REQUEST",
        erasedAt: "2026-05-01T03:00:00.000Z",
        // Erasure DELETES the cache row, and the bulk contact sync never
        // re-fetches an archived contact, so a contact nobody has checked is
        // honestly unknown rather than assumed active.
        contactStatus: "UNKNOWN",
        contactStatusCheckedAt: null,
      },
    ]);
  });

  it("reports the contact a hard delete left behind, dated from the processing", async () => {
    linkLedger({ retired: [retiredLink("m2", "contact-2")] });
    reads.memberLifecycleActionRequest.findMany.mockResolvedValue([
      {
        memberId: "m2",
        reviewedAt: new Date("2026-05-02T00:00:00.000Z"),
        processedAt: new Date("2026-05-02T04:00:00.000Z"),
      },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.rows).toHaveLength(1);
    expect(review.rows[0].erasure).toBe("HARD_DELETED");
    expect(review.rows[0].erasedAt).toBe("2026-05-02T04:00:00.000Z");
  });

  it("asks the lifecycle request read for DELETE approvals only", async () => {
    linkLedger({ retired: [retiredLink("m2", "contact-2")] });
    await getErasedMemberXeroContactReview();

    expect(reads.memberLifecycleActionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: "DELETE", status: "APPROVED" }),
      }),
    );
  });

  it("says nothing about a retired link with no erasure behind it", async () => {
    // A merge-loser teardown, an admin manual unlink and the stale-canonical
    // cleanup all produce exactly this state. None of them is an erasure, and
    // reporting one would accuse the club of forgetting somebody it did not.
    linkLedger({ retired: [retiredLink("unlinked", "contact-3")] });

    const review = await getErasedMemberXeroContactReview();

    expect(review.needsReview).toBe(0);
    expect(review.rows).toEqual([]);
  });

  it("says nothing about a contact a school's ORGANISATION now holds", async () => {
    // The #3367 transfer: the school's own invented member held the contact,
    // the organisation took it, and the member-side link was retired. Nothing
    // was abandoned. A reader looking only at `Member.xeroContactId` would
    // report a school's live Xero customer as orphaned.
    linkLedger({ retired: [retiredLink("school-member", "contact-4")] });
    reads.organisation.findMany.mockResolvedValue([
      { id: "org-1", xeroContactId: "contact-4" },
    ]);
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "school-member", reviewedAt: new Date("2026-05-03T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.rows).toEqual([]);
    // And the erasure read was never even reached for it, because the contact
    // dropped out at the home filter.
    expect(reads.xeroContactCache.findMany).not.toHaveBeenCalled();
  });

  it("says nothing about a contact another MEMBER now holds", async () => {
    linkLedger({ retired: [retiredLink("m5", "contact-5")] });
    reads.member.findMany.mockResolvedValue([
      { id: "m-other", xeroContactId: "contact-5" },
    ]);
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m5", reviewedAt: new Date("2026-05-04T00:00:00.000Z") },
    ]);

    expect((await getErasedMemberXeroContactReview()).rows).toEqual([]);
  });

  it("says nothing about a contact the ledger still links actively", async () => {
    // The belt to the home filter's braces: a contact still actively linked is
    // spared even where the ownership column write is the half that went
    // missing.
    linkLedger({ retired: [retiredLink("m6", "contact-6")], active: ["contact-6"] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m6", reviewedAt: new Date("2026-05-05T00:00:00.000Z") },
    ]);

    expect((await getErasedMemberXeroContactReview()).rows).toEqual([]);
  });

  it("counts a contact the live check found archived, instead of listing it", async () => {
    /*
      SEEDED THE WAY PRODUCTION REACHES IT. An earlier revision of this test
      seeded a `XeroContactCache` row saying `ARCHIVED` — and a real erasure
      DELETES that row, while the bulk contact sync fetches changed contacts
      with `includeArchived: false` and so can never write it back. It proved
      the counter on a state this population cannot be in.

      The reachable state is an observation stamped by the live check on the
      retired link, which is the one thing that ever retires a row.
    */
    linkLedger({
      retired: [
        retiredLink("m7", "contact-7", {
          contactStatus: "ARCHIVED",
          observedAt: "2026-06-20T00:00:00.000Z",
        }),
        retiredLink("m8", "contact-8", {
          contactStatus: "ACTIVE",
          observedAt: "2026-06-20T00:00:00.000Z",
        }),
      ],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m7", reviewedAt: new Date("2026-05-06T00:00:00.000Z") },
      { memberId: "m8", reviewedAt: new Date("2026-05-07T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.alreadyRetiredInXero).toBe(1);
    expect(review.needsReview).toBe(1);
    expect(review.rows.map((row) => row.xeroContactId)).toEqual(["contact-8"]);
    expect(review.rows[0].contactStatus).toBe("ACTIVE");
    expect(review.rows[0].contactStatusCheckedAt).toBe("2026-06-20T00:00:00.000Z");
    expect(review.lastContactStatusCheckAt).toBe("2026-06-20T00:00:00.000Z");
  });

  it("retires a contact Xero has been asked to erase, rather than calling it active", async () => {
    /*
      `GDPRREQUEST` is Xero's third contact status and the earlier classifier
      was a DENYLIST — anything that was not exactly `ARCHIVED` became active.
      So the one row most certainly needing no further attention was the one
      the panel asserted most confidently was live.
    */
    linkLedger({
      retired: [
        retiredLink("m11", "contact-11", {
          contactStatus: "GDPR_ERASED",
          observedAt: "2026-06-21T00:00:00.000Z",
        }),
      ],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m11", reviewedAt: new Date("2026-05-10T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.alreadyRetiredInXero).toBe(1);
    expect(review.needsReview).toBe(0);
    expect(review.rows).toEqual([]);
  });

  it("believes the live check over a leftover cache row", async () => {
    // A cache row for an erased member's contact can only be older news than an
    // observation about the same id: the erasure deleted the row, so anything
    // there predates the erasure or was written by a sync that cannot see an
    // archived contact at all.
    linkLedger({
      retired: [
        retiredLink("m12", "contact-12", {
          contactStatus: "ARCHIVED",
          observedAt: "2026-06-22T00:00:00.000Z",
        }),
      ],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m12", reviewedAt: new Date("2026-05-11T00:00:00.000Z") },
    ]);
    reads.xeroContactCache.findMany.mockResolvedValue([
      { contactId: "contact-12", contactStatus: "ACTIVE" },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.alreadyRetiredInXero).toBe(1);
    expect(review.rows).toEqual([]);
  });

  it("lists a contact the club's OWN software already archived, until somebody checks", async () => {
    /*
      The canonical sequence, not an exotic one. When a membership is cancelled
      this application archives that member's own Xero contact
      (`xeroArchiveContactsOnCancellation`) and refreshes the cache row saying
      so. A later erasure DELETES that cache row and retires the link — so the
      review finds a retired link, no local home, an approved erasure, and
      nothing at all about the contact.

      It is listed, because over-reporting is the safe direction — but it is
      listed at UNKNOWN rather than asserted to be live, and one check retires
      it. Before the check existed this row was a permanent false accusation
      about a contact the club's own software had already dealt with.
    */
    linkLedger({ retired: [retiredLink("m13", "contact-13")] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m13", reviewedAt: new Date("2026-05-12T00:00:00.000Z") },
    ]);

    const before = await getErasedMemberXeroContactReview();
    expect(before.needsReview).toBe(1);
    expect(before.rows[0].contactStatus).toBe("UNKNOWN");
    expect(before.rows[0].contactStatusCheckedAt).toBeNull();
    expect(before.lastContactStatusCheckAt).toBeNull();

    // ...and once the check has asked Xero, with archived included:
    linkLedger({
      retired: [
        retiredLink("m13", "contact-13", {
          contactStatus: "ARCHIVED",
          observedAt: "2026-06-23T00:00:00.000Z",
        }),
      ],
    });

    const after = await getErasedMemberXeroContactReview();
    expect(after.needsReview).toBe(0);
    expect(after.alreadyRetiredInXero).toBe(1);
  });

  it("keeps the freshest observation when two retired roles name one contact", async () => {
    // The ledger's unique key includes `role`, so one member can hold several
    // retired links to one contact. An older stamp on a second role must not
    // un-retire a row the newer one retired.
    linkLedger({
      retired: [
        retiredLink("m14", "contact-14", {
          contactStatus: "ACTIVE",
          observedAt: "2026-06-01T00:00:00.000Z",
        }),
        retiredLink("m14", "contact-14", {
          contactStatus: "ARCHIVED",
          observedAt: "2026-06-24T00:00:00.000Z",
        }),
      ],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m14", reviewedAt: new Date("2026-05-13T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.alreadyRetiredInXero).toBe(1);
    expect(review.rows).toEqual([]);
  });

  it("reads TWO columns of the contact cache, and no more", async () => {
    /*
      The privacy pin. The cache row also holds the erased person's name, email,
      phone and address, re-cached from Xero by a later contact sync — so a
      widened `select` here would quietly re-import the details of somebody this
      club has erased onto an admin screen. The assertion is on the exact select
      rather than on "does not include name", because the next field added to
      `XeroContactCache` would pass that weaker form.
    */
    linkLedger({ retired: [retiredLink("m9", "contact-9")] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m9", reviewedAt: new Date("2026-05-08T00:00:00.000Z") },
    ]);

    await getErasedMemberXeroContactReview();

    expect(reads.xeroContactCache.findMany).toHaveBeenCalledTimes(1);
    expect(reads.xeroContactCache.findMany.mock.calls[0][0].select).toEqual({
      contactId: true,
      contactStatus: true,
    });
  });

  it("carries no member name or email on any row", async () => {
    linkLedger({ retired: [retiredLink("m10", "contact-10")] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m10", reviewedAt: new Date("2026-05-09T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(Object.keys(review.rows[0]).sort()).toEqual([
      "contactStatus",
      "contactStatusCheckedAt",
      "erasedAt",
      "erasure",
      "memberId",
      "xeroContactId",
    ]);
  });

  it("orders oldest erasure first and sorts an undated one last", async () => {
    linkLedger({
      retired: [
        retiredLink("recent", "c-recent"),
        retiredLink("undated", "c-undated"),
        retiredLink("oldest", "c-oldest"),
      ],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "recent", reviewedAt: new Date("2026-06-01T00:00:00.000Z") },
      { memberId: "undated", reviewedAt: null },
      { memberId: "oldest", reviewedAt: new Date("2025-01-01T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.rows.map((row) => row.memberId)).toEqual([
      "oldest",
      "recent",
      "undated",
    ]);
  });

  it("counts the whole population even when the rows are capped", async () => {
    linkLedger({
      retired: [retiredLink("a", "c-a"), retiredLink("b", "c-b")],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "a", reviewedAt: new Date("2026-01-01T00:00:00.000Z") },
      { memberId: "b", reviewedAt: new Date("2026-02-01T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview({ limit: 1 });

    expect(review.needsReview).toBe(2);
    expect(review.rows).toHaveLength(1);
    expect(review.truncated).toBe(true);
  });

  it("shows one row where a member holds the same contact under two roles", async () => {
    // The ledger's unique key includes `role`, so one erasure can retire more
    // than one row for one contact. That is one fact, not two on a screen.
    linkLedger({
      retired: [retiredLink("m11", "contact-11"), retiredLink("m11", "contact-11")],
    });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m11", reviewedAt: new Date("2026-05-10T00:00:00.000Z") },
    ]);

    expect((await getErasedMemberXeroContactReview()).rows).toHaveLength(1);
  });

  it("reports cache staleness without letting it change the list", async () => {
    reads.xeroSyncCursor.findUnique.mockResolvedValue(null);
    linkLedger({ retired: [retiredLink("m12", "contact-12")] });
    reads.deletionRequest.findMany.mockResolvedValue([
      { memberId: "m12", reviewedAt: new Date("2026-05-11T00:00:00.000Z") },
    ]);

    const review = await getErasedMemberXeroContactReview();

    expect(review.contactCacheLastRefreshedAt).toBeNull();
    expect(review.contactCacheStale).toBe(false);
    // The list is derived from local links and decisions, so a cache that has
    // never run does not suppress it — unlike the missing-contact census, which
    // refuses outright because every member would look unlinked.
    expect(review.rows).toHaveLength(1);
  });

  it("refuses to be a no-op reader: the write guard really discriminates", async () => {
    /*
      The Proxy above is what every other test in this file leans on, so it is
      itself proved here rather than trusted: reaching a mutating method on any
      delegate — including one this engine never touches — throws.
    */
    type Refusing = (...args: unknown[]) => unknown;
    const client = mocks.prisma as unknown as Record<
      string,
      Record<string, Refusing>
    > & {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    };

    // EVERY listed mutating method, not a sample of them: a method that fell
    // out of the set would otherwise leave a silent hole in every other test
    // in this file.
    for (const method of mocks.MUTATING_METHODS) {
      expect(() => client.member[method]({})).toThrow(/must write nothing/);
    }
    // Including on a delegate nobody has added yet, which is the whole point
    // of proxying rather than spying on the delegates this engine reads.
    expect(() => client.somethingNobodyHasAddedYet.deleteMany({})).toThrow(
      /must write nothing/,
    );
    expect(() => client.$executeRaw``).toThrow(/must write nothing/);
  });
});

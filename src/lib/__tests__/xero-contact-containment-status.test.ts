import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Xero-containment summary an operator reads (ENV-SAFETY 3, #3036; epic
 * #2986; INV-CONFIG-005).
 *
 * WHY THIS NUMBER EXISTS. `/admin/environment` already says which installation
 * this is. What the role cannot say is whether this copy has been pointed at the
 * club's REAL Xero organisation — and if it has, containment has rewritten email
 * addresses on real accounting records. That is a destructive edit made for a
 * good reason, and the person who finds it needs to know how many contacts it
 * touched, WHICH ones, and when. So: two counts that are never summed, three
 * instants that answer different questions, and a bounded addressable list.
 */

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  memberFindMany: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSandboxContactContainment: {
      aggregate: mocks.aggregate,
      count: mocks.count,
      findMany: mocks.findMany,
    },
    member: { findMany: mocks.memberFindMany },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  readXeroContactContainment,
  REWRITTEN_CONTACT_SAMPLE_LIMIT,
} from "@/lib/xero-contact-containment-status";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.memberFindMany.mockResolvedValue([]);
});

/** The aggregate shape the reader asks for, with every instant supplied. */
function aggregate(params: {
  all: number;
  updatedAt?: Date | null;
  rewrittenAt?: Date | null;
  containedAt?: Date | null;
}) {
  return {
    _count: { _all: params.all },
    _max: {
      updatedAt: params.updatedAt ?? null,
      rewrittenAt: params.rewrittenAt ?? null,
    },
    _min: { containedAt: params.containedAt ?? null },
  };
}

describe("readXeroContactContainment", () => {
  it("reports how many contacts are contained and how many held a real address", async () => {
    mocks.aggregate.mockResolvedValue(
      aggregate({
        all: 214,
        updatedAt: new Date("2026-06-25T02:00:00.000Z"),
        rewrittenAt: new Date("2026-06-20T01:00:00.000Z"),
        containedAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    mocks.count.mockResolvedValue(198);

    expect(await readXeroContactContainment()).toEqual({
      available: true,
      containedContacts: 214,
      rewrittenContacts: 198,
      mostRecentAt: "2026-06-25T02:00:00.000Z",
      lastRewrittenAt: "2026-06-20T01:00:00.000Z",
      firstContainedAt: "2026-06-01T00:00:00.000Z",
      rewritten: [],
    });
  });

  it("keeps the last CHECK and the last REWRITE apart", async () => {
    /*
      The two instants answer different questions and the difference is the whole
      reason there are two. `mostRecentAt` moves whenever this copy re-checks any
      contact — which is whenever it runs anything at all. `lastRewrittenAt` is
      the date of the destructive edit. Reporting the first under the second's
      sentence dates a June overwrite to this morning.
    */
    mocks.aggregate.mockResolvedValue(
      aggregate({
        all: 5,
        updatedAt: new Date("2026-06-30T23:00:00.000Z"),
        rewrittenAt: new Date("2026-06-02T09:00:00.000Z"),
        containedAt: new Date("2026-06-02T09:00:00.000Z"),
      }),
    );
    mocks.count.mockResolvedValue(1);

    const summary = await readXeroContactContainment();
    expect(summary).toMatchObject({
      mostRecentAt: "2026-06-30T23:00:00.000Z",
      lastRewrittenAt: "2026-06-02T09:00:00.000Z",
      firstContainedAt: "2026-06-02T09:00:00.000Z",
    });
  });

  it("counts the rewritten ones as a SUBSET, keyed on the flag", async () => {
    // Not a second population: the same table, narrowed to the contacts that
    // were holding something deliverable when this installation overwrote it.
    mocks.aggregate.mockResolvedValue(
      aggregate({ all: 3, updatedAt: new Date("2026-06-01T00:00:00.000Z") }),
    );
    mocks.count.mockResolvedValue(0);

    const summary = await readXeroContactContainment();
    expect(summary).toMatchObject({
      containedContacts: 3,
      rewrittenContacts: 0,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { rewroteAddress: true } });
  });

  it("says null for every instant when nothing has been contained", async () => {
    mocks.aggregate.mockResolvedValue(aggregate({ all: 0 }));
    mocks.count.mockResolvedValue(0);

    expect(await readXeroContactContainment()).toEqual({
      available: true,
      containedContacts: 0,
      rewrittenContacts: 0,
      mostRecentAt: null,
      lastRewrittenAt: null,
      firstContainedAt: null,
      rewritten: [],
    });
  });

  describe("the addressable list", () => {
    /*
      A count tells an operator that damage exists and gives them no way to act
      on it: the repair is per contact, performed in Xero, and "re-sync those
      members" has no addressable "those" behind it. The row holds the contact
      id, so the list is one extra bounded query.
    */
    it("names the member and links the contact for each rewritten one", async () => {
      mocks.aggregate.mockResolvedValue(
        aggregate({
          all: 2,
          updatedAt: new Date("2026-06-25T02:00:00.000Z"),
          rewrittenAt: new Date("2026-06-25T02:00:00.000Z"),
        }),
      );
      mocks.count.mockResolvedValue(2);
      mocks.findMany.mockResolvedValue([
        {
          xeroContactId: "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
          rewrittenAt: new Date("2026-06-25T02:00:00.000Z"),
        },
        {
          xeroContactId: "11111111-2222-3333-4444-555555555555",
          rewrittenAt: new Date("2026-06-24T02:00:00.000Z"),
        },
      ]);
      mocks.memberFindMany.mockResolvedValue([
        {
          id: "member-1",
          firstName: "Ada",
          lastName: "Lovelace",
          xeroContactId: "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
        },
      ]);

      const summary = await readXeroContactContainment();
      expect(summary.available).toBe(true);
      if (!summary.available) return;
      expect(summary.rewritten).toEqual([
        {
          xeroContactId: "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
          xeroContactUrl:
            "https://go.xero.com/Contacts/View/8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
          memberName: "Ada Lovelace",
          memberId: "member-1",
          rewrittenAt: "2026-06-25T02:00:00.000Z",
        },
        {
          // No member points at this contact any more — a merge moved the link,
          // or the contact was imported and never claimed. It is still a contact
          // this installation edited, so it is still listed.
          xeroContactId: "11111111-2222-3333-4444-555555555555",
          xeroContactUrl:
            "https://go.xero.com/Contacts/View/11111111-2222-3333-4444-555555555555",
          memberName: null,
          memberId: null,
          rewrittenAt: "2026-06-24T02:00:00.000Z",
        },
      ]);
    });

    it("lists only the rewritten ones, newest first, and bounds the page", async () => {
      mocks.aggregate.mockResolvedValue(aggregate({ all: 900 }));
      mocks.count.mockResolvedValue(700);
      await readXeroContactContainment();
      expect(mocks.findMany).toHaveBeenCalledWith({
        where: { rewroteAddress: true },
        select: { xeroContactId: true, rewrittenAt: true },
        orderBy: { rewrittenAt: { sort: "desc", nulls: "last" } },
        take: REWRITTEN_CONTACT_SAMPLE_LIMIT,
      });
      expect(REWRITTEN_CONTACT_SAMPLE_LIMIT).toBeLessThanOrEqual(100);
      /*
        NULLS LAST, explicitly. Postgres sorts NULLs FIRST on a DESC order, and
        nothing in the database ties `rewroteAddress: true` to a non-null
        `rewrittenAt` — only this application's writer does. Without this, a pair
        that ever came apart would put an undated row at the TOP of the list an
        operator repairs from.
      */
      const [args] = mocks.findMany.mock.calls[0] as [
        { orderBy: { rewrittenAt: unknown } },
      ];
      expect(args.orderBy.rewrittenAt).toEqual({ sort: "desc", nulls: "last" });
    });

    it("asks for no member names at all when nothing was rewritten", async () => {
      mocks.aggregate.mockResolvedValue(aggregate({ all: 4 }));
      mocks.count.mockResolvedValue(0);
      mocks.findMany.mockResolvedValue([]);
      await readXeroContactContainment();
      expect(mocks.memberFindMany).not.toHaveBeenCalled();
    });

    it("carries no email address anywhere in the payload", async () => {
      /*
        The whole reason the stored fingerprint is a hash. An operator surface
        may report containment; it may not become a second place a member's real
        address lives.
      */
      mocks.aggregate.mockResolvedValue(
        aggregate({ all: 1, rewrittenAt: new Date("2026-06-25T02:00:00.000Z") }),
      );
      mocks.count.mockResolvedValue(1);
      mocks.findMany.mockResolvedValue([
        {
          xeroContactId: "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
          rewrittenAt: new Date("2026-06-25T02:00:00.000Z"),
        },
      ]);
      mocks.memberFindMany.mockResolvedValue([
        {
          id: "member-1",
          firstName: "Ada",
          lastName: "Lovelace",
          xeroContactId: "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34",
        },
      ]);

      const summary = await readXeroContactContainment();
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("@");
      // Anti-vacuity: the payload really does carry the list this asserts about.
      expect(serialized).toContain("Ada Lovelace");
      // And the queries never asked for an address in the first place.
      const [contactArgs] = mocks.findMany.mock.calls[0] as [
        { select: Record<string, unknown> },
      ];
      expect(Object.keys(contactArgs.select).sort()).toEqual([
        "rewrittenAt",
        "xeroContactId",
      ]);
      const [memberArgs] = mocks.memberFindMany.mock.calls[0] as [
        { select: Record<string, unknown> },
      ];
      expect(Object.keys(memberArgs.select).sort()).toEqual([
        "firstName",
        "id",
        "lastName",
        "xeroContactId",
      ]);
    });
  });

  it("answers UNAVAILABLE rather than zero when the table cannot be read", async () => {
    /*
      The distinction is the point. "Nothing has been contained" says this copy
      has not touched the club's accounting; "we could not count" says nobody
      knows. On a copy that has been pointed at the real Xero organisation those
      are opposite answers, and a fabricated zero is the reassuring one.
    */
    mocks.aggregate.mockRejectedValue(new Error("relation does not exist"));
    mocks.count.mockRejectedValue(new Error("relation does not exist"));
    mocks.findMany.mockRejectedValue(new Error("relation does not exist"));

    expect(await readXeroContactContainment()).toEqual({ available: false });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = mocks.logger.error.mock.calls[0];
    expect(message).toContain("prisma migrate deploy");
    // The Prisma error's MESSAGE and nothing else: a Prisma error can carry the
    // client's configuration on adjacent fields, and DATABASE_URL holds the
    // database password.
    expect(payload.err).toEqual({ message: "relation does not exist" });
    expect(Object.keys(payload).sort()).toEqual(["err", "scope"]);
  });

  it("fails soft, so an admin page renders rather than 500ing", async () => {
    mocks.aggregate.mockRejectedValue(new Error("boom"));
    mocks.count.mockRejectedValue(new Error("boom"));
    mocks.findMany.mockRejectedValue(new Error("boom"));
    await expect(readXeroContactContainment()).resolves.toEqual({
      available: false,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockTx, mockRequireActiveSessionUser } = vi.hoisted(() => {
  const mockTx = {
    familyGroup: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      // #2716: the transfer rewrites the address on every member of the
      // cluster, so it re-resolves email inheritance in the same transaction —
      // the cluster's own pointers, then anyone outside it who inherits from a
      // cluster member. Both halves read through `findMany`.
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  const mockPrisma = {
    $transaction: vi.fn(),
  };

  return {
    mockPrisma,
    mockTx,
    mockRequireActiveSessionUser: vi.fn(async () => null),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { POST } from "@/app/api/admin/family-groups/[id]/login-holder/route";
import {
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";
import { LOGIN_HOLDER_SIGN_OUT_NOTICE } from "@/lib/admin-family-group-ui-helpers";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
// A Membership Officer: has admin-portal access but is not a Full Admin.
const officerSession = { user: { id: "officer-1", role: "USER", accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] } } as any;
const adminAccessRoles = [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }];
const passwordDate = new Date("2026-05-01T00:00:00.000Z");

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/family-groups/group-1/login-holder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "shared@example.com",
    firstName: "Alice",
    lastName: "Smith",
    ageTier: "ADULT",
    active: true,
    canLogin: false,
    passwordHash: "hash",
    passwordChangedAt: passwordDate,
    lastLoginAt: null,
    inheritEmailFromId: "old-holder",
    inheritEmailFrom: { email: "shared@example.com" },
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [],
    ...overrides,
  };
}

function makeGroup(members: Array<ReturnType<typeof makeMember>>) {
  return {
    id: "group-1",
    memberships: members.map((member) => ({ member })),
  };
}

describe("POST /api/admin/family-groups/[id]/login-holder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(adminSession);
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) =>
      callback(mockTx)
    );
    mockTx.member.findUnique.mockResolvedValue({
      id: "new-holder",
      ageTier: "ADULT",
      parentMemberId: null,
      inheritEmailFromId: null,
      // #2716: the source check reads the CHOICE column too — an adult whose
      // chosen source went unreachable holds a live choice beside a NULL
      // pointer, and must not be handed a cluster to receive mail for. The
      // incoming holder has chosen nobody, which is what makes them usable.
      inheritEmailChoiceId: null,
      email: "shared@example.com",
      archivedAt: null,
    });
    // The reconciliation re-reads members through the transaction. These mocked
    // writes update no store, so there is nothing coherent to read back: no
    // rows is the only honest answer, and it keeps the assertions below about
    // the writes the route makes rather than about a fake convergence.
    mockTx.member.findMany.mockResolvedValue([]);
    // Last-admin end-state (#1604/#1622) counts active Full Admins AFTER the
    // transfer's writes; default to one surviving so the guard is a no-op.
    mockTx.member.count.mockResolvedValue(1);
    // #2385 login-email pre-check: nobody outside this family group logs in
    // with the requested address unless a test says so.
    mockTx.member.findFirst.mockResolvedValue(null);
  });

  it("swaps login holder in a shared 2-adult cluster", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          firstName: "Old",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder", firstName: "New" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    // #2716: both columns, on both sides of the swap. `inheritEmailFromId` is
    // who receives the mail today; `inheritEmailChoiceId` is who was CHOSEN,
    // and it is the only record that survives the holder's address being
    // removed. A write that recorded the pointer alone would leave a cluster
    // whose mailbox could never be restored once the address came back.
    expect(mockTx.member.update).toHaveBeenCalledWith({
      where: { id: "old-holder" },
      data: {
        canLogin: false,
        email: "shared@example.com",
        inheritEmailFromId: "new-holder",
        inheritEmailChoiceId: "new-holder",
      },
    });
    expect(mockTx.member.update).toHaveBeenCalledWith({
      where: { id: "new-holder" },
      data: {
        canLogin: true,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
        email: "shared@example.com",
      },
    });
  });

  it("rejects if the new holder is not ADULT", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
        makeMember({ id: "child-1", ageTier: "CHILD" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "child-1",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("rejects if the new holder is not in the family group", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "missing-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("rejects if the new holder has no password", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({ id: "old-holder", canLogin: true, inheritEmailFromId: null }),
        makeMember({ id: "new-holder", passwordHash: null, passwordChangedAt: null }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(422);
    expect(mockTx.member.update).not.toHaveBeenCalled();
  });

  it("cascades email inheritance across the shared-email cluster", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder" }),
        makeMember({
          id: "youth-1",
          ageTier: "YOUTH",
          passwordHash: null,
          passwordChangedAt: null,
        }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockTx.member.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-holder", "youth-1"] } },
      data: {
        canLogin: false,
        email: "shared@example.com",
        inheritEmailFromId: "new-holder",
        // #2716: the rest of the cluster records the CHOICE beside the pointer
        // for the same reason the holders above do — without it, removing the
        // new holder's address would strand the whole cluster permanently.
        inheritEmailChoiceId: "new-holder",
      },
    });
  });

  // #3603: switching a login off stamps the member's revocation time and signs
  // them out, so re-saving the CURRENT holder (the editor pre-selects them)
  // must never write canLogin: false for them, not even transiently.
  it("never switches the login off when the same holder is saved again", async () => {
    mockTx.member.findUnique.mockResolvedValue({
      id: "holder",
      ageTier: "ADULT",
      parentMemberId: null,
      inheritEmailFromId: null,
      inheritEmailChoiceId: null,
      email: "shared@example.com",
      archivedAt: null,
    });
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "other-adult" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    const holderWrites = mockTx.member.update.mock.calls
      .map(([args]) => args as { where: { id: string }; data: Record<string, unknown> })
      .filter((args) => args.where.id === "holder");
    expect(holderWrites.length).toBeGreaterThan(0);
    for (const write of holderWrites) {
      expect(write.data.canLogin).not.toBe(false);
    }
    expect(holderWrites.at(-1)?.data.canLogin).toBe(true);
    // Nobody is signed out, so no audit row carries the sign-out notice.
    for (const [args] of mockTx.auditLog.create.mock.calls) {
      expect(String((args as { data: { details: string } }).data.details)).not.toContain(
        "signed out",
      );
    }
  });

  it("writes audit logs for each touched member and records the sign-out notice for the old holder", async () => {
    mockTx.familyGroup.findUnique.mockResolvedValue(
      makeGroup([
        makeMember({
          id: "old-holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder" }),
        makeMember({ id: "youth-1", ageTier: "YOUTH" }),
      ])
    );

    const res = await POST(makeReq({
      email: "shared@example.com",
      newHolderId: "new-holder",
    }), {
      params: Promise.resolve({ id: "group-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(3);
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "family-group.login-holder-swapped",
        memberId: "admin-1",
        targetId: "old-holder",
        details: expect.stringContaining(LOGIN_HOLDER_SIGN_OUT_NOTICE),
      }),
    });
  });

  describe("admin-account guards (#1604/#1622)", () => {
    it("blocks a Membership Officer from transferring away an admin-holding login holder", async () => {
      mockedAuth.mockResolvedValue(officerSession);
      mockTx.familyGroup.findUnique.mockResolvedValue(
        makeGroup([
          makeMember({
            id: "old-holder",
            canLogin: true,
            inheritEmailFromId: null,
            inheritEmailFrom: null,
            role: "ADMIN",
            accessRoles: adminAccessRoles,
          }),
          makeMember({ id: "new-holder" }),
        ])
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: PRIVILEGED_TARGET_GUARD_MESSAGE,
      });
      expect(mockTx.member.update).not.toHaveBeenCalled();
    });

    it("allows a Full Admin to transfer an admin-holding login holder", async () => {
      mockTx.familyGroup.findUnique.mockResolvedValue(
        makeGroup([
          makeMember({
            id: "old-holder",
            canLogin: true,
            inheritEmailFromId: null,
            inheritEmailFrom: null,
            role: "ADMIN",
            accessRoles: adminAccessRoles,
          }),
          makeMember({ id: "new-holder" }),
        ])
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockTx.member.update).toHaveBeenCalledWith({
        where: { id: "old-holder" },
        data: expect.objectContaining({ canLogin: false }),
      });
    });

    it("blocks a transfer whose end-state leaves no active Full Admin", async () => {
      // End-state count (post-write, incl. the new holder's canLogin grant) is
      // zero: the transfer would strand the club, so it rolls back with 409.
      mockTx.member.count.mockResolvedValue(0);
      mockTx.familyGroup.findUnique.mockResolvedValue(
        makeGroup([
          makeMember({
            id: "old-holder",
            canLogin: true,
            inheritEmailFromId: null,
            inheritEmailFrom: null,
          }),
          makeMember({ id: "new-holder" }),
        ])
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: LAST_FULL_ADMIN_GUARD_MESSAGE,
      });
    });

    it("allows the transfer when the incoming holder keeps a Full Admin in the end-state", async () => {
      // The outgoing holder was the last admin, but the incoming holder is
      // himself a Full Admin whose canLogin flips true, so the post-write count
      // stays positive and the transfer is allowed.
      mockTx.member.count.mockResolvedValue(1);
      mockTx.familyGroup.findUnique.mockResolvedValue(
        makeGroup([
          makeMember({
            id: "old-holder",
            canLogin: true,
            inheritEmailFromId: null,
            inheritEmailFrom: null,
            role: "ADMIN",
            accessRoles: adminAccessRoles,
          }),
          makeMember({
            id: "new-holder",
            role: "ADMIN",
            accessRoles: adminAccessRoles,
          }),
        ])
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockTx.member.update).toHaveBeenCalledWith({
        where: { id: "new-holder" },
        data: expect.objectContaining({ canLogin: true }),
      });
    });
  });

  describe("login-email uniqueness (#2385)", () => {
    const cluster = () =>
      makeGroup([
        makeMember({
          id: "old-holder",
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        }),
        makeMember({ id: "new-holder" }),
      ]);

    it("refuses when a member outside the family group already logs in with the address", async () => {
      mockTx.familyGroup.findUnique.mockResolvedValue(cluster());
      mockTx.member.findFirst.mockResolvedValue({ id: "stranger" });

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "A member with this email already exists",
      });
      // Checked before anything is written, and the cluster this transfer
      // rewrites itself is excluded (the outgoing holder frees the index slot).
      expect(mockTx.member.findFirst).toHaveBeenCalledWith({
        where: {
          email: "shared@example.com",
          canLogin: true,
          id: { notIn: ["old-holder", "new-holder"] },
        },
        select: { id: true },
      });
      expect(mockTx.member.update).not.toHaveBeenCalled();
    });

    it("gives the loser of a concurrent claim the same message, not a 500", async () => {
      mockTx.familyGroup.findUnique.mockResolvedValue(cluster());
      // Pre-check passes; another write claims the address before this one.
      mockTx.member.update.mockRejectedValueOnce(
        Object.assign(
          new Error("Unique constraint failed on the fields: (`email`)"),
          { code: "P2002" },
        ),
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "A member with this email already exists",
      });
    });

    it("does not blame the email for a collision on another unique column", async () => {
      mockTx.familyGroup.findUnique.mockResolvedValue(cluster());
      mockTx.member.update.mockRejectedValueOnce(
        Object.assign(
          new Error("Unique constraint failed on the fields: (`googleSub`)"),
          { code: "P2002" },
        ),
      );

      const res = await POST(makeReq({
        email: "shared@example.com",
        newHolderId: "new-holder",
      }), {
        params: Promise.resolve({ id: "group-1" }),
      });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: "Failed to swap family group login holder",
      });
    });
  });
});

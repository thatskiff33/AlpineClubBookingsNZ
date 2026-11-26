/**
 * ALP-720 (`INV-MCP-006`): the locker actions an officer's AI app connection
 * may run, each held to its contract (`expectActionContract`): the
 * connection gets exactly the action's `returns` fields and the browser's
 * answer is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    locker: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    member: { findMany: vi.fn(), findFirst: vi.fn() },
    lodge: { findUnique: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/lodges", () => ({
  lodgeNullTolerantScope: (lodgeId: string) => ({ lodgeId }),
  resolveOptionalActiveLodgeId: vi.fn(async () => "lodge-1"),
}));

import { GET as listLockers, POST as createLocker } from "@/app/api/admin/lockers/route";
import { DELETE as deleteLocker, PUT as updateLocker } from "@/app/api/admin/lockers/[id]/route";
import { POST as bulkCreateLockers } from "@/app/api/admin/lockers/bulk/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

/** A locker row as the routes read it, with a column no action returns. */
const lockerRow = {
  id: "locker-1",
  name: "Locker 1",
  lodgeId: "lodge-1",
  allocatedToMemberId: "member-2",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  allocatedTo: { id: "member-2", firstName: "Ana", lastName: "Hale" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
  h.prisma.locker.findFirst.mockResolvedValue(null);
  h.prisma.member.findFirst.mockResolvedValue({ id: "member-2" });
});

describe("list_lockers", () => {
  it("sends the lockers and never the screen's list of every active member", async () => {
    h.prisma.locker.findMany.mockResolvedValue([lockerRow]);
    h.prisma.member.findMany.mockResolvedValue([{ id: "member-3", firstName: "Kai", lastName: "Ngata" }]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_lockers",
      handler: listLockers,
      args: { lodgeId: "lodge-1" },
    });

    expect(connection).toEqual({
      lockers: [
        {
          id: "locker-1",
          name: "Locker 1",
          lodgeId: "lodge-1",
          allocatedToMemberId: "member-2",
          allocatedTo: { id: "member-2", firstName: "Ana", lastName: "Hale" },
        },
      ],
    });
    expect(browser).toMatchObject({ members: [{ id: "member-3" }] });
    expect(h.prisma.locker.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { lodgeId: "lodge-1" } }));
  });
});

describe("create_locker, update_locker and bulk_create_lockers", () => {
  it("creates one locker and answers with it", async () => {
    h.prisma.locker.create.mockResolvedValue(lockerRow);

    const { connection } = await expectActionContract({
      actionId: "create_locker",
      handler: createLocker,
      args: { name: "Locker 1", allocatedToMemberId: "member-2" },
    });

    expect(connection).toMatchObject({ locker: { id: "locker-1", allocatedTo: { firstName: "Ana" } } });
  });

  it("renames a locker and answers with it", async () => {
    h.prisma.locker.findUnique.mockResolvedValue(lockerRow);
    h.prisma.locker.update.mockResolvedValue({ ...lockerRow, name: "Locker 9" });

    const { connection } = await expectActionContract({
      actionId: "update_locker",
      handler: updateLocker,
      args: { id: "locker-1", name: "Locker 9", allocatedToMemberId: "member-2" },
    });

    expect(connection).toMatchObject({ locker: { name: "Locker 9" } });
    expect(h.prisma.locker.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "locker-1" }, data: { name: "Locker 9", allocatedToMemberId: "member-2" } }),
    );
  });

  it("seeds numbered lockers and answers with how many", async () => {
    h.prisma.locker.createMany.mockResolvedValue({ count: 3 });

    const { connection } = await expectActionContract({
      actionId: "bulk_create_lockers",
      handler: bulkCreateLockers,
      args: { count: 3, namePrefix: "Rack" },
    });

    expect(connection).toEqual({ createdCount: 3 });
    expect(h.prisma.locker.createMany).toHaveBeenCalledWith({
      data: ["Rack 1", "Rack 2", "Rack 3"].map((name) => ({ name, lodgeId: "lodge-1" })),
    });
  });
});

describe("delete_locker", () => {
  it("deletes the locker named in the address", async () => {
    h.prisma.locker.findUnique.mockResolvedValue(lockerRow);

    const { connection } = await expectActionContract({
      actionId: "delete_locker",
      handler: deleteLocker,
      args: { id: "locker-1" },
    });

    expect(connection).toEqual({ success: true });
    expect(h.prisma.locker.delete).toHaveBeenCalledWith({ where: { id: "locker-1" } });
  });
});

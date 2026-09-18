import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, capacityLockMock, prismaMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  capacityLockMock: vi.fn(),
  prismaMock: {
    bedAllocation: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    lodge: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }));
vi.mock("@/lib/capacity", async () => {
  const actual = (await vi.importActual("@/lib/capacity")) as typeof import("@/lib/capacity");
  return { ...actual, acquireLodgeCapacityLock: capacityLockMock };
});
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  approveBedAllocations,
} from "@/lib/bed-allocation-approval";

describe("bed allocation approval transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
    );
    prismaMock.bedAllocation.findMany.mockResolvedValue([{ id: "alloc-1" }]);
    prismaMock.bedAllocation.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.lodge.findMany.mockResolvedValue([
      { id: "lodge-1" },
      { id: "lodge-2" },
    ]);
    capacityLockMock.mockResolvedValue(undefined);
    auditMock.mockResolvedValue(undefined);
  });

  it("narrows allocation ids by lodge before locking and approving", async () => {
    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      allocationIds: ["alloc-1", "off-lodge"],
      lodgeId: "lodge-1",
    });

    const lockWhere = prismaMock.bedAllocation.findMany.mock.calls[0][0].where;
    const updateWhere = prismaMock.bedAllocation.updateMany.mock.calls[0][0].where;
    expect(lockWhere).toMatchObject({
      approvedAt: null,
      id: { in: ["alloc-1", "off-lodge"] },
      room: expect.any(Object),
    });
    expect(updateWhere).toEqual(lockWhere);
    expect(capacityLockMock).toHaveBeenCalledWith(prismaMock, "lodge-1");
  });

  it("keeps a booking approval searchable and writes its audit through tx", async () => {
    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      bookingId: "booking-1",
    });

    expect(prismaMock.lodge.findMany).toHaveBeenCalledWith({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(capacityLockMock.mock.calls.map(([, lodgeId]) => lodgeId)).toEqual([
      "lodge-1",
      "lodge-2",
    ]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_APPROVED",
        targetId: "booking-1",
        metadata: expect.objectContaining({ bookingId: "booking-1" }),
      }),
      prismaMock,
    );
  });

  it("keeps board range approvals unattributed to a single booking", async () => {
    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      lodgeId: "lodge-1",
      range: {
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-03T00:00:00.000Z"),
        fromDate: "2026-08-01",
        toDate: "2026-08-03",
      },
    });

    expect(auditMock.mock.calls[0][0].targetId).toBeUndefined();
    expect(auditMock.mock.calls[0][1]).toBe(prismaMock);
  });

  it("rejects the approval transaction when its audit write fails", async () => {
    auditMock.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      approveBedAllocations({
        approvedByMemberId: "admin-1",
        allocationIds: ["alloc-1"],
        lodgeId: "lodge-1",
      }),
    ).rejects.toThrow("audit unavailable");

    expect(prismaMock.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toBe(prismaMock);
  });
});

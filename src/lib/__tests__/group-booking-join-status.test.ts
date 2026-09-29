import { beforeEach, describe, expect, it, vi } from "vitest";
import { GroupBookingStatus } from "@prisma/client";

/*
 * #3672 review (close/reopen race): an organiser's close or reopen must never
 * write OPEN or CLOSED over CANCELLED. The organiser-pays cancel fence writes
 * CANCELLED under `lock(1)`, and the paid apply, the reaper and the payer
 * switch rely on it. So the write takes the same key, re-reads the status
 * under it, and is status-guarded.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  txFindUnique: vi.fn(),
  txUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

const tx = {
  $executeRaw: mocks.executeRaw,
  groupBooking: { findUnique: mocks.txFindUnique, updateMany: mocks.txUpdateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.findUnique },
    $transaction: mocks.transaction,
  },
}));

import {
  closeGroupBooking,
  GroupBookingError,
  reopenGroupBooking,
} from "@/lib/group-booking";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (cb: (store: typeof tx) => unknown) => cb(tx));
  mocks.executeRaw.mockResolvedValue(undefined);
  // The ownership read, before any lock: the group looked open.
  mocks.findUnique.mockResolvedValue({
    id: "group-1",
    organiserMemberId: "organiser-1",
    status: GroupBookingStatus.CLOSED,
  });
  mocks.txFindUnique.mockResolvedValue({ status: GroupBookingStatus.CLOSED });
  mocks.txUpdateMany.mockResolvedValue({ count: 1 });
});

describe.each([
  ["reopen", reopenGroupBooking, GroupBookingStatus.OPEN],
  ["close", closeGroupBooking, GroupBookingStatus.CLOSED],
] as const)("%s a group booking (#3672 review)", (_name, write, target) => {
  it("takes lock(1), re-reads under it, and writes with a status guard", async () => {
    await expect(write("ABCD2345", "organiser-1")).resolves.toEqual({
      id: "group-1",
      status: target,
    });

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(String(mocks.executeRaw.mock.calls[0][0].join("?"))).toContain(
      "pg_advisory_xact_lock(1)"
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.txUpdateMany).toHaveBeenCalledWith({
      where: { id: "group-1", status: { not: GroupBookingStatus.CANCELLED } },
      data: { status: target },
    });
  });

  it("refuses, writing nothing, when the group was cancelled after the stale read", async () => {
    // Read before the lock: not cancelled. Under the lock: the cancel won.
    mocks.txFindUnique.mockResolvedValue({ status: GroupBookingStatus.CANCELLED });

    await expect(write("ABCD2345", "organiser-1")).rejects.toMatchObject({
      status: 409,
      message: "This group booking has been cancelled",
    });
    expect(mocks.txUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses when the guarded write matches nothing", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 0 });

    await expect(write("ABCD2345", "organiser-1")).rejects.toBeInstanceOf(
      GroupBookingError
    );
  });

  it("still refuses a non-owner before taking any lock", async () => {
    await expect(write("ABCD2345", "someone-else")).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

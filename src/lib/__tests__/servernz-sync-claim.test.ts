import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateMany: vi.fn(), warn: vi.fn() }));

vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/prisma", () => ({
  prisma: { serverNzSettings: { updateMany: mocks.updateMany } },
}));

import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";

const NOW = new Date("2026-07-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withOtherLodgesSyncClaim", () => {
  it("runs the pass when it wins the claim, then releases it", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const fn = vi.fn().mockResolvedValue("done");

    await expect(withOtherLodgesSyncClaim(fn, NOW)).resolves.toBe("done");

    expect(fn).toHaveBeenCalledTimes(1);
    // Claim, then release scoped to OUR instant so a later run that reaped this
    // claim as stale is not released out from under itself.
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[1][0]).toEqual({
      where: { id: "default", otherLodgesSyncStartedAt: NOW },
      data: { otherLodgesSyncStartedAt: null },
    });
  });

  it("runs NO side effect when it loses the claim", async () => {
    // The whole point of a guarded claim: a lost claim must make no request.
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const fn = vi.fn();

    await expect(withOtherLodgesSyncClaim(fn, NOW)).resolves.toBeNull();

    expect(fn).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1); // claim only, no release
  });

  it("claims a stale row so a killed container cannot wedge the sync forever", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await withOtherLodgesSyncClaim(async () => null, NOW);

    const where = mocks.updateMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ otherLodgesSyncStartedAt: null });
    const cutoff = where.OR[1].otherLodgesSyncStartedAt.lt as Date;
    expect(NOW.getTime() - cutoff.getTime()).toBe(15 * 60 * 1000);
  });

  it("releases the claim even when the pass throws", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const boom = new Error("connection reset");

    await expect(
      withOtherLodgesSyncClaim(async () => {
        throw boom;
      }, NOW),
    ).rejects.toThrow(boom);

    // A failed pass must not wedge the next one.
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[1][0].data).toEqual({
      otherLodgesSyncStartedAt: null,
    });
  });
});

describe("a failed release (#66)", () => {
  it("never turns a pass that succeeded into a failure: it is logged, and the result returned", async () => {
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("connection lost"));

    await expect(withOtherLodgesSyncClaim(async () => "done", NOW)).resolves.toBe("done");
    expect(mocks.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/freed as stale/));
  });

  it("never replaces the pass's own error", async () => {
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      withOtherLodgesSyncClaim(async () => {
        throw new Error("the pass failed");
      }, NOW),
    ).rejects.toThrow("the pass failed");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  assertRequestedOtherLodgeExists,
  getPublicOtherLodges,
} from "@/lib/booking-request";

/**
 * Hidden Other lodges (#58): deleted on the central server or hidden by an
 * administrator, they are not offered to choose, but a record already naming
 * one keeps it.
 */

describe("getPublicOtherLodges (#58)", () => {
  it("offers only visible lodges", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await getPublicOtherLodges({ otherLodge: { findMany } } as never);
    expect(findMany.mock.calls[0][0].where).toEqual({ hiddenAt: null });
  });

  it("keeps the lodge a record being edited already names, even when hidden", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await getPublicOtherLodges({ otherLodge: { findMany } } as never, "ol-hidden");
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ hiddenAt: null }, { id: "ol-hidden" }],
    });
  });
});

describe("assertRequestedOtherLodgeExists (#58)", () => {
  it("refuses a hidden lodge for a new request", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      assertRequestedOtherLodgeExists("ol-hidden", { otherLodge: { findFirst } } as never),
    ).rejects.toThrow("Selected lodge not found");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "ol-hidden", hiddenAt: null },
      select: { id: true },
    });
  });

  it("accepts a visible lodge", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ol-1" });
    await expect(
      assertRequestedOtherLodgeExists("ol-1", { otherLodge: { findFirst } } as never),
    ).resolves.toBe("ol-1");
  });
});

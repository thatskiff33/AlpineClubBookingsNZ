import { describe, expect, it, vi } from "vitest";
import { assertLodgeCapacityLockHeld, LodgeCapacityLockNotHeldError } from "@/lib/lodge-capacity-lock";
import { RawSqlShapeError } from "@/lib/raw-sql-rows";

describe("assertLodgeCapacityLockHeld", () => {
  it("accepts a held key and binds the lodge id without acquiring any lock", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ held: true }]);
    await expect(assertLodgeCapacityLockHeld({ $queryRaw }, "lodge-a", "writer")).resolves.toBeUndefined();
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect($queryRaw.mock.calls[0]?.slice(1)).toEqual(["lodge-a"]);
  });
  it.each([{ rows: [{ held: false }] }, { rows: [] }])("refuses an absent lock (%j)", async ({ rows }) => {
    const $queryRaw = vi.fn().mockResolvedValue(rows);
    await expect(assertLodgeCapacityLockHeld({ $queryRaw }, "lodge-a", "writer")).rejects.toEqual(
      new LodgeCapacityLockNotHeldError("lodge-a", "writer"),
    );
  });
  it("refuses a malformed catalog response instead of treating it as held", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ held: "true" }]);
    await expect(assertLodgeCapacityLockHeld({ $queryRaw }, "lodge-a", "writer")).rejects.toBeInstanceOf(RawSqlShapeError);
  });
});

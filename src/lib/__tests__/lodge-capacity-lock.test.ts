import { describe, expect, it, vi } from "vitest";
import {
  acquireLodgeCapacityLock,
  assertLodgeCapacityLockHeld,
  LodgeCapacityLockNotHeldError,
  tryAcquireLodgeCapacityLock,
} from "@/lib/lodge-capacity-lock";
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
  it("derives the key exactly as the acquire and try-acquire mints do", async () => {
    // The probe would refuse every correctly locked caller if its key drifted from the mint.
    const keyOf = (strings: TemplateStringsArray) => {
      const sql = strings.join("$1");
      return sql.match(/hashtextextended\([^)]*\)/g);
    };
    const $executeRaw = vi.fn().mockResolvedValue(0);
    const $queryRaw = vi.fn().mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{ held: true }]);
    await acquireLodgeCapacityLock({ $executeRaw }, "lodge-a");
    await tryAcquireLodgeCapacityLock({ $queryRaw }, "lodge-a");
    await assertLodgeCapacityLockHeld({ $queryRaw }, "lodge-a", "writer");
    const mint = keyOf($executeRaw.mock.calls[0]![0]);
    expect(mint).toEqual(["hashtextextended($1, 0)"]);
    expect(keyOf($queryRaw.mock.calls[0]![0])).toEqual(mint);
    expect(keyOf($queryRaw.mock.calls[1]![0])).toEqual(mint);
    expect([$executeRaw, $queryRaw].flatMap((fn) => fn.mock.calls.map((call) => call.slice(1)))).toEqual([["lodge-a"], ["lodge-a"], ["lodge-a"]]);
  });
  it("refuses a malformed catalog response instead of treating it as held", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ held: "true" }]);
    await expect(assertLodgeCapacityLockHeld({ $queryRaw }, "lodge-a", "writer")).rejects.toBeInstanceOf(RawSqlShapeError);
  });
});

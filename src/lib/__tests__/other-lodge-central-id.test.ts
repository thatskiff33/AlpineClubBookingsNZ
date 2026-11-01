import { describe, expect, it } from "vitest";
import { usableCentralId } from "@/lib/other-lodge-central-id";
import { canRenameOtherLodge, ownedCentralLodgesSchema, ownsOtherLodge } from "@/lib/other-lodges";

describe("usableCentralId (#64)", () => {
  it("keeps an id that could key a row", () => {
    expect(usableCentralId("cmabc123")).toBe("cmabc123");
    expect(usableCentralId("x".repeat(64))).toBe("x".repeat(64));
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["padded", " cmabc123 "],
    ["over-long", "x".repeat(65)],
    ["NUL-bearing", "cm\u0000abc"],
    ["not a string", 42],
  ])("is null (match by name) for an id that is %s", (_label, raw) => {
    expect(usableCentralId(raw)).toBeNull();
  });
});

describe("ownsOtherLodge: by central id only (#69)", () => {
  const owned = [{ id: "c-1", name: "Ruapehu Lodge" }];

  it("owns a keyed row by its id, whatever it is called here", () => {
    expect(ownsOtherLodge(owned, { centralId: "c-1" })).toBe(true);
  });

  it("never owns another lodge of the same name: its id says it is not ours", () => {
    expect(ownsOtherLodge(owned, { centralId: "c-2" })).toBe(false);
  });

  it("never owns a row not keyed yet, even one with an owned lodge's name", () => {
    // Another row of that name may be ours; the download keys it first.
    expect(ownsOtherLodge(owned, { centralId: null })).toBe(false);
  });

  it("owns nothing while the list is unknown, or empty", () => {
    expect(ownsOtherLodge(null, { centralId: "c-1" })).toBe(false);
    expect(ownsOtherLodge([], { centralId: "c-1" })).toBe(false);
  });
});

describe("canRenameOtherLodge (#64)", () => {
  it("is true only for an owned lodge that is keyed", () => {
    const mine = [{ id: "c-1", name: "Mine" }];
    expect(canRenameOtherLodge(mine, { centralId: "c-1" })).toBe(true);
    expect(canRenameOtherLodge(mine, { centralId: null })).toBe(false);
    expect(canRenameOtherLodge(mine, { centralId: "c-2" })).toBe(false);
    expect(canRenameOtherLodge(null, { centralId: "c-1" })).toBe(false);
  });
});

describe("one central lodge id rule for the pull's lodges and its ownLodges (#64)", () => {
  it("refuses a padded owned id exactly as it refuses a padded lodge id", () => {
    expect(ownedCentralLodgesSchema.safeParse([{ id: " c-1", name: "Mine" }]).success).toBe(false);
    expect(usableCentralId(" c-1")).toBeNull();
    expect(ownedCentralLodgesSchema.safeParse([{ id: "c-1", name: "Mine" }]).success).toBe(true);
  });
});

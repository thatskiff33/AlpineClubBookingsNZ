import { describe, expect, it } from "vitest";
import {
  ownedNamesAsLocal,
  renameInOwnedNames,
  usableCentralId,
} from "@/lib/other-lodge-central-id";
import { canRenameOtherLodge, ownedCentralLodgesSchema } from "@/lib/other-lodges";

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

describe("ownedNamesAsLocal (#64)", () => {
  const own = [
    { id: "c-1", name: "Server Name" },
    { id: "c-2", name: "Second Lodge" },
  ];

  it("names an owned lodge by its LOCAL row's name when that row is keyed", () => {
    const local = new Map([["c-1", "Our New Name"]]);
    expect(ownedNamesAsLocal(["Server Name", "Second Lodge"], own, local)).toEqual([
      "Our New Name",
      "Second Lodge",
    ]);
  });

  it("keeps the server's names when it sent no ids (an older server)", () => {
    const local = new Map([["c-1", "Our New Name"]]);
    expect(ownedNamesAsLocal(["Server Name"], undefined, local)).toEqual(["Server Name"]);
  });

  it("keeps an empty list as an answer", () => {
    expect(ownedNamesAsLocal([], own, new Map())).toEqual([]);
  });

  it("never lists one name twice", () => {
    const local = new Map([["c-1", "Second Lodge"]]);
    expect(ownedNamesAsLocal(["Server Name", "Second Lodge"], own, local)).toEqual([
      "Second Lodge",
    ]);
  });
});

describe("renameInOwnedNames (#64)", () => {
  it("moves the one name and leaves the rest in order", () => {
    expect(renameInOwnedNames(["A", "B", "C"], "B", "Bee")).toEqual(["A", "Bee", "C"]);
  });

  it("leaves a list without the old name as it was", () => {
    expect(renameInOwnedNames(["A"], "B", "Bee")).toEqual(["A"]);
  });
});

describe("canRenameOtherLodge (#64)", () => {
  it("is true only for an owned lodge that is keyed", () => {
    expect(canRenameOtherLodge(["Mine"], { name: "Mine", centralId: "c-1" })).toBe(true);
    expect(canRenameOtherLodge(["Mine"], { name: "Mine", centralId: null })).toBe(false);
    expect(canRenameOtherLodge(["Mine"], { name: "Theirs", centralId: "c-2" })).toBe(false);
    expect(canRenameOtherLodge(null, { name: "Mine", centralId: "c-1" })).toBe(false);
  });
});

describe("one central lodge id rule for the pull's lodges and its ownLodges (#64)", () => {
  it("refuses a padded owned id exactly as it refuses a padded lodge id", () => {
    expect(ownedCentralLodgesSchema.safeParse([{ id: " c-1", name: "Mine" }]).success).toBe(false);
    expect(usableCentralId(" c-1")).toBeNull();
    expect(ownedCentralLodgesSchema.safeParse([{ id: "c-1", name: "Mine" }]).success).toBe(true);
  });
});

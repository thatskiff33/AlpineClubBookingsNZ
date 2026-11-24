import { describe, expect, it } from "vitest";

import { buildUniqueCatalogueKey, isCatalogueKey } from "@/lib/catalogue-key";

// #5248: a catalogue name can be up to 120 characters but a key at most 80, so
// the cut can land on a separator. Every key the admin pages mint must pass
// isCatalogueKey, or Export & Import refuses the category it came from.
const nothingTaken = async () => false;

describe("catalogue keys", () => {
  it("drops the underscore a cut leaves when a long name has a space at character 80", async () => {
    const name = `${"A".repeat(79)} MORE WORDS`;

    const key = await buildUniqueCatalogueKey(name, nothingTaken);

    expect(key).toBe("A".repeat(79));
    expect(isCatalogueKey(key)).toBe(true);
  });

  it("keeps a full 80-character key when the cut lands inside a word", async () => {
    const key = await buildUniqueCatalogueKey(`${"A".repeat(78)} BBBB`, nothingTaken);

    expect(key).toBe(`${"A".repeat(78)}_B`);
    expect(isCatalogueKey(key)).toBe(true);
  });

  it("never makes a double underscore when a collision suffix follows a separator", async () => {
    // The base is 77 letters, a separator, then more; the `_2` suffix cuts the
    // base to 78 characters, which would end on that separator.
    const name = `${"A".repeat(77)} BBB`;
    const firstChoice = `${"A".repeat(77)}_BBB`.slice(0, 80);
    const taken = new Set([firstChoice]);

    const key = await buildUniqueCatalogueKey(name, async (candidate) => taken.has(candidate));

    expect(key).toBe(`${"A".repeat(77)}_2`);
    expect(key).not.toContain("__");
    expect(isCatalogueKey(key)).toBe(true);
  });

  it("suffixes ordinary collisions as before", async () => {
    const taken = new Set(["FAMILY", "FAMILY_2"]);

    const key = await buildUniqueCatalogueKey("Family", async (candidate) => taken.has(candidate));

    expect(key).toBe("FAMILY_3");
  });

  it("still accepts every key shape the pages minted before, and refuses the rest", () => {
    for (const key of ["FAMILY", "COUPLE_2", "SENIOR_CITIZEN", "CUSTOM", "A".repeat(80)]) {
      expect(isCatalogueKey(key), key).toBe(true);
    }
    for (const key of ["", "family", "_FAMILY", "FAMILY_", "FAMILY__2", "A".repeat(81)]) {
      expect(isCatalogueKey(key), key).toBe(false);
    }
  });
});

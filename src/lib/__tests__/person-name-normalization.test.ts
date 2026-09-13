import { describe, expect, it } from "vitest";
import {
  normalizePersonFullName,
  normalizePersonNamePart,
} from "@/lib/person-name-normalization";
import { isLikelyTypoCorrection } from "@/lib/guest-name-similarity";

/*
  The one written-name comparison rule (#2721). It was private to
  `guest-name-similarity.ts` until the own-dependant collision guard needed the
  identical normalisation; the last describe below is what stops the two callers
  drifting apart again, since a change made for one of them would otherwise only
  be noticed by the other's suite.
*/

describe("normalizePersonNamePart", () => {
  it("trims, lowercases and collapses internal whitespace, and nothing else", () => {
    expect(normalizePersonNamePart("  Van   der  BERG ")).toBe("van der berg");
    expect(normalizePersonNamePart("O'Brien-Smith")).toBe("o'brien-smith");
    expect(normalizePersonNamePart("\tSam\n")).toBe("sam");
  });

  it("does NOT fold accents, punctuation or anything phonetic", () => {
    // Widening this is what turns an exact-collision guard into a fuzzy one, so
    // the non-equalities are pinned as firmly as the equalities.
    expect(normalizePersonNamePart("José")).not.toBe(
      normalizePersonNamePart("Jose"),
    );
    expect(normalizePersonNamePart("Ngāti")).not.toBe(
      normalizePersonNamePart("Ngati"),
    );
    expect(normalizePersonNamePart("Smith-Jones")).not.toBe(
      normalizePersonNamePart("Smith Jones"),
    );
  });

  it("returns empty for a value that is only whitespace", () => {
    expect(normalizePersonNamePart("   ")).toBe("");
  });
});

describe("normalizePersonFullName", () => {
  it("joins the two normalised parts with exactly one space", () => {
    expect(normalizePersonFullName("  SAM ", " smith  ")).toBe("sam smith");
  });

  it("mints NO key when either part is missing", () => {
    // The asymmetry that stops two half-typed rows matching each other: an
    // empty string equals an empty string, and a guest still being typed must
    // collide with nobody.
    expect(normalizePersonFullName("Sam", "  ")).toBe("");
    expect(normalizePersonFullName("", "Smith")).toBe("");
    expect(normalizePersonFullName("", "")).toBe("");
  });
});

describe("the post-payment typo guard still uses this rule (#1386)", () => {
  it("treats a pure case-and-whitespace change as the same identity", () => {
    // Distance 0 on the normalised full name. If the normaliser stopped
    // lowercasing or collapsing, this would become a rejected rename and a
    // member would be sent to the office to fix their own capitalisation.
    expect(isLikelyTypoCorrection("Sam", "Smith", "  sam ", "SMITH")).toBe(true);
  });

  it("still rejects a different person", () => {
    expect(isLikelyTypoCorrection("Sam", "Smith", "Aroha", "Ngata")).toBe(false);
  });
});

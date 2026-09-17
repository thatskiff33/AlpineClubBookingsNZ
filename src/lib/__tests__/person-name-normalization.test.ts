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

  /*
    THE MACRON CASE (#2721 review). A name with a macron has two spellings that
    render identically — one code point, or the base letter plus a combining
    macron — and which one arrives depends on the keyboard, not the person. The
    guard reads the dependant's name from the database and the guest's name from
    a form; those are two different keyboards by construction. Before NFC these
    compared unequal, so no question was asked and the child went onto the
    bumpable non-member split: the exact defect, reachable only for macronised
    names.
  */
  describe("canonically-equivalent spellings of the same characters (NFC)", () => {
    const COMPOSED_NGATI = "Ngāti"; // the macron as ONE code point
    const DECOMPOSED_NGATI = "Ngāti"; // a + a COMBINING macron

    it("the two spellings are genuinely different input", () => {
      expect(COMPOSED_NGATI).not.toBe(DECOMPOSED_NGATI);
    });

    it("normalises both spellings of a macron to the same key", () => {
      expect(normalizePersonNamePart(DECOMPOSED_NGATI)).toBe(
        normalizePersonNamePart(COMPOSED_NGATI),
      );
      expect(
        normalizePersonFullName(DECOMPOSED_NGATI, "Whānau"),
      ).toBe(normalizePersonFullName(COMPOSED_NGATI, "Whānau"));
    });

    it("still refuses to fold the macron away altogether", () => {
      // Canonical equivalence, not accent folding: "Ngāti" and "Ngati" are
      // different names and stay different.
      expect(normalizePersonNamePart(DECOMPOSED_NGATI)).not.toBe(
        normalizePersonNamePart("Ngati"),
      );
    });

    it("is NFC and not NFKC — compatibility folding stays out", () => {
      // NFKC would make these equal. They are different characters, and folding
      // them is the fuzzy matching the owner rule on #2721 prohibits.
      expect(normalizePersonNamePart("ﬁona")).not.toBe( // fi ligature
        normalizePersonNamePart("fiona"),
      );
      expect(normalizePersonNamePart("Ｓam")).not.toBe( // full-width S
        normalizePersonNamePart("Sam"),
      );
    });
  });

  /*
    ACCEPTED LIMITS, pinned deliberately so nobody "fixes" one without a
    decision. Each of these is a near-miss that a human would call the same
    person, and in every case the rule answers "different name" — so NO question
    is asked and the row proceeds down the guest path. That is the SAME
    direction the defect ran in, which is why they are limits worth naming
    rather than harmless conservatism; closing them means fuzzy matching, which
    the owner rule prohibits, and every widening also makes a genuine different
    person harder to book.
  */
  describe("near misses this rule deliberately does not close", () => {
    it("a curly apostrophe is a different name from a straight one", () => {
      expect(normalizePersonNamePart("O’Brien")).not.toBe(
        normalizePersonNamePart("O'Brien"),
      );
    });

    it("a hyphen is a different name from a space", () => {
      expect(normalizePersonNamePart("Smith-Jones")).not.toBe(
        normalizePersonNamePart("Smith Jones"),
      );
    });

    it("a middle name on one side is a different name", () => {
      expect(normalizePersonFullName("Sam James", "Smith")).not.toBe(
        normalizePersonFullName("Sam", "Smith"),
      );
    });
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

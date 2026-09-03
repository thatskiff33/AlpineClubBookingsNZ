import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalNights,
  sha256Hex,
  sortKeysDeep,
  stableDigest,
  stableStringify,
} from "@/lib/stable-digest";

/**
 * #3218: the deterministic-identity bytes, PINNED — the safety net the collapse
 * of `stable-json.ts` into `stable-digest.ts` rested on, and the guard that
 * keeps the one remaining home honest.
 *
 * Every literal in this file was pinned BEFORE the collapse, against the two
 * separate modules, and passed the collapse unchanged. That is the whole proof
 * that `computeProposalHash` still produces the digest already stored in every
 * `BookingExceptionRequest` row.
 *
 * Three stored identities in this codebase are `sha256` over deterministically
 * serialised JSON, and all three are COMPARED against a value written down
 * earlier rather than merely recomputed:
 *
 *  - a booking-exception proposal hash, which `booking-exception-execution.ts`
 *    recomputes and compares to the stored `proposalHash` before executing an
 *    approved request. A digest that changes turns every stored, not-yet-executed
 *    request into an apparently tampered row;
 *  - the `EDIT_FINANCIAL_REVIEW` occurrence key (#3030), which is a
 *    unique-indexed column and IS the duplicate fence; and
 *  - the diagnostics knowledge bundle's integrity digest, compared against bytes
 *    already on disk.
 *
 * Those three are pinned where they are built
 * (`booking-exception-requests.test.ts`, `edit-financial-review.test.ts`,
 * `diagnostics/knowledge/__tests__/hash.test.ts`). What was NOT pinned is the
 * shared machinery underneath all three — `stableStringify`, `sortKeysDeep`,
 * `canonicalNights`, `sha256Hex` and `stableDigest` — so a change to the
 * serialisation could only be caught indirectly, by one caller's pin, for one
 * shape of input. This file pins the machinery itself, on input chosen to
 * exercise what stable ordering is FOR.
 *
 * If you are here because one of these failed: the literal is not the thing to
 * update. A stored identity cannot be re-verified against new bytes. Work out
 * what changed in the serialisation first, and only re-pin if you also
 * versioned the identity that depends on it.
 */

/**
 * Deliberately hostile: keys in reverse-ish insertion order, nesting, an array
 * of objects whose OWN keys are out of order, an empty key, `null`, `undefined`
 * (which `JSON.stringify` drops from an object), zero, a negative float, a
 * number that only has an exponential spelling, an empty object, and a string
 * carrying non-ASCII, a combining accent, an em dash and an astral-plane
 * emoji — the four ways UTF-8 encoding goes wrong.
 */
const HOSTILE = {
  zeta: [3, 1, 2],
  alpha: { nested: { b: null, a: 0 }, list: [{ y: 1, x: 2 }] },
  "": "empty key",
  mid: "kōwhai — é́ 🏔",
  empty: {},
  omitted: undefined,
  negative: -0.5,
  big: 1e21,
};

/** The same fields, supplied in a different insertion order at every level. */
const HOSTILE_REORDERED = {
  big: 1e21,
  negative: -0.5,
  omitted: undefined,
  empty: {},
  mid: "kōwhai — é́ 🏔",
  "": "empty key",
  alpha: { list: [{ x: 2, y: 1 }], nested: { a: 0, b: null } },
  zeta: [3, 1, 2],
};

describe("stableStringify byte contract (#3218)", () => {
  it("MUTATION: pins the exact bytes — every key sorted, at every depth", () => {
    expect(stableStringify(HOSTILE)).toBe(
      '{"":"empty key","alpha":{"list":[{"x":2,"y":1}],"nested":{"a":0,"b":null}},' +
        '"big":1e+21,"empty":{},"mid":"kōwhai — é́ 🏔","negative":-0.5,"zeta":[3,1,2]}',
    );
  });

  it("MUTATION: is insertion-order independent, which is the whole point", () => {
    // This one would still pass if the sorter were removed AND both literals
    // happened to agree, which is why it is paired with the byte pin above
    // rather than standing in for it.
    expect(stableStringify(HOSTILE_REORDERED)).toBe(stableStringify(HOSTILE));
  });

  it("keeps array order, because for some arrays the order IS the data", () => {
    expect(stableStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    expect(sortKeysDeep([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("sorts keys inside an array element, not just at the top level", () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("passes primitives through untouched", () => {
    expect(sortKeysDeep(null)).toBeNull();
    expect(sortKeysDeep(7)).toBe(7);
    expect(sortKeysDeep("kōwhai")).toBe("kōwhai");
    expect(stableStringify(null)).toBe("null");
  });
});

describe("canonicalNights (#3218)", () => {
  it("MUTATION: sorts and de-duplicates, so a caller's walk order cannot reach a digest", () => {
    expect(
      canonicalNights(["2026-07-05", "2026-07-04", "2026-07-05", "2026-06-30"]),
    ).toEqual(["2026-06-30", "2026-07-04", "2026-07-05"]);
  });

  it("does not mutate its argument", () => {
    const input = ["2026-07-05", "2026-07-04"];
    canonicalNights(input);
    expect(input).toEqual(["2026-07-05", "2026-07-04"]);
  });
});

describe("sha256Hex byte contract (#3218)", () => {
  it("MUTATION: pins the published sha256 of \"abc\", which is checkable against any reference", () => {
    // ba7816bf… is the FIPS 180-2 worked example. It is here rather than a value
    // this repository produced, so a reader can confirm the algorithm and the
    // hex casing without running anything.
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("MUTATION: pins a non-ASCII digest, so the utf8 encoding cannot drift to latin1", () => {
    // `createHash().update(text)` defaults to utf8, so dropping the explicit
    // argument is a no-op TODAY and a silent re-identification the day a caller
    // passes a Buffer or a different default lands. This is what fails then.
    expect(sha256Hex("kōwhai")).toBe(
      "8190d72d7db960954b5ba50f64f845b4c8df7e3d30afcfe1d367ba10746dc8aa",
    );
    expect(sha256Hex("kōwhai")).not.toBe(
      createHash("sha256").update("kōwhai", "latin1").digest("hex"),
    );
  });
});

describe("stableDigest byte contract (#3218)", () => {
  it("MUTATION: pins the digest of the hostile value, which is the composition every stored identity uses", () => {
    expect(stableDigest(HOSTILE)).toBe(
      "0b575410722350098b283066f071708ebd96ecce44838b513b10af646a69d6ce",
    );
  });

  it("MUTATION: the reordered twin lands on the SAME pinned digest", () => {
    expect(stableDigest(HOSTILE_REORDERED)).toBe(
      "0b575410722350098b283066f071708ebd96ecce44838b513b10af646a69d6ce",
    );
  });

  it("is exactly sha256 of the stable JSON, with no separator or prefix", () => {
    expect(stableDigest(HOSTILE)).toBe(sha256Hex(stableStringify(HOSTILE)));
  });

  it("MUTATION: a one-field change moves the digest", () => {
    expect(stableDigest({ ...HOSTILE, negative: -0.6 })).not.toBe(
      "0b575410722350098b283066f071708ebd96ecce44838b513b10af646a69d6ce",
    );
  });
});

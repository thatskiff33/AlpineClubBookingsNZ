import { describe, expect, it } from "vitest";

import { canonicalValue } from "@/lib/config-transfer/import-types";
import { stableStringify } from "@/lib/stable-digest";

/**
 * #3251 — the config-transfer importer's own key-sorted stringifier.
 *
 * The issue proposed importing the canonical `stableStringify` and deleting the
 * private copy. That would have been an unforced behaviour change, because the
 * two are NOT byte-equivalent, so what shipped instead was the rename plus this
 * file: the divergence is measured, pinned, and explained at the function.
 */
describe("canonicalValue is a comparison string, not the canonical identity (#3251)", () => {
  it("PINS the divergence the issue asked to be measured before adopting", () => {
    // The local renderer builds an array as `value.map(f).join(",")`, and
    // `JSON.stringify(undefined)` returns the VALUE `undefined`, which `join`
    // renders as the empty string — so a one-element array holding `undefined`
    // collapses to "[]".
    expect(canonicalValue([undefined])).toBe("[]");
    // `JSON.stringify` maps a hole in an array to `null`, so the canonical
    // identity renderer says "[null]" for the same input.
    expect(stableStringify([undefined])).toBe("[null]");
    // Stated as an inequality too, so the point survives a future reader who
    // reads only one of the two assertions above.
    expect(canonicalValue([undefined])).not.toBe(stableStringify([undefined]));
  });

  it("still normalises key order, which is the property the differ actually needs", () => {
    // The reason this function exists at all: two Json column values carrying
    // the same data must compare equal however their keys were inserted, or an
    // import preview reports a row as changed when nothing changed.
    expect(canonicalValue({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalValue({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("agrees with the canonical renderer everywhere `undefined` is not in play", () => {
    // The divergence above is the WHOLE of it for the values this importer
    // meets, which is what makes "keep the local one" a bounded decision rather
    // than an open question.
    for (const value of [
      { b: 1, a: { d: [1, 2, { z: 1, y: 2 }], c: null } },
      [1, [2, 3], { k: "v" }],
      { "": 0, "\"quoted\"": "a\b", "ü": "Māhuta — O'Brien" },
      [],
      {},
    ]) {
      expect(canonicalValue(value)).toBe(stableStringify(value));
    }
  });
});

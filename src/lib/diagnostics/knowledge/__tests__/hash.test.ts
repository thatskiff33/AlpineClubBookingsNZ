import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  normalizeContent,
  sha256Hex,
} from "@/lib/diagnostics/knowledge/hash";

/**
 * #3030: the canonical-JSON bytes, PINNED.
 *
 * `canonicalStringify` is not a formatter. Its exact output bytes are load
 * bearing in two independent places:
 *
 *  - the knowledge bundle's integrity digest is `sha256Hex(canonicalStringify(
 *    entries))` (`serialize.ts`), compared against a digest computed from the
 *    ON-DISK bundle, so a single byte of indentation or a missing trailing
 *    newline invalidates every bundle already generated; and
 *  - `support-correlation.ts` and `booking-records.ts` measure
 *    `canonicalStringify(...)` against byte ceilings, so wider output silently
 *    truncates a diagnostic payload rather than failing.
 *
 * Nothing pinned those bytes before. #3030 needed to move the recursive key
 * sorter into the shared deterministic-identity module for a third caller to
 * share - `@/lib/stable-json` then, `@/lib/stable-digest` since #3218 collapsed
 * the two halves back together (`INV-SSOT` -
 * there were already two copies), and "the move was byte-identical" is a claim,
 * not a fact, unless something fails when it stops being true. This is that
 * something, and it is written to be equally useful to whoever changes the
 * sorter next.
 *
 * If you are here because this failed: the digest is not the thing to update.
 * Work out what changed in the serialisation first - a bundle already on disk
 * cannot be re-verified against new bytes.
 */
describe("canonicalStringify byte contract (#3030)", () => {
  // Deliberately hostile input order, mixed types, nested arrays and objects,
  // a null, a zero, an empty object and a non-ASCII string.
  const value = {
    zeta: [3, 1, 2],
    alpha: { nested: { b: null, a: 0 }, list: [{ y: 1, x: 2 }] },
    "": "empty key",
    mid: "kōwhai",
    empty: {},
  };

  it("MUTATION: pins the exact bytes - sorted keys, 2-space indent, LF, one trailing newline", () => {
    expect(canonicalStringify(value)).toBe(
      [
        "{",
        '  "": "empty key",',
        '  "alpha": {',
        '    "list": [',
        "      {",
        '        "x": 2,',
        '        "y": 1',
        "      }",
        "    ],",
        '    "nested": {',
        '      "a": 0,',
        '      "b": null',
        "    }",
        "  },",
        '  "empty": {},',
        '  "mid": "kōwhai",',
        '  "zeta": [',
        "    3,",
        "    1,",
        "    2",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("MUTATION: pins the integrity digest those bytes produce, which is what a stored bundle is verified against", () => {
    expect(sha256Hex(canonicalStringify(value))).toBe(
      "c0a8f9a426ec2dc63c5c4e0de07b62997fb20bd2e2101335a3f458ff8838786e",
    );
  });

  it("preserves array order, because callers sort arrays themselves where order carries meaning", () => {
    expect(canonicalStringify([3, 1, 2])).toContain("3,\n  1,\n  2");
  });

  it("normalizes CRLF and a leading BOM so a Windows checkout hashes like a Linux runner", () => {
    expect(normalizeContent("﻿a\r\nb\rc")).toBe("a\nb\nc");
  });
});

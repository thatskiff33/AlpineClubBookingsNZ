import { describe, expect, it } from "vitest";

import {
  areaOf,
  compareWithBaseline,
  diagnosticKey,
  inventory,
  parseBaseline,
  parseTscOutput,
  renderBaseline,
} from "../lib/nuia-ratchet";

/**
 * #2799 — the `noUncheckedIndexedAccess` ratchet's decision, both directions.
 *
 * The compiler is deliberately not run here: `scripts/ci/check-nuia-ratchet.ts`
 * hands `tsc --pretty false` output to these functions, and the two properties
 * that make the gate a ratchet — new debt fails, and a stale recorded line
 * fails — are properties of the comparison, provable on strings. The real
 * compiler was mutation-proved by hand in the pull request (a seeded unchecked
 * index in a policies file, and a stale line left in the baseline).
 */

const SAMPLE = [
  "src/lib/policies/pricing.ts(12,5): error TS2532: Object is possibly 'undefined'.",
  "src/lib/policies/pricing.ts(40,9): error TS2532: Object is possibly 'undefined'.",
  "src/lib/capacity.ts(300,3): error TS2345: Argument of type 'Row | undefined' is not assignable to parameter of type 'Row'.",
  "  Type 'undefined' is not assignable to type 'Row'.",
  "src\\app\\admin\\page.tsx(7,1): error TS18048: 'first' is possibly 'undefined'.",
].join("\n");

describe("parseTscOutput", () => {
  it("drops positions, folds elaboration lines into the message and normalises separators", () => {
    const parsed = parseTscOutput(SAMPLE);
    expect(parsed.map(diagnosticKey)).toEqual([
      "src/lib/policies/pricing.ts:TS2532:Object is possibly 'undefined'.",
      "src/lib/policies/pricing.ts:TS2532:Object is possibly 'undefined'.",
      "src/lib/capacity.ts:TS2345:Argument of type 'Row | undefined' is not assignable to parameter of type 'Row'. Type 'undefined' is not assignable to type 'Row'.",
      "src/app/admin/page.tsx:TS18048:'first' is possibly 'undefined'.",
    ]);
  });

  it("ignores lines that are not diagnostics", () => {
    expect(parseTscOutput("\nFound 0 errors.\n")).toEqual([]);
  });
});

describe("compareWithBaseline", () => {
  const baseline = ["a.ts:TS2532:x", "a.ts:TS2532:x", "b.ts:TS2532:y"];

  it("passes only when the multisets agree exactly", () => {
    expect(compareWithBaseline(["b.ts:TS2532:y", "a.ts:TS2532:x", "a.ts:TS2532:x"], baseline)).toEqual({
      added: [],
      stale: [],
    });
  });

  it("fails a NEW diagnostic — including one more occurrence of a recorded key", () => {
    const { added, stale } = compareWithBaseline([...baseline, "a.ts:TS2532:x", "c.ts:TS18048:z"], baseline);
    expect(added).toEqual([
      { key: "a.ts:TS2532:x", extra: 1 },
      { key: "c.ts:TS18048:z", extra: 1 },
    ]);
    expect(stale).toEqual([]);
  });

  it("fails a STALE line — a fixed diagnostic must be re-recorded, not left to mask a new one", () => {
    const { added, stale } = compareWithBaseline(["a.ts:TS2532:x"], baseline);
    expect(added).toEqual([]);
    expect(stale).toEqual([
      { key: "a.ts:TS2532:x", missing: 1 },
      { key: "b.ts:TS2532:y", missing: 1 },
    ]);
  });

  it("does not let a stale line pay for a new one with the same text in another file", () => {
    // The scenario the stale-fails rule exists for: the site in a.ts was fixed,
    // and a new site with the identical message appeared in c.ts. Membership on
    // message alone would call that even; keys carry the file, so it is not.
    const { added, stale } = compareWithBaseline(["a.ts:TS2532:x", "b.ts:TS2532:y", "c.ts:TS2532:x"], baseline);
    expect(added).toEqual([{ key: "c.ts:TS2532:x", extra: 1 }]);
    expect(stale).toEqual([{ key: "a.ts:TS2532:x", missing: 1 }]);
  });
});

describe("baseline file format", () => {
  it("round-trips sorted with a trailing newline, tolerating CRLF and comments on read", () => {
    const text = renderBaseline(["b.ts:TS1:y", "a.ts:TS1:x", "a.ts:TS1:x"]);
    expect(text).toBe("a.ts:TS1:x\na.ts:TS1:x\nb.ts:TS1:y\n");
    expect(parseBaseline(text.replaceAll("\n", "\r\n") + "# note\n")).toEqual(["a.ts:TS1:x", "a.ts:TS1:x", "b.ts:TS1:y"]);
    expect(renderBaseline([])).toBe("");
  });
});

describe("inventory", () => {
  it("groups by programme area (two segments under src/, one elsewhere) and by file", () => {
    const parsed = parseTscOutput(SAMPLE);
    const inv = inventory(parsed);
    expect(inv.total).toBe(4);
    expect(inv.byArea).toEqual([
      { area: "src/lib", count: 3 },
      { area: "src/app", count: 1 },
    ]);
    expect(inv.byFile[0]).toEqual({ file: "src/lib/policies/pricing.ts", count: 2 });
    expect(areaOf("prisma/seed.ts")).toBe("prisma");
    expect(areaOf("scripts/ci/x.ts")).toBe("scripts");
  });
});

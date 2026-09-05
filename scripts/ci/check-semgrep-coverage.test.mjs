import { describe, expect, it } from "vitest";

import {
  classifyErrorType,
  findCoverageFailures,
  readAllowlistFiles,
  summariseCoverage,
} from "./check-semgrep-coverage.mjs";

/**
 * Contract for the Semgrep coverage gate (#2842).
 *
 * The shapes asserted here are the ones the pinned CI image really emits,
 * copied from a measured run of the blocking invocation on the epic base:
 * a whole-file failure carries `"type": "Syntax error"`, and a recovered
 * region carries the tagged array `["PartialParsing", [span, ...]]`.
 */

const partialSpan = (path, line) => [
  "PartialParsing",
  [{ path, start: { line, col: 1, offset: 0 }, end: { line, col: 4, offset: 3 } }],
];

const alwaysExists = () => true;

describe("classifyErrorType", () => {
  it("reads a bare `Syntax error` as a whole-file failure", () => {
    expect(classifyErrorType("Syntax error")).toBe("whole-file");
    expect(classifyErrorType("Lexical error")).toBe("whole-file");
  });

  it("reads the tagged PartialParsing array as a recovered region", () => {
    expect(classifyErrorType(partialSpan("a.ts", 1))).toBe("partial");
  });

  it("leaves timeouts to the scan step rather than calling them unparsed source", () => {
    expect(classifyErrorType("Timeout")).toBe("not-parse");
  });

  it("fails closed on a type it has never seen", () => {
    // The whole point: a scanner that invents a new failure name must not be
    // able to reduce coverage silently just because this gate predates it.
    expect(classifyErrorType("Some future error")).toBe("unknown");
    expect(classifyErrorType(["SomeFutureTag", []])).toBe("unknown");
    expect(classifyErrorType(undefined)).toBe("unknown");
  });
});

describe("summariseCoverage", () => {
  it("separates whole-file failures from partial ones and counts what was scanned", () => {
    const summary = summariseCoverage({
      errors: [
        { type: "Syntax error", path: "src/dead.ts" },
        { type: partialSpan("src/partial.tsx", 12), path: "src/partial.tsx" },
        { type: partialSpan("src/partial.tsx", 40), path: "src/partial.tsx" },
        { type: "Timeout", path: "src/slow.ts" },
      ],
      paths: { scanned: ["a", "b", "c"] },
    });

    expect(summary.wholeFile).toEqual(["src/dead.ts"]);
    expect(summary.partial).toEqual(["src/partial.tsx"]);
    expect(summary.unknown).toEqual([]);
    expect(summary.scannedCount).toBe(3);
  });

  it("reports a file with both failure kinds as scanned by nothing, not as partial", () => {
    const summary = summariseCoverage({
      errors: [
        { type: partialSpan("src/x.ts", 3), path: "src/x.ts" },
        { type: "Syntax error", path: "src/x.ts" },
      ],
    });

    expect(summary.wholeFile).toEqual(["src/x.ts"]);
    expect(summary.partial).toEqual([]);
  });

  it("collects unclassifiable errors instead of dropping them", () => {
    const summary = summariseCoverage({
      errors: [{ type: "Brand new failure", path: "src/x.ts" }],
    });

    expect(summary.unknown).toEqual([
      { path: "src/x.ts", type: '"Brand new failure"' },
    ]);
  });

  it("treats a report with no errors as full coverage", () => {
    expect(summariseCoverage({ errors: [], paths: { scanned: [] } })).toMatchObject({
      wholeFile: [],
      partial: [],
      unknown: [],
    });
  });
});

describe("readAllowlistFiles", () => {
  it("accepts a list of paths", () => {
    expect(readAllowlistFiles({ files: ["a.ts", "b.ts"] })).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses a malformed allowlist rather than treating it as empty", () => {
    // An empty allowlist and an unreadable one are opposite facts: the first
    // says nothing is exempt, the second says we do not know.
    expect(() => readAllowlistFiles({})).toThrow(/expected a `files` array/);
    expect(() => readAllowlistFiles({ files: [1] })).toThrow(/non-empty string/);
    expect(() => readAllowlistFiles({ files: [""] })).toThrow(/non-empty string/);
  });
});

describe("findCoverageFailures", () => {
  const summary = (over = {}) => ({
    wholeFile: [],
    partial: [],
    unknown: [],
    scannedCount: 0,
    ...over,
  });

  it("passes when every partial failure is allowlisted and every entry is still true", () => {
    const failures = findCoverageFailures(
      summary({ partial: ["src/known.tsx"] }),
      ["src/known.tsx"],
      alwaysExists,
    );

    expect(failures).toEqual([]);
  });

  it("fails a whole-file failure even when the file is on the allowlist", () => {
    // Zero coverage is not exemptible. If it were, the allowlist would be a
    // way to sign off a file nothing scans.
    const failures = findCoverageFailures(
      summary({ wholeFile: ["src/dead.ts"] }),
      ["src/dead.ts"],
      alwaysExists,
    );

    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      kind: "file scanned by nothing",
      path: "src/dead.ts",
    });
    expect(failures[0].detail).toContain("importOriginal");
  });

  it("fails a newly unparsed file that nobody listed", () => {
    const failures = findCoverageFailures(
      summary({ partial: ["src/new.tsx"] }),
      [],
      alwaysExists,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "new unparsed region",
      path: "src/new.tsx",
    });
  });

  it("fails an allowlisted file that now parses, so the list can only shrink", () => {
    const failures = findCoverageFailures(summary(), ["src/fixed.tsx"], alwaysExists);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "stale allowlist entry",
      path: "src/fixed.tsx",
    });
    expect(failures[0].detail).toContain("parsed all of it");
  });

  it("fails an allowlisted file that has been deleted, and says which case it is", () => {
    const failures = findCoverageFailures(summary(), ["src/gone.tsx"], () => false);

    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("no longer exists");
  });

  it("fails an unrecognised scan error rather than ignoring it", () => {
    const failures = findCoverageFailures(
      summary({ unknown: [{ path: "src/x.ts", type: '"Brand new failure"' }] }),
      [],
      alwaysExists,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "unrecognised scan error",
      path: "src/x.ts",
    });
  });
});

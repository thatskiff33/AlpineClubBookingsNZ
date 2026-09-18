import { describe, expect, it } from "vitest";

import {
  classifyErrorType,
  findCoverageFailures,
  normalisePath,
  readAllowlistFiles,
  readMinimumScannedFiles,
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

  it("treats a timeout as rules abandoned, not as somebody else's problem", () => {
    // This test used to assert `"not-parse"`, on the premise that the scan
    // step fails on a timeout. MEASURED, and false: the exact blocking
    // invocation plus `--timeout 1` exits 0 with 11 `Timeout` errors over 7
    // files. Nothing failed, and a live `react-dangerouslysetinnerhtml`
    // finding went missing behind one.
    expect(classifyErrorType("Timeout")).toBe("abandoned");
    expect(classifyErrorType("Out of memory")).toBe("abandoned");
    expect(classifyErrorType("Timeout during interfile analysis")).toBe(
      "abandoned",
    );
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
    expect(summary.abandoned).toEqual(["src/slow.ts"]);
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
  it("accepts entries carrying a file and a reason", () => {
    expect(
      readAllowlistFiles({
        files: [
          { file: "a.ts", reason: "a bare & inside a string literal" },
          { file: "b.ts", reason: "the same, asserted with toHaveAttribute" },
        ],
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses a malformed allowlist rather than treating it as empty", () => {
    // An empty allowlist and an unreadable one are opposite facts: the first
    // says nothing is exempt, the second says we do not know.
    expect(() => readAllowlistFiles({})).toThrow(/expected a `files` array/);
    expect(() => readAllowlistFiles({ files: [1] })).toThrow(/non-empty `file`/);
    expect(() => readAllowlistFiles({ files: [{}] })).toThrow(/non-empty `file`/);
    expect(() => readAllowlistFiles({ files: [{ file: "" }] })).toThrow(
      /non-empty `file`/,
    );
  });

  // #3318: the entry shape became `{ file, reason }` so that the reason sits on
  // the entry it explains instead of in a prose summary next to the list - which
  // is where it used to live, and where BOTH of its clauses had drifted false.
  // An entry signs part of a real file off as unscanned, and after #3318 removed
  // everything that had a rewrite, an entry with nothing to say for itself is
  // almost certainly a shape `scan/no-semgrep-unparsable-import-type` should
  // have caught. Refusing it is what keeps that true.
  it("refuses a bare path string, the shape it used to accept", () => {
    expect(() => readAllowlistFiles({ files: ["a.ts"] })).toThrow(
      /non-empty `file`/,
    );
  });

  it("refuses an entry with no reason, or a blank one", () => {
    expect(() => readAllowlistFiles({ files: [{ file: "a.ts" }] })).toThrow(
      /carries no `reason`/,
    );
    expect(() =>
      readAllowlistFiles({ files: [{ file: "a.ts", reason: "   " }] }),
    ).toThrow(/carries no `reason`/);
  });
});

describe("readMinimumScannedFiles", () => {
  it("reads a positive integer floor", () => {
    expect(readMinimumScannedFiles({ minimumScannedFiles: 4000 })).toBe(4000);
  });

  it("refuses a missing or nonsensical floor rather than scanning without one", () => {
    expect(() => readMinimumScannedFiles({})).toThrow(/minimumScannedFiles/);
    expect(() => readMinimumScannedFiles({ minimumScannedFiles: 0 })).toThrow();
    expect(() =>
      readMinimumScannedFiles({ minimumScannedFiles: "4000" }),
    ).toThrow();
  });
});

describe("findCoverageFailures", () => {
  const summary = (over = {}) => ({
    wholeFile: [],
    partial: [],
    abandoned: [],
    unknown: [],
    scannedCount: 5000,
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

  it("fails a file whose rules were abandoned, because the scan step will not", () => {
    // The blocker this gate was missing: measured, `semgrep scan --error`
    // exits 0 with timeouts, and Semgrep's default --timeout-threshold 3 drops
    // ALL remaining rules on a file after three of them time out. So a busy
    // runner silently stops running the security rules on the biggest files.
    const failures = findCoverageFailures(
      summary({ abandoned: ["src/big.ts"] }),
      [],
      alwaysExists,
      4000,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "rules abandoned on a readable file",
      path: "src/big.ts",
    });
  });

  it("does not also call an abandoned file's allowlist entry stale", () => {
    // An abandoned file reports no PartialParsing, so it LOOKS like it started
    // parsing cleanly. It is not evidence of anything, and reporting it as
    // stale makes a required check flap in both directions at once.
    const failures = findCoverageFailures(
      summary({ abandoned: ["src/known.tsx"] }),
      ["src/known.tsx"],
      alwaysExists,
      4000,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("rules abandoned on a readable file");
    expect(failures.some((f) => f.kind === "stale allowlist entry")).toBe(false);
  });

  it("refuses a scan that scanned nothing", () => {
    const failures = findCoverageFailures(
      summary({ scannedCount: 0 }),
      [],
      alwaysExists,
      4000,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("scan covered nothing");
  });

  it("refuses a scan that fell below the committed file floor", () => {
    // Closes the axis the allowlist cannot see: a new --exclude or
    // .semgrepignore entry drops files from coverage with no error at all.
    const failures = findCoverageFailures(
      summary({ scannedCount: 120 }),
      [],
      alwaysExists,
      4000,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("scan covered too little");
    expect(failures[0].detail).toContain("4000");
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

describe("normalisePath", () => {
  it("compares Windows and POSIX spellings of the same file as one path", () => {
    // Semgrep reports paths in the HOST separator. CI runs it in a Linux
    // container and gets `src/lib/x.ts`; a Semgrep installed on Windows
    // reports `src\\lib\\x.ts` for that same file, while the allowlist is
    // committed with forward slashes. Without normalising, the documented
    // local command on Windows reported every allowlisted file as BOTH newly
    // unparsed and stale - 338 failures over an allowlist of 169.
    expect(normalisePath("src\\lib\\x.ts")).toBe("src/lib/x.ts");
    expect(normalisePath("src/lib/x.ts")).toBe("src/lib/x.ts");
  });

  it("matches a backslash report against a forward-slash allowlist", () => {
    const summary = summariseCoverage({
      errors: [
        {
          type: ["PartialParsing", []],
          path: "src\\lib\\known.tsx",
        },
      ],
    });
    expect(summary.partial).toEqual(["src/lib/known.tsx"]);
    expect(
      findCoverageFailures(
        summary,
        readAllowlistFiles({
          files: [{ file: "src/lib/known.tsx", reason: "a bare & in a string" }],
        }),
        () => true,
      ),
    ).toEqual([]);
  });
});

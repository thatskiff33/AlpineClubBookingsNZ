import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeResult,
  filterSarifFile,
  filterSuppressedResults,
  isSuppressedInSource,
} from "./filter-suppressed-sarif.mjs";

/**
 * Unit coverage for the SARIF suppression filter (#2841, alerts 43 and 42).
 *
 * The shape below is the real one: measured from the `Static analysis gate`
 * SARIF artifact of a green `main` run, both `acb-unsafe-raw-sql` results carry
 * `"suppressions": [{ "kind": "inSource" }]` and no `status` field.
 */

function sarifWith(results) {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: { driver: { name: "Semgrep", semanticVersion: "1.161.0" } },
        results,
      },
    ],
  };
}

const SUPPRESSED_RESULT = {
  ruleId: "acb-unsafe-raw-sql",
  message: { text: "Raw SQL outside the approved helpers" },
  suppressions: [{ kind: "inSource" }],
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: "src/lib/example.ts" },
        region: { startLine: 42 },
      },
    },
  ],
};

const LIVE_RESULT = {
  ruleId: "javascript.lang.security.audit.example",
  message: { text: "A real finding" },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: "src/lib/other.ts" },
        region: { startLine: 7 },
      },
    },
  ],
};

describe("isSuppressedInSource", () => {
  it("recognises the exact shape Semgrep emits for a nosemgrep comment", () => {
    expect(isSuppressedInSource(SUPPRESSED_RESULT)).toBe(true);
  });

  it("leaves a result with no suppressions alone", () => {
    expect(isSuppressedInSource(LIVE_RESULT)).toBe(false);
    expect(isSuppressedInSource({ ruleId: "x", suppressions: [] })).toBe(false);
  });

  it("keeps a result whose suppression was REJECTED", () => {
    // A rejected suppression is one somebody turned down, so the finding is live
    // and must still reach the Security tab. Dropping it would be the actual
    // dangerous version of this filter.
    expect(
      isSuppressedInSource({
        ruleId: "x",
        suppressions: [{ kind: "inSource", status: "rejected" }],
      }),
    ).toBe(false);
  });

  it("keeps a result whose suppression is still UNDER REVIEW", () => {
    // `underReview` means the suppression has NOT been accepted — the decision
    // is open. Honouring it would withhold a result nobody has agreed to
    // suppress, which #2842's security review named as the only path by which
    // this filter could hide something that is not actually suppressed.
    expect(
      isSuppressedInSource({
        ruleId: "x",
        suppressions: [{ kind: "inSource", status: "underReview" }],
      }),
    ).toBe(false);
  });

  it("honours an accepted suppression, and one with no status at all", () => {
    // An absent status defaults to `accepted` in SARIF 2.1.0, which is what
    // Semgrep emits today.
    for (const suppression of [
      { kind: "inSource", status: "accepted" },
      { kind: "inSource" },
    ]) {
      expect(
        isSuppressedInSource({ ruleId: "x", suppressions: [suppression] }),
        JSON.stringify(suppression),
      ).toBe(true);
    }
  });

  it("does NOT honour an external suppression", () => {
    // An `external` suppression lives outside the repository, so no reviewer
    // would see it being added in a diff. Only an in-source comment counts.
    expect(
      isSuppressedInSource({ ruleId: "x", suppressions: [{ kind: "external" }] }),
    ).toBe(false);
  });

  it("survives malformed entries instead of throwing", () => {
    expect(isSuppressedInSource({})).toBe(false);
    expect(isSuppressedInSource(null)).toBe(false);
    expect(isSuppressedInSource({ suppressions: [null, "nope"] })).toBe(false);
  });
});

describe("filterSuppressedResults", () => {
  it("drops the suppressed result and keeps the live one", () => {
    const { sarif, dropped } = filterSuppressedResults(
      sarifWith([SUPPRESSED_RESULT, LIVE_RESULT]),
    );

    expect(sarif.runs[0].results).toEqual([LIVE_RESULT]);
    expect(dropped).toEqual(["acb-unsafe-raw-sql at src/lib/example.ts:42"]);
  });

  it("does not mutate the input", () => {
    const input = sarifWith([SUPPRESSED_RESULT, LIVE_RESULT]);
    filterSuppressedResults(input);
    expect(input.runs[0].results).toHaveLength(2);
  });

  it("passes through everything that is not a result", () => {
    const input = sarifWith([SUPPRESSED_RESULT]);
    const { sarif } = filterSuppressedResults(input);

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toBe(input.$schema);
    expect(sarif.runs[0].tool).toEqual(input.runs[0].tool);
    // An emptied results array must stay an array: SARIF requires it, and
    // dropping the key would make the upload reject the file.
    expect(sarif.runs[0].results).toEqual([]);
  });

  it("leaves a run with no results untouched", () => {
    const input = { version: "2.1.0", runs: [{ tool: { driver: {} } }] };
    const { sarif, dropped } = filterSuppressedResults(input);
    expect(sarif.runs[0].results).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  it("handles a file that is not a SARIF log at all", () => {
    for (const input of [null, undefined, {}, { runs: "nope" }, 7]) {
      const { dropped } = filterSuppressedResults(input);
      expect(dropped).toEqual([]);
    }
  });

  it("filters every run, not just the first", () => {
    const input = {
      version: "2.1.0",
      runs: [
        { tool: { driver: {} }, results: [SUPPRESSED_RESULT] },
        { tool: { driver: {} }, results: [SUPPRESSED_RESULT, LIVE_RESULT] },
      ],
    };
    const { sarif, dropped } = filterSuppressedResults(input);
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[1].results).toEqual([LIVE_RESULT]);
    expect(dropped).toHaveLength(2);
  });
});

describe("describeResult", () => {
  it("names the rule and the location a dropped result came from", () => {
    expect(describeResult(SUPPRESSED_RESULT)).toBe(
      "acb-unsafe-raw-sql at src/lib/example.ts:42",
    );
  });

  it("degrades gracefully when the location is missing", () => {
    expect(describeResult({ ruleId: "r" })).toBe("r");
    expect(describeResult({})).toBe("<no ruleId>");
    expect(
      describeResult({
        ruleId: "r",
        locations: [
          { physicalLocation: { artifactLocation: { uri: "a/b.ts" } } },
        ],
      }),
    ).toBe("r at a/b.ts");
  });
});

describe("filterSarifFile", () => {
  it("writes valid JSON the upload step can consume", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-filter-"));
    const input = path.join(dir, "in.sarif");
    const output = path.join(dir, "out.sarif");
    try {
      fs.writeFileSync(
        input,
        JSON.stringify(sarifWith([SUPPRESSED_RESULT, LIVE_RESULT])),
        "utf8",
      );

      const dropped = filterSarifFile(input, output);

      expect(dropped).toHaveLength(1);
      const written = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(written.runs[0].results).toEqual([LIVE_RESULT]);
      // The raw file is left alone — it is what the build artifact preserves.
      expect(
        JSON.parse(fs.readFileSync(input, "utf8")).runs[0].results,
      ).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a missing file rather than writing an empty log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-filter-"));
    try {
      expect(() =>
        filterSarifFile(path.join(dir, "absent.sarif"), path.join(dir, "o.sarif")),
      ).toThrow();
      expect(fs.existsSync(path.join(dir, "o.sarif"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

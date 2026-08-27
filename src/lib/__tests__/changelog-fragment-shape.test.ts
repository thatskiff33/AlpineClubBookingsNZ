import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `changelog.d/README.md` step 2 states the fragment format in one sentence: "one
 * or more top-level `- ` bullets in the house style below. Nothing else — no
 * headings, no version number, no date."
 *
 * Sixteen fragments broke that rule before #3112, eleven of them written by epic
 * #2988's own lanes, and nobody noticed for a reason worth recording: fragments
 * are only compiled into `CHANGELOG.md` at a release cut, so a malformed one
 * produces no output until then. Sixteen files doing the same wrong thing also
 * reads as a convention, so each lane copied its predecessor.
 *
 * Measured at the time: `CHANGELOG.md` has no `###` sections at all — every
 * released entry is a flat bullet list — so the fragments had drifted from the
 * README, not the other way round.
 *
 * This scans the directory from disk rather than importing anything, which means
 * `vitest related` cannot reach it: it is deliberately a full-suite check, like
 * the other tree-wide contracts here.
 */
const FRAGMENT_DIR = "changelog.d";

/** The no-entry marker lives in the pull request body, never in a fragment. */
const FRAGMENT_PATTERN = /\.md$/;

function fragmentNames(): string[] {
  return readdirSync(FRAGMENT_DIR)
    .filter((name) => FRAGMENT_PATTERN.test(name))
    .filter((name) => name !== "README.md")
    .sort();
}

describe("changelog fragment shape (#3112)", () => {
  it("finds fragments to check, so a rename cannot make this vacuous", () => {
    expect(fragmentNames().length).toBeGreaterThan(0);
  });

  it("carries no Markdown heading in any fragment", () => {
    const offenders = fragmentNames().filter((name) =>
      readFileSync(join(FRAGMENT_DIR, name), "utf8")
        .split("\n")
        .some((line) => /^#{1,6}\s/.test(line)),
    );

    expect(
      offenders,
      `changelog.d/README.md forbids headings in a fragment: "one or more ` +
        `top-level \`- \` bullets … Nothing else — no headings, no version ` +
        `number, no date." A heading produces a stray section in the middle of ` +
        `CHANGELOG.md's bullet list at the next release cut, which is a bad ` +
        `moment to find out. Rewrite the heading's content as bullets. ` +
        `Offending fragment(s): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("starts every fragment with a top-level bullet", () => {
    const offenders = fragmentNames().filter((name) => {
      const firstMeaningfulLine = readFileSync(join(FRAGMENT_DIR, name), "utf8")
        .split("\n")
        .find((line) => line.trim() !== "");
      return firstMeaningfulLine !== undefined && !firstMeaningfulLine.startsWith("- ");
    });

    expect(
      offenders,
      `A fragment's first line must be a top-level "- " bullet, per ` +
        `changelog.d/README.md. Offending fragment(s): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

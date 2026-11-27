import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  deployFragmentProblems,
  isDeployFragmentName,
} from "../../../scripts/lib/deploy-fragments.mjs";
import { FRAGMENTS_DIRNAME, rebaseFragmentLinks } from "../../../scripts/release/fragment-links.mjs";

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
 * This scans the directory from disk, so `vitest related` reaches it only through
 * `scripts/release/fragment-links.mjs`, never through a new fragment: it is
 * deliberately a full-suite check, like the other tree-wide contracts here.
 */
const FRAGMENT_DIR = FRAGMENTS_DIRNAME;

/** The no-entry marker lives in the pull request body, never in a fragment. */
const FRAGMENT_PATTERN = /\.md$/;

/**
 * Changelog entries only. An after-deploy step (`*.deploy.md`, #5379) has its
 * own fixed headings and is checked against its own format below.
 */
function fragmentNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => FRAGMENT_PATTERN.test(name))
    .filter((name) => name !== "README.md")
    .filter((name) => !isDeployFragmentName(name))
    .sort();
}

/**
 * Each rule's offending fragments in `dir`. One function serves the real
 * directory and the fixtures below, so the empty-directory and bad-fragment
 * tests exercise the same code the census runs.
 */
function shapeOffences(dir: string) {
  const fragments = fragmentNames(dir).map((name) => ({
    name,
    body: readFileSync(join(dir, name), "utf8"),
  }));
  return {
    headings: fragments.filter(({ body }) => body.split("\n").some((line) => /^#{1,6}\s/.test(line))).map(({ name }) => name),
    notBullet: fragments
      .filter(({ body }) => {
        const first = body.split("\n").find((line) => line.trim() !== "");
        return first !== undefined && !first.startsWith("- ");
      })
      .map(({ name }) => name),
    // The compiler rewrites `../docs/X.md` to `docs/X.md` as it copies a
    // fragment into CHANGELOG.md; a link that climbs out of the repository —
    // wrapped across lines or not — has no root-relative form, so it would
    // stop the release cut. Catch it here, with the compiler's own parser.
    unrebasable: fragments.flatMap(({ name, body }) => {
      try {
        rebaseFragmentLinks(body, name);
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    }),
  };
}

const NO_OFFENCES = { headings: [], notBullet: [], unrebasable: [] };

const fixtures: string[] = [];
afterAll(() => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A throwaway fragment directory holding `files` beside a README. */
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fragment-shape-"));
  fixtures.push(dir);
  writeFileSync(join(dir, "README.md"), "# Fragments\n\n## A heading the census must skip\n");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("changelog fragment shape (#3112)", () => {
  it("reads the real fragment directory, so a rename cannot make this vacuous", () => {
    // A release cut compiles and deletes every fragment, so an empty directory
    // is the normal state straight after a release. What would make the checks
    // below vacuous is reading the wrong directory or a filter that matches
    // nothing, so assert those instead of a fragment count.
    const names = readdirSync(FRAGMENT_DIR);
    expect(names).toContain("README.md");
    expect(FRAGMENT_PATTERN.test("2448-example-slug.md")).toBe(true);
  });

  it("passes on a directory holding only its README, the state after a release (#5214)", () => {
    expect(shapeOffences(fixtureDir({}))).toEqual(NO_OFFENCES);
  });

  it("still flags each rule's offender when the directory is not empty (#5214)", () => {
    const dir = fixtureDir({
      "1-good.md": "- Fine; see [the hut leader\n  guide](../docs/g.md#x).\n",
      "2-heading.md": "- Entry.\n\n### Not allowed\n",
      "3-prose.md": "Starts with prose.\n",
      "4-escapes.md": "- See [the\n  outside](../../x.md).\n",
    });
    const offences = shapeOffences(dir);
    expect(offences.headings).toEqual(["2-heading.md"]);
    expect(offences.notBullet).toEqual(["3-prose.md"]);
    expect(offences.unrebasable).toEqual([expect.stringContaining("4-escapes.md links \"../../x.md\"")]);
  });

  it("carries no Markdown heading in any fragment", () => {
    const offenders = shapeOffences(FRAGMENT_DIR).headings;

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
    const offenders = shapeOffences(FRAGMENT_DIR).notBullet;

    expect(
      offenders,
      `A fragment's first line must be a top-level "- " bullet, per ` +
        `changelog.d/README.md. Offending fragment(s): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("links nothing the release compiler cannot rebase to the repository root (#5214)", () => {
    expect(shapeOffences(FRAGMENT_DIR).unrebasable).toEqual([]);
  });

  /*
    #5379: an after-deploy step is only read at a release cut too, and a
    malformed one refuses that cut. The `verify` gate checks the ones a pull
    request writes; this checks every one on disk, so one that reached the
    tree another way (an edit during a merge, a hand-made commit) fails here
    rather than on release day.
  */
  it("keeps every after-deploy step fragment well formed", () => {
    const offenders = readdirSync(FRAGMENT_DIR)
      .filter((name) => isDeployFragmentName(name))
      .map((name) => ({
        name,
        problems: deployFragmentProblems(name, readFileSync(join(FRAGMENT_DIR, name), "utf8")),
      }))
      .filter(({ problems }) => problems.length > 0)
      .map(({ name, problems }) => `${name}: ${problems.join("; ")}`);

    expect(
      offenders,
      `Malformed after-deploy step fragment(s); changelog.d/README.md, ` +
        `"After-deploy steps", gives the format:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

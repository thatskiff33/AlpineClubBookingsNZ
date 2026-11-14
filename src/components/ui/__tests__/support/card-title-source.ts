import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The one way the `CardTitle` source guards read the tree (#2796, #4951):
 * `card-title-heading-contract.test.ts` and
 * `card-title-classification-census.test.ts` both scan with these helpers, so
 * the two cannot come to disagree about which files exist or what counts as a
 * `CardTitle` and its heading classification.
 *
 * Discovery, not an allow-list: a new file is covered the day it lands.
 */

const repoRoot = process.cwd();

export function read(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

export function filesUnder(dir: string, match: RegExp, skipTests: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(repoRoot, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) {
      if (skipTests && entry === "__tests__") continue;
      if (entry === "node_modules") continue;
      out.push(...filesUnder(rel, match, skipTests));
    } else if (match.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

/** Every production `.tsx` file under `src/`, tests excluded. */
export const SOURCE_FILES = filesUnder("src", /\.tsx$/, true).filter(
  (file) => !/\.test\.tsx$/.test(file)
);

export function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

/** Opening `<CardTitle …>` tags, with their attribute text. */
export const CARD_TITLE_OPEN = /<CardTitle\b([^>]*?)(\/?)>/g;

/**
 * What a `CardTitle`'s attribute text says about its place in the outline:
 * `"omitted"` when it passes no `headingLevel` (the census counts these),
 * `"none"` when it has decided it is not a heading, and `"heading"` when it
 * renders `role="heading"` at some level.
 */
export function headingClassification(
  attrs: string
): "omitted" | "none" | "heading" {
  const value = /\bheadingLevel\s*=\s*(\{\s*)?(["'])?([\w-]+)/.exec(attrs);
  if (!value) return "omitted";
  // `{undefined}` and `{null}` pass no level at all; they compile, so a call
  // site could otherwise satisfy the census while still being unclassified.
  if (value[1] && !value[2] && (value[3] === "undefined" || value[3] === "null")) {
    return "omitted";
  }
  return value[3] === "none" ? "none" : "heading";
}

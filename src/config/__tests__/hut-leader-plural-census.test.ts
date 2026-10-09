import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/*
  #3976 — every plural of the club's hut-leader label goes through
  `pluralHutLeaderLabel` (src/config/hut-leader-label.ts). Appending "s" by hand
  is how a club that saved "Hut Leaders" came to read "Hut Leaderss" in the
  admin sidebar.

  This census reads source from disk, so `test:related` cannot select it; it
  walks every non-test .ts/.tsx under src/ and flags an interpolation of the
  label followed directly by "s":
    - any identifier or member chain naming the label (`hutLeaderLabel`,
      `hutLeaderLower`, `club.hutLeaderLabel`, `CLUB_HUT_LEADER_LABEL`), with or
      without `.toLowerCase()` / `.toUpperCase()`;
    - a bare `label` likewise, but only in a file that reads the hut-leader
      label, since `label` is a common parameter name for unrelated words.
  It cannot see a plural built any other way (concatenation, a helper of one's
  own); the helper's existence and this rule's statement in its docblock are
  what cover those.
*/

const SRC = join(process.cwd(), "src");
const NAMED =
  /\{\s*[\w.]*(?:hutLeader|HUT_LEADER)\w*(?:\.to(?:Lower|Upper)Case\(\))?\s*\}s\b/g;
const BARE_LABEL = /\{\s*label(?:\.to(?:Lower|Upper)Case\(\))?\s*\}s\b/g;
const READS_LABEL = /hutLeaderLabel|HUT_LEADER_LABEL/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function handBuiltPlurals(source: string): number[] {
  const code = stripComments(source);
  const readsLabel = READS_LABEL.test(code);
  const lines = new Set<number>();
  for (const pattern of readsLabel ? [NAMED, BARE_LABEL] : [NAMED]) {
    for (const match of code.matchAll(pattern)) {
      // Comment normalization retains newlines, so these remain source lines.
      lines.add(code.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

describe("hut-leader plural census (#3976)", () => {
  it("recognises the hand-built plurals it exists to catch, and not other nouns", () => {
    const label = "hutLeaderLabel";
    for (const bad of [
      "`${" + label + "}s`",
      "{hutLeaderLower}s rely on",
      "({club." + label + ".toLowerCase()}s)",
      "const label = club.hutLeaderLabel; `(Admin → ${label}s)`",
    ]) {
      expect(handBuiltPlurals(bad), bad).not.toEqual([]);
    }
    for (const fine of [
      "`Unassigned ${CLUB_HUT_LEADER_LABEL.toLowerCase()} ${unassignedNoun}s`",
      "`All ${label.toLowerCase()}s`", // a file that never reads the label
      "{pluralHutLeaderLabel(" + label + ").toLowerCase()}",
      "`${" + label + "} Assignments`",
    ]) {
      expect(handBuiltPlurals(fine), fine).toEqual([]);
    }
  });

  it("ignores old spellings in comments without hiding executable plurals", () => {
    expect(
      handBuiltPlurals(
        "pluralHutLeaderLabel(hutLeaderLabel);\n// Formerly `${hutLeaderLabel}s`",
      ),
    ).toEqual([]);
    expect(handBuiltPlurals("/* hutLeaderLabel */ `${label}s`")).toEqual([]);
    expect(handBuiltPlurals("/* old\n spelling */ `${hutLeaderLabel}s`")).toEqual([2]);
  });

  it("finds multiline interpolations and reports their original source lines", () => {
    expect(handBuiltPlurals("// Heading\nconst text = `${\n hutLeaderLabel\n}s`;"))
      .toEqual([2]);
    expect(handBuiltPlurals("const label = club.hutLeaderLabel;\n`${\n label.toLowerCase()\n}s`"))
      .toEqual([2]);
    expect(handBuiltPlurals("`${hutLeaderLabel}s ${hutLeaderLower}s`\n`${hutLeaderLabel}s`"))
      .toEqual([1, 2]);
  });

  it("finds no plural of the hut-leader label built by appending s", () => {
    const files = sourceFiles(SRC);
    const readers = files.filter((file) =>
      READS_LABEL.test(readFileSync(file, "utf8")),
    );
    // Vacuity guard: an empty or mis-rooted walk must fail, not pass.
    expect(readers.length).toBeGreaterThan(10);

    const offenders = files.flatMap((file) =>
      handBuiltPlurals(readFileSync(file, "utf8")).map(
        (line) => `${relative(process.cwd(), file)}:${line}`,
      ),
    );
    expect(
      offenders,
      "INV-SSOT-001 / #3976: build the hut-leader label's plural with pluralHutLeaderLabel " +
        "(src/config/hut-leader-label.ts), never by appending \"s\" — a club that " +
        'saved "Hut Leaders" otherwise reads "Hut Leaderss".',
    ).toEqual([]);
  });
});

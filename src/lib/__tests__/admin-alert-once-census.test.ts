import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #4696 (`INV-SSOT`): the caller census in `admin-alert-once.ts` is the one
 * list of `sendAdminAlertOnceEver`'s callers, grouped by whether anything sends
 * an alert again once its uncertain claim is given back. This suite holds that
 * list to the code: it walks `src/` for every production file that names the
 * boolean helper outside a comment and fails when the set differs from the
 * census, so a new caller cannot arrive without someone deciding its group.
 * Disk-scanning: run by name (`pnpm run test:named`).
 */
const ROOT = process.cwd();
const HELPER = "src/lib/admin-alert-once.ts";
const CALLER_DIR = "src/lib";
const NAMES_THE_HELPER = /\bsendAdminAlertOnceEver\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.[cm]?[jt]sx?$/.test(name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The census block's `- <file>` lines, by group heading, as repo paths. */
function readCensus(): Map<string, string[]> {
  const source = readFileSync(path.join(ROOT, HELPER), "utf8");
  const start = source.indexOf("#4696 CENSUS");
  expect(start, "the census block in admin-alert-once.ts").toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf("*/", start));
  const groups = new Map<string, string[]>();
  let heading: string | null = null;
  for (const line of block.split("\n")) {
    const entry = /^\s*\*\s+-\s+(\S+\.ts)\s*$/.exec(line);
    if (entry) {
      expect(heading, `${entry[1]} sits under no group heading`).not.toBeNull();
      groups.get(heading!)!.push(path.posix.join(CALLER_DIR, entry[1]));
      continue;
    }
    const groupHeading = /^\s*\*\s+(\S.*):\s*$/.exec(line);
    if (groupHeading) {
      heading = groupHeading[1];
      groups.set(heading, []);
    }
  }
  return groups;
}

describe("#4696: the once-ever helper's caller census matches the code", () => {
  it("lists every production caller of sendAdminAlertOnceEver, and nothing else", () => {
    const callers = walk(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => file !== HELPER)
      .filter((file) => NAMES_THE_HELPER.test(stripComments(readFileSync(path.join(ROOT, file), "utf8"))))
      .sort();
    const listed = [...readCensus().values()].flat().sort();

    expect(callers.length, "the scan found no caller at all").toBeGreaterThan(0);
    expect(
      listed,
      "a caller was added or removed: put it in admin-alert-once.ts's #4696 census under the group that says whether its alert is sent again",
    ).toEqual(callers);
  });

  it("puts each caller in exactly one group, and leaves no group empty", () => {
    const groups = readCensus();
    expect([...groups.keys()]).toHaveLength(3);
    for (const [heading, files] of groups) expect(files.length, heading).toBeGreaterThan(0);
    const listed = [...groups.values()].flat();
    expect(new Set(listed).size).toBe(listed.length);
  });
});

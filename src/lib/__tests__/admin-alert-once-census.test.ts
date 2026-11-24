import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * #4696, #5255 (`INV-SSOT`, `INV-INT-042`): the caller census in
 * `admin-alert-once.ts` is the one list of the once-ever helpers' callers,
 * grouped by what sends an alert again once its claim is given back. This
 * suite holds that list to the code: it walks `src/` for every production file
 * that names a helper outside a comment, and fails when a file is missing
 * from its group, or sits in the other one. A caller retried by its own next
 * run calls `sendAdminAlertOnceEver`, `sendAdminAlertOnceEverClaim` or the
 * takeover sequence `sendAdminAlertOnceEverWithTakeover` (itself a helper, so
 * its callers are listed, not it); one raised only once calls
 * `sendReplayableAdminAlertOnceEver`, so the sweep re-sends its stored alert.
 * A new caller cannot arrive without someone deciding which it is.
 * Disk-scanning: run by name (`pnpm run test:named`).
 */
const ROOT = process.cwd();
const HELPERS = new Set([
  "src/lib/admin-alert-once.ts",
  "src/lib/admin-alert-once-replayable.ts",
  "src/lib/admin-alert-once-takeover.ts",
]);
const CENSUS = "src/lib/admin-alert-once.ts";
const CALLER_DIR = "src/lib";
const RETRIED = "Retried by its next run (cron, or a webhook or request then cron)";
const REPLAYED = "Raised once; the sweep re-sends its stored alert";
const NAMES = {
  [RETRIED]: /\bsendAdminAlertOnceEver(?:Claim|WithTakeover)?\b/,
  [REPLAYED]: /\bsendReplayableAdminAlertOnceEver\b/,
};

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
  const source = readFileSync(path.join(ROOT, CENSUS), "utf8");
  const start = source.indexOf("#4696 CENSUS");
  expect(start, "the census block in admin-alert-once.ts").toBeGreaterThan(-1);
  // The block runs to the first empty line, which follows its closing line.
  const lines = source.slice(start).split("\n");
  const block = lines.slice(0, lines.findIndex((line) => line.trim() === ""));
  const groups = new Map<string, string[]>();
  let heading: string | null = null;
  for (const line of block) {
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

let productionSources: Map<string, string> | null = null;

/** Every production file under `src/` but the helpers, comments stripped, read once per run. */
function readProductionSources(): Map<string, string> {
  productionSources ??= new Map(
    walk(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => !HELPERS.has(file))
      .map((file) => [file, stripComments(readFileSync(path.join(ROOT, file), "utf8"))]),
  );
  return productionSources;
}

function callersNaming(name: RegExp): string[] {
  return [...readProductionSources()]
    .filter(([, source]) => name.test(source))
    .map(([file]) => file)
    .sort();
}

describe("#4696, #5255: the once-ever helpers' caller census matches the code", () => {
  it("has exactly the two groups, each non-empty, with no file in both", () => {
    const groups = readCensus();
    expect([...groups.keys()]).toEqual([RETRIED, REPLAYED]);
    for (const [heading, files] of groups) expect(files.length, heading).toBeGreaterThan(0);
    const listed = [...groups.values()].flat();
    expect(new Set(listed).size).toBe(listed.length);
  });

  it.each([RETRIED, REPLAYED] as const)("lists under \"%s\" exactly the files that call its helper", (heading) => {
    expect(readCensus().get(heading)?.slice().sort(), `put the caller in admin-alert-once.ts's census under "${heading}", or switch it to the other helper`).toEqual(
      callersNaming(NAMES[heading]),
    );
  }, CENSUS_TIMEOUT_MS);

  it("finds no file calling both helpers, so each caller's retry is one answer", () => {
    const replayed = new Set(callersNaming(NAMES[REPLAYED]));
    const both = callersNaming(NAMES[RETRIED]).filter((file) => replayed.has(file));
    expect(both).toEqual([]);
  }, CENSUS_TIMEOUT_MS);
});

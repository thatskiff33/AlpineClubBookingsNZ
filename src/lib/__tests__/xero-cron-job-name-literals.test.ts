import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { XERO_CRON_JOB_NAMES } from "@/lib/xero-cron-jobs";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// No production code spells a Xero cron job name as a string literal (#4922
// review, INV-SSOT).
//
// The runner records and claims each run under its `XERO_CRON_JOB_NAMES`
// entry; the scheduler logs and checks in to Sentry under the same name, and
// admin cron health and Xero health read the `CronJobRun` rows back by it. A
// raw copy keeps matching until the name is renamed, then cron health shows
// the job as never run and the Sentry monitor stops matching, with nothing
// failing. So every literal is refused outside `xero-cron-jobs.ts`.
//
// What counts: the whole name between `"`, `'` or `` ` `` quotes, in code with
// its comments removed. `"admin-xero-reconciliation-report"` (an email
// template) is a different literal and is not matched.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const HOME = "src/lib/xero-cron-jobs.ts";

/** Every production `.ts`/`.tsx` file under `src/`, tests left out. */
function productionFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : productionFiles(rel);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [rel];
  });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const JOB_NAME_LITERAL = new RegExp(
  `(["'\`])(${Object.values(XERO_CRON_JOB_NAMES).map(escapeRegExp).join("|")})\\1`,
  "g",
);

/** `file:line: literal` for every Xero job-name literal in `source`. */
function findJobNameLiterals(file: string, source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(JOB_NAME_LITERAL)].map((match) => {
    const line = code.slice(0, match.index).split("\n").length;
    return `${file}:${line}: ${match[0]}`;
  });
}

describe("Xero cron job names have one spelling (INV-SSOT)", () => {
  it("finds a raw job name, and ignores one in a comment or a longer literal", () => {
    const source = [
      `logger.info({ job: "xero-inbound-reconcile" });`,
      `// the "xero-outbox" job`,
      `const template = "admin-xero-reconciliation-report";`,
      "const slug = `xero-link-cleanup`;",
    ].join("\n");

    expect(findJobNameLiterals("x.ts", source)).toEqual([
      `x.ts:1: "xero-inbound-reconcile"`,
      "x.ts:4: `xero-link-cleanup`",
    ]);
  });

  it("spells every name in xero-cron-jobs.ts and nowhere else in production code", () => {
    const files = productionFiles("src");
    expect(files).toContain(HOME);

    const homeLiterals = findJobNameLiterals(HOME, fs.readFileSync(path.join(ROOT, HOME), "utf8"));
    expect(homeLiterals).toHaveLength(Object.keys(XERO_CRON_JOB_NAMES).length);

    const elsewhere = files
      .filter((file) => file !== HOME)
      .flatMap((file) => findJobNameLiterals(file, fs.readFileSync(path.join(ROOT, file), "utf8")));
    expect(elsewhere).toEqual([]);
  });
});

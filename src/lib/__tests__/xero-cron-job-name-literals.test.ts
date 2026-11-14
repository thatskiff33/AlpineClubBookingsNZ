import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { XERO_CRON_JOB_NAMES } from "@/lib/xero-cron-jobs";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// No code under `src/` outside `__tests__` spells one of the ten Xero cron
// runner job names as a string literal (#4922 review, INV-SSOT). That is the
// tasks of `xero-cron-runner.ts` only: the payments cycle's jobs, such as
// `xero-waiting-invoice-reaper`, are named in `payments-cron-runner.ts` and
// `admin-cron-health.ts` and are not covered here. Test support files under
// `src/test/` (the fakes, not the `*.test.ts` files) are scanned too, on
// purpose: a fake that copied a name would go stale the same way.
//
// The runner records and claims each run under its `XERO_CRON_JOB_NAMES`
// entry; the scheduler logs and checks in to Sentry under the same name, and
// admin cron health and Xero health read the `CronJobRun` rows back by it. A
// raw copy keeps matching until the name is renamed, then cron health shows
// the job as never run and the Sentry monitor stops matching, with nothing
// failing. So every literal is refused outside `xero-cron-jobs.ts`.
// `xero-cron-jobs.ts` itself imports nothing, because `instrumentation.node.ts`
// loads it at boot; the last test holds it to that.
//
// What counts: the whole name between `"`, `'` or `` ` `` quotes, in code with
// its comments removed. `"admin-xero-reconciliation-report"` (an email
// template) is a different literal and is not matched.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const HOME = "src/lib/xero-cron-jobs.ts";

/** Every `.ts`/`.tsx` file under `src/` outside `__tests__` and `*.test.*`. */
function scannedFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : scannedFiles(rel);
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

describe("The ten Xero cron runner job names have one spelling (INV-SSOT)", () => {
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

  it("spells every name in xero-cron-jobs.ts and nowhere else under src/", () => {
    const files = scannedFiles("src");
    expect(files).toContain(HOME);

    const homeLiterals = findJobNameLiterals(HOME, fs.readFileSync(path.join(ROOT, HOME), "utf8"));
    expect(homeLiterals).toHaveLength(Object.keys(XERO_CRON_JOB_NAMES).length);

    const elsewhere = files
      .filter((file) => file !== HOME)
      .flatMap((file) => findJobNameLiterals(file, fs.readFileSync(path.join(ROOT, file), "utf8")));
    expect(elsewhere).toEqual([]);
  });

  it("keeps xero-cron-jobs.ts free of imports, so booting the scheduler pulls in nothing else", () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, HOME), "utf8"));
    // Static `import ... from`, bare `import "x"`, `export ... from`, a dynamic
    // `import(` and `require(` are all a way to pull another module in.
    const pullsIn = /^\s*(import|export)\b[^;]*?\bfrom\s*["'`]|^\s*import\s*["'`(]|\brequire\s*\(|\bimport\s*\(/m;
    expect(code).not.toMatch(pullsIn);
  });
});

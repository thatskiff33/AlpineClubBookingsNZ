import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PAYMENTS_CRON_JOB_NAMES } from "@/lib/payments-cron-jobs";
import { XERO_CRON_JOB_NAMES } from "@/lib/xero-cron-jobs";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

// ---------------------------------------------------------------------------
// Each cron runner's job names have one home module, and no other code under
// `src/` outside `__tests__` spells one as a string literal (#4922 review for
// the Xero runner, #5256 for the payments cycle; INV-SSOT). Test support files
// under `src/test/` (the fakes, not the `*.test.ts` files) are scanned too, on
// purpose: a fake that copied a name would go stale the same way.
//
// The runner records each run under its home's entry; the scheduler logs and
// checks in to Sentry under it, and admin cron health reads the `CronJobRun`
// rows back by it. A raw copy keeps matching until the name is renamed, then
// cron health shows the job as never run and the Sentry monitor stops
// matching, with nothing failing. So every literal is refused outside its
// home. Each home imports nothing, because `instrumentation.node.ts` loads it
// at boot; the last test holds it to that.
//
// What counts: the whole name between `"`, `'` or `` ` `` quotes, in code with
// its comments removed. `"admin-xero-reconciliation-report"` (an email
// template) is a different literal and is not matched. One named exemption:
// `"payment-recovery"` straight after `kind:` or `kind ===` is the replay-alert
// kind stored in `AlertCooldown.replayAlert` (`admin-alert-once-replayable.ts`),
// a stored value typed by its own union, not a job name.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

/** Each module that owns a cron runner's job names, and the names it owns. */
const HOMES = [
  { file: "src/lib/xero-cron-jobs.ts", names: Object.values(XERO_CRON_JOB_NAMES) },
  { file: "src/lib/payments-cron-jobs.ts", names: Object.values(PAYMENTS_CRON_JOB_NAMES) },
] as const;

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
  `(["'\`])(${HOMES.flatMap((home) => home.names).map(escapeRegExp).join("|")})\\1`,
  "g",
);

/** The replay-alert kind (`admin-alert-once-replayable.ts`) shares the recovery job's spelling. */
const REPLAY_ALERT_KIND = /\bkind\s*(?::|===)\s*$/;

/** `file:line: literal` for every cron job-name literal in `source`. */
function findJobNameLiterals(file: string, source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(JOB_NAME_LITERAL)]
    .filter(
      (match) =>
        !(match[2] === PAYMENTS_CRON_JOB_NAMES.recovery && REPLAY_ALERT_KIND.test(code.slice(0, match.index)))
    )
    .map((match) => {
      const line = code.slice(0, match.index).split("\n").length;
      return `${file}:${line}: ${match[0]}`;
    });
}

const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Every cron runner's job names have one spelling, in their home module (INV-SSOT)", () => {
  it("finds a raw job name, and ignores one in a comment or a longer literal", () => {
    const source = [
      `logger.info({ job: "xero-inbound-reconcile" });`,
      `// the "xero-outbox" job`,
      `const template = "admin-xero-reconciliation-report";`,
      "const slug = `xero-link-cleanup`;",
      `const reaper = 'xero-waiting-invoice-reaper';`,
    ].join("\n");

    expect(findJobNameLiterals("x.ts", source)).toEqual([
      `x.ts:1: "xero-inbound-reconcile"`,
      "x.ts:4: `xero-link-cleanup`",
      `x.ts:5: 'xero-waiting-invoice-reaper'`,
    ]);
  });

  it("skips the replay-alert kind, and still finds the recovery job name anywhere else", () => {
    const source = [
      `type Replay = { kind: "payment-recovery"; paymentId: string };`,
      `if (fields.kind === "payment-recovery") {}`,
      `const replay = { kind:"payment-recovery" };`,
      `runRecordedCronTask({ jobName: "payment-recovery" });`,
      `Sentry.captureCheckIn({ monitorSlug: "payment-recovery" });`,
      `const kind = { release: "internet-banking-hold-release" };`,
    ].join("\n");

    expect(findJobNameLiterals("x.ts", source)).toEqual([
      `x.ts:4: "payment-recovery"`,
      `x.ts:5: "payment-recovery"`,
      `x.ts:6: "internet-banking-hold-release"`,
    ]);
  });

  it("gives no job name two homes", () => {
    const names = HOMES.flatMap((home) => home.names);
    expect(new Set(names).size).toBe(names.length);
  });

  it("spells each home's names in that home only, and nowhere else under src/", () => {
    const files = scannedFiles("src");
    const homeFiles = HOMES.map((home) => home.file);

    for (const home of HOMES) {
      expect(files).toContain(home.file);
      const spelled = findJobNameLiterals(home.file, readSource(home.file)).map((found) =>
        found.replace(/^.*?: (["'`])(.*)\1$/, "$2")
      );
      expect(spelled.sort()).toEqual([...home.names].sort());
    }

    const elsewhere = files
      .filter((file) => !homeFiles.includes(file))
      .flatMap((file) => findJobNameLiterals(file, readSource(file)));
    expect(elsewhere).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it.each(HOMES.map((home) => home.file))(
    "keeps %s free of imports, so booting the scheduler pulls in nothing else",
    (file) => {
      const code = stripComments(readSource(file));
      // Static `import ... from`, bare `import "x"`, `export ... from`, a dynamic
      // `import(` and `require(` are all a way to pull another module in.
      const pullsIn = /^\s*(import|export)\b[^;]*?\bfrom\s*["'`]|^\s*import\s*["'`(]|\brequire\s*\(|\bimport\s*\(/m;
      expect(code).not.toMatch(pullsIn);
    }
  );
});

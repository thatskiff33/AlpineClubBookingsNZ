import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// #5407: the deploy script's cron-registration check accepts fixed lines from
// the cron container's startup log (grep -F, a plain substring). A line no log
// call in `src/instrumentation.node.ts` can produce is either dead (the check
// can never pass on it) or, where it is the only success line, a check that can
// only fail: "Scheduled Xero membership refresh" was both, against the app's
// "Scheduled Xero membership safety-net refresh (daily at 2 AM …)".

const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), "utf8");

const SCRIPT = read("scripts/run-production-blue-green-deploy.sh");
const INSTRUMENTATION = read("src/instrumentation.node.ts");

/** The body of `verify_cron_registration() { ... }`, up to the next top-level `}`. */
function verifyCronRegistrationBody(script: string): string {
  const start = script.indexOf("verify_cron_registration() {");
  expect(start, "verify_cron_registration is missing from the deploy script").toBeGreaterThan(-1);
  const end = script.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

/** Every line the function accepts: the required list and each assert's alternatives. */
function acceptedLines(body: string): string[] {
  const lines: string[] = [];
  const list = /local patterns=\(([\s\S]*?)\n\s*\)/.exec(body);
  expect(list, "the required patterns list is missing").not.toBeNull();
  for (const match of (list?.[1] ?? "").matchAll(/"([^"]+)"/g)) lines.push(match[1] ?? "");
  // assert_logs_contain_any "$logs" "<description>" "<line>" ...
  for (const call of body.matchAll(/assert_logs_contain_any((?:\s*\\\n\s*"[^"]*")+)/g)) {
    const args = [...(call[1] ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(args[0]).toBe("$logs");
    lines.push(...args.slice(2));
  }
  return lines;
}

describe("the deploy's cron-registration check accepts only lines the app logs (#5407)", () => {
  const lines = acceptedLines(verifyCronRegistrationBody(SCRIPT));

  it("finds the required list and the three optional-cron checks", () => {
    expect(lines.length).toBeGreaterThanOrEqual(17);
    expect(lines).toContain("Scheduled Xero membership safety-net refresh");
  });

  it.each(lines)("%s appears in a log call in instrumentation.node.ts", (line) => {
    expect(INSTRUMENTATION).toContain(line);
  });

  it("refuses a line no log call produces", () => {
    expect(INSTRUMENTATION).not.toContain("Scheduled Xero membership refresh");
  });
});

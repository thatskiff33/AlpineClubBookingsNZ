import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

// #5407: the deploy script's cron-registration check accepts fixed lines from
// the cron container's startup log (grep -F, a plain substring). A line no log
// call in `src/instrumentation.node.ts` can produce is either dead (the check
// can never pass on it) or, where it is the only success line, a check that can
// only fail: "Scheduled Xero membership refresh" was both, against the app's
// "Scheduled Xero membership safety-net refresh (daily at 2 AM …)".
//
// The source is read with its comments stripped (INV-SSOT-004): a phrase that
// appears only in a comment is not something the app logs.

const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), "utf8");

const SCRIPT = read("scripts/run-production-blue-green-deploy.sh");
const INSTRUMENTATION_CODE = stripComments(read("src/instrumentation.node.ts"));

/** The register() cron block's top level: four spaces, after `if (!cronEnabled) return`. */
const TOP_LEVEL = "    ";

/** The body of `verify_cron_registration() { ... }`, up to the next top-level `}`. */
function verifyCronRegistrationBody(script: string): string {
  const start = script.indexOf("verify_cron_registration() {");
  expect(start, "verify_cron_registration is missing from the deploy script").toBeGreaterThan(-1);
  const end = script.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

/** The required list, and each optional check's alternative lines. */
function acceptedLines(body: string): { required: string[]; optional: string[][] } {
  const list = /local patterns=\(([\s\S]*?)\n\s*\)/.exec(body);
  expect(list, "the required patterns list is missing").not.toBeNull();
  const required = [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  const optional: string[][] = [];
  // assert_logs_contain_any "$logs" "<description>" "<line>" ...
  for (const call of body.matchAll(/assert_logs_contain_any((?:\s*\\\n\s*"[^"]*")+)/g)) {
    const args = [...(call[1] ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(args[0]).toBe("$logs");
    optional.push(args.slice(2));
  }
  return { required, optional };
}

/** The indentation of the `logger.*(` call whose message contains `line`, or null. */
function loggerCallIndent(code: string, line: string): string | null {
  const at = code.indexOf(line);
  if (at < 0) return null;
  const call = code.lastIndexOf("logger.", at);
  const lineStart = code.lastIndexOf("\n", call) + 1;
  return /^\s*/.exec(code.slice(lineStart, call))?.[0] ?? "";
}

/**
 * True when one accepted line sits in the `if` branch and another in the `else`
 * branch of the same top-level if/else, so one of them is always logged.
 */
function coveredByBothBranches(code: string, lines: string[]): boolean {
  for (const opening of code.matchAll(new RegExp(`\\n${TOP_LEVEL}if \\(.*\\) \\{\\n`, "g"))) {
    const start = (opening.index ?? 0) + opening[0].length;
    const elseAt = code.indexOf(`\n${TOP_LEVEL}} else {\n`, start);
    if (elseAt < 0) continue;
    const endAt = code.indexOf(`\n${TOP_LEVEL}}\n`, elseAt + 1);
    if (endAt < 0) continue;
    const thenPart = code.slice(start, elseAt);
    const elsePart = code.slice(elseAt, endAt);
    if (thenPart.includes(`\n${TOP_LEVEL}`.concat("}"))) continue;
    if (lines.some((l) => thenPart.includes(l)) && lines.some((l) => elsePart.includes(l))) return true;
  }
  return false;
}

describe("the deploy's cron-registration check accepts only lines the app logs (#5407)", () => {
  const { required, optional } = acceptedLines(verifyCronRegistrationBody(SCRIPT));
  const every = [...required, ...optional.flat()];

  it("finds the required list and the three optional-cron checks", () => {
    expect(required.length).toBeGreaterThanOrEqual(13);
    expect(optional).toHaveLength(3);
    expect(every).toContain("Scheduled Xero membership safety-net refresh");
  });

  it.each(every)("%s appears in a log call in instrumentation.node.ts", (line) => {
    expect(INSTRUMENTATION_CODE).toContain(line);
    expect(loggerCallIndent(INSTRUMENTATION_CODE, line), "not inside a logger call").not.toBeNull();
  });

  it("does not count a phrase that appears only in a comment", () => {
    // The Xero job's comment reads "Xero membership refresh safety net".
    expect(read("src/instrumentation.node.ts")).toContain("Xero membership refresh safety net");
    expect(INSTRUMENTATION_CODE).not.toContain("Xero membership refresh safety net");
    expect(INSTRUMENTATION_CODE).not.toContain("Scheduled Xero membership refresh");
  });

  it("the required lines are logged at the cron block's top level", () => {
    for (const line of required) expect(loggerCallIndent(INSTRUMENTATION_CODE, line), line).toBe(TOP_LEVEL);
  });

  it.each(optional.map((lines) => [lines[0] ?? "", lines] as const))(
    "the %s check always has a line to find once cron is enabled",
    (_first, lines) => {
      const unconditional = lines.some((line) => loggerCallIndent(INSTRUMENTATION_CODE, line) === TOP_LEVEL);
      expect(unconditional || coveredByBothBranches(INSTRUMENTATION_CODE, lines), lines.join(" | ")).toBe(true);
    },
  );
});
